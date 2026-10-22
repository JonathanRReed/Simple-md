use std::time::{Duration, Instant};

pub struct PendingPeek<T> {
    next: u64,
    active: Option<(u64, Instant, T)>,
}

const LIFETIME: Duration = Duration::from_secs(2);

impl<T> PendingPeek<T> {
    pub const fn new() -> Self {
        Self {
            next: 0,
            active: None,
        }
    }

    pub fn begin(&mut self, now: Instant, context: T) -> Option<u64> {
        if self
            .active
            .as_ref()
            .is_some_and(|(_, at, _)| now.duration_since(*at) < LIFETIME)
        {
            return None;
        }
        self.next += 1;
        let id = self.next;
        self.active = Some((id, now, context));
        Some(id)
    }

    pub fn context(&self, now: Instant, id: u64) -> Option<&T> {
        let (active, at, context) = self.active.as_ref()?;
        (*active == id && now.duration_since(*at) < LIFETIME).then_some(context)
    }

    pub fn take(&mut self, now: Instant, id: u64) -> Option<T> {
        self.context(now, id)?;
        self.active.take().map(|(_, _, context)| context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_is_consumed_once_and_old_ack_cannot_consume_new_request() {
        let now = Instant::now();
        let mut pending = PendingPeek::new();
        let first = pending.begin(now, "first window").unwrap();
        assert_eq!(pending.begin(now, "second window"), None);
        assert_eq!(pending.take(now, first), Some("first window"));
        assert_eq!(pending.take(now, first), None);
        let second = pending.begin(now, "second window").unwrap();
        assert_ne!(first, second);
        assert_eq!(pending.take(now, first), None);
        assert_eq!(pending.take(now, second), Some("second window"));
    }

    #[test]
    fn expired_request_cannot_replay_and_does_not_block_new_keys() {
        let now = Instant::now();
        let mut pending = PendingPeek::new();
        let first = pending.begin(now, "stale window").unwrap();
        let later = now + LIFETIME;
        assert_eq!(pending.context(later, first), None);
        assert_eq!(pending.take(later, first), None);
        let second = pending.begin(later, "current window").unwrap();
        assert_eq!(pending.take(later, first), None);
        assert_eq!(pending.take(later, second), Some("current window"));
    }
}
