use super::deadline::AcceptanceDeadline;
use super::{FRAME_CAP, STDIN_CAP, read_frame, secret_matches, write_frame};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{self, BufRead, Read, Write},
    os::windows::{
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{
        Console::*,
        IO::{CancelIoEx, CancelSynchronousIo},
        Pipes::*,
        Threading::*,
    },
};
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn error() -> String {
    io::Error::last_os_error().to_string()
}
struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn sid() -> Result<String, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(error());
        }
        let mut size = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
        let mut data = vec![0u64; (size as usize).div_ceil(8)];
        let ok = GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size);
        CloseHandle(token);
        if ok == 0 {
            return Err(error());
        }
        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        let mut string = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut string) == 0 {
            return Err(error());
        }
        let mut length = 0;
        while *string.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(string, length));
        LocalFree(string.cast());
        Ok(result)
    }
}
fn descriptor() -> Result<Descriptor, String> {
    let sddl = wide(&format!("O:{}D:P(A;OICI;FA;;;{})", sid()?, sid()?));
    let mut sd = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, null_mut())
    } == 0
    {
        return Err(error());
    }
    Ok(Descriptor(sd))
}
fn verify_acl(owner: PSID, dacl: *mut ACL) -> Result<(), String> {
    unsafe {
        let expected = descriptor()?;
        let mut expected_owner = null_mut();
        let mut defaulted = 0;
        if GetSecurityDescriptorOwner(expected.0, &mut expected_owner, &mut defaulted) == 0
            || owner.is_null()
            || EqualSid(owner, expected_owner) == 0
            || dacl.is_null()
            || (*dacl).AceCount != 1
        {
            return Err("Unsafe runtime ACL".into());
        }
        let mut ace = null_mut();
        if GetAce(dacl, 0, &mut ace) == 0 {
            return Err(error());
        }
        let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        if ace.Header.AceType != 0
            || ace.Mask != FILE_ALL_ACCESS
            || EqualSid(
                (&ace.SidStart as *const u32).cast_mut().cast(),
                expected_owner,
            ) == 0
        {
            return Err("Unsafe runtime ACL".into());
        }
    }
    Ok(())
}
fn check_acl(file: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(file).map_err(|e| e.to_string())?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Runtime reparse points are forbidden".into());
    }
    unsafe {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut sd = null_mut();
        let result = GetNamedSecurityInfoW(
            wide(&file.to_string_lossy()).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut sd,
        );
        if result != 0 {
            return Err(format!("Cannot inspect runtime ACL: {result}"));
        }
        let _sd = Descriptor(sd);
        verify_acl(owner, dacl)?;
    }
    Ok(())
}
pub fn runtime_dir() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?)
            .join("SimpleMD")
            .join("cli"),
    )
}
pub fn validate_runtime(dir: &Path) -> Result<(), String> {
    check_acl(dir)
}
pub fn read_state(dir: &Path) -> Result<Value, String> {
    check_acl(&dir.join("state.json"))?;
    let bytes = fs::read(dir.join("state.json")).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("Invalid connection state".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn runtime_info() -> Result<(), String> {
    let dir = super::runtime_dir()?;
    if !dir.exists() {
        fs::create_dir_all(dir.parent().ok_or("Invalid runtime path")?)
            .map_err(|e| e.to_string())?;
        let sd = descriptor()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: 0,
        };
        if unsafe { CreateDirectoryW(wide(&dir.to_string_lossy()).as_ptr(), &attributes) } == 0 {
            return Err(error());
        }
    }
    validate_runtime(&dir)?;
    println!(
        "{}",
        json!({"directory":dir,"endpoint":format!(r"\\.\pipe\simplemd-{}",sid()?)})
    );
    Ok(())
}
pub struct Connection {
    file: File,
    deadline: AcceptanceDeadline,
}
impl Read for Connection {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.deadline.expired() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "CLI acceptance timed out",
            ));
        }
        self.file.read(bytes)
    }
}
impl Write for Connection {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.deadline.expired() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "CLI acceptance timed out",
            ));
        }
        self.file.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
pub fn connect(_: &Path) -> Result<Connection, String> {
    let name = wide(&format!(r"\\.\pipe\simplemd-{}", sid()?));
    connect_pipe(&name, Duration::from_secs(30))
}
fn connect_pipe(name: &[u16], timeout: Duration) -> Result<Connection, String> {
    let mut thread_handle = null_mut();
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentThread(),
            GetCurrentProcess(),
            &mut thread_handle,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(error());
    }
    let thread = unsafe { File::from_raw_handle(thread_handle) };
    let pending: Arc<Mutex<Option<File>>> = Arc::new(Mutex::new(None));
    let pipe = pending.clone();
    let deadline = AcceptanceDeadline::new(timeout, move || unsafe {
        CancelSynchronousIo(thread.as_raw_handle());
        if let Some(file) = &*pipe.lock().unwrap() {
            CancelIoEx(file.as_raw_handle(), null());
        }
    });
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    unsafe {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut sd = null_mut();
        let result = GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut sd,
        );
        if result != 0 {
            return Err(format!("Cannot inspect pipe ACL: {result}"));
        }
        let _sd = Descriptor(sd);
        verify_acl(owner, dacl)?;
    }
    *pending.lock().unwrap() = Some(file.try_clone().map_err(|e| e.to_string())?);
    if deadline.expired() {
        return Err("CLI connection timed out".into());
    }
    Ok(Connection { file, deadline })
}
pub fn wait_forever(stream: &Connection) -> Result<(), String> {
    stream.deadline.cancel();
    if stream.deadline.expired() {
        return Err("CLI acceptance timed out".into());
    }
    Ok(())
}
pub fn interrupt_handler() {
    unsafe extern "system" fn interrupted(code: u32) -> i32 {
        if code == CTRL_C_EVENT || code == CTRL_BREAK_EVENT {
            std::process::exit(1);
        }
        0
    }
    unsafe {
        SetConsoleCtrlHandler(Some(interrupted), 1);
    }
}
fn emit(value: Value) {
    let mut out = io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, &value);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
