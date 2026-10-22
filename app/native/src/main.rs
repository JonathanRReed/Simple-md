// The fallback backend never produces most events.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

mod platform;
mod protocol;

use std::io::{self, BufRead, Write};
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use platform::{Backend, Outbox};
use protocol::{Command, Event};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--probe") {
        run_probe(&args);
        return;
    }

    let (tx, rx) = mpsc::channel();
    spawn_writer(rx);

    let backend = platform::init(tx.clone());
    spawn_stdin_reader(backend, tx);
    platform::run_loop();
}

fn run_probe(args: &[String]) {
    // Lets a human switch to Finder before the snapshot is taken.
    if let Some(secs) = args
        .iter()
        .position(|a| a == "--delay")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<f64>().ok())
    {
        thread::sleep(Duration::from_secs_f64(secs.clamp(0.0, 60.0)));
    }
    let probe = platform::probe();
    println!(
        "{}",
        serde_json::to_string(&probe).expect("probe is serializable")
    );
}

/// Single writer so event producers (including the key-event callback) never block on stdout.
fn spawn_writer(rx: mpsc::Receiver<Option<Event>>) {
    thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        for msg in rx {
            let Some(event) = msg else { break };
            if writeln!(stdout, "{}", event.to_line())
                .and_then(|()| stdout.flush())
                .is_err()
            {
                // Parent closed the pipe; nobody is listening anymore.
                break;
            }
        }
        process::exit(0);
    });
}

fn spawn_stdin_reader(backend: std::sync::Arc<dyn Backend>, out: Outbox) {
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match protocol::parse_command(line) {
                Ok(Command::ReplaySpace { request_id }) => backend.replay_space(request_id),
                Ok(Command::CompletePeek { request_id }) => backend.complete_peek(request_id),
                Ok(Command::ValidatePeek { request_id }) => {
                    let valid = backend.validate_peek(request_id);
                    let _ = out.send(Some(Event::PeekValid { request_id, valid }));
                }
                Ok(Command::SetEnabled { enabled }) => backend.set_enabled(enabled),
                Ok(Command::Quit) => break,
                Err(e) => {
                    let _ = out.send(Some(Event::error(format!("invalid command: {e}"))));
                }
            }
        }
        // Quit or EOF (parent died): drain pending events, then the writer exits the process.
        let _ = out.send(None);
    });
}
