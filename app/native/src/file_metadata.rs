use std::io;

pub fn run(source: &str, target: &str) -> io::Result<()> {
    copy(source, target)
}

#[cfg(target_os = "macos")]
fn copy(source: &str, target: &str) -> io::Result<()> {
    use std::ffi::{CString, c_char, c_int, c_void};
    unsafe extern "C" {
        fn copyfile(
            source: *const c_char,
            target: *const c_char,
            state: *mut c_void,
            flags: u32,
        ) -> c_int;
    }
    let source = CString::new(source)?;
    let target = CString::new(target)?;
    // COPYFILE_ACL | COPYFILE_XATTR | COPYFILE_NOFOLLOW.
    // The caller owns the empty temp file and writes its data after copying metadata.
    let result = unsafe {
        copyfile(
            source.as_ptr(),
            target.as_ptr(),
            std::ptr::null_mut(),
            5 | (1 << 18) | (1 << 19),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn copy(_source: &str, _target: &str) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS metadata copy only",
    ))
}
