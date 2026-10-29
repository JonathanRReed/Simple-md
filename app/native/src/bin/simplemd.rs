#[path = "../cli/mod.rs"]
mod cli;
fn main() {
    match cli::run() {
        Ok(()) => {}
        Err((code, message)) => {
            eprintln!("simplemd: {message}");
            std::process::exit(code);
        }
    }
}
