#![allow(non_snake_case)] // COM method and export names are part of the ABI.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    ptr::null_mut,
    rc::{Rc, Weak},
    sync::atomic::{AtomicUsize, Ordering},
};

use webview2_com::{
    AcceleratorKeyPressedEventHandler, ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, ProcessFailedEventHandler,
    WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
            TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel,
        },
        System::{
            Com::*,
            Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl},
            SystemInformation::GetSystemTime,
            Threading::{
                GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{GetFocus, SetFocus},
            Shell::{
                DefSubclassProc, FOLDERID_LocalAppDataLow, IPreviewHandler, IPreviewHandler_Impl,
                IPreviewHandlerFrame, KF_FLAG_DEFAULT, PropertiesSystem::*, RemoveWindowSubclass,
                SHGetKnownFolderPath, SetWindowSubclass,
            },
            WindowsAndMessaging::*,
        },
    },
    core::{
        BOOL, Error, GUID, HRESULT, HSTRING, IUnknown, Interface, PCWSTR, PWSTR, Ref, Result,
        implement, w,
    },
};
use windows_core::IUnknownImpl;

use crate::content::{
    Generation, HTML_LIMIT, INPUT_LIMIT, Input, can_render, fallback_text, read_bounded,
    render_script,
};

const RENDER_CORE: &str = include_str!("../render-core.js");

// Keep this in sync with install.ps1 and uninstall.ps1.
const CLSID_PREVIEW: GUID = GUID::from_u128(0xa8b4f9c2_6e75_4eaa_9a1d_e4276f01d937);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static LOCKS: AtomicUsize = AtomicUsize::new(0);
static NEXT_ID: AtomicUsize = AtomicUsize::new(1);

// Factories, handlers, startup callbacks and event callbacks all hold a lease.
// In particular, Unload must not let COM unload code still awaiting a callback.
struct ModuleLease;
impl ModuleLease {
    fn new() -> Self {
        LIVE.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for ModuleLease {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

fn low_root() -> Result<PathBuf> {
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_LocalAppDataLow, KF_FLAG_DEFAULT, None)?;
        let root = path.to_string();
        CoTaskMemFree(Some(path.0.cast()));
        Ok(PathBuf::from(root?).join("SimpleMD").join("Preview"))
    }
}

fn log(message: &str) {
    // A failed logger must never panic across a COM boundary. Install creates and
    // inherits the LocalLow label for this directory; do not fall back to a medium-integrity location.
    let Ok(root) = low_root() else { return };
    let path = root.join("preview.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() >= 1024 * 1024) {
        // An append-only Windows handle cannot truncate. Use a separate writable
        // handle, then reopen for atomic append by concurrent preview hosts.
        if let Ok(file) = OpenOptions::new().write(true).open(&path) {
            let _ = file.set_len(0);
        }
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let t = unsafe { GetSystemTime() };
        let line = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z pid={} tid={} {message}\n",
            t.wYear,
            t.wMonth,
            t.wDay,
            t.wHour,
            t.wMinute,
            t.wSecond,
            t.wMilliseconds,
            std::process::id(),
            unsafe { GetCurrentThreadId() }
        );
        let _ = file.write_all(line.as_bytes());
    }
}

fn record<T>(step: &str, result: Result<T>) -> Result<T> {
    if let Err(error) = &result
        && error.code().is_err()
    {
        log(&format!(
            "{step} HRESULT=0x{:08X} {error}",
            error.code().0 as u32
        ));
    }
    result
}

fn cleanup(path: &Path) {
    match fs::remove_dir_all(path) {
        Ok(()) => log(&format!("User data removed: {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log(&format!(
            "User data cleanup deferred: {}: {e}",
            path.display()
        )),
    }
}

fn log_integrity() -> Result<()> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let result = (|| {
            let mut size = 0;
            // The first call asks only for the required buffer length.
            let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut size);
            if size == 0 {
                return Err(Error::from_thread());
            }
            let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buffer.as_mut_ptr().cast()),
                size,
                &mut size,
            )?;
            let label = &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
            let count = *GetSidSubAuthorityCount(label.Label.Sid);
            if count == 0 {
                return Err(E_UNEXPECTED.into());
            }
            let rid = *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1));
            log(&format!(
                "Process integrity RID=0x{rid:04X}; low=0x1000 medium=0x2000"
            ));
            Ok(())
        })();
        let _ = record("Close token", CloseHandle(token));
        result
    }
}

// Each STA caches its COM environment and an empty, hidden WebView. The empty
// controller keeps the shared browser alive between selections in this process.
// A lease pins the DLL until the host STA exits, including its window procedure.
#[derive(Default)]
struct Host {
    environment: Option<ICoreWebView2Environment>,
    keeper: Option<ICoreWebView2Controller>,
    window: HWND,
    waiting: Vec<(Weak<State>, u64)>,
    _lease: Option<ModuleLease>,
}
impl Drop for Host {
    fn drop(&mut self) {
        if let Some(controller) = self.keeper.take() {
            let _ = unsafe { controller.Close() };
        }
        self.environment.take();
        if !self.window.is_invalid() {
            let _ = unsafe { DestroyWindow(self.window) };
        }
    }
}
thread_local! { static HOST: RefCell<Option<Host>> = const { RefCell::new(None) }; }

fn user_data() -> Result<PathBuf> {
    let root = low_root()?.join("UserData");
    fs::create_dir_all(&root).map_err(|e| Error::new(E_FAIL, e.to_string()))?;
    // Older builds used PID-handler-generation directories. Never remove a live
    // PID's data, including access-denied PIDs. Rust removes directory links as links.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.split('-').next())
                .and_then(|pid| pid.parse::<u32>().ok())
                && pid != 0
                && pid != std::process::id()
            {
                let dead = unsafe {
                    match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                        Ok(process) => {
                            let mut code = 259;
                            let dead = windows::Win32::System::Threading::GetExitCodeProcess(
                                process, &mut code,
                            )
                            .is_ok()
                                && code != 259;
                            let _ = CloseHandle(process);
                            dead
                        }
                        Err(error) => {
                            error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0)
                        }
                    }
                };
                if dead {
                    cleanup(&entry.path());
                }
            }
        }
    }
    let path = root.join(std::process::id().to_string());
    fs::create_dir_all(&path).map_err(|e| Error::new(E_FAIL, e.to_string()))?;
    Ok(path)
}

