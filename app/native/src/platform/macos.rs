//! macOS backend: a CGEventTap on the main run loop plus Accessibility queries.
//!
//! The tap callback runs inline in the HID event path. If it is slow the system disables
//! the tap (and the user's keyboard feels laggy), so every check before the Accessibility
//! query is a cheap integer or string comparison, and the Accessibility query itself has a
//! short messaging timeout. The callback reads the current AX selection, then resolves its
//! file references on a worker. Predictive rendering cannot authorize key interception.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use core_foundation_sys::base::{CFRelease, CFTypeRef, kCFAllocatorDefault};
use core_foundation_sys::date::CFAbsoluteTimeGetCurrent;
use core_foundation_sys::mach_port::CFMachPortCreateRunLoopSource;
use core_foundation_sys::runloop::{
    CFRunLoopAddSource, CFRunLoopAddTimer, CFRunLoopGetCurrent, CFRunLoopGetMain,
    CFRunLoopRunInMode, CFRunLoopTimerCreate, CFRunLoopTimerRef, CFRunLoopWakeUp,
    kCFRunLoopCommonModes, kCFRunLoopDefaultMode,
};
use core_foundation_sys::url::{CFURLCreateFilePathURL, CFURLCreateWithString};
use objc2_app_kit::NSWorkspace;

use super::pending::PendingPeek;
use super::{Backend, Outbox};
use crate::protocol::{Event, PermissionState, Probe};

/// Bundle identifiers of file managers that trigger a peek.
const SUPPORTED_APPS: &[&str] = &["com.apple.finder"];

/// Accessibility roles (and the search subrole) in which Space is a typed character.
const TEXT_INPUT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];
const SEARCH_SUBROLE: &str = "AXSearchField";

const SPACE_KEYCODE: i64 = 49;

/// Written to kCGEventSourceUserData on replayed events so our own tap lets them through.
const REPLAY_TAG: i64 = 0x534D_4450;

// CGEventType
const EVENT_KEY_DOWN: u32 = 10;
const EVENT_KEY_UP: u32 = 11;
const EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

// CGEventField
const FIELD_KEYBOARD_AUTOREPEAT: u32 = 8;
const FIELD_KEYBOARD_KEYCODE: u32 = 9;
const FIELD_SOURCE_USER_DATA: u32 = 42;

// CGEventFlags. Caps lock, fn and the numeric-pad bit are deliberately not blocking.
const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_OPTION: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;
const BLOCKING_MODIFIERS: u64 = FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND;

const TAP_LOCATION_SESSION: u32 = 1;
const TAP_PLACEMENT_HEAD_INSERT: u32 = 0;
const TAP_OPTION_DEFAULT: u32 = 0;
const KEY_EVENT_MASK: u64 = (1 << EVENT_KEY_DOWN) | (1 << EVENT_KEY_UP);

const AX_ERROR_NO_VALUE: i32 = -25212;
const AX_MESSAGING_TIMEOUT_SECS: f32 = 0.008;

type CGEventRef = *mut c_void;
type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: TapCallback,
        user_info: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventTapIsEnabled(tap: *mut c_void) -> bool;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap_location: u32, event: CGEventRef);
    fn CGEventCreateKeyboardEvent(
        source: *const c_void,
        keycode: u16,
        key_down: bool,
    ) -> CGEventRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: *const c_void,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
}

static ENABLED: AtomicBool = AtomicBool::new(true);
/// True between a swallowed Space key-down and its key-up.
static SWALLOWING: AtomicBool = AtomicBool::new(false);
static TAP: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
static OUT: OnceLock<Outbox> = OnceLock::new();
static TRACING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectionSnapshot {
    pid: i32,
    urls: Vec<String>,
}

static REQUESTS: OnceLock<SyncSender<u64>> = OnceLock::new();
static PENDING: Mutex<PendingPeek<SelectionSnapshot>> = Mutex::new(PendingPeek::new());
const SELECTION_BUDGET: Duration = Duration::from_millis(20);
const MAX_SELECTION: usize = 32;

fn emit(event: Event) {
    if let Some(out) = OUT.get() {
        let _ = out.send(Some(event));
    }
}

