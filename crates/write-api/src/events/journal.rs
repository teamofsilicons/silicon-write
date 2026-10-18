//! An honest, bounded resume window. Epochs change whenever a room is recreated.

use std::collections::VecDeque;
use std::sync::Arc;

use serde_json::{Value, json};

const CAPACITY: usize = 1024;

pub struct Journal {
    epoch: String,
    offset: u64,
    entries: VecDeque<(u64, Value)>,
    changed: Arc<tokio::sync::Notify>,
}

impl Default for Journal {
    fn default() -> Self {
        Self {
            epoch: crate::ids::new_id("e"),
            offset: 0,
            entries: VecDeque::new(),
            changed: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

impl Journal {
    pub fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.offset)
    }

    pub fn notifier(&self) -> Arc<tokio::sync::Notify> {
        self.changed.clone()
    }
    pub fn wake(&self) {
        self.changed.notify_waiters();
    }

    pub fn push(&mut self, mut event: Value) {
        self.offset += 1;
        event["cursor"] = json!(self.cursor());
        event["at"] = json!(
            time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        );
        self.entries.push_back((self.offset, event));
        if self.entries.len() > CAPACITY {
            self.entries.pop_front();
        }
        self.wake();
    }

    /// Only return events after a cursor this precise room can prove it still retains.
    pub fn after(&self, cursor: &str) -> Result<Vec<Value>, &'static str> {
        let (epoch, offset) = cursor.rsplit_once(':').ok_or("invalid_cursor")?;
        let offset: u64 = offset.parse().map_err(|_| "invalid_cursor")?;
        if epoch != self.epoch {
            return Err("room_recreated");
        }
        if offset > self.offset {
            return Err("cursor_ahead");
        }
        let earliest = self
            .entries
            .front()
            .map(|(n, _)| n.saturating_sub(1))
            .unwrap_or(self.offset);
        if offset < earliest {
            return Err("cursor_expired");
        }
        Ok(self
            .entries
            .iter()
            .filter(|(n, _)| *n > offset)
            .map(|(_, event)| event.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_document_and_comment_events_in_one_order_without_repeating_cursor() {
        let mut journal = Journal::default();
        let start = journal.cursor();
        journal.push(json!({"type":"document","seq":4}));
        let after_doc = journal.cursor();
        journal.push(json!({"type":"comments","thread_id":"t_a","activity_version":2}));
        let all = journal.after(&start).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["type"], "document");
        assert_eq!(all[1]["type"], "comments");
        assert_eq!(journal.after(&after_doc).unwrap(), all[1..]);
        assert!(journal.after(&journal.cursor()).unwrap().is_empty());
    }

    #[test]
    fn overflow_requires_reset_but_last_retained_boundary_can_resume() {
        let mut journal = Journal::default();
        let old = journal.cursor();
        journal.push(json!({"type":"document"}));
        let boundary = journal.cursor();
        for _ in 0..CAPACITY {
            journal.push(json!({"type":"comments"}));
        }
        assert_eq!(journal.after(&old), Err("cursor_expired"));
        assert_eq!(journal.after(&boundary).unwrap().len(), CAPACITY);
    }

    #[test]
    fn restart_different_doc_future_and_invalid_cursors_never_silently_resume() {
        let first = Journal::default();
        let second = Journal::default();
        assert_eq!(second.after(&first.cursor()), Err("room_recreated"));
        assert_eq!(
            first.after(&format!("{}:1", first.epoch)),
            Err("cursor_ahead")
        );
        for bad in ["", "anything", "e:wrong", "e:-1"] {
            assert_eq!(first.after(bad), Err("invalid_cursor"));
        }
    }
}
