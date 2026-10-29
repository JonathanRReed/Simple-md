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
    ExecuteScriptCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, ProcessFailedEventHandler, WebMessageReceivedEventHandler,
    WebResourceRequestedEventHandler,
};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::Gdi::{ANSI_FIXED_FONT, GetStockObject},
        Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
            TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel,
        },
        System::{
            Com::*,
            Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl},
            SystemInformation::GetSystemTime,
            Threading::{GetCurrentProcess, GetCurrentThreadId, OpenProcessToken},
        },
        UI::{
            Input::KeyboardAndMouse::{GetFocus, SetFocus},
            Shell::{
                FOLDERID_LocalAppDataLow, IPreviewHandler, IPreviewHandler_Impl,
                IPreviewHandlerFrame, KF_FLAG_DEFAULT, PropertiesSystem::*, SHGetKnownFolderPath,
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

use crate::content::{Generation, INPUT_LIMIT, Input, fallback_text, read_bounded, render_script};

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
    // labels this directory; do not fall back to a medium-integrity location.
    let Ok(root) = low_root() else { return };
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("preview.log"))
    {
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

#[derive(Default)]
struct Resources {
    input: Option<Input>,
    mode: u32,
    site: Option<IUnknown>,
    frame: Option<IPreviewHandlerFrame>,
    child: HWND,
    rect: RECT,
    controller: Option<ICoreWebView2Controller>,
    timer: usize,
    rendered: bool,
    expected_navigation: bool,
    data: Option<PathBuf>,
    started: bool,
}
impl Resources {
    fn release(mut self) {
        // No RefCell borrow is held across Close, Release or DestroyWindow.
        cancel_timer(self.timer);
        if let Some(controller) = self.controller.take() {
            let _ = record("Controller.Close", unsafe { controller.Close() });
        }
        if !self.child.is_invalid() {
            let _ = record("DestroyWindow", unsafe { DestroyWindow(self.child) });
        }
        if let Some(data) = &self.data {
            cleanup(data);
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
        log(&format!(
            "handler={} generation={} {step}",
            self.id,
            self.generation.get()
        ));
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

struct Pending {
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
        // KillTimer leaves posted WM_TIMER messages behind. Drain only our private
        // source HWND before releasing the callback's DLL lease.
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, Some(pending.child), WM_TIMER, WM_TIMER, PM_REMOVE) }
            .as_bool()
        {}
    }
}
unsafe extern "system" fn preview_timeout(_: HWND, _: u32, timer: usize, _: u32) {
    let pending = TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    if let Some(pending) = pending {
        let _ = unsafe { KillTimer(Some(pending.child), timer) };
        if let Some(state) = pending.state.upgrade() {
            state.fallback(
                pending.generation,
                "WebView2 startup/render deadline exceeded",
            );
        }
    }
}
impl State {
    fn fallback(&self, generation: u64, reason: &str) {
        if !self.current(generation) {
            return;
        }
        log(&format!("Native fallback: {reason}"));
        // Cancel all outstanding startup/render callbacks but retain the source control.
        self.generation.cancel();
        let (controller, data, timer) = {
            let mut r = self.resources.borrow_mut();
            (
                r.controller.take(),
                r.data.take(),
                std::mem::take(&mut r.timer),
            )
        };
        cancel_timer(timer);
        if let Some(controller) = controller {
            let _ = record("Fallback Close", unsafe { controller.Close() });
        }
        if let Some(data) = data {
            cleanup(&data);
        }
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
                r.mode = mode;
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
        let (child, controller) = {
            let mut r = self.state.resources.borrow_mut();
            r.rect = rect;
            (r.child, r.controller.clone())
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
        if let Some(controller) = controller {
            record("Controller.SetBounds", unsafe {
                controller.SetBounds(RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                })
            })?;
        }
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
                    // A built-in class needs no DLL WndProc and cannot outlive our code.
                    let child = unsafe {
                        CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("EDIT"),
                            w!(""),
                            WS_CHILD
                                | WS_VISIBLE
                                | WS_CLIPCHILDREN
                                | WS_VSCROLL
                                | WS_HSCROLL
                                | WINDOW_STYLE(
                                    (ES_MULTILINE | ES_READONLY | ES_AUTOHSCROLL | ES_AUTOVSCROLL)
                                        as u32,
                                ),
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
                    if !self.state.current(generation) {
                        let _ = record("Destroy stale child", unsafe { DestroyWindow(child) });
                        return Err(E_ABORT.into());
                    }
                    unsafe {
                        SendMessageW(
                            child,
                            WM_SETFONT,
                            Some(WPARAM(GetStockObject(ANSI_FIXED_FONT).0 as usize)),
                            Some(LPARAM(1)),
                        );
                    }
                    self.state.resources.borrow_mut().child = child;
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
                let child = {
                    let r = self.state.resources.borrow();
                    if r.started || r.child.is_invalid() || r.input.is_none() {
                        return Err(E_UNEXPECTED.into());
                    }
                    r.child
                };
                let text = fallback_text(self.state.resources.borrow().input.as_ref().unwrap());
                record("Set fallback text", unsafe {
                    SetWindowTextW(child, &HSTRING::from(text))
                })?;
                if !self.state.current(generation) {
                    return Err(E_ABORT.into());
                }
                self.state.resources.borrow_mut().started = true;
                log(&format!(
                    "Native source visible while WebView2 starts; mode=0x{:08X}",
                    self.state.resources.borrow().mode
                ));
                // A timer bounds startup and rendering without waiting on the host STA.
                let timer = unsafe {
                    SetTimer(
                        Some(child),
                        NEXT_ID.fetch_add(1, Ordering::Relaxed),
                        10_000,
                        Some(preview_timeout),
                    )
                };
                if timer == 0 {
                    self.state
                        .fallback(generation, "Cannot create startup deadline");
                    return Ok(());
                }
                TIMERS.with(|timers| {
                    timers.borrow_mut().insert(
                        timer,
                        Pending {
                            child,
                            state: Rc::downgrade(&self.state),
                            generation,
                            _lease: ModuleLease::new(),
                        },
                    )
                });
                self.state.resources.borrow_mut().timer = timer;
                let data = match low_root().and_then(|root| {
                    let data = root.join("UserData").join(format!(
                        "{}-{}-{generation}",
                        std::process::id(),
                        self.state.id
                    ));
                    fs::create_dir_all(&data).map_err(|e| Error::new(E_FAIL, e.to_string()))?;
                    Ok(data)
                }) {
                    Ok(data) => data,
                    Err(error) => {
                        self.state
                            .fallback(generation, &format!("User data: {error}"));
                        return Ok(());
                    }
                };
                log(&format!("WebView2 user data: {}", data.display()));
                self.state.resources.borrow_mut().data = Some(data.clone());
                let callback: ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler =
                    Startup {
                        state: Rc::downgrade(&self.state),
                        generation,
                        data: data.clone(),
                        _lease: ModuleLease::new(),
                    }
                    .into();
                // No sandbox flags, custom browser arguments, or nested message pump.
                if let Err(error) = record("CreateCoreWebView2EnvironmentWithOptions", unsafe {
                    CreateCoreWebView2EnvironmentWithOptions(
                        PCWSTR::null(),
                        &HSTRING::from(data.as_os_str()),
                        None,
                        &callback,
                    )
                }) {
                    self.state
                        .fallback(generation, &format!("Environment startup: {error}"));
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
        let controller = self.state.resources.borrow().controller.clone();
        record(
            "SetFocus",
            if let Some(controller) = controller {
                unsafe { controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }
            } else {
                let child = self.state.resources.borrow().child;
                unsafe { SetFocus(Some(child)) }.map(|_| ())
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
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
    ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
    Agile = false
)]
struct Startup {
    state: Weak<State>,
    generation: u64,
    data: PathBuf,
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
impl ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_Impl for Startup_Impl {
    fn Invoke(&self, hr: HRESULT, environment: Ref<ICoreWebView2Environment>) -> Result<()> {
        // Log failures even when the selection has already changed.
        if let Err(error) = record("Environment completed", hr.ok()) {
            if let Some(state) = self.current("Environment failed")? {
                state.fallback(self.generation, &format!("Environment callback: {error}"));
            }
            cleanup(&self.data);
            return Ok(());
        }
        let Some(state) = self.current("Environment completed")? else {
            cleanup(&self.data);
            return Ok(());
        };
        let result = record(
            "Environment callback",
            (|| {
                let environment = environment.as_ref().ok_or_else(|| Error::from(E_POINTER))?;
                let mut version = PWSTR::null();
                record("BrowserVersionString", unsafe {
                    environment.BrowserVersionString(&mut version)
                })?;
                unsafe {
                    log(&format!(
                        "WebView2 runtime: {}",
                        version.to_string().unwrap_or_default()
                    ));
                    CoTaskMemFree(Some(version.0.cast()));
                }
                if !state.current(self.generation) {
                    return Err(E_ABORT.into());
                }
                let child = state.resources.borrow().child;
                let callback = self
                    .to_interface::<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>();
                unsafe { environment.CreateCoreWebView2Controller(child, &callback) }
            })(),
        );
        if let Err(error) = result {
            state.fallback(self.generation, &format!("Create controller: {error}"));
        }
        Ok(())
    }
}
impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_Impl for Startup_Impl {
    fn Invoke(&self, hr: HRESULT, controller: Ref<ICoreWebView2Controller>) -> Result<()> {
        if let Err(error) = record("Controller completed", hr.ok()) {
            if let Some(state) = self.current("Controller failed")? {
                state.fallback(self.generation, &format!("Controller callback: {error}"));
            }
            cleanup(&self.data);
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
            cleanup(&self.data);
            return Ok(());
        };
        state.resources.borrow_mut().controller = Some(controller.clone());
        let result = record(
            "Configure WebView2",
            configure(controller, &state, self.generation),
        );
        if result.is_err() || !state.current(self.generation) {
            let _ = record("Close rejected controller", unsafe { controller.Close() });
            cleanup(&self.data);
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
                        log(if blocked {
                            "Navigation blocked"
                        } else {
                            "Host document or fragment navigation"
                        });
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
                    if html.len() > 1_900_000 {
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
        let rect = state.resources.borrow().rect;
        controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: rect.right - rect.left,
            bottom: rect.bottom - rect.top,
        })?;
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
        log("Factory.CreateInstance");
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
                log(&format!(
                    "COM apartment={} qualifier={}",
                    apartment.0, qualifier.0
                ));
                if apartment != APTTYPE_STA && apartment != APTTYPE_MAINSTA {
                    return Err(RPC_E_WRONG_THREAD.into());
                }
                let _ = record("Process integrity", log_integrity());
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
        log(&format!("Factory.LockServer {}", lock.as_bool()));
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
    log("DllGetClassObject");
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
    log(&format!("DllCanUnloadNow live={live} locks={locks}"));
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
            let mut text = [0u16; 256];
            let count = GetWindowTextW(child, &mut text);
            assert_eq!(
                String::from_utf16_lossy(&text[..count as usize]),
                "# Hidden preview\r\n<script>inert</script>"
            );
            assert_ne!(GetWindowLongW(child, GWL_STYLE) & ES_READONLY, 0);
            // Deterministic missing/denied-runtime path while startup callbacks may be pending.
            let stale = state.generation.get();
            state.fallback(stale, "Test: runtime unavailable");
            assert!(!state.current(stale));
            assert!(state.resources.borrow().controller.is_none());
            assert_eq!(state.resources.borrow().timer, 0);
            preview.Unload()?;
            assert!(!IsWindow(Some(child)).as_bool());
            let second = SHCreateMemStream(Some(
                b"# Rendered preview\n\n$x^2$\n\n<script>inert</script>",
            ))
            .unwrap();
            init.Initialize(&second, STGM_READ.0)?;
            preview.SetWindow(parent, &rect)?;
            preview.DoPreview()?;
            let current = state.generation.get();
            state.fallback(stale, "Test: stale failure must not cancel new selection");
            assert!(state.current(current));
            // Let the real controller callbacks run. Either rich output or the bounded fallback is valid.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
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
                let mut title = PWSTR::null();
                view.DocumentTitle(&mut title)?;
                let title_text = title.to_string();
                CoTaskMemFree(Some(title.0.cast()));
                assert_eq!(title_text?, "Rendered preview");
                let settings = view.Settings()?;
                let mut enabled = BOOL(1);
                settings.IsScriptEnabled(&mut enabled)?;
                assert!(!enabled.as_bool());
                settings.IsWebMessageEnabled(&mut enabled)?;
                assert!(!enabled.as_bool());
            }
            preview.Unload()?;
            assert!(state.resources.borrow().input.is_none());
            DestroyWindow(parent)?;
        }
        Ok(())
    }
}