fn host_start(state: &Rc<State>, generation: u64) -> Result<()> {
    let environment = HOST.with(|host| {
        host.borrow()
            .as_ref()
            .filter(|host| host.keeper.is_some())
            .and_then(|host| host.environment.clone())
    });
    if let Some(environment) = environment {
        state.create_controller(generation, &environment);
        return Ok(());
    }
    let starting = HOST.with(|host| {
        let mut host = host.borrow_mut();
        let starting = host.is_some();
        host.get_or_insert_with(Host::default)
            .waiting
            .push((Rc::downgrade(state), generation));
        starting
    });
    if starting {
        return Ok(());
    }
    let result = (|| {
        let data = user_data()?;
        log(&format!("WebView2 host user data: {}", data.display()));
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        }?;
        HOST.with(|host| {
            let mut host = host.borrow_mut();
            let host = host.as_mut().unwrap();
            host.window = window;
            host._lease = Some(ModuleLease::new());
        });
        let callback: ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler = HostStartup {
            _lease: ModuleLease::new(),
        }
        .into();
        // No sandbox flags, browser arguments or nested message pump.
        unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                PCWSTR::null(),
                &HSTRING::from(data.as_os_str()),
                None,
                &callback,
            )
        }
    })();
    if result.is_err() {
        host_ready(false);
    }
    result
}

fn host_ready(success: bool) {
    let (environment, waiting, rejected) = HOST.with(|host| {
        let mut host = host.borrow_mut();
        if success {
            let host = host.as_mut().unwrap();
            (
                host.environment.clone(),
                std::mem::take(&mut host.waiting),
                None,
            )
        } else {
            let mut rejected = host.take().unwrap_or_default();
            (None, std::mem::take(&mut rejected.waiting), Some(rejected))
        }
    });
    drop(rejected);
    for (state, generation) in waiting {
        if let Some(state) = state.upgrade().filter(|s| s.current(generation)) {
            if let Some(environment) = &environment {
                state.create_controller(generation, environment);
            } else {
                state.fallback(generation, "WebView2 host startup failed");
            }
        }
    }
}

#[implement(
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
    ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
    Agile = false
)]
struct HostStartup {
    _lease: ModuleLease,
}
impl ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_Impl for HostStartup_Impl {
    fn Invoke(&self, hr: HRESULT, environment: Ref<ICoreWebView2Environment>) -> Result<()> {
        let result = (|| {
            hr.ok()?;
            let environment = environment.as_ref().ok_or_else(|| Error::from(E_POINTER))?;
            let window = HOST.with(|host| {
                let mut host = host.borrow_mut();
                let host = host.as_mut().unwrap();
                host.environment = Some(environment.clone());
                host.window
            });
            let mut version = PWSTR::null();
            unsafe {
                environment.BrowserVersionString(&mut version)?;
                log(&format!(
                    "WebView2 runtime: {}",
                    version.to_string().unwrap_or_default()
                ));
                CoTaskMemFree(Some(version.0.cast()));
                environment.CreateCoreWebView2Controller(
                    window,
                    &self
                        .to_interface::<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        ),
                )
            }
        })();
        if record("Host environment", result).is_err() {
            host_ready(false);
        }
        Ok(())
    }
}
impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_Impl for HostStartup_Impl {
    fn Invoke(&self, hr: HRESULT, controller: Ref<ICoreWebView2Controller>) -> Result<()> {
        let result = (|| {
            hr.ok()?;
            let controller = controller.as_ref().ok_or_else(|| Error::from(E_POINTER))?;
            // This empty control never receives author content or focus.
            unsafe {
                controller.SetIsVisible(false)?;
                let settings = controller.CoreWebView2()?.Settings()?;
                settings.SetIsScriptEnabled(false)?;
                settings.SetIsWebMessageEnabled(false)?;
                settings.SetAreHostObjectsAllowed(false)?;
                settings.SetAreDevToolsEnabled(false)?;
                settings
                    .cast::<ICoreWebView2Settings3>()?
                    .SetAreBrowserAcceleratorKeysEnabled(false)?;
            }
            HOST.with(|host| host.borrow_mut().as_mut().unwrap().keeper = Some(controller.clone()));
            Ok(())
        })();
        let success = record("Host browser", result).is_ok();
        if !success && let Some(controller) = controller.as_ref() {
            let _ = unsafe { controller.Close() };
        }
        host_ready(success);
        Ok(())
    }
}