/// File extensions that count as Markdown for the Space preview. `.txt` is deliberately absent.
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];

fn is_markdown_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| MARKDOWN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn is_supported_app(bundle_id: &str) -> bool {
    SUPPORTED_APPS.contains(&bundle_id)
}

fn is_text_input_role(role: &str, subrole: Option<&str>) -> bool {
    TEXT_INPUT_ROLES.contains(&role) || subrole == Some(SEARCH_SUBROLE)
}

/// A fresh, unmodified Space press (not a key repeat).
fn is_plain_space(keycode: i64, flags: u64, autorepeat: bool) -> bool {
    keycode == SPACE_KEYCODE && flags & BLOCKING_MODIFIERS == 0 && !autorepeat
}

fn ax_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

fn permission_state(trusted: bool) -> PermissionState {
    if trusted {
        PermissionState::Granted
    } else {
        PermissionState::Missing
    }
}

fn frontmost_bundle_id() -> Option<String> {
    objc2::rc::autoreleasepool(|_| {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        app.bundleIdentifier().map(|id| id.to_string())
    })
}

fn frontmost_pid() -> Option<i32> {
    objc2::rc::autoreleasepool(|_| {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        Some(app.processIdentifier())
    })
}

fn message_timeout(deadline: Instant, now: Instant) -> Option<f32> {
    let remaining = deadline.checked_duration_since(now)?;
    if remaining.is_zero() {
        return None;
    }
    Some(
        remaining
            .min(Duration::from_secs_f32(AX_MESSAGING_TIMEOUT_SECS))
            .as_secs_f32(),
    )
}

struct AxQuery {
    deadline: Instant,
}

impl AxQuery {
    fn new() -> Self {
        Self {
            deadline: Instant::now() + SELECTION_BUDGET,
        }
    }

    fn copy(&self, element: &CFType, name: &'static str) -> Result<CFType, i32> {
        let attr = CFString::from_static_string(name);
        let timeout = message_timeout(self.deadline, Instant::now()).ok_or(AX_ERROR_NO_VALUE)?;
        let mut value: CFTypeRef = ptr::null();
        let err = unsafe {
            AXUIElementSetMessagingTimeout(element.as_CFTypeRef(), timeout);
            AXUIElementCopyAttributeValue(
                element.as_CFTypeRef(),
                attr.as_concrete_TypeRef().cast(),
                &mut value,
            )
        };
        if err != 0 {
            return Err(err);
        }
        if value.is_null() {
            return Err(AX_ERROR_NO_VALUE);
        }
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }

    fn string(&self, element: &CFType, name: &'static str) -> Option<String> {
        self.copy(element, name)
            .ok()?
            .downcast::<CFString>()
            .map(|s| s.to_string())
    }

    fn array(&self, element: &CFType, name: &'static str) -> Option<Vec<CFType>> {
        let value = self.copy(element, name).ok()?;
        let array = value.downcast::<CFArray>()?;
        if array.len() as usize > MAX_SELECTION {
            return None;
        }
        Some(
            array
                .iter()
                .map(|p| unsafe { CFType::wrap_under_get_rule(*p) })
                .collect(),
        )
    }
}

/// `None` means the query failed; callers must treat that as "do not swallow".
fn text_input_focused() -> Option<bool> {
    let query = AxQuery::new();
    // Asking the frontmost app directly is reliable; the system-wide element answers
    // kAXErrorCannotComplete for some apps and setups, so it is only the fallback.
    let from_app = frontmost_pid().map(|pid| {
        let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
        unsafe { AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), AX_MESSAGING_TIMEOUT_SECS) };
        query.copy(&app, "AXFocusedUIElement")
    });
    let focused = match from_app {
        Some(Ok(el)) => Ok(el),
        Some(Err(AX_ERROR_NO_VALUE)) => Err(AX_ERROR_NO_VALUE),
        _ => {
            let system = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateSystemWide()) };
            unsafe {
                AXUIElementSetMessagingTimeout(system.as_CFTypeRef(), AX_MESSAGING_TIMEOUT_SECS)
            };
            query.copy(&system, "AXFocusedUIElement")
        }
    };
    match focused {
        // Nothing focused (e.g. desktop selection) cannot be a text field.
        Err(AX_ERROR_NO_VALUE) => Some(false),
        Err(_) => None,
        Ok(element) => {
            let role = query.string(&element, "AXRole")?;
            let subrole = query.string(&element, "AXSubrole");
            Some(is_text_input_role(&role, subrole.as_deref()))
        }
    }
}

