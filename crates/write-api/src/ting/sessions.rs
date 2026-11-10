//! Ephemeral Ting receivers for open Write pages. The gateway owns an anonymous
//! Ting socket; a random binding capability proves that an HTTP subscriber owns
//! that socket. Write authorization (including email gates) is checked separately.
//! No account tokens or document content cross Ting's live notification channel.
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{
    Path, State,
    ws::{Message, WebSocket, WebSocketUpgrade},
};
use axum::http::HeaderMap;
use axum::response::Response;
use futures::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, Role};
use crate::auth::{Caller, MaybeAuth};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const LEASE: Duration = Duration::from_secs(60);
const MAX_SESSIONS: usize = 2048;
const MAX_DOCS: usize = 100;

#[derive(Clone)]
struct Subscription {
    caller: Option<Caller>,
    gate_version: i64,
    expires: Instant,
}
struct Receiver {
    binding: String,
    docs: HashMap<String, Subscription>,
    revisions: HashMap<String, u64>,
}
#[derive(Default)]
struct Inner {
    receivers: HashMap<String, Receiver>,
    dirty: HashMap<String, BTreeSet<String>>,
}
#[derive(Default)]
pub struct Sessions(Mutex<Inner>);

impl Sessions {
    pub fn changed(&self, doc: &str, change: &str) {
        if !matches!(change, "meta" | "threads" | "document") {
            return;
        }
        let mut inner = self.0.lock().unwrap();
        if inner
            .receivers
            .values()
            .any(|r| r.docs.get(doc).is_some_and(|s| s.expires > Instant::now()))
        {
            inner
                .dirty
                .entry(doc.into())
                .or_default()
                .insert(change.into());
        }
    }

    fn insert(&self, session: &str, binding: &str) -> ApiResult<()> {
        let mut inner = self.0.lock().unwrap();
        if inner.receivers.len() >= MAX_SESSIONS {
            return Err(ApiError::unavailable(
                "Live notifications are busy. Try again shortly.",
            ));
        }
        inner.receivers.insert(
            session.into(),
            Receiver {
                binding: binding.into(),
                docs: HashMap::new(),
                revisions: HashMap::new(),
            },
        );
        Ok(())
    }

    fn bind(
        &self,
        request: &Watch,
        doc: &str,
        subscription: Option<Subscription>,
    ) -> ApiResult<bool> {
        let mut inner = self.0.lock().unwrap();
        let receiver = inner
            .receivers
            .get_mut(&request.session_id)
            .filter(|r| r.binding == request.binding)
            .ok_or_else(|| {
                ApiError::conflict(
                    "The live notification session ended. Reconnect to receive updates.",
                )
            })?;
        receiver.docs.retain(|_, s| s.expires > Instant::now());
        if receiver
            .revisions
            .get(doc)
            .is_some_and(|revision| *revision >= request.revision)
        {
            return Ok(receiver.docs.contains_key(doc));
        }
        if !receiver.revisions.contains_key(doc) && receiver.revisions.len() >= 512 {
            return Err(ApiError::conflict(
                "Reconnect the notification session to open more documents.",
            ));
        }
        if let Some(subscription) = subscription {
            if !receiver.docs.contains_key(doc) && receiver.docs.len() >= MAX_DOCS {
                return Err(ApiError::invalid(
                    "Too many documents in this notification session.",
                ));
            }
            receiver.docs.insert(doc.into(), subscription);
        } else {
            receiver.docs.remove(doc);
        }
        receiver.revisions.insert(doc.into(), request.revision);
        Ok(receiver.docs.contains_key(doc))
    }

    fn remove(&self, session: &str) {
        self.0.lock().unwrap().receivers.remove(session);
    }

    fn due(&self) -> Vec<(String, String, Subscription, Vec<String>)> {
        let mut inner = self.0.lock().unwrap();
        let dirty = std::mem::take(&mut inner.dirty);
        let mut due = vec![];
        for (session, receiver) in &mut inner.receivers {
            receiver.docs.retain(|_, s| s.expires > Instant::now());
            for (doc, changes) in &dirty {
                if let Some(subscription) = receiver.docs.get(doc) {
                    due.push((
                        session.clone(),
                        doc.clone(),
                        subscription.clone(),
                        changes.iter().cloned().collect(),
                    ));
                }
            }
        }
        due
    }
}