struct Container {
    state: Weak<State>,
    _lease: ModuleLease,
}
unsafe extern "system" fn container_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    let context = unsafe { &*(data as *const Container) };
    if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(container_proc), id) };
        let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        unsafe {
            drop(Box::from_raw(data as *mut Container));
        }
        return result;
    }
    if message == WM_TIMER {
        preview_timer(wparam.0);
        return LRESULT(0);
    }
    if matches!(message, WM_SIZE | WM_DPICHANGED | WM_DPICHANGED_AFTERPARENT)
        && let Some(state) = context.state.upgrade()
    {
        let _ = record("Preview layout", layout(&state));
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn layout(state: &State) -> Result<()> {
    let (child, source, controller, dpi) = {
        let r = state.resources.borrow();
        (r.child, r.source, r.controller.clone(), r.dpi)
    };
    if child.is_invalid() {
        return Ok(());
    }
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(child, &mut rect)?;
        SetWindowPos(
            source,
            None,
            0,
            0,
            rect.right,
            rect.bottom,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )?;
        let current_dpi = GetDpiForWindow(child).max(96);
        if current_dpi != dpi {
            // The font mapper substitutes a modern fixed-pitch system face when
            // Consolas is unavailable. A positive FIXED_PITCH requests monospace.
            let font = CreateFontW(
                -(((11 * current_dpi + 36) / 72) as i32),
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                (FIXED_PITCH.0 | FF_MODERN.0) as u32,
                w!("Consolas"),
            );
            if font.is_invalid() {
                return Err(E_FAIL.into());
            }
            let old = {
                let mut r = state.resources.borrow_mut();
                r.dpi = current_dpi;
                std::mem::replace(&mut r.font, font)
            };
            SendMessageW(
                source,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            );
            if !old.is_invalid() {
                let _ = DeleteObject(old.into());
            }
        }
        if let Some(controller) = controller {
            controller.SetBounds(rect)?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct Resources {
    input: Option<Input>,
    site: Option<IUnknown>,
    frame: Option<IPreviewHandlerFrame>,
    child: HWND,
    source: HWND,
    font: HFONT,
    dpi: u32,
    controller: Option<ICoreWebView2Controller>,
    timer: usize,
    rendered: bool,
    expected_navigation: bool,
    started: bool,
}
impl Resources {
    fn release(mut self) {
        // No RefCell borrow is held across Close, Release or DestroyWindow.
        cancel_timer(self.timer);
        if let Some(controller) = self.controller.take() {
            let _ = record("Controller.Close", unsafe { controller.Close() });
        }
        if !self.source.is_invalid() {
            unsafe {
                SendMessageW(self.source, WM_SETFONT, None, None);
            }
        }
        if !self.child.is_invalid() {
            let _ = record("DestroyWindow", unsafe { DestroyWindow(self.child) });
        }
        if !self.font.is_invalid() {
            let _ = record("Delete preview font", unsafe {
                DeleteObject(self.font.into()).ok()
            });
        }
        // All COM references, including the input stream and site, drop here.
    }
}

struct State {
    owner: u32,
    id: usize,
    generation: Generation,
    resources: RefCell<Resources>,
}
impl State {
    fn check_thread(&self, step: &str) -> Result<()> {
        record(
            step,
            if unsafe { GetCurrentThreadId() } == self.owner {
                Ok(())
            } else {
                Err(RPC_E_WRONG_THREAD.into())
            },
        )
    }

    fn current(&self, generation: u64) -> bool {
        self.generation.current(generation)
    }

    fn unload(&self) {
        self.generation.cancel();
        let old = std::mem::take(&mut *self.resources.borrow_mut());
        old.release();
        log(&format!(
            "handler={} Unload complete generation={}",
            self.id,
            self.generation.get()
        ));
    }
}

#[derive(Clone, Copy)]
enum PendingWork {
    Start,
    Deadline,
}

struct Pending {
    work: PendingWork,
    child: HWND,
    state: Weak<State>,
    generation: u64,
    _lease: ModuleLease,
}
thread_local! { static TIMERS: RefCell<HashMap<usize, Pending>> = RefCell::new(HashMap::new()); }
fn cancel_timer(timer: usize) {
    let pending = TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    if let Some(pending) = pending {
        let _ = unsafe { KillTimer(Some(pending.child), timer) };
    }
}
fn schedule(state: &Rc<State>, generation: u64, work: PendingWork, delay: u32) -> bool {
    let child = state.resources.borrow().child;
    let timer = unsafe {
        SetTimer(
            Some(child),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
            delay,
            None,
        )
    };
    if timer == 0 {
        return false;
    }
    TIMERS.with(|timers| {
        timers.borrow_mut().insert(
            timer,
            Pending {
                child,
                state: Rc::downgrade(state),
                generation,
                work,
                _lease: ModuleLease::new(),
            },
        )
    });
    state.resources.borrow_mut().timer = timer;
    true
}
fn preview_timer(timer: usize) {
    let pending = TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    if let Some(pending) = pending {
        let _ = unsafe { KillTimer(Some(pending.child), timer) };
        if let Some(state) = pending
            .state
            .upgrade()
            .filter(|state| state.current(pending.generation))
        {
            state.resources.borrow_mut().timer = 0;
            match pending.work {
                PendingWork::Start => {
                    if schedule(&state, pending.generation, PendingWork::Deadline, 15_000) {
                        state.start(pending.generation);
                    } else {
                        state.fallback(pending.generation, "Cannot create startup deadline");
                    }
                }
                PendingWork::Deadline => state.fallback(
                    pending.generation,
                    "WebView2 startup/render deadline exceeded",
                ),
            }
        }
    }
}
impl State {
    fn start(self: &Rc<Self>, generation: u64) {
        let result = host_start(self, generation);
        if let Err(error) = result {
            self.fallback(generation, &format!("Environment startup: {error}"));
        }
    }

    fn create_controller(self: &Rc<Self>, generation: u64, environment: &ICoreWebView2Environment) {
        if !self.current(generation) {
            return;
        }
        let child = self.resources.borrow().child;
        let callback: ICoreWebView2CreateCoreWebView2ControllerCompletedHandler = Startup {
            state: Rc::downgrade(self),
            generation,
            _lease: ModuleLease::new(),
        }
        .into();
        if let Err(error) = record("Create controller", unsafe {
            environment.CreateCoreWebView2Controller(child, &callback)
        }) {
            self.fallback(generation, &format!("Create controller: {error}"));
        }
    }

    fn fallback(&self, generation: u64, reason: &str) {
        if !self.current(generation) {
            return;
        }
        log(&format!("Native fallback: {reason}"));
        // Cancel all outstanding startup/render callbacks but retain the source control.
        self.generation.cancel();
        let (controller, source, timer) = {
            let mut r = self.resources.borrow_mut();
            (r.controller.take(), r.source, std::mem::take(&mut r.timer))
        };
        cancel_timer(timer);
        if let Some(controller) = controller {
            let _ = record("Fallback Close", unsafe { controller.Close() });
        }
        let _ = unsafe { ShowWindow(source, SW_SHOWNA) };
    }
}

#[implement(
    IPreviewHandler,
    IInitializeWithStream,
    IObjectWithSite,
    IOleWindow,
    Agile = false
)]
struct Preview {
    state: Rc<State>,
    _lease: ModuleLease,
}
impl Drop for Preview {
    fn drop(&mut self) {
        log("Handler released");
        self.state.unload();
    }
}

impl IInitializeWithStream_Impl for Preview_Impl {
    fn Initialize(&self, stream: Ref<IStream>, mode: u32) -> Result<()> {
        self.state.check_thread("Initialize")?;
        record(
            "Initialize",
            (|| {
                if self.state.resources.borrow().input.is_some() {
                    return Err(HRESULT(0x800704DFu32 as i32).into()); // ERROR_ALREADY_INITIALIZED
                }
                let stream = stream.cloned().ok_or_else(|| Error::from(E_POINTER))?;
                let generation = self.state.generation.get();
                let input = read_bounded(|chunk| {
                    let mut read = 0;
                    record("IStream.Read", unsafe {
                        stream
                            .Read(
                                chunk.as_mut_ptr().cast(),
                                chunk.len() as u32,
                                Some(&mut read),
                            )
                            .ok()
                    })
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                    Ok(read as usize)
                })
                .map_err(|e| Error::new(E_FAIL, e.to_string()))?;
                if !self.state.current(generation) {
                    return Err(E_ABORT.into());
                }
                let mut r = self.state.resources.borrow_mut();
                r.input = Some(input);
                drop(r);
                log(&format!(
                    "Initialize mode=0x{mode:08X}, read limit={INPUT_LIMIT}"
                ));
                Ok(())
            })(),
        )
    }
}

impl IObjectWithSite_Impl for Preview_Impl {
    fn SetSite(&self, site: Ref<IUnknown>) -> Result<()> {
        self.state.check_thread("SetSite")?;
        let site = site.cloned();
        let frame = site
            .as_ref()
            .and_then(|s| record("Query IPreviewHandlerFrame", s.cast()).ok());
        // Release previous foreign objects after the borrow ends.
        let old = {
            let mut r = self.state.resources.borrow_mut();
            (
                std::mem::replace(&mut r.site, site),
                std::mem::replace(&mut r.frame, frame),
            )
        };
        drop(old);
        Ok(())
    }

    fn GetSite(&self, iid: *const GUID, out: *mut *mut c_void) -> Result<()> {
        self.state.check_thread("GetSite")?;
        record(
            "GetSite",
            (|| {
                if out.is_null() {
                    return Err(E_POINTER.into());
                }
                unsafe {
                    *out = null_mut();
                }
                if iid.is_null() {
                    return Err(E_POINTER.into());
                }
                let site = self
                    .state
                    .resources
                    .borrow()
                    .site
                    .clone()
                    .ok_or_else(|| Error::from(E_FAIL))?;
                unsafe { site.query(iid, out).ok() }
            })(),
        )
    }
}

fn rect_from_ptr(rect: *const RECT) -> Result<RECT> {
    if rect.is_null() {
        return Err(E_POINTER.into());
    }
    let rect = unsafe { *rect };
    if rect.right.checked_sub(rect.left).is_none_or(|v| v < 0)
        || rect.bottom.checked_sub(rect.top).is_none_or(|v| v < 0)
    {
        return Err(E_INVALIDARG.into());
    }
    Ok(rect)
}

impl Preview_Impl {
    fn resize(&self, rect: RECT) -> Result<()> {
        let child = {
            let r = self.state.resources.borrow();
            r.child
        };
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if !child.is_invalid() {
            record("SetWindowPos", unsafe {
                SetWindowPos(
                    child,
                    None,
                    rect.left,
                    rect.top,
                    width,
                    height,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                )
            })?;
        }
        layout(&self.state)?;
        Ok(())
    }
}

impl IPreviewHandler_Impl for Preview_Impl {
    fn SetWindow(&self, parent: HWND, rect: *const RECT) -> Result<()> {
        self.state.check_thread("SetWindow")?;
        record(
            "SetWindow",
            (|| {
                let rect = rect_from_ptr(rect)?;
                if parent.is_invalid() {
                    return Err(E_INVALIDARG.into());
                }
                let generation = self.state.generation.get();
                let child = self.state.resources.borrow().child;
                if child.is_invalid() {
                    let child = unsafe {
                        CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("STATIC"),
                            w!(""),
                            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                            rect.left,
                            rect.top,
                            rect.right - rect.left,
                            rect.bottom - rect.top,
                            Some(parent),
                            None,
                            None,
                            None,
                        )
                    }?;
                    let source = match unsafe {
                        CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("EDIT"),
                            w!(""),
                            WS_CHILD
                                | WS_VISIBLE
                                | WS_VSCROLL
                                | WS_HSCROLL
                                | WINDOW_STYLE(
                                    (ES_MULTILINE | ES_READONLY | ES_AUTOHSCROLL | ES_AUTOVSCROLL)
                                        as u32,
                                ),
                            0,
                            0,
                            0,
                            0,
                            Some(child),
                            None,
                            None,
                            None,
                        )
                    } {
                        Ok(source) => source,
                        Err(error) => {
                            let _ = unsafe { DestroyWindow(child) };
                            return Err(error);
                        }
                    };
                    if !self.state.current(generation) {
                        let _ = unsafe { DestroyWindow(child) };
                        return Err(E_ABORT.into());
                    }
                    let context = Box::new(Container {
                        state: Rc::downgrade(&self.state),
                        _lease: ModuleLease::new(),
                    });
                    let context = Box::into_raw(context);
                    if !unsafe {
                        SetWindowSubclass(child, Some(container_proc), 1, context as usize)
                    }
                    .as_bool()
                    {
                        unsafe {
                            drop(Box::from_raw(context));
                            let _ = DestroyWindow(child);
                        }
                        return Err(E_FAIL.into());
                    }
                    let mut r = self.state.resources.borrow_mut();
                    r.child = child;
                    r.source = source;
                } else {
                    unsafe { SetParent(child, Some(parent)) }?;
                }
                self.resize(rect)
            })(),
        )
    }

    fn SetRect(&self, rect: *const RECT) -> Result<()> {
        self.state.check_thread("SetRect")?;
        record(
            "SetRect",
            rect_from_ptr(rect).and_then(|rect| self.resize(rect)),
        )
    }

    fn DoPreview(&self) -> Result<()> {
        self.state.check_thread("DoPreview")?;
        record(
            "DoPreview",
            (|| {
                let generation = self.state.generation.get();
                {
                    let r = self.state.resources.borrow();
                    if r.started || r.child.is_invalid() || r.input.is_none() {
                        return Err(E_UNEXPECTED.into());
                    }
                }
                let source = self.state.resources.borrow().source;
                let text = fallback_text(self.state.resources.borrow().input.as_ref().unwrap());
                record("Set fallback text", unsafe {
                    SetWindowTextW(source, &HSTRING::from(text))
                })?;
                if !self.state.current(generation) {
                    return Err(E_ABORT.into());
                }
                self.state.resources.borrow_mut().started = true;
                if !can_render(self.state.resources.borrow().input.as_ref().unwrap()) {
                    self.state
                        .fallback(generation, "Input exceeds static preview size limit");
                    return Ok(());
                }
                log("Native source visible while WebView2 starts");
                // Return before loading WebView2 or touching its profile. The private
                // timer dispatches that work on this STA after the host resumes its loop.
                if !schedule(&self.state, generation, PendingWork::Start, 1) {
                    self.state
                        .fallback(generation, "Cannot defer WebView2 startup");
                }
                Ok(())
            })(),
        )
    }

    fn Unload(&self) -> Result<()> {
        self.state.check_thread("Unload")?;
        self.state.unload();
        Ok(())
    }

    fn SetFocus(&self) -> Result<()> {
        self.state.check_thread("SetFocus")?;
        let controller = {
            let r = self.state.resources.borrow();
            r.controller.clone().filter(|_| r.rendered && r.timer == 0)
        };
        record(
            "SetFocus",
            if let Some(controller) = controller {
                unsafe { controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }
            } else {
                let source = self.state.resources.borrow().source;
                unsafe { SetFocus(Some(source)) }.map(|_| ())
            },
        )
    }

    fn QueryFocus(&self) -> Result<HWND> {
        self.state.check_thread("QueryFocus")?;
        let focus = unsafe { GetFocus() };
        record(
            "QueryFocus",
            if focus.is_invalid() {
                Err(E_FAIL.into())
            } else {
                Ok(focus)
            },
        )
    }

    fn TranslateAccelerator(&self, msg: *const MSG) -> Result<()> {
        self.state.check_thread("TranslateAccelerator")?;
        if msg.is_null() {
            return record("TranslateAccelerator", Err(E_POINTER.into()));
        }
        let frame = self.state.resources.borrow().frame.clone();
        let hr = if let Some(frame) = frame {
            // Preserve S_FALSE. The generated Result wrapper would turn it into S_OK.
            unsafe { (frame.vtable().TranslateAccelerator)(frame.as_raw(), msg) }
        } else {
            S_FALSE
        };
        record(
            "TranslateAccelerator",
            if hr == S_OK {
                Ok(())
            } else {
                Err(Error::from_hresult(hr))
            },
        )
    }
}

