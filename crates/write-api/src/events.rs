//! Agent workflow: finite structured context, resumable changes, and explicit connected presence.
//! A cursor is an in-memory room epoch and offset, not a durable revision or a global timestamp.
//! Snapshot cursors precede their reads: replay may repeat represented changes, never skip them.

pub mod journal;

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::stream;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use write_doc::ydoc;
use yrs::Transact;
use yrs::updates::decoder::Decode;

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::auth::{Auth, Caller};
use crate::error::{ApiError, ApiResult};
use crate::rooms::Room;
use crate::state::AppState;
use crate::{comments, content, views};

const ACCESS_RECHECK: Duration = Duration::from_secs(1);
const STREAM_LIFETIME: Duration = Duration::from_secs(240);

fn failure_event(error: &ApiError) -> Value {
    let retry = error.status.is_server_error()
        || matches!(
            error.status,
            StatusCode::CONFLICT | StatusCode::TOO_MANY_REQUESTS
        );
    if retry {
        json!({"type":"reconnect","reason":"temporarily_unavailable","error":{"code":error.code,"message":error.message}})
    } else {
        json!({"type":"access","role":null,"error":{"code":error.code,"message":error.message}})
    }
}

/// Human-readable browser selection hints are advisory, bounded, and never stable anchors.
pub fn location(value: &Value) -> Option<Value> {
    let block = value.get("block_index")?.as_u64()?;
    let from = value.get("from")?.as_u64()?;
    let to = value.get("to")?.as_u64()?;
    if block > 1_000_000 || from > to || to > 10_000_000 {
        return None;
    }
    let mode = value.get("mode")?.as_str()?;
    if !matches!(mode, "editing" | "suggesting" | "viewing") {
        return None;
    }
    let at = value.get("updated_at")?.as_str()?;
    if at.len() > 40
        || OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).is_err()
    {
        return None;
    }
    let quote: String = value.get("quote")?.as_str()?.chars().take(240).collect();
    Some(json!({"block_index":block,"from":from,"to":to,"quote":quote,"mode":mode,"updated_at":at}))
}

