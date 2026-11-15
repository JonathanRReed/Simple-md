mod file_exchange;
mod file_metadata;
mod file_move;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 3 && matches!(args[0].as_str(), "--exchange" | "--exchange-with-metadata") {
        if args[0] == "--exchange-with-metadata" {
            if let Err(error) = file_metadata::run(&args[2], &args[1]) {
                println!("METADATA_FAILED");
                eprintln!("metadata copy: {error}");
            }
            // Persist metadata too, before publishing the completed file.
            if let Err(error) = file_exchange::sync_file(&args[1]) {
                eprintln!("SYNC_FAILED: {error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = file_exchange::exchange(
            std::path::Path::new(&args[1]),
            std::path::Path::new(&args[2]),
        ) {
            let code = if file_exchange::unsupported(&error) {
                "NOSWAP"
            } else {
                "EXCHANGE_FAILED"
            };
            eprintln!("{code}: {error}");
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 3 && args[0] == "--move-no-replace" {
        if let Err(error) = file_move::move_file(
            std::path::Path::new(&args[1]),
            std::path::Path::new(&args[2]),
        ) {
            let code = match error.kind() {
                #[cfg(unix)]
                _ if error.raw_os_error() == Some(libc::ENOTSUP)
                    || cfg!(target_os = "linux") && error.raw_os_error() == Some(libc::EINVAL) =>
                {
                    "NOEXCL"
                }
                std::io::ErrorKind::CrossesDevices => "EXDEV",
                std::io::ErrorKind::AlreadyExists => "EEXIST",
                _ => "MOVE_FAILED",
            };
            eprintln!("{code}: {error}");
            std::process::exit(1);
        }
        return;
    }
    if args.len() != 3 || args[0] != "--copy-metadata" {
        eprintln!("Usage: simplemd-helper --copy-metadata <src> <dst>");
        std::process::exit(1);
    }
    if let Err(error) = file_metadata::run(&args[1], &args[2]) {
        eprintln!("metadata copy: {error}");
        std::process::exit(1);
    }
}
