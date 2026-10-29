//! Platform backends. Each backend exposes the same three functions:
//!
//! * `init(out)` installs whatever hooks the platform needs, emits `ready`, and
//!   returns a [`Backend`] used to service stdin commands.
//! * `run_loop()` blocks the main thread. macOS needs it because
//!   `NSWorkspace.frontmostApplication` only updates while the main run loop spins.
//! * `probe()` takes a one-shot snapshot for `--probe`.

use std::sync::mpsc::Sender;

use crate::protocol::Event;

/// `Some(event)` is written to stdout; `None` flushes everything queued before it and exits.
pub type Outbox = Sender<Option<Event>>;

#[cfg(target_os = "macos")]
mod pending;

pub trait Backend: Send + Sync {
    /// Re-post a Space press so the OS file manager handles the key itself.
    fn replay_space(&self, request_id: u64);
    fn complete_peek(&self, request_id: u64);
    fn validate_peek(&self, request_id: u64) -> bool;
    fn set_enabled(&self, enabled: bool);
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{init, probe, run_loop};

#[cfg(not(target_os = "macos"))]
mod linux;
#[cfg(not(target_os = "macos"))]
pub use linux::{init, probe, run_loop};
