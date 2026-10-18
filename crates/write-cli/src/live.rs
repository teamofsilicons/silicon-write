//! A normal agent-facing co-writing connection: context, resumable events, and real presence.

use std::io::Write;
use std::time::Duration;

use serde_json::{Value, json};
use silicon_write_client::DocumentEvent;
use tokio::time::Instant;

use crate::ctx::Ctx;
use crate::error::{CliError, CliResult};
use crate::resolve;

pub async fn context(ctx: &Ctx, doc: &str, revisions: u16) -> CliResult<()> {
    ctx.require_session()?;
    let id = resolve::doc_id(ctx, doc, false).await?;
    let mut snapshot = ctx.client.context(&id).await?;
    limit_history(&mut snapshot, revisions);
    ctx.emit(&snapshot, || {
        let threads = snapshot.threads.as_array().map_or(0, Vec::len);
        format!("{} ({id})\nRole: {} · seq {} · {} comment threads\nResume cursor: {}\n\n{}\n\nUse --json for passage anchors, comments, authors, permissions and live presence.",
            snapshot.doc.title, snapshot.doc.role, snapshot.seq, threads, snapshot.cursor, snapshot.markdown)
    });
    Ok(())
}

fn limit_history(context: &mut silicon_write_client::DocumentContext, count: u16) {
    if let Some(history) = context.revisions.as_array_mut()
        && history.len() > usize::from(count)
    {
        history.truncate(usize::from(count));
        context
            .extra
            .insert("revisions_truncated".into(), json!(true));
    }
}

type OutputMessage = (String, tokio::sync::oneshot::Sender<std::io::Result<()>>);

/// A bounded writer on a detached OS thread: a stalled stdout pipe must never
/// block async cancellation or keep a live presence connection open.
struct Output {
    sender: tokio::sync::mpsc::Sender<OutputMessage>,
}

impl Output {
    fn new() -> CliResult<Self> {
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<OutputMessage>(1);
        std::thread::Builder::new()
            .name("write-event-output".into())
            .spawn(move || {
                let mut output = std::io::stdout().lock();
                while let Some((line, done)) = receiver.blocking_recv() {
                    let result = writeln!(output, "{line}").and_then(|_| output.flush());
                    let failed = result.is_err();
                    let _ = done.send(result);
                    if failed {
                        break;
                    }
                }
            })
            .map_err(|error| CliError::io("Could not start the stream output writer.", error))?;
        Ok(Self { sender })
    }

    async fn emit(&self, json: bool, event: &str, id: Option<&str>, data: &Value) -> CliResult<()> {
        let (done, acknowledged) = tokio::sync::oneshot::channel();
        self.sender
            .send((format_event(json, event, id, data), done))
            .await
            .map_err(|_| {
                CliError::new(
                    "io",
                    "The stream output writer stopped.",
                    "Check the output destination.",
                )
            })?;
        acknowledged
            .await
            .map_err(|_| {
                CliError::new(
                    "io",
                    "The stream output writer stopped.",
                    "Check the output destination.",
                )
            })?
            .map_err(|error| CliError::io("Could not write the document stream.", error))
    }
}

fn format_event(json: bool, event: &str, id: Option<&str>, data: &Value) -> String {
    if json {
        let mut value = json!({ "event": event, "data": data });
        if let Some(id) = id {
            value["id"] = json!(id);
        }
        serde_json::to_string(&value).expect("JSON value serializes")
    } else {
        match event {
            "snapshot" | "reset" => {
                let context = &data["context"];
                format!(
                    "{}: {} · seq {} · cursor {}\n{}",
                    if event == "reset" {
                        "Resynced"
                    } else {
                        "Snapshot"
                    },
                    context["doc"]["title"].as_str().unwrap_or("Document"),
                    context["seq"],
                    id.unwrap_or(""),
                    context["markdown"].as_str().unwrap_or("")
                )
            }
            "connection" => match data["status"].as_str().unwrap_or("") {
                "joined" => format!(
                    "Joined {} as {}. Keep this command running to remain present; Ctrl+C leaves.",
                    data["document"].as_str().unwrap_or("the doc"),
                    data["account"]["id"]
                        .as_str()
                        .unwrap_or("your signed-in identity")
                ),
                "watching" => format!(
                    "Watching {}. Ctrl+C stops.",
                    data["document"].as_str().unwrap_or("the doc")
                ),
                "reconnecting" => {
                    "Connection interrupted; reconnecting from the last received cursor…".into()
                }
                "left" => "Left the document.".into(),
                _ => "Stopped watching.".into(),
            },
            "document" => format!(
                "Document changed · seq {} · author {} · cursor {}",
                data["seq"],
                data["author_uuid"].as_str().unwrap_or("unknown"),
                id.unwrap_or("")
            ),
            "comments" => format!(
                "Comments changed · cursor {}. Read `write context --json` for current threads.",
                id.unwrap_or("")
            ),
            "presence" => format!(
                "Presence: {}",
                serde_json::to_string(data).expect("JSON serializes")
            ),
            _ => format!(
                "{event}: {}",
                serde_json::to_string(data).expect("JSON serializes")
            ),
        }
    }
}

