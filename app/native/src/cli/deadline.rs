use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

pub struct AcceptanceDeadline {
    stopped: Arc<(Mutex<bool>, Condvar)>,
    expired: Arc<AtomicBool>,
}
impl AcceptanceDeadline {
    pub fn new(timeout: Duration, cancel_io: impl Fn() + Send + 'static) -> Self {
        let stopped = Arc::new((Mutex::new(false), Condvar::new()));
        let expired = Arc::new(AtomicBool::new(false));
        let state = stopped.clone();
        let timed_out = expired.clone();
        thread::spawn(move || {
            let (lock, signal) = &*state;
            let (mut done, _) = signal
                .wait_timeout_while(lock.lock().unwrap(), timeout, |done| !*done)
                .unwrap();
            while !*done {
                timed_out.store(true, Ordering::SeqCst);
                // Retry cancellation across the gap between a timeout check and an I/O call.
                cancel_io();
                (done, _) = signal
                    .wait_timeout(done, Duration::from_millis(10))
                    .unwrap();
            }
        });
        Self { stopped, expired }
    }
    pub fn cancel(&self) {
        let (lock, signal) = &*self.stopped;
        *lock.lock().unwrap() = true;
        signal.notify_all();
    }
    pub fn expired(&self) -> bool {
        self.expired.load(Ordering::SeqCst)
    }
}
impl Drop for AcceptanceDeadline {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    #[test]
    fn cancels_stalled_io_until_acceptance_or_drop() {
        let (send, receive) = mpsc::channel();
        let deadline = AcceptanceDeadline::new(Duration::from_millis(10), move || {
            let _ = send.send(());
        });
        receive.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(deadline.expired());
        receive.recv_timeout(Duration::from_secs(1)).unwrap();
        deadline.cancel();
        while receive.try_recv().is_ok() {}
        assert!(receive.recv_timeout(Duration::from_millis(40)).is_err());
    }
    #[test]
    fn accepted_waiters_have_no_deadline() {
        let (send, receive) = mpsc::channel();
        let deadline = AcceptanceDeadline::new(Duration::from_millis(20), move || {
            let _ = send.send(());
        });
        deadline.cancel();
        assert!(receive.recv_timeout(Duration::from_millis(60)).is_err());
        assert!(!deadline.expired());
    }
}
