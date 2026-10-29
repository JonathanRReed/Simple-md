// Measurement-only helper. It never starts the file-manager backend.
#[cfg(target_os = "macos")]
fn measure(pid: u32) -> Result<(u64, u64), String> {
    // rusage_info_v0, from sys/resource.h. Flavor 0 has a stable 96-byte ABI.
    #[repr(C)]
    #[derive(Default)]
    struct Usage {
        uuid: [u8; 16],
        user_time: u64,
        system_time: u64,
        pkg_idle_wakeups: u64,
        interrupt_wakeups: u64,
        pageins: u64,
        wired_size: u64,
        resident_size: u64,
        phys_footprint: u64,
        start_time: u64,
        exit_time: u64,
    }
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut Usage) -> i32;
    }
    const _: [(); 96] = [(); size_of::<Usage>()];
    let mut usage = Usage::default();
    if unsafe { proc_pid_rusage(pid as i32, 0, &mut usage) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok((usage.phys_footprint, usage.resident_size))
}

#[cfg(windows)]
fn measure(pid: u32) -> Result<(u64, u64), String> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn K32QueryWorkingSet(handle: *mut c_void, buffer: *mut c_void, bytes: u32) -> i32;
        fn GetSystemInfo(buffer: *mut u32);
    }
    let handle = unsafe { OpenProcess(0x0400 | 0x0010, 0, pid) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // QueryWorkingSet returns one pointer-sized flags word per resident page.
    // Bit 8 is Shared. Private working set is the sum of pages without that bit.
    let result = (|| {
        let mut words = vec![0usize; 4096];
        loop {
            let ok = unsafe {
                K32QueryWorkingSet(
                    handle,
                    words.as_mut_ptr().cast(),
                    (words.len() * size_of::<usize>()) as u32,
                )
            };
            if ok != 0 {
                let count = words[0];
                if count >= words.len() {
                    return Err("Invalid working-set page count".into());
                }
                let mut info = [0u32; 16];
                unsafe { GetSystemInfo(info.as_mut_ptr()) };
                let page_size = u64::from(info[1]);
                let private = words[1..=count]
                    .iter()
                    .filter(|flags| **flags & (1 << 8) == 0)
                    .count();
                return Ok((private as u64 * page_size, count as u64 * page_size));
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(24) || words.len() >= 16 * 1024 * 1024 {
                return Err(error.to_string());
            }
            words.resize(words.len() * 2, 0);
        }
    })();
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(any(target_os = "macos", windows)))]
fn measure(_pid: u32) -> Result<(u64, u64), String> {
    Err("Physical-footprint gate requires macOS or Windows".into())
}

fn main() {
    let mut samples = Vec::new();
    for arg in std::env::args().skip(1) {
        let result = arg
            .parse::<u32>()
            .map_err(|error| error.to_string())
            .and_then(measure);
        match result {
            Ok((physical, rss)) => samples.push(serde_json::json!({ "pid": arg.parse::<u32>().unwrap(), "physicalBytes": physical, "rssBytes": rss })),
            Err(error) => {
                eprintln!("PID {arg}: {error}");
                std::process::exit(1);
            }
        }
    }
    println!("{}", serde_json::to_string(&samples).unwrap());
}

#[cfg(all(test, any(target_os = "macos", windows)))]
#[test]
fn measures_the_running_process() {
    let (physical, rss) = measure(std::process::id()).expect("current process is measurable");
    assert!(physical > 0);
    assert!(rss > 0);
}