fn selected_url(
    element: &CFType,
    depth: usize,
    query: &AxQuery,
    nodes: &mut usize,
) -> Option<Option<String>> {
    if depth > 4 || *nodes >= 64 || Instant::now() >= query.deadline {
        return None;
    }
    *nodes += 1;
    if let Ok(value) = query.copy(element, "AXURL") {
        let url = value.downcast::<CFURL>()?;
        let name = query
            .string(element, "AXFilename")
            .or_else(|| query.string(element, "AXTitle"))
            .or_else(|| query.string(element, "AXValue"))?;
        let url = url.get_string().to_string();
        return Some((is_markdown_path(&name) && url.starts_with("file:")).then_some(url));
    }
    let children = query.array(element, "AXChildren").unwrap_or_default();
    for child in children {
        match selected_url(&child, depth + 1, query, nodes)? {
            Some(url) => return Some(Some(url)),
            None => continue,
        }
    }
    Some(None)
}

fn selected_file_urls() -> Option<SelectionSnapshot> {
    let query = AxQuery::new();
    let pid = frontmost_pid()?;
    let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
    let focused = query.copy(&app, "AXFocusedUIElement").ok()?;
    let role = query.string(&focused, "AXRole")?;
    if query.string(&focused, "AXSubrole").as_deref() == Some("AXSourceList") {
        return None;
    }
    let selection_attribute = match role.as_str() {
        "AXOutline" | "AXTable" => "AXSelectedRows",
        "AXList" => "AXSelectedChildren",
        _ => return None,
    };
    let items = query.array(&focused, selection_attribute)?;
    if items.len() != 1 {
        return Some(SelectionSnapshot { pid, urls: vec![] });
    }
    let mut urls = Vec::new();
    let mut nodes = 0;
    for item in items {
        if let Some(url) = selected_url(&item, 0, &query, &mut nodes)? {
            urls.push(url);
        }
    }
    let still_focused = query.copy(&app, "AXFocusedUIElement").ok()?;
    if Instant::now() >= query.deadline || frontmost_pid() != Some(pid) || focused != still_focused
    {
        return None;
    }
    Some(SelectionSnapshot { pid, urls })
}

fn resolve_files(urls: &[String]) -> Vec<String> {
    urls.iter()
        .filter_map(|text| unsafe {
            let text = CFString::new(text);
            let raw =
                CFURLCreateWithString(kCFAllocatorDefault, text.as_concrete_TypeRef(), ptr::null());
            if raw.is_null() {
                return None;
            }
            let reference = CFURL::wrap_under_create_rule(raw);
            let raw = CFURLCreateFilePathURL(
                kCFAllocatorDefault,
                reference.as_concrete_TypeRef(),
                ptr::null_mut(),
            );
            if raw.is_null() {
                return None;
            }
            let url = CFURL::wrap_under_create_rule(raw);
            let path = url.to_path()?;
            let path = path.to_str()?;
            (is_markdown_path(path) && std::path::Path::new(path).is_file())
                .then(|| path.to_owned())
        })
        .collect()
}