impl IOleWindow_Impl for Preview_Impl {
    fn GetWindow(&self) -> Result<HWND> {
        self.state.check_thread("GetWindow")?;
        let child = self.state.resources.borrow().child;
        record(
            "GetWindow",
            if child.is_invalid() {
                Err(E_FAIL.into())
            } else {
                Ok(child)
            },
        )
    }
    fn ContextSensitiveHelp(&self, _: BOOL) -> Result<()> {
        self.state.check_thread("ContextSensitiveHelp")?;
        record("ContextSensitiveHelp", Err(E_NOTIMPL.into()))
    }
}

#[implement(
    ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
    Agile = false
)]
struct Startup {
    state: Weak<State>,
    generation: u64,
    _lease: ModuleLease,
}
impl Startup_Impl {
    fn current(&self, step: &str) -> Result<Option<Rc<State>>> {
        let Some(state) = self.state.upgrade() else {
            log("Startup callback after handler release");
            return Ok(None);
        };
        state.check_thread(step)?;
        if !state.current(self.generation) {
            log("Stale startup callback ignored");
            return Ok(None);
        }
        Ok(Some(state))
    }
}
impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_Impl for Startup_Impl {
    fn Invoke(&self, hr: HRESULT, controller: Ref<ICoreWebView2Controller>) -> Result<()> {
        if let Err(error) = record("Controller completed", hr.ok()) {
            if let Some(state) = self.current("Controller failed")? {
                state.fallback(self.generation, &format!("Controller callback: {error}"));
            }
            return Ok(());
        }
        let Some(controller) = controller.as_ref() else {
            if let Some(state) = self.current("Missing controller")? {
                state.fallback(self.generation, "Missing controller");
            }
            return Ok(());
        };
        let Some(state) = self.current("Controller completed")? else {
            let _ = record("Close stale controller", unsafe { controller.Close() });
            return Ok(());
        };
        state.resources.borrow_mut().controller = Some(controller.clone());
        let result = record(
            "Configure WebView2",
            configure(controller, &state, self.generation),
        );
        if result.is_err() || !state.current(self.generation) {
            let _ = record("Close rejected controller", unsafe { controller.Close() });
            state.fallback(self.generation, "Controller configuration failed");
        }
        Ok(())
    }
}

