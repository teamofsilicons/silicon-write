//! Incremental decoding of Silicon Write's server-sent document events.

use std::collections::VecDeque;
use std::pin::Pin;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};

const MAX_EVENT_BYTES: usize = 32 * 1024 * 1024;

/// One document event. JSON output can be stored with its cursor and resumed later.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentEvent {
    /// Opaque resume cursor, when this event advances the stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Event kind (for example `snapshot`, `change`, or `presence`).
    pub event: String,
    /// Event payload. Unknown fields and future event kinds are preserved.
    pub data: Value,
}

/// A live HTTP response. Dropping it closes the stream and its joined presence session.
pub struct DocumentEvents {
    chunks: Pin<Box<dyn Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>>,
    decoder: EventDecoder,
    ready: VecDeque<DocumentEvent>,
}

impl DocumentEvents {
    pub(crate) fn new(response: reqwest::Response) -> Self {
        Self {
            chunks: Box::pin(response.bytes_stream()),
            decoder: EventDecoder::default(),
            ready: VecDeque::new(),
        }
    }

    /// Waits for a full event, ignoring keepalives. `None` means the service closed the stream.
    /// Call the client's events method again with the last successfully consumed event id to resume.
    pub async fn next_event(&mut self) -> Result<Option<DocumentEvent>> {
        loop {
            if let Some(event) = self.ready.pop_front() {
                return Ok(Some(event));
            }
            let Some(chunk) = self.chunks.next().await else {
                // Never dispatch a partial frame; reconnecting with the previous cursor recovers it.
                return Ok(None);
            };
            let chunk = chunk.map_err(crate::client::network_error)?;
            self.ready.extend(self.decoder.push(&chunk)?);
        }
    }
}

#[derive(Default)]
struct EventDecoder {
    line: Vec<u8>,
    data: String,
    event: String,
    id: Option<String>,
    bytes: usize,
    after_cr: bool,
}

impl EventDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<DocumentEvent>> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                if let Some(event) = self.finish_line()? {
                    events.push(event);
                }
                self.after_cr = byte == b'\r';
            } else {
                self.bytes += 1;
                if self.bytes > MAX_EVENT_BYTES {
                    return Err(decode_error("A live event exceeded the 32 MiB limit."));
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }

    fn finish_line(&mut self) -> Result<Option<DocumentEvent>> {
        let line = String::from_utf8(std::mem::take(&mut self.line))
            .map_err(|_| decode_error("The live stream contained invalid UTF-8."))?;
        if line.is_empty() {
            self.bytes = 0;
            let data = std::mem::take(&mut self.data);
            let event = std::mem::take(&mut self.event);
            if data.is_empty() {
                return Ok(None);
            }
            let data = serde_json::from_str(data.trim_end_matches('\n'))
                .map_err(|_| decode_error("The live event was not valid JSON."))?;
            return Ok(Some(DocumentEvent {
                id: self.id.clone(),
                event: if event.is_empty() {
                    "message".into()
                } else {
                    event
                },
                data,
            }));
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = line.split_once(':').unwrap_or((&line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event = value.to_owned(),
            "id" if !value.contains('\0') => {
                self.id = if value.is_empty() {
                    None
                } else {
                    Some(value.to_owned())
                }
            }
            _ => {}
        }
        Ok(None)
    }
}

fn decode_error(message: &str) -> Error {
    Error::Decode { message: message.into(), hint: "Reconnect from your last consumed event cursor; if this repeats, report the service response.".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_split_utf8_and_crlf_frames() {
        let text = "id: epoch:7\r\nevent: comment\r\ndata: {\"body\":\"猫\"}\r\n\r\n";
        for split in 0..=text.len() {
            let mut decoder = EventDecoder::default();
            let mut events = decoder.push(&text.as_bytes()[..split]).unwrap();
            events.extend(decoder.push(&text.as_bytes()[split..]).unwrap());
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].id.as_deref(), Some("epoch:7"));
            assert_eq!(events[0].event, "comment");
            assert_eq!(events[0].data["body"], "猫");
        }
    }

    #[test]
    fn keeps_independent_comment_cursors_and_ignores_keepalive() {
        let mut decoder = EventDecoder::default();
        let events = decoder.push(b": ping\n\nid: e:8\nevent: document\ndata: {\"seq\":7}\n\nid: e:9\nevent: comment\ndata: {\"seq\":7}\n\n").unwrap();
        assert_eq!(events.len(), 2);
        assert_ne!(events[0].id, events[1].id);
        assert_eq!(events[0].data["seq"], events[1].data["seq"]);
    }

    #[test]
    fn supports_multiline_json_and_cursor_reset() {
        let mut decoder = EventDecoder::default();
        let events = decoder
            .push(b"id: e:1\ndata: {\n data: ignored\ndata: \"ok\":true}\n\nid:\ndata: {}\n\n")
            .unwrap();
        assert_eq!(events[0].data["ok"], true);
        assert_eq!(events[1].id, None);
    }

    #[test]
    fn rejects_invalid_json_without_emitting_a_partial_frame() {
        let mut decoder = EventDecoder::default();
        assert!(
            decoder
                .push(b"id: e:2\ndata: {\"part\":")
                .unwrap()
                .is_empty()
        );
        assert!(decoder.push(b"bad}\n\n").is_err());
    }

    #[test]
    fn bounds_unfinished_frames() {
        let mut decoder = EventDecoder {
            bytes: MAX_EVENT_BYTES,
            ..Default::default()
        };
        assert!(decoder.push(b"x").is_err());
    }
}