fn recoverable(error: &silicon_write_client::Error) -> bool {
    error.code() == "network"
        || error
            .status()
            .is_some_and(|status| status == 429 || status >= 500)
}

async fn stop_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// No writes are retried here: only the read-only event stream and its connection-scoped presence.
pub async fn watch(
    ctx: &Ctx,
    doc: &str,
    joined: bool,
    mut after: Option<String>,
    duration: Option<u64>,
) -> CliResult<()> {
    ctx.require_session()?;
    let id = resolve::doc_id(ctx, doc, false).await?;
    let account = if joined {
        Some(ctx.client.me().await?)
    } else {
        None
    };
    let deadline = duration
        .map(|seconds| {
            Instant::now()
                .checked_add(Duration::from_secs(seconds))
                .ok_or_else(|| {
                    CliError::invalid(
                        "That session duration is too large.",
                        "Use a shorter --duration in seconds.",
                    )
                })
        })
        .transpose()?;
    let stop = stop_signal();
    tokio::pin!(stop);
    let timeout = async {
        match deadline {
            Some(at) => tokio::time::sleep_until(at).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(timeout);
    let output = Output::new()?;
    let session = async {
        let mut backoff = 1u64;
        loop {
            let result = ctx
                .client
                .document_events(&id, joined, after.as_deref())
                .await;
            match result {
                Ok(mut events) => {
                    let mut announced = false;
                    loop {
                        let next = events.next_event().await;
                        match next {
                            Ok(Some(DocumentEvent {
                                id: cursor,
                                event,
                                data,
                            })) => {
                                if !announced {
                                    output.emit(
                                    ctx.json,
                                    "connection",
                                    after.as_deref(),
                                    &json!({ "status": if joined { "joined" } else { "watching" }, "document": id, "account": account }),
                                ).await?;
                                    announced = true;
                                    backoff = 1;
                                }
                                output
                                    .emit(ctx.json, &event, cursor.as_deref(), &data)
                                    .await?;
                                // Advance only after the complete event reached stdout.
                                if let Some(cursor) = cursor {
                                    after = Some(cursor);
                                }
                                if event == "reconnect" {
                                    break;
                                }
                                if event == "access" && data["role"].is_null() {
                                    return Err(CliError::new(
                                        data["error"]["code"].as_str().unwrap_or("forbidden"),
                                        data["error"]["message"]
                                            .as_str()
                                            .unwrap_or("Access to the document ended."),
                                        "Check your sign-in and document access before joining again.",
                                    ));
                                }
                            }
                            Ok(None) => break,
                            Err(error) if recoverable(&error) => break,
                            Err(error) => return Err(error.into()),
                        }
                    }
                    // Drop the old joined connection before starting another one.
                    drop(events);
                }
                Err(error) if recoverable(&error) => {}
                Err(error) => return Err(error.into()),
            }
            output
                .emit(
                    ctx.json,
                    "connection",
                    after.as_deref(),
                    &json!({ "status": "reconnecting", "document": id }),
                )
                .await?;
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(10);
        }
    };
    // Cancellation covers receiving, connecting, backoff AND blocked output.
    // Dropping the future closes the HTTP body before any final output attempt.
    tokio::select! {
        _ = &mut stop => {},
        _ = &mut timeout => {},
        result = session => return result,
    }
    let _ = tokio::time::timeout(
        Duration::from_millis(100),
        output.emit(
            ctx.json,
            "connection",
            after.as_deref(),
            &json!({ "status": if joined { "left" } else { "stopped" }, "document": id }),
        ),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use silicon_write_client::Error;

    #[test]
    fn compact_history_preserves_context_and_reports_truncation() {
        let mut context: silicon_write_client::DocumentContext = serde_json::from_value(json!({
            "cursor":"e:1","doc":{"id":"d_1"},"seq":42,"markdown":"text","prosemirror":{},
            "threads":[{"activity_version":2}],"authors":{},"revisions":[{"seq":42},{"seq":41}],
            "revisions_truncated":false,"presence":[]
        }))
        .unwrap();
        limit_history(&mut context, 1);
        assert_eq!(context.revisions, json!([{"seq":42}]));
        assert_eq!(context.extra["revisions_truncated"], true);
        assert_eq!(context.threads[0]["activity_version"], 2);
        assert_eq!(context.cursor, "e:1");
        context.revisions = Value::Null;
        limit_history(&mut context, 0);
        assert!(
            context.revisions.is_null(),
            "viewer permissions remain explicit"
        );
    }

    #[test]
    fn access_and_protocol_errors_are_terminal() {
        for status in [400, 401, 403, 404, 409] {
            assert!(!recoverable(&Error::Api {
                status,
                code: "test".into(),
                message: "test".into(),
                hint: None,
                details: None
            }));
        }
        assert!(!recoverable(&Error::Decode {
            message: "bad frame".into(),
            hint: "retry".into()
        }));
        assert!(recoverable(&Error::Api {
            status: 503,
            code: "unavailable".into(),
            message: "retry".into(),
            hint: None,
            details: None
        }));
    }
}