fn configure(
    controller: &ICoreWebView2Controller,
    state: &Rc<State>,
    generation: u64,
) -> Result<()> {
    unsafe {
        let view = controller.CoreWebView2()?;
        let settings = view.Settings()?;
        settings.SetIsScriptEnabled(false)?;
        settings.SetIsWebMessageEnabled(true)?;
        settings.SetAreHostObjectsAllowed(false)?;
        settings.SetAreDevToolsEnabled(false)?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetAreDefaultScriptDialogsEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)?;
        let lease = ModuleLease::new();
        let weak = Rc::downgrade(state);
        let mut accelerator_token = 0;
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let _keep_loaded = &lease;
                let Some(state) = weak.upgrade().filter(|s| s.current(generation)) else {
                    return Ok(());
                };
                let args = args.ok_or_else(|| Error::from(E_POINTER))?;
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                let mut key = 0;
                let mut lparam = 0;
                args.KeyEventKind(&mut kind)?;
                args.VirtualKey(&mut key)?;
                args.KeyEventLParam(&mut lparam)?;
                let frame = state.resources.borrow().frame.clone();
                if let Some(frame) = frame {
                    let message = MSG {
                        hwnd: state.resources.borrow().child,
                        message: match kind {
                            COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN => WM_KEYDOWN,
                            COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP => WM_KEYUP,
                            COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN => WM_SYSKEYDOWN,
                            COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP => WM_SYSKEYUP,
                            _ => return Ok(()),
                        },
                        wParam: WPARAM(key as usize),
                        lParam: LPARAM(lparam as isize),
                        ..Default::default()
                    };
                    let hr = (frame.vtable().TranslateAccelerator)(frame.as_raw(), &message);
                    if hr.is_err() {
                        record("Host accelerator", hr.ok())?;
                    }
                    args.SetHandled(hr == S_OK)?;
                }
                Ok(())
            })),
            &mut accelerator_token,
        )?;
        view.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        let environment = view.cast::<ICoreWebView2_2>()?.Environment()?;
        let blocked_response = environment.CreateWebResourceResponse(
            None,
            403,
            w!("Blocked"),
            w!("Content-Type: text/plain"),
        )?;
        let mut token = 0;
        let lease = ModuleLease::new();
        view.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let _keep_loaded = &lease;
                log("Blocked resource request");
                record(
                    "Block resource",
                    (|| {
                        let args = args.ok_or_else(|| Error::from(E_POINTER))?;
                        // A synthetic response blocks all schemes without contacting a server.
                        args.SetResponse(&blocked_response)
                    })(),
                )
            })),
            &mut token,
        )?;
        let lease = ModuleLease::new();
        let weak = Rc::downgrade(state);
        view.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let _keep_loaded = &lease;
                record(
                    "NavigationStarting",
                    (|| {
                        let args = args.ok_or_else(|| Error::from(E_POINTER))?;
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let text = uri.to_string();
                        CoTaskMemFree(Some(uri.0.cast()));
                        let Some(state) = weak.upgrade().filter(|s| s.current(generation)) else {
                            return args.SetCancel(true);
                        };
                        // NavigateToString may report a synthetic data URI at NavigationStarting.
                        // Only our two explicit host loads may replace the document. Author DOM
                        // does not exist before either load starts, so it cannot race this permit.
                        let expected =
                            std::mem::take(&mut state.resources.borrow_mut().expected_navigation);
                        let text = text?;
                        let blocked = !expected && !text.starts_with("about:blank#");
                        if blocked {
                            log("Navigation blocked");
                        }
                        args.SetCancel(blocked)
                    })(),
                )
            })),
            &mut token,
        )?;
        let lease = ModuleLease::new();
        view.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let _keep_loaded = &lease;
                log("NewWindowRequested blocked");
                record(
                    "Block new window",
                    args.ok_or_else(|| Error::from(E_POINTER))?.SetHandled(true),
                )
            })),
            &mut token,
        )?;
        let lease = ModuleLease::new();
        let weak = Rc::downgrade(state);
        let bootstrap = Cell::new(true);
        view.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |view, args| {
                let _keep_loaded = &lease;
                let Some(state) = weak.upgrade().filter(|s| s.current(generation)) else {
                    return Ok(());
                };
                let result: Result<()> = (|| {
                    let args = args.ok_or_else(|| Error::from(E_POINTER))?;
                    let view = view.ok_or_else(|| Error::from(E_POINTER))?;
                    let mut success = BOOL(0);
                    args.IsSuccess(&mut success)?;
                    if !state.current(generation) {
                        return Ok(());
                    }
                    if !success.as_bool() {
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                        args.WebErrorStatus(&mut status)?;
                        return Err(Error::new(
                            E_FAIL,
                            format!("WebView2 navigation status={}", status.0),
                        ));
                    }
                    if bootstrap.replace(false) {
                        let script = render_script(
                            RENDER_CORE,
                            state
                                .resources
                                .borrow()
                                .input
                                .as_ref()
                                .ok_or_else(|| Error::from(E_ABORT))?,
                        );
                        let weak = Rc::downgrade(&state);
                        let lease = ModuleLease::new();
                        let callback =
                            ExecuteScriptCompletedHandler::create(Box::new(move |hr, _| {
                                let _keep_loaded = &lease;
                                if let Some(state) =
                                    weak.upgrade().filter(|s| s.current(generation))
                                    && let Err(error) = hr
                                {
                                    state
                                        .fallback(generation, &format!("Renderer script: {error}"));
                                }
                                Ok(())
                            }));
                        view.ExecuteScript(&HSTRING::from(script), &callback)?;
                    } else {
                        let (controller, timer) = {
                            let mut r = state.resources.borrow_mut();
                            (r.controller.clone(), std::mem::take(&mut r.timer))
                        };
                        cancel_timer(timer);
                        if let Some(controller) = controller {
                            controller.SetIsVisible(true)?;
                        }
                        let source = state.resources.borrow().source;
                        let _ = ShowWindow(source, SW_HIDE);
                        log("Static preview visible NavigationCompleted success=true");
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    state.fallback(generation, &format!("Navigation/render: {error}"));
                }
                Ok(())
            })),
            &mut token,
        )?;
        let lease = ModuleLease::new();
        let weak = Rc::downgrade(state);
        view.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |view, args| {
                let _keep_loaded = &lease;
                let Some(state) = weak.upgrade().filter(|s| s.current(generation)) else {
                    return Ok(());
                };
                // Only the empty bootstrap document can send a message. No author DOM exists yet.
                if state.resources.borrow().rendered {
                    return Ok(());
                }
                let result: Result<()> = (|| {
                    let args = args.ok_or_else(|| Error::from(E_POINTER))?;
                    let view = view.ok_or_else(|| Error::from(E_POINTER))?;
                    let mut source = PWSTR::null();
                    args.Source(&mut source)?;
                    let origin = source.to_string();
                    CoTaskMemFree(Some(source.0.cast()));
                    if origin? != "about:blank" {
                        return Err(E_ACCESSDENIED.into());
                    }
                    let mut value = PWSTR::null();
                    args.TryGetWebMessageAsString(&mut value)?;
                    let html = value.to_string();
                    CoTaskMemFree(Some(value.0.cast()));
                    let html = html?;
                    // NavigateToString has a 2 MB limit. Oversize results keep native source.
                    if html.is_empty() {
                        return Err(Error::new(E_FAIL, "Static renderer returned no HTML"));
                    }
                    if html.len() > HTML_LIMIT {
                        return Err(Error::new(E_FAIL, "Static HTML exceeds preview size limit"));
                    }
                    view.Settings()?.SetIsWebMessageEnabled(false)?;
                    if !state.current(generation) {
                        return Ok(());
                    }
                    {
                        let mut r = state.resources.borrow_mut();
                        r.rendered = true;
                        r.expected_navigation = true;
                    }
                    view.NavigateToString(&HSTRING::from(html))
                })();
                if let Err(error) = result {
                    state.fallback(generation, &format!("Static output: {error}"));
                }
                Ok(())
            })),
            &mut token,
        )?;
        let lease = ModuleLease::new();
        let weak = Rc::downgrade(state);
        view.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, _| {
                let _keep_loaded = &lease;
                if let Some(state) = weak.upgrade() {
                    state.fallback(generation, "WebView2 process failed");
                }
                Ok(())
            })),
            &mut token,
        )?;
        layout(state)?;
        if !state.current(generation) {
            return Err(E_ABORT.into());
        }
        controller.SetIsVisible(false)?;
        // Host ExecuteScript runs with document scripting disabled. This page has no author DOM.
        state.resources.borrow_mut().expected_navigation = true;
        view.NavigateToString(w!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\">"))?;
        Ok(())
    }
}