pub async fn context(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    let room = state.rooms.get(&state, &id).await?;
    Ok(Json(snapshot(&state, &caller, &room).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_locations_are_bounded_whitelisted_and_unknown_locations_stay_unknown() {
        let mut value = json!({"block_index":2,"from":6,"to":12,"quote":"hello","mode":"editing","updated_at":"2026-10-18T10:00:00Z","user":{"id":"si:forged"}});
        let safe = location(&value).unwrap();
        assert!(safe.get("user").is_none());
        value["quote"] = json!("日".repeat(500));
        assert_eq!(
            location(&value).unwrap()["quote"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            240
        );
        value["from"] = json!(13);
        assert!(location(&value).is_none());
        value["from"] = json!(-1);
        assert!(location(&value).is_none());
        assert!(location(&Value::Null).is_none());
        assert!(location(&json!({})).is_none());
    }

    #[test]
    fn transient_failure_is_not_reported_as_revoked_access() {
        assert_eq!(
            failure_event(&ApiError::unavailable("Retry"))["type"],
            "reconnect"
        );
        assert_eq!(
            failure_event(&ApiError::conflict("Role changed"))["type"],
            "reconnect"
        );
        assert_eq!(failure_event(&ApiError::not_found("Doc"))["type"], "access");
        assert_eq!(
            failure_event(&ApiError::forbidden("Removed"))["role"],
            Value::Null
        );
    }
}

async fn snapshot(state: &AppState, caller: &Caller, room: &Arc<Room>) -> ApiResult<Value> {
    let (row, role) = access::require_doc(state, Some(caller), &room.doc_id, Role::Viewer).await?;
    // Nothing asynchronous after capture may advance this cursor: the stream replays all
    // changes published during the independent content/comment/metadata reads below.
    let (mut doc, seq, clients, per_block, cursor, presence) = {
        let inner = room.inner.lock().await;
        let copy = ydoc::new_ydoc(1);
        copy.transact_mut()
            .apply_update(yrs::Update::decode_v1(&inner.full_state()).map_err(ApiError::internal)?)
            .map_err(ApiError::internal)?;
        (
            ydoc::read_doc(&copy),
            inner.seq,
            inner.clients.clone(),
            ydoc::block_authors(&copy),
            inner.events.cursor(),
            inner.presence(),
        )
    };
    if row.kind == "pdf" {
        doc = content::pdf_doc(state, &row).await?;
    }
    if role == Role::Viewer {
        doc = doc.without_suggestions();
    }
    let current_authors: Vec<_> = per_block
        .iter()
        .flatten()
        .filter_map(|id| clients.get(id).cloned())
        .collect();
    let people = accounts::many(state, &current_authors).await?;
    let mut account_list: Vec<_> = people.values().cloned().collect();
    account_list.sort_by(|a, b| a.uuid.cmp(&b.uuid));
    let blocks: Vec<_> = per_block
        .into_iter()
        .enumerate()
        .map(|(index, ids)| {
            let mut authors: Vec<Account> = ids
                .into_iter()
                .filter_map(|id| people.get(clients.get(&id)?).cloned())
                .collect();
            authors.sort_by(|a, b| a.uuid.cmp(&b.uuid));
            authors.dedup_by(|a, b| a.uuid == b.uuid);
            json!({"index":index,"authors":authors})
        })
        .collect();
    let threads = if role >= Role::Commenter {
        json!(comments::snapshot(state, &room.doc_id, &caller.uuid).await?)
    } else {
        Value::Null
    };
    let mut revisions = Value::Null;
    let mut revisions_truncated = false;
    if role >= Role::Editor {
        let mut rows: Vec<(i64, String, String, OffsetDateTime)> = sqlx::query_as("select seq, author_uuid, origin, created_at from doc_updates where doc_id = $1 and seq <= $2 order by seq desc limit 101")
            .bind(&room.doc_id).bind(seq).fetch_all(&state.db).await?;
        revisions_truncated = rows.len() > 100;
        rows.truncate(100);
        let people =
            accounts::many(state, &rows.iter().map(|r| r.1.clone()).collect::<Vec<_>>()).await?;
        revisions = json!(rows.into_iter().map(|(seq, author, origin, at)| json!({"seq":seq,"author":people.get(&author).cloned().unwrap_or_else(|| Account::unknown(&author)),"origin":origin,"created_at":at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()})).collect::<Vec<_>>());
    }
    let mut doc_view = views::doc_view(state, &row, role, Some(&caller.uuid)).await?;
    doc_view.seq = seq;
    // A share may change during the reads. Never send fields authorized only by an old role.
    let (_, final_role) =
        access::require_doc(state, Some(caller), &room.doc_id, Role::Viewer).await?;
    if final_role != role {
        return Err(ApiError::conflict(
            "Your access changed while reading the doc. Try again.",
        ));
    }
    Ok(json!({
        "doc":doc_view,"seq":seq,"markdown":write_doc::to_markdown(&doc),"prosemirror":write_doc::prosemirror::to_json(&doc),
        "threads":threads,"revisions":revisions,"revisions_truncated":revisions_truncated,
        "authors":{"accounts":account_list,"blocks":blocks},"presence":presence,
        "permissions":{"comments":role >= Role::Commenter,"revisions":role >= Role::Editor},"cursor":cursor,
    }))
}

#[derive(Deserialize)]
pub struct Options {
    after: Option<String>,
}

type Events = Response;

pub async fn watch(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Query(options): Query<Options>,
    headers: HeaderMap,
) -> ApiResult<Events> {
    open(state, caller, id, options, headers, false).await
}

pub async fn join(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Query(options): Query<Options>,
    headers: HeaderMap,
) -> ApiResult<Events> {
    open(state, caller, id, options, headers, true).await
}

/// Owned by the response body. Dropping an aborted or disconnected stream removes presence.
struct Presence {
    room: Arc<Room>,
    id: u64,
}

impl Drop for Presence {
    fn drop(&mut self) {
        let room = self.room.clone();
        let id = self.id;
        tokio::spawn(async move {
            room.inner.lock().await.leave(id);
        });
    }
}

struct Session {
    state: AppState,
    caller: Caller,
    room: Arc<Room>,
    after: Option<String>,
    presence: Option<Presence>,
    last_presence: Option<Value>,
    role: Role,
    started: Instant,
    last_heartbeat: Instant,
    ended: bool,
}

async fn open(
    state: AppState,
    caller: Caller,
    id: String,
    options: Options,
    headers: HeaderMap,
    joined: bool,
) -> ApiResult<Events> {
    let (_, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    let after = options.after.or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    });
    if after
        .as_ref()
        .is_some_and(|c| c.len() > 128 || c.chars().any(char::is_control))
    {
        return Err(ApiError::invalid("That event cursor is invalid."));
    }
    let room = state.rooms.get(&state, &id).await?;
    let presence = if joined {
        let account = accounts::one(&state, &caller.uuid).await?;
        let id = room.inner.lock().await.join(account);
        Some(Presence {
            room: room.clone(),
            id,
        })
    } else {
        None
    };
    let session = Session {
        state,
        caller,
        room,
        after,
        presence,
        last_presence: None,
        role,
        started: Instant::now(),
        last_heartbeat: Instant::now(),
        ended: false,
    };
    Ok(Sse::new(stream::unfold(session, |mut session| async move {
        if session.ended {
            return None;
        }
        let value = match session.next().await {
            Ok(value) => value,
            Err(error) => {
                session.end().await;
                failure_event(&error)
            }
        };
        let mut event = Event::default()
            .event(value["type"].as_str().unwrap_or("message"))
            .data(value.to_string());
        if let Some(cursor) = value.get("cursor").and_then(Value::as_str) {
            event = event.id(cursor);
        }
        Some((Ok::<Event, Infallible>(event), session))
    }))
    .keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
    .into_response())
}

impl Session {
    async fn end(&mut self) {
        self.ended = true;
        if let Some(presence) = self.presence.take() {
            presence.room.inner.lock().await.leave(presence.id);
        }
    }

    async fn next(&mut self) -> ApiResult<Value> {
        loop {
            if self.started.elapsed() >= STREAM_LIFETIME {
                self.end().await;
                return Ok(json!({"type":"reconnect","reason":"session_refresh"}));
            }
            // Revalidate expiry/signature without the account-registration side effects of Auth.
            let keys = self.state.jwks(false).await.map_err(ApiError::internal)?;
            if self
                .state
                .app()
                .verify_access_token_locally(&keys, &self.caller.token)
                .is_err()
            {
                self.end().await;
                return Ok(json!({"type":"reconnect","reason":"authentication_refresh"}));
            }
            let (_, role) = access::require_doc(
                &self.state,
                Some(&self.caller),
                &self.room.doc_id,
                Role::Viewer,
            )
            .await?;
            let current = self.state.rooms.get(&self.state, &self.room.doc_id).await?;
            if !Arc::ptr_eq(&current, &self.room) {
                let joined = self.presence.take().is_some();
                self.room = current;
                if joined {
                    let account = accounts::one(&self.state, &self.caller.uuid).await?;
                    let id = self.room.inner.lock().await.join(account);
                    self.presence = Some(Presence {
                        room: self.room.clone(),
                        id,
                    });
                }
            }
            if role != self.role {
                self.role = role;
                return Ok(json!({"type":"access","role":role}));
            }
            // Register before inspecting the journal so a change between the read and wait
            // cannot be lost. Idle streams only query permissions once per second.
            let notifier = self.room.inner.lock().await.events.notifier();
            let notified = notifier.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let replay = {
                let inner = self.room.inner.lock().await;
                self.after.as_deref().map(|after| inner.events.after(after))
            };
            match replay {
                None | Some(Err(_)) => {
                    let reason = match replay {
                        Some(Err(reason)) => Some(reason),
                        _ => None,
                    };
                    let context = snapshot(&self.state, &self.caller, &self.room).await?;
                    self.after = context["cursor"].as_str().map(str::to_owned);
                    self.last_presence = Some(context["presence"].clone());
                    return Ok(
                        json!({"type":if reason.is_some() {"reset"} else {"snapshot"},"cursor":self.after,"reason":reason,"context":context}),
                    );
                }
                Some(Ok(events)) => {
                    for event in events {
                        self.after = event["cursor"].as_str().map(str::to_owned);
                        if event["type"] == "comments" && role < Role::Commenter {
                            continue;
                        }
                        return Ok(event);
                    }
                }
            }
            let mut inner = self.room.inner.lock().await;
            if self.last_heartbeat.elapsed() >= Duration::from_secs(10) {
                if let Some(presence) = &self.presence {
                    inner.heartbeat_join(presence.id);
                }
                self.last_heartbeat = Instant::now();
            }
            let presence = json!(inner.presence());
            drop(inner);
            if self.last_presence.as_ref() != Some(&presence) {
                self.last_presence = Some(presence.clone());
                return Ok(json!({"type":"presence","participants":presence}));
            }
            tokio::select! {
                _ = &mut notified => {},
                _ = tokio::time::sleep(ACCESS_RECHECK) => {},
            }
        }
    }
}