pub async fn config(State(state): State<AppState>) -> Json<Value> {
    Json(
        json!({"enabled": state.config.ting_url.is_some(), "url": format!("{}/v1/ting/live", state.config.api_url.trim_end_matches('/').replacen("https://", "wss://", 1).replacen("http://", "ws://", 1))}),
    )
}

pub async fn connect(State(state): State<AppState>, ws: WebSocketUpgrade) -> ApiResult<Response> {
    if state.config.ting_url.is_none() {
        return Err(ApiError::unavailable(
            "Live notifications are not configured.",
        ));
    }
    Ok(ws
        .max_message_size(4096)
        .on_upgrade(move |socket| async move {
            if let Err(error) = relay(state, socket).await {
                tracing::debug!(error = %error, "live notification session ended");
            }
        }))
}

/// Cleanup also runs when the browser disconnects, a task is cancelled, or Ting fails.
struct Connection {
    state: AppState,
    id: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.state.rooms.notifications.remove(&self.id);
    }
}

async fn relay(state: AppState, mut browser: WebSocket) -> anyhow::Result<()> {
    // No browser cookie or Accounts credential is forwarded to Ting. Only Write
    // subscribes this anonymous receiver, so its inbox cannot attach other accounts.
    let client = ting_client::Client::new(state.config.ting_url.as_deref().unwrap())?;
    let mut ting = ting_client::websocket::WebSocket::connect(&client).await?;
    ting.register(&[state.config.app_id.clone()], None).await?;
    let id = ting.session_id().to_owned();
    let binding = crate::ids::new_id("binding");
    state
        .rooms
        .notifications
        .insert(&id, &binding)
        .map_err(|e| anyhow::anyhow!(e.message))?;
    let _connection = Connection {
        state,
        id: id.clone(),
    };
    browser
        .send(Message::Text(
            json!({"op":"ready","session_id":id,"binding":binding,"lease_seconds":LEASE.as_secs()})
                .to_string()
                .into(),
        ))
        .await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut last_pong = Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                // Browsers automatically pong. A vanished browser must not leave
                // an otherwise healthy upstream Ting receiver alive indefinitely.
                if last_pong.elapsed() > Duration::from_secs(10) { return Ok(()); }
                tokio::time::timeout(Duration::from_secs(5), browser.send(Message::Ping(Vec::new().into()))).await??;
            }
            message = browser.next() => {
                // Receiver-only endpoint: browser messages cannot publish tings or attach identities.
                match message {
                    Some(Ok(Message::Ping(bytes))) => browser.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Pong(_))) => { last_pong = Instant::now(); },
                    _ => return Ok(()),
                }
            }
            event = ting.next_event() => {
                let event = event?;
                tokio::time::timeout(Duration::from_secs(5), browser.send(Message::Text(serde_json::to_string(&event)?.into()))).await??;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Watch {
    session_id: String,
    binding: String,
    revision: u64,
    #[serde(default)]
    remove: bool,
}

pub async fn watch(
    State(state): State<AppState>,
    MaybeAuth(mut caller): MaybeAuth,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Watch>,
) -> ApiResult<Json<Value>> {
    if request.session_id.len() > 200
        || request.binding.len() > 200
        || request.revision == 0
        || request.revision > 9_007_199_254_740_991
    {
        return Err(ApiError::invalid("Invalid notification session."));
    }
    let subscription = if request.remove {
        None
    } else {
        let (doc, _) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
        crate::visitors::ensure(&state, caller.as_ref(), &doc, &headers, false).await?;
        // Leases store identity, never a reusable access credential.
        if let Some(caller) = &mut caller {
            caller.token.clear();
        }
        Some(Subscription {
            caller,
            gate_version: doc.email_gate_version,
            expires: Instant::now() + LEASE,
        })
    };
    let active = state
        .rooms
        .notifications
        .bind(&request, &id, subscription)?;
    Ok(Json(
        json!({"active": active, "lease_seconds":LEASE.as_secs()}),
    ))
}

pub async fn worker(state: AppState) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let due = state.rooms.notifications.due();
        if due.is_empty() {
            continue;
        }
        if let Err(error) = dispatch(&state, due).await {
            // Hints are expendable. Never put a dead session in the durable outbox
            // or reroute its notification to another session/account.
            tracing::debug!(%error, "live notification hints unavailable");
        }
    }
}