#[implement(IClassFactory)]
struct Factory {
    _lease: ModuleLease,
}
impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> Result<()> {
        record(
            "Factory.CreateInstance",
            (|| {
                if out.is_null() {
                    return Err(E_POINTER.into());
                }
                unsafe {
                    *out = null_mut();
                }
                if iid.is_null() {
                    return Err(E_POINTER.into());
                }
                if outer.is_some() {
                    return Err(CLASS_E_NOAGGREGATION.into());
                }
                let mut apartment = APTTYPE::default();
                let mut qualifier = APTTYPEQUALIFIER::default();
                unsafe { CoGetApartmentType(&mut apartment, &mut qualifier) }?;
                if apartment != APTTYPE_STA && apartment != APTTYPE_MAINSTA {
                    return Err(RPC_E_WRONG_THREAD.into());
                }
                static STARTUP: std::sync::Once = std::sync::Once::new();
                STARTUP.call_once(|| {
                    let _ = record("Process integrity", log_integrity());
                });
                let handler: IPreviewHandler = Preview {
                    state: Rc::new(State {
                        owner: unsafe { GetCurrentThreadId() },
                        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                        generation: Generation::default(),
                        resources: RefCell::new(Resources::default()),
                    }),
                    _lease: ModuleLease::new(),
                }
                .into();
                unsafe { handler.query(iid, out).ok() }
            })(),
        )
    }
    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            let mut current = LOCKS.load(Ordering::SeqCst);
            while let Some(next) = current.checked_sub(1) {
                match LOCKS.compare_exchange_weak(current, next, Ordering::SeqCst, Ordering::SeqCst)
                {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
        }
        Ok(())
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllGetClassObject(
    clsid: *const GUID,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    let result = (|| {
        if out.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            *out = null_mut();
        }
        if clsid.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        if unsafe { *clsid } != CLSID_PREVIEW {
            return Err(CLASS_E_CLASSNOTAVAILABLE.into());
        }
        let factory: IClassFactory = Factory {
            _lease: ModuleLease::new(),
        }
        .into();
        unsafe { factory.query(iid, out).ok() }
    })();
    record("DllGetClassObject", result).into()
}