extern "C" fn tap_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: CGEventRef,
    _user_info: *mut c_void,
) -> CGEventRef {
    match event_type {
        EVENT_TAP_DISABLED_BY_TIMEOUT | EVENT_TAP_DISABLED_BY_USER_INPUT => {
            let tap = TAP.load(Ordering::Acquire);
            if !tap.is_null() {
                unsafe { CGEventTapEnable(tap, true) };
            }
            return event;
        }
        EVENT_KEY_DOWN | EVENT_KEY_UP => {}
        _ => return event,
    }

    unsafe {
        if CGEventGetIntegerValueField(event, FIELD_KEYBOARD_KEYCODE) != SPACE_KEYCODE
            || CGEventGetIntegerValueField(event, FIELD_SOURCE_USER_DATA) == REPLAY_TAG
        {
            return event;
        }
        if TRACING.load(Ordering::Relaxed) {
            eprintln!(
                "peek-key type={event_type} frontmost={:?}",
                frontmost_bundle_id()
            );
        }

        if event_type == EVENT_KEY_UP {
            return if SWALLOWING.swap(false, Ordering::AcqRel) {
                ptr::null_mut()
            } else {
                event
            };
        }

        let autorepeat = CGEventGetIntegerValueField(event, FIELD_KEYBOARD_AUTOREPEAT) != 0;
        if autorepeat {
            // Repeats of a press we swallowed must not leak through to Finder either.
            return if SWALLOWING.load(Ordering::Acquire) {
                ptr::null_mut()
            } else {
                event
            };
        }
        // A fresh press clears any state left over from a key-up the tap never saw.
        SWALLOWING.store(false, Ordering::Release);

        if !ENABLED.load(Ordering::Acquire)
            || !is_plain_space(SPACE_KEYCODE, CGEventGetFlags(event), false)
        {
            return event;
        }
    }

    let Some(_) = frontmost_bundle_id().filter(|id| is_supported_app(id)) else {
        return event;
    };
    let Some(selection) = selected_file_urls() else {
        return event;
    };
    if selection.urls.is_empty() {
        return event;
    }
    let Some(request_id) = PENDING
        .try_lock()
        .ok()
        .and_then(|mut p| p.begin(Instant::now(), selection))
    else {
        return event;
    };
    if REQUESTS
        .get()
        .is_none_or(|requests| requests.try_send(request_id).is_err())
    {
        MacBackend.complete_peek(request_id);
        return event;
    }
    SWALLOWING.store(true, Ordering::Release);
    ptr::null_mut()
}

/// Creates the tap on first use; afterwards just makes sure it is enabled.
fn ensure_tap() -> Result<(), String> {
    let existing = TAP.load(Ordering::Acquire);
    if !existing.is_null() {
        unsafe {
            if !CGEventTapIsEnabled(existing) {
                CGEventTapEnable(existing, true);
            }
        }
        return Ok(());
    }

    unsafe {
        let tap = CGEventTapCreate(
            TAP_LOCATION_SESSION,
            TAP_PLACEMENT_HEAD_INSERT,
            TAP_OPTION_DEFAULT,
            KEY_EVENT_MASK,
            tap_callback,
            ptr::null_mut(),
        );
        if tap.is_null() {
            return Err(
                "could not create the keyboard event tap; grant Accessibility and \
                        Input Monitoring to the app that launches simplemd-peek"
                    .into(),
            );
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap.cast(), 0);
        if source.is_null() {
            CFRelease(tap.cast_const());
            return Err("could not create a run loop source for the event tap".into());
        }
        // Publish before the source goes live so the callback can always re-enable the tap.
        TAP.store(tap, Ordering::Release);
        let main = CFRunLoopGetMain();
        CFRunLoopAddSource(main, source, kCFRunLoopCommonModes);
        CFRunLoopWakeUp(main);
        CGEventTapEnable(tap, true);
    }
    Ok(())
}

struct MacBackend;

impl Backend for MacBackend {
    fn replay_space(&self, request_id: u64) {
        let snapshot = PENDING
            .lock()
            .ok()
            .and_then(|mut p| p.take(Instant::now(), request_id));
        let Some(snapshot) = snapshot else {
            return;
        };
        if selected_file_urls().as_ref() != Some(&snapshot)
            || !frontmost_bundle_id().is_some_and(|id| is_supported_app(&id))
        {
            return;
        }
        for key_down in [true, false] {
            unsafe {
                let event = CGEventCreateKeyboardEvent(ptr::null(), SPACE_KEYCODE as u16, key_down);
                if event.is_null() {
                    emit(Event::error("could not create a keyboard event to replay"));
                    return;
                }
                CGEventSetIntegerValueField(event, FIELD_SOURCE_USER_DATA, REPLAY_TAG);
                CGEventSetFlags(event, 0);
                CGEventPost(TAP_LOCATION_SESSION, event);
                CFRelease(event.cast_const());
            }
        }
    }

