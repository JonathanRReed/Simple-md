//! Windows backend: a WH_KEYBOARD_LL hook on a dedicated message-loop thread.
//!
//! Low-level hooks are called synchronously from the input thread and are silently removed
//! by the system if they exceed the hook timeout, so the callback only does window-class
//! lookups and never blocks on I/O (events go through a channel).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Instant;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_KEYUP, SendInput, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GUITHREADINFO, GetClassNameW, GetForegroundWindow,
    GetGUIThreadInfo, GetMessageW, GetWindowThreadProcessId, HC_ACTION, KBDLLHOOKSTRUCT, MSG,
    SetWindowsHookExW, TranslateMessage, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

use super::pending::PendingPeek;
use super::{Backend, Outbox};
use crate::protocol::{Event, PermissionState, Probe};

/// Window classes of Explorer folder windows and the desktop.
const SUPPORTED_CLASSES: &[&str] = &["CabinetWClass", "ExploreWClass", "Progman", "WorkerW"];

/// Reported as the `app` of a peek event.
const APP_NAME: &str = "explorer.exe";

/// Exact focus-window classes in which Space is a typed character.
const TEXT_INPUT_CLASSES: &[&str] = &["Edit", "SearchEditBoxWrapperClass", "ComboBox"];
/// Prefixes for the same purpose. The XAML bridge classes host Windows 11 Explorer's
/// search box and cannot be inspected from here, so they are treated as text input.
const TEXT_INPUT_CLASS_PREFIXES: &[&str] = &[
    "RichEdit",
    "Microsoft.UI.Content.",
    "Windows.UI.Composition.",
    "Windows.UI.Core.",
];

/// Written to dwExtraInfo on injected events so the hook lets them through.
const REPLAY_TAG: usize = 0x534D_4450;

static ENABLED: AtomicBool = AtomicBool::new(true);
static SPACE_DOWN: AtomicBool = AtomicBool::new(false);
static SWALLOWING: AtomicBool = AtomicBool::new(false);
static OUT: OnceLock<Outbox> = OnceLock::new();
static PENDING: Mutex<PendingPeek<isize>> = Mutex::new(PendingPeek::new());

fn emit(event: Event) {
    if let Some(out) = OUT.get() {
        let _ = out.send(Some(event));
    }
}

fn is_supported_class(class: &str) -> bool {
    SUPPORTED_CLASSES.contains(&class)
}

fn is_text_input_class(class: &str) -> bool {
    TEXT_INPUT_CLASSES.contains(&class)
        || TEXT_INPUT_CLASS_PREFIXES
            .iter()
            .any(|prefix| class.starts_with(prefix))
}

fn class_name(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    (len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

fn key_held(vk: u16) -> bool {
    let state = unsafe { GetAsyncKeyState(i32::from(vk)) } as u16;
    state & 0x8000 != 0
}

fn modifiers_held() -> bool {
    [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
        .iter()
        .any(|vk| key_held(vk.0))
}

/// `None` means the query failed; callers must treat that as "do not swallow".
fn text_input_focused() -> Option<bool> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            return None;
        }
        let thread_id = GetWindowThreadProcessId(foreground, None);
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(thread_id, &mut info).ok()?;
        if info.hwndFocus.is_invalid() {
            return Some(false);
        }
        Some(is_text_input_class(&class_name(info.hwndFocus)?))
    }
}

fn foreground_class() -> Option<String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        None
    } else {
        class_name(hwnd)
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && should_swallow(wparam, lparam) {
        return LRESULT(1);
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn should_swallow(wparam: WPARAM, lparam: LPARAM) -> bool {
    let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
    if key.vkCode != u32::from(VK_SPACE.0) || key.dwExtraInfo == REPLAY_TAG {
        return false;
    }

    match wparam.0 as u32 {
        WM_KEYUP | WM_SYSKEYUP => {
            SPACE_DOWN.store(false, Ordering::Release);
            SWALLOWING.swap(false, Ordering::AcqRel)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            // The low-level hook has no auto-repeat flag, so repeats are inferred from state.
            if SPACE_DOWN.swap(true, Ordering::AcqRel) {
                return SWALLOWING.load(Ordering::Acquire);
            }
            SWALLOWING.store(false, Ordering::Release);

            if !ENABLED.load(Ordering::Acquire) || modifiers_held() {
                return false;
            }
            let foreground = unsafe { GetForegroundWindow() };
            if !class_name(foreground).is_some_and(|c| is_supported_class(&c)) {
                return false;
            }
            // Fail open: only an explicit "not a text input" answer lets us take the key.
            if text_input_focused() != Some(false) || unsafe { GetForegroundWindow() } != foreground
            {
                return false;
            }
            let origin = foreground.0 as isize;
            let Some(request_id) = PENDING
                .try_lock()
                .ok()
                .and_then(|mut p| p.begin(Instant::now(), origin))
            else {
                return false;
            };
            SWALLOWING.store(true, Ordering::Release);
            emit(Event::Peek {
                request_id,
                origin: Some(origin.to_string()),
                app: APP_NAME.into(),
                paths: Vec::new(),
            });
            true
        }
        _ => false,
    }
}

fn run_hook_thread() {
    unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(e) => return emit(Event::error(format!("GetModuleHandleW failed: {e}"))),
        };
        if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), Some(module.into()), 0) {
            return emit(Event::error(format!(
                "could not install keyboard hook: {e}"
            )));
        }
        // The hook is only called while this thread pumps messages.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

struct WindowsBackend;

impl Backend for WindowsBackend {
    fn replay_space(&self, request_id: u64) {
        let origin = PENDING
            .lock()
            .ok()
            .and_then(|mut p| p.take(Instant::now(), request_id));
        if origin != Some(unsafe { GetForegroundWindow() }.0 as isize)
            || text_input_focused() != Some(false)
        {
            return;
        }
        let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SPACE,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: REPLAY_TAG,
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            emit(Event::error("SendInput did not deliver the replayed Space"));
        }
    }

    fn validate_peek(&self, request_id: u64) -> bool {
        let origin = PENDING
            .lock()
            .ok()
            .and_then(|p| p.context(Instant::now(), request_id).copied());
        origin == Some(unsafe { GetForegroundWindow() }.0 as isize)
            && text_input_focused() == Some(false)
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
    let experimental = std::env::args().any(|arg| arg == "--experimental-space");
    emit(Event::Ready {
        platform: "windows",
        permission: if experimental {
            PermissionState::Granted
        } else {
            PermissionState::Unsupported
        },
    });
    if experimental {
        thread::spawn(run_hook_thread);
    }
    Arc::new(WindowsBackend)
}

pub fn run_loop() -> ! {
    loop {
        thread::park();
    }
}

pub fn probe() -> Probe {
    Probe {
        frontmost: foreground_class().unwrap_or_default(),
        text_input_focused: text_input_focused().unwrap_or(false),
        accessibility: true,
        paths: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_classes() {
        assert!(is_supported_class("CabinetWClass"));
        assert!(is_supported_class("Progman"));
        assert!(!is_supported_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn text_input_classes() {
        assert!(is_text_input_class("Edit"));
        assert!(is_text_input_class("RichEdit20W"));
        assert!(is_text_input_class("SearchEditBoxWrapperClass"));
        assert!(is_text_input_class(
            "Microsoft.UI.Content.DesktopChildSiteBridge"
        ));
        assert!(!is_text_input_class("SysListView32"));
        assert!(!is_text_input_class("DirectUIHWND"));
    }
}