#[unsafe(no_mangle)]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    let live = LIVE.load(Ordering::SeqCst);
    let locks = LOCKS.load(Ordering::SeqCst);
    if live == 0 && locks == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

// Runtime detection for the per-user installer, without registry probing.
#[unsafe(no_mangle)]
pub extern "system" fn SimpleMDWebView2Available() -> BOOL {
    let mut version = PWSTR::null();
    let available = unsafe {
        GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version).is_ok()
    };
    unsafe { CoTaskMemFree(Some(version.0.cast())) };
    BOOL::from(available)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::Shell::SHCreateMemStream;

    #[test]
    fn com_contract_and_unload_allow_stream_reinitialization() -> Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let root = low_root()?;
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("preview.log"), vec![b'x'; 1024 * 1024]).unwrap();
            log("Test: rotate full log");
            assert!(fs::metadata(root.join("preview.log")).unwrap().len() < 1024);
            let stale_profile = root.join("UserData/4294967295-1-0");
            fs::create_dir_all(&stale_profile).unwrap();
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() };
                }
            }
            let _apartment = Apartment;
            assert_eq!(DllCanUnloadNow(), S_OK);
            let mut raw = null_mut();
            DllGetClassObject(&CLSID_PREVIEW, &IClassFactory::IID, &mut raw).ok()?;
            let factory = IClassFactory::from_raw(raw);
            assert_eq!(DllCanUnloadNow(), S_FALSE);
            let preview: IPreviewHandler = factory.CreateInstance(None)?;
            assert_eq!(
                preview.cast::<IAgileObject>().unwrap_err().code(),
                E_NOINTERFACE
            );
            let init: IInitializeWithStream = preview.cast()?;
            let site: IObjectWithSite = preview.cast()?;
            let window: IOleWindow = preview.cast()?;
            let stream = SHCreateMemStream(Some(b"<script>inert</script>")).unwrap();
            init.Initialize(&stream, STGM_READ.0)?;
            assert_eq!(
                init.Initialize(&stream, STGM_READ.0).unwrap_err().code(),
                HRESULT(0x800704DFu32 as i32)
            );
            assert_eq!(preview.DoPreview().unwrap_err().code(), E_UNEXPECTED);
            preview.Unload()?;
            // Unload must drop the initialized state, including the old stream.
            init.Initialize(&stream, STGM_READ.0)?;
            preview.Unload()?;
            drop((preview, init, site, window, stream));
            factory.LockServer(true)?;
            factory.LockServer(false)?;
            drop(factory);
            assert_eq!(DllCanUnloadNow(), S_OK);

            // Runner-only hidden HWND. No focus, visible top-level window, or Explorer required.
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WS_OVERLAPPED,
                0,
                0,
                640,
                480,
                None,
                None,
                None,
                None,
            )?;
            let state = Rc::new(State {
                owner: GetCurrentThreadId(),
                id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                generation: Generation::default(),
                resources: RefCell::new(Resources::default()),
            });
            let preview: IPreviewHandler = Preview {
                state: state.clone(),
                _lease: ModuleLease::new(),
            }
            .into();
            let init: IInitializeWithStream = preview.cast()?;
            let source = b"# Hidden preview\n<script>inert</script>";
            let stream = SHCreateMemStream(Some(source)).unwrap();
            init.Initialize(&stream, STGM_READ.0)?;
            let rect = RECT {
                left: 0,
                top: 0,
                right: 640,
                bottom: 480,
            };
            preview.SetWindow(parent, &rect)?;
            preview.DoPreview()?;
            let child = state.resources.borrow().child;
            let source_control = state.resources.borrow().source;
            assert_eq!(GetParent(source_control)?, child);
            assert_eq!(
                GetWindowLongW(child, GWL_STYLE) & (WS_VSCROLL | WS_HSCROLL).0 as i32,
                0
            );
            let mut text = [0u16; 256];
            let count = GetWindowTextW(source_control, &mut text);
            assert_eq!(
                String::from_utf16_lossy(&text[..count as usize]),
                "# Hidden preview\r\n<script>inert</script>"
            );
            assert_ne!(GetWindowLongW(source_control, GWL_STYLE) & ES_READONLY, 0);
            // DoPreview must not load the runtime or touch a browser profile synchronously.
            assert!(HOST.with(|host| host.borrow().is_none()));
            let log_size = fs::metadata(root.join("preview.log")).unwrap().len();
            for _ in 0..100 {
                state.check_thread("TranslateAccelerator")?;
            }
            assert_eq!(
                fs::metadata(root.join("preview.log")).unwrap().len(),
                log_size
            );
            // Deterministic missing/denied-runtime path while deferred startup is pending.
            let stale = state.generation.get();
            state.fallback(stale, "Test: runtime unavailable");
            assert!(!state.current(stale));
            assert!(state.resources.borrow().controller.is_none());
            assert_eq!(state.resources.borrow().timer, 0);
            preview.Unload()?;
            assert!(!IsWindow(Some(child)).as_bool());
            let second = SHCreateMemStream(Some(
                b"---\ntitle: Rendered preview\n---\n# Rendered preview\n\n$x^2$\n\n<script>globalThis.pwned=true</script>\n<img src=\"https://example.com/never.png\" onerror=\"globalThis.pwned=true\">",
            ))
            .unwrap();
            init.Initialize(&second, STGM_READ.0)?;
            preview.SetWindow(parent, &rect)?;
            preview.DoPreview()?;
            let current = state.generation.get();
            state.fallback(stale, "Test: stale failure must not cancel new selection");
            assert!(state.current(current));
            // Let the real controller callbacks run. Either rich output or the bounded fallback is valid.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(18);
            while state.current(current)
                && state.resources.borrow().timer != 0
                && std::time::Instant::now() < deadline
            {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(state.resources.borrow().timer, 0);
            assert!(state.resources.borrow().rendered || !state.current(current));
            let mut browser_pid = 0;
            if SimpleMDWebView2Available().as_bool() {
                assert!(
                    state.current(current),
                    "Installed WebView2 did not render; inspect preview.log"
                );
                let controller = state
                    .resources
                    .borrow()
                    .controller
                    .clone()
                    .expect("Static controller");
                let view = controller.CoreWebView2()?;
                view.BrowserProcessId(&mut browser_pid)?;
                assert!(!stale_profile.exists());
                assert_eq!(
                    GetWindowLongW(state.resources.borrow().source, GWL_STYLE)
                        & WS_VISIBLE.0 as i32,
                    0
                );
                let resized = RECT {
                    left: 5,
                    top: 7,
                    right: 805,
                    bottom: 607,
                };
                preview.SetRect(&resized)?;
                let mut client = RECT::default();
                GetClientRect(state.resources.borrow().child, &mut client)?;
                let mut bounds = RECT::default();
                controller.Bounds(&mut bounds)?;
                assert_eq!(
                    (bounds.left, bounds.top, bounds.right, bounds.bottom),
                    (0, 0, client.right, client.bottom)
                );
                let original_font = state.resources.borrow().font;
                state.resources.borrow_mut().dpi = 0;
                let container = state.resources.borrow().child;
                SendMessageW(container, WM_DPICHANGED_AFTERPARENT, None, None);
                let font = state.resources.borrow().font;
                assert!(!font.is_invalid());
                assert_ne!(font, original_font);
                let mut font_info = LOGFONTW::default();
                assert_ne!(
                    GetObjectW(
                        font.into(),
                        size_of::<LOGFONTW>() as i32,
                        Some((&mut font_info as *mut LOGFONTW).cast())
                    ),
                    0
                );
                assert_eq!(
                    font_info.lfHeight,
                    -(((11 * GetDpiForWindow(state.resources.borrow().child).max(96) + 36) / 72)
                        as i32)
                );
                let mut title = PWSTR::null();
                view.DocumentTitle(&mut title)?;
                let title_text = title.to_string();
                CoTaskMemFree(Some(title.0.cast()));
                assert_eq!(title_text?, "Rendered preview");
                let settings = view.Settings()?;
                let mut enabled = BOOL(1);
                settings
                    .cast::<ICoreWebView2Settings3>()?
                    .AreBrowserAcceleratorKeysEnabled(&mut enabled)?;
                assert!(!enabled.as_bool());
                settings.IsScriptEnabled(&mut enabled)?;
                assert!(!enabled.as_bool());
                settings.IsWebMessageEnabled(&mut enabled)?;
                assert!(!enabled.as_bool());
                // Host-issued readback checks the final DOM, not just a successful navigation.
                let output = Rc::new(RefCell::new(None));
                let received = output.clone();
                let lease = ModuleLease::new();
                let callback = ExecuteScriptCompletedHandler::create(Box::new(move |hr, value| {
                    let _keep_loaded = &lease;
                    received.replace(Some(hr.map(|_| value)));
                    Ok(())
                }));
                view.ExecuteScript(w!("Boolean(document.querySelector('h1')?.textContent === 'Rendered preview' && document.querySelector('.katex') && !document.querySelector('script,iframe,[onerror]') && !globalThis.pwned && Array.from(document.images).every(img => !img.getAttribute('src')))") , &callback)?;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while output.borrow().is_none() && std::time::Instant::now() < deadline {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let actual = output.borrow_mut().take().expect("Final DOM readback")?;
                assert_eq!(actual, "true");
            }
            let font = state.resources.borrow().font;
            preview.Unload()?;
            assert!(state.resources.borrow().input.is_none());
            let mut deleted_font = LOGFONTW::default();
            assert_eq!(
                GetObjectW(
                    font.into(),
                    size_of::<LOGFONTW>() as i32,
                    Some((&mut deleted_font as *mut LOGFONTW).cast())
                ),
                0
            );
            // Select and unload repeatedly in one host. The shared browser must
            // survive and the number of process profiles must remain bounded.
            for _ in 0..4 {
                let stream = SHCreateMemStream(Some(b"# Again")).unwrap();
                init.Initialize(&stream, STGM_READ.0)?;
                preview.SetWindow(parent, &rect)?;
                preview.DoPreview()?;
                let current = state.generation.get();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(18);
                while state.current(current)
                    && state.resources.borrow().timer != 0
                    && std::time::Instant::now() < deadline
                {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                assert_eq!(state.resources.borrow().timer, 0);
                if browser_pid != 0 {
                    assert!(state.current(current));
                    let mut pid = 0;
                    state
                        .resources
                        .borrow()
                        .controller
                        .as_ref()
                        .unwrap()
                        .CoreWebView2()?
                        .BrowserProcessId(&mut pid)?;
                    assert_eq!(
                        pid, browser_pid,
                        "Browser process changed between selections"
                    );
                }
                preview.Unload()?;
            }
            let count = fs::read_dir(root.join("UserData")).unwrap().count();
            assert_eq!(
                count, 1,
                "UserData accumulated profiles after preview/unload"
            );
            let large = vec![b'x'; HTML_LIMIT + 1];
            let stream = SHCreateMemStream(Some(&large)).unwrap();
            init.Initialize(&stream, STGM_READ.0)?;
            preview.SetWindow(parent, &rect)?;
            preview.DoPreview()?;
            assert_eq!(state.resources.borrow().timer, 0);
            assert!(state.resources.borrow().controller.is_none());
            assert_ne!(
                GetWindowLongW(state.resources.borrow().source, GWL_STYLE) & WS_VISIBLE.0 as i32,
                0
            );
            preview.Unload()?;
            let host = HOST.with(|host| host.borrow_mut().take());
            drop(host);
            DestroyWindow(parent)?;
        }
        Ok(())
    }
}
