use std::{
    fs,
    io::Read,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};
pub fn runtime_dir() -> Result<PathBuf, String> {
    Ok(PathBuf::from(format!("/tmp/smd-{}", unsafe {
        libc::geteuid()
    })))
}
pub fn validate_runtime(dir: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err("Unsafe CLI runtime directory".into());
    }
    Ok(())
}
pub fn read_state(dir: &Path) -> Result<serde_json::Value, String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join("state.json"))
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o777 != 0o600
        || meta.len() > 4096
    {
        return Err("Unsafe CLI connection state".into());
    }
    let mut bytes = vec![];
    file.by_ref()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn connect(dir: &Path) -> Result<UnixStream, String> {
    let file = dir.join("ipc.sock");
    let meta = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
    use std::os::unix::fs::FileTypeExt;
    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
        return Err("Unsafe CLI endpoint".into());
    }
    let stream = UnixStream::connect(file).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    Ok(stream)
}
pub fn wait_forever(stream: &UnixStream) -> Result<(), String> {
    stream.set_read_timeout(None).map_err(|e| e.to_string())
}
pub fn interrupt_handler() {
    extern "C" fn interrupted(_: libc::c_int) {
        unsafe { libc::_exit(1) }
    }
    unsafe {
        libc::signal(libc::SIGINT, interrupted as *const () as libc::sighandler_t);
    }
}