async fn dispatch(
    state: &AppState,
    due: Vec<(String, String, Subscription, Vec<String>)>,
) -> anyhow::Result<()> {
    super::ensure_types(state).await?;
    let proof = super::send_proof(state).await?;
    let base = state
        .config
        .ting_url
        .as_deref()
        .unwrap()
        .trim_end_matches('/');
    stream::iter(due).for_each_concurrent(8, |(session, doc_id, sub, mut changes)| {
        let proof = &proof;
        async move {
            let Ok((doc, role)) = access::require_doc(state, sub.caller.as_ref(), &doc_id, Role::Viewer).await else { return };
            if sub.expires <= Instant::now() || doc.email_gate_version != sub.gate_version { return; }
            if role < Role::Commenter { changes.retain(|c| c != "threads"); }
            if changes.is_empty() { return; }
            let body = json!({"type":"write.documentChanged","session_id":session,"key":crate::ids::new_id("hint"),"data":{"doc_id":doc_id,"changes":changes},"metadata":{}});
            // A fresh key denotes one new coalesced hint, never a retry of an uncertain send.
            if let Ok(response) = state.http.post(format!("{base}/v1/tings")).bearer_auth(proof).json(&body).timeout(Duration::from_secs(5)).send().await {
                if response.status() == reqwest::StatusCode::UNAUTHORIZED || response.status() == reqwest::StatusCode::FORBIDDEN {
                    *state.ting.send_proof.lock().await = None;
                }
            }
        }
    }).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn watch(session: &str, binding: &str) -> Watch {
        Watch {
            session_id: session.into(),
            binding: binding.into(),
            remove: false,
            revision: 1,
        }
    }
    fn subscription() -> Subscription {
        Subscription {
            caller: None,
            gate_version: 0,
            expires: Instant::now() + LEASE,
        }
    }

    #[test]
    fn capability_is_required_and_changes_are_coalesced_per_live_session() {
        let sessions = Sessions::default();
        sessions.insert("a", "secret-a").unwrap();
        sessions.insert("b", "secret-b").unwrap();
        assert!(
            sessions
                .bind(&watch("a", "secret-b"), "private", Some(subscription()))
                .is_err()
        );
        sessions
            .bind(&watch("a", "secret-a"), "doc", Some(subscription()))
            .unwrap();
        sessions
            .bind(&watch("b", "secret-b"), "other", Some(subscription()))
            .unwrap();
        sessions.changed("doc", "threads");
        sessions.changed("doc", "threads");
        sessions.changed("doc", "meta");
        let due = sessions.due();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "a");
        assert_eq!(due[0].3, ["meta", "threads"]);
        assert!(sessions.due().is_empty());
    }

    #[test]
    fn disconnect_unwatch_and_expired_leases_never_reroute() {
        let sessions = Sessions::default();
        sessions.insert("a", "secret").unwrap();
        let mut expired = subscription();
        expired.expires = Instant::now() - LEASE;
        sessions
            .bind(&watch("a", "secret"), "old", Some(expired))
            .unwrap();
        sessions.changed("old", "document");
        assert!(sessions.due().is_empty());
        sessions
            .bind(&watch("a", "secret"), "doc", Some(subscription()))
            .unwrap();
        sessions.changed("doc", "meta");
        sessions
            .bind(
                &Watch {
                    revision: 2,
                    ..watch("a", "secret")
                },
                "doc",
                None,
            )
            .unwrap();
        assert!(sessions.due().is_empty());
        sessions
            .bind(
                &Watch {
                    revision: 3,
                    ..watch("a", "secret")
                },
                "doc",
                Some(subscription()),
            )
            .unwrap();
        sessions.changed("doc", "meta");
        sessions.remove("a");
        assert!(sessions.due().is_empty());
        assert!(
            sessions
                .bind(&watch("a", "secret"), "doc", Some(subscription()))
                .is_err()
        );
    }
}
