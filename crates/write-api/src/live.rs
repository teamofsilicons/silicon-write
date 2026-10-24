//! Joining a doc live: the web editor asks for a short-lived ticket (with its signed-in session,
//! or none for a public doc), then opens a WebSocket with it. The ticket names the doc, the
//! account and the role, and is signed so it can't be altered.

use axum::Json;
use axum::http::HeaderMap;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use time::OffsetDateTime;

use crate::access::{self, Role};
use crate::accounts;
use crate::auth::MaybeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const TICKET_TTL: i64 = 600;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Serialize, Deserialize)]
struct Ticket {
    d: String,
    a: Option<String>,
    r: Role,
    e: i64,
    #[serde(default)]
    g: i64,
}

fn sign(state: &AppState, payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&state.config.ticket_secret).expect("hmac accepts any key");
    mac.update(payload.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn issue(state: &AppState, ticket: &Ticket) -> String {
    let payload = B64.encode(serde_json::to_vec(ticket).unwrap());
    format!("{payload}.{}", sign(state, &payload))
}

fn check(state: &AppState, token: &str) -> ApiResult<Ticket> {
    let (payload, signature) = token.split_once('.').ok_or_else(|| ApiError::unauthorized().hint("That live ticket isn't valid."))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&state.config.ticket_secret).expect("hmac accepts any key");
    mac.update(payload.as_bytes());
    let expected = B64.decode(signature).map_err(|_| ApiError::unauthorized())?;
    mac.verify_slice(&expected).map_err(|_| ApiError::unauthorized().hint("That live ticket isn't valid."))?;
    let ticket: Ticket = serde_json::from_slice(&B64.decode(payload).map_err(|_| ApiError::unauthorized())?).map_err(|_| ApiError::unauthorized())?;
    if ticket.e < OffsetDateTime::now_utc().unix_timestamp() {
        return Err(ApiError::unauthorized().hint("That live ticket expired; ask for a new one."));
    }
    Ok(ticket)
}

pub async fn ticket(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let (doc, role) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
    crate::visitors::ensure(&state, caller.as_ref(), &doc, &headers, false).await?;
    if doc.kind == "pdf" {
        return Err(ApiError::conflict("A PDF shown as it is has no live text.").hint("Turn it into a doc to edit it."));
    }
    let expires = OffsetDateTime::now_utc().unix_timestamp() + TICKET_TTL;
    let token = issue(&state, &Ticket { d: id.clone(), a: caller.as_ref().map(|c| c.uuid.clone()), r: role, e: expires, g: doc.email_gate_version });
    let base = state.config.api_url.trim_end_matches('/').replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let account = match &caller {
        Some(c) => Some(accounts::one(&state, &c.uuid).await?),
        None => None,
    };
    Ok(Json(json!({
        "url": format!("{base}/v1/live/{id}"),
        "ticket": token,
        "expires_at": OffsetDateTime::from_unix_timestamp(expires).ok().and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok()),
        "role": role,
        "account": account,
    })))
}

#[derive(Deserialize)]
pub struct LiveQuery {
    ticket: String,
}

pub async fn connect(State(state): State<AppState>, Path(id): Path<String>, Query(q): Query<LiveQuery>, ws: WebSocketUpgrade) -> ApiResult<Response> {
    let ticket = check(&state, &q.ticket)?;
    if ticket.d != id {
        return Err(ApiError::forbidden("That ticket is for another doc."));
    }
    let account = match &ticket.a {
        Some(uuid) => Some(accounts::one(&state, uuid).await?),
        None => None,
    };
    // The role may have changed since the ticket was issued.
    let doc = access::load_doc(&state, &id).await?;
    let caller = account.as_ref().map(|a| crate::auth::Caller { uuid: a.uuid.clone(), id: a.id.clone(), kind: a.kind.clone(), token: String::new() });
    let role = access::doc_role(&state, caller.as_ref(), &doc).await?.ok_or_else(|| ApiError::not_found("This doc"))?;
    if doc.require_email && doc.public_access != "none" && ticket.g != doc.email_gate_version { return Err(crate::visitors::required()); }
    let _ = ticket.r;
    Ok(ws
        .max_message_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| crate::rooms::serve(state, id, account, role, socket)))
}
