use std::{io, path::Path};

#[cfg(unix)]
pub fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(windows)]
pub fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rename_never_replaces_a_destination() {
        let dir = std::env::temp_dir().join(format!("simplemd-move-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("source.md");
        let target = dir.join("target.md");
        std::fs::write(&source, b"source\r\n").unwrap();
        std::fs::write(&target, b"target").unwrap();
        assert!(move_file(&source, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source\r\n");
        assert_eq!(std::fs::read(&target).unwrap(), b"target");
        std::fs::remove_file(&target).unwrap();
        move_file(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"source\r\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