    fn validate_peek(&self, request_id: u64) -> bool {
        let snapshot = PENDING
            .lock()
            .ok()
            .and_then(|p| p.context(Instant::now(), request_id).cloned());
        let Some(snapshot) = snapshot else {
            return false;
        };
        selected_file_urls().as_ref() == Some(&snapshot)
            && PENDING
                .lock()
                .ok()
                .is_some_and(|p| p.context(Instant::now(), request_id).is_some())
    }

    fn complete_peek(&self, request_id: u64) {
        if let Ok(mut pending) = PENDING.lock() {
            pending.take(Instant::now(), request_id);
        }
    }

    fn set_enabled(&self, enabled: bool) {
        ENABLED.store(enabled, Ordering::Release);
    }
}

pub fn init(out: Outbox) -> Arc<dyn Backend> {
    let _ = OUT.set(out);
    TRACING.store(std::env::var_os("SMD_TRACE").is_some(), Ordering::Relaxed);
    // Workspace notifications must attach to the main run loop, not the polling thread.
    let _ = NSWorkspace::sharedWorkspace();
    let (requests, pending) = mpsc::sync_channel::<u64>(1);
    let _ = REQUESTS.set(requests);
    thread::spawn(move || {
        for request_id in pending {
            let snapshot = PENDING
                .lock()
                .ok()
                .and_then(|p| p.context(Instant::now(), request_id).cloned());
            let Some(snapshot) = snapshot else {
                continue;
            };
            let paths = resolve_files(&snapshot.urls);
            if !ENABLED.load(Ordering::Acquire)
                || selected_file_urls().as_ref() != Some(&snapshot)
                || PENDING
                    .lock()
                    .ok()
                    .and_then(|p| p.context(Instant::now(), request_id).cloned())
                    .is_none()
            {
                MacBackend.complete_peek(request_id);
                continue;
            }
            if paths.is_empty() {
                MacBackend.replay_space(request_id);
            } else {
                emit(Event::Peek {
                    request_id,
                    origin: None,
                    app: "com.apple.finder".into(),
                    paths,
                });
            }
        }
    });

    let trusted = ax_trusted();
    emit(Event::Ready {
        platform: "macos",
        permission: permission_state(trusted),
    });
    thread::spawn(move || {
        let mut last = trusted;
        let mut last_tap_error: Option<String> = None;
        let mut last_selection: Option<SelectionSnapshot> = None;
        loop {
            let now = ax_trusted();
            if now != last {
                last = now;
                emit(Event::Permission {
                    state: permission_state(now),
                });
            }
            if now {
                match ensure_tap() {
                    Ok(()) => last_tap_error = None,
                    Err(message) if last_tap_error.as_ref() != Some(&message) => {
                        emit(Event::error(message.clone()));
                        last_tap_error = Some(message);
                    }
                    Err(_) => {}
                }
                let selection = if ENABLED.load(Ordering::Acquire)
                    && frontmost_bundle_id().is_some_and(|id| is_supported_app(&id))
                {
                    selected_file_urls()
                } else {
                    None
                };
                if selection != last_selection {
                    let paths = selection
                        .as_ref()
                        .map(|s| resolve_files(&s.urls))
                        .unwrap_or_default();
                    last_selection = selection;
                    emit(Event::Selection { paths });
                }
            }
            thread::sleep(Duration::from_millis(400));
        }
    });
    Arc::new(MacBackend)
}

extern "C" fn keep_alive(_timer: CFRunLoopTimerRef, _info: *mut c_void) {}

pub fn run_loop() -> ! {
    unsafe {
        // A run loop with no sources returns immediately; this timer keeps it alive while
        // permission is missing and the tap does not exist yet.
        let day = 24.0 * 60.0 * 60.0;
        let timer = CFRunLoopTimerCreate(
            kCFAllocatorDefault,
            CFAbsoluteTimeGetCurrent() + day,
            day,
            0,
            0,
            keep_alive,
            ptr::null_mut(),
        );
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), timer, kCFRunLoopCommonModes);
        loop {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, day, 0);
        }
    }
}