// The primary Electron process owns this child and validates all requests. The
// broker exists because Node's pipe listener cannot specify a current-user DACL.
pub fn broker() -> Result<(), String> {
    let dir = super::runtime_dir()?;
    validate_runtime(&dir)?;
    let secret = read_state(&dir)?["secret"]
        .as_str()
        .ok_or("Missing secret")?
        .to_owned();
    let clients: Arc<Mutex<HashMap<u64, File>>> = Arc::new(Mutex::new(HashMap::new()));
    let writers = clients.clone();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            let Some(id) = value["connection"].as_u64() else {
                break;
            };
            if let Some(file) = writers.lock().unwrap().get_mut(&id) {
                let _ = write_frame(
                    file,
                    &serde_json::to_vec(&value["response"]).unwrap_or_default(),
                    FRAME_CAP,
                );
            }
        }
        std::process::exit(1);
    });
    let active = Arc::new(AtomicUsize::new(0));
    let authenticated = Arc::new(AtomicUsize::new(0));
    let sd = descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let name = wide(&format!(r"\\.\pipe\simplemd-{}", sid()?));
    let mut counter = 0u64;
    loop {
        let first = if counter == 0 {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | first,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                65536,
                15000,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(error());
        }
        if counter == 0 {
            emit(json!({"ready":true}));
        }
        let connected = unsafe { ConnectNamedPipe(handle, null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        let mut file = unsafe { File::from_raw_handle(handle) };
        if !connected {
            continue;
        }
        counter += 1;
        if active.load(Ordering::SeqCst) >= 16 {
            continue;
        }
        active.fetch_add(1, Ordering::SeqCst);
        let id = counter;
        let clients = clients.clone();
        let active = active.clone();
        let secret = secret.clone();
        let authenticated = authenticated.clone();
        thread::spawn(move || {
            let watchdog = file.try_clone().ok();
            let finished = Arc::new(AtomicUsize::new(0));
            let done = finished.clone();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while done.load(Ordering::SeqCst) == 0 {
                    if Instant::now() > deadline {
                        if let Some(f) = watchdog {
                            unsafe {
                                CancelIoEx(f.as_raw_handle(), null());
                                DisconnectNamedPipe(f.as_raw_handle());
                            }
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            });
            let mut authorized = false;
            let result = (|| -> Result<(), String> {
                let request: Value = serde_json::from_slice(
                    &read_frame(&mut file, FRAME_CAP).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                if !secret_matches(&secret, request["secret"].as_str().unwrap_or("")) {
                    return Err("Unauthorized".into());
                }
                if authenticated
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                        (count < 256).then_some(count + 1)
                    })
                    .is_err()
                {
                    let response = json!({"version":1,"id":request["id"],"status":"error","message":"Too many authenticated CLI connections. Close a waiting session and retry."});
                    write_frame(
                        &mut file,
                        &serde_json::to_vec(&response).map_err(|e| e.to_string())?,
                        FRAME_CAP,
                    )
                    .map_err(|e| e.to_string())?;
                    return Err("Authenticated connection limit".into());
                }
                authorized = true;
                active.fetch_sub(1, Ordering::SeqCst);
                let mut text = String::new();
                if request["command"] == "stdin" {
                    let length = request["length"]
                        .as_u64()
                        .filter(|v| *v <= STDIN_CAP as u64)
                        .ok_or("Invalid stdin length")?;
                    if length > 0 {
                        let bytes = read_frame(&mut file, STDIN_CAP).map_err(|e| e.to_string())?;
                        if bytes.len() != length as usize {
                            return Err("Invalid stdin frame".into());
                        }
                        text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                    }
                }
                clients
                    .lock()
                    .unwrap()
                    .insert(id, file.try_clone().map_err(|e| e.to_string())?);
                emit(json!({"connection":id,"request":request,"stdin":text}));
                finished.store(1, Ordering::SeqCst);
                let mut byte = [0];
                let _ = file.read(&mut byte);
                Ok(())
            })();
            finished.store(1, Ordering::SeqCst);
            clients.lock().unwrap().remove(&id);
            emit(json!({"connection":id,"disconnected":true,"failed":result.is_err()}));
            if authorized {
                authenticated.fetch_sub(1, Ordering::SeqCst);
            } else {
                active.fetch_sub(1, Ordering::SeqCst);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_first_frame_is_cancelled() {
        let name = wide(&format!(
            r"\\.\pipe\simplemd-watchdog-{}",
            std::process::id()
        ));
        let sd = descriptor().unwrap();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: 0,
        };
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                1000,
                &attributes,
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let mut server = unsafe { File::from_raw_handle(handle) };
        let peer = thread::spawn(move || {
            assert!(
                unsafe { ConnectNamedPipe(server.as_raw_handle(), null_mut()) } != 0
                    || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED
            );
            server.write_all(&[0, 0]).unwrap();
            let _ = server.read(&mut [0]);
        });
        let started = Instant::now();
        let mut client = connect_pipe(&name, Duration::from_millis(50)).unwrap();
        assert!(read_frame(&mut client, FRAME_CAP).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(client);
        peer.join().unwrap();
    }
}
