//! Fallback for platforms without a backend. Runs the protocol but never peeks.

use std::sync::Arc;
use std::thread;

use super::{Backend, Outbox};
use crate::protocol::{Event, PermissionState, Probe};

struct Unsupported;

impl Backend for Unsupported {
    fn replay_space(&self, _request_id: u64) {}
    fn complete_peek(&self, _request_id: u64) {}
    fn validate_peek(&self, _request_id: u64) -> bool {
        false
    }
    fn set_enabled(&self, _enabled: bool) {}
}

pub fn init(out: Outbox) -> Arc<dyn Backend> {
    let _ = out.send(Some(Event::Ready {
        platform: if cfg!(windows) { "windows" } else { "linux" },
        permission: PermissionState::Unsupported,
    }));
    let _ = out.send(Some(Event::error(
        "bare Space preview is unsupported on this desktop; open a Markdown file with SimpleMD",
    )));
    Arc::new(Unsupported)
}

pub fn run_loop() -> ! {
    loop {
        thread::park();
    }
}

pub fn probe() -> Probe {
    Probe {
        frontmost: String::new(),
        text_input_focused: false,
        accessibility: false,
        paths: None,
    }
}
