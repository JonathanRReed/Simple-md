mod file_metadata;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 || args[0] != "--copy-metadata" {
        eprintln!("Usage: simplemd-helper --copy-metadata <src> <dst>");
        std::process::exit(1);
    }
    if let Err(error) = file_metadata::run(&args[1], &args[2]) {
        eprintln!("metadata copy: {error}");
        std::process::exit(1);
    }
}