pub fn probe() -> Probe {
    // NSWorkspace only reflects the current frontmost app once the run loop has spun.
    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0) };
    let accessibility = ax_trusted();
    Probe {
        frontmost: frontmost_bundle_id().unwrap_or_default(),
        text_input_focused: accessibility && text_input_focused().unwrap_or(false),
        accessibility,
        paths: if accessibility && frontmost_bundle_id().is_some_and(|id| is_supported_app(&id)) {
            selected_file_urls().map(|s| resolve_files(&s.urls))
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ax_messages_share_one_deadline_and_last_message_gets_remaining_time() {
        let start = Instant::now();
        let deadline = start + Duration::from_millis(20);
        assert_eq!(message_timeout(deadline, start), Some(0.008));
        assert_eq!(
            message_timeout(deadline, start + Duration::from_millis(8)),
            Some(0.008)
        );
        assert_eq!(
            message_timeout(deadline, start + Duration::from_millis(16)),
            Some(0.004)
        );
        assert_eq!(message_timeout(deadline, deadline), None);
        assert_eq!(
            message_timeout(deadline, deadline + Duration::from_millis(1)),
            None
        );
    }

    #[test]
    fn supported_apps() {
        assert!(is_supported_app("com.apple.finder"));
        assert!(!is_supported_app("com.apple.Safari"));
        assert!(!is_supported_app(""));
    }

    #[test]
    fn markdown_paths() {
        for p in [
            "/a/b.md",
            "/a/b.MD",
            "/a/b.markdown",
            "/a/b.mdx",
            "/a.b/c.mkd",
        ] {
            assert!(is_markdown_path(p), "{p}");
        }
        for p in ["/a/b.txt", "/a/md", "/a/b.md.bak", "/a/b", ""] {
            assert!(!is_markdown_path(p), "{p}");
        }
    }

    #[test]
    fn resolves_file_references_with_reserved_characters_and_rejects_directories() {
        use core_foundation_sys::url::CFURLCreateFileReferenceURL;
        let dir = std::env::temp_dir().join(format!("simple-md-native-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("note #日本語.md");
        let folder = dir.join("folder.md");
        std::fs::write(&note, "# Test").unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        let url = CFURL::from_path(&note, false).unwrap();
        let reference = unsafe {
            let raw = CFURLCreateFileReferenceURL(
                kCFAllocatorDefault,
                url.as_concrete_TypeRef(),
                ptr::null_mut(),
            );
            assert!(!raw.is_null());
            CFURL::wrap_under_create_rule(raw)
        };
        let paths = resolve_files(&[
            reference.get_string().to_string(),
            CFURL::from_path(&folder, true)
                .unwrap()
                .get_string()
                .to_string(),
            "https://example.com/file.md".into(),
            "file:///this-file-does-not-exist.md".into(),
        ]);
        assert_eq!(
            paths,
            vec![std::fs::canonicalize(note).unwrap().to_str().unwrap()]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn text_input_roles() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
            assert!(is_text_input_role(role, None), "{role}");
        }
        assert!(is_text_input_role("AXGroup", Some("AXSearchField")));
        assert!(!is_text_input_role("AXList", None));
        assert!(!is_text_input_role("AXOutline", Some("AXOutlineRow")));
        assert!(!is_text_input_role("AXStaticText", None));
    }

    #[test]
    fn plain_space_filtering() {
        assert!(is_plain_space(49, 0, false));
        // Caps lock (0x10000) and fn (0x800000) do not make Space a shortcut.
        assert!(is_plain_space(49, 0x0001_0000 | 0x0080_0000, false));
        assert!(!is_plain_space(49, FLAG_COMMAND, false));
        assert!(!is_plain_space(49, FLAG_CONTROL, false));
        assert!(!is_plain_space(49, FLAG_OPTION, false));
        assert!(!is_plain_space(49, FLAG_SHIFT, false));
        assert!(!is_plain_space(49, 0, true));
        assert!(!is_plain_space(36, 0, false));
    }
}
