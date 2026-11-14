use std::{io, path::Path};

#[cfg(unix)]
pub fn sync_file(path: &str) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let file = std::fs::File::open(path)?;
    // Match the app's fsync, rather than Rust's stronger macOS F_FULLFSYNC.
    if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub fn sync_file(path: &str) -> io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(unix)]
pub fn exchange(source: &Path, target: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_SWAP) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub fn exchange(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "file exchange is unavailable",
    ))
}

pub fn unsupported(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::ENOTSUP)
    ) {
        return true;
    }
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn exchanges_complete_files_and_can_restore_them() {
        let dir = std::env::temp_dir().join(format!("simplemd-exchange-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("source.tmp");
        let target = dir.join("target.md");
        std::fs::write(&source, b"new\r\n").unwrap();
        std::fs::write(&target, b"old").unwrap();
        sync_file(source.to_str().unwrap()).unwrap();
        assert!(sync_file(dir.join("missing").to_str().unwrap()).is_err());
        exchange(&source, &target).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"old");
        assert_eq!(std::fs::read(&target).unwrap(), b"new\r\n");
        exchange(&source, &target).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"new\r\n");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert!(exchange(&source, &dir.join("missing")).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"new\r\n");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsupported_errors_are_distinct_from_permission_and_io_errors() {
        for code in [libc::ENOSYS, libc::EINVAL, libc::ENOTSUP] {
            assert!(unsupported(&io::Error::from_raw_os_error(code)));
        }
        for code in [libc::EACCES, libc::EIO, libc::ENOENT] {
            assert!(!unsupported(&io::Error::from_raw_os_error(code)));
        }
    }
}
