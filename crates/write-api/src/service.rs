//! Health, the Silicon Accounts webhook, and the development outbox.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

use crate::accounts;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub async fn healthz() -> &'static str {
    "ok"
}

pub async fn readyz(State(state): State<AppState>) -> ApiResult<&'static str> {
    sqlx::query("select 1").execute(&state.db).await?;
    Ok("ready")
}

/// Silicon Accounts tells us when an account's id, name or photo changes, or it's deleted.
pub async fn accounts_webhook(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<StatusCode> {
    let Some(secret) = state.config.accounts_webhook_secret.clone() else {
        return Err(ApiError::unavailable("The Silicon Accounts webhook isn't set up here."));
    };
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let event = silicon_accounts_client::verify_and_parse_webhook(
        &secret,
        &header(silicon_accounts_client::TIMESTAMP_HEADER),
        &header(silicon_accounts_client::SIGNATURE_HEADER),
        &body,
        silicon_accounts_client::DEFAULT_WEBHOOK_TOLERANCE,
    )
    .map_err(|e| ApiError::unauthorized().hint(format!("The delivery's signature didn't check out: {e}")))?;
    if let Some(uuid) = event.data.get("uuid").and_then(Value::as_str) {
        let _ = accounts::refresh(&state, uuid).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Local development only: the emails and notifications that would have been sent.
pub async fn dev_outbox(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    if !state.config.dev {
        return Err(ApiError::not_found("This page"));
    }
    let emails: Vec<(i64, String, String, String, String)> = sqlx::query_as("select id, to_email, subject, text_body, status from email_outbox order by id desc limit 100")
        .fetch_all(&state.db)
        .await?;
    type TingRow = (i64, String, String, String, Value, String, Option<String>);
    let tings: Vec<TingRow> =
        sqlx::query_as("select id, type, for_uuid, key, data, status, last_error from ting_outbox order by id desc limit 200").fetch_all(&state.db).await?;
    Ok(Json(json!({
        "emails": emails.into_iter().map(|(id, to, subject, body, status)| json!({ "id": id, "to": to, "subject": subject, "body": body, "status": status })).collect::<Vec<_>>(),
        "tings": tings.into_iter().map(|(id, kind, for_uuid, key, data, status, error)| json!({ "id": id, "type": kind, "for": for_uuid, "key": key, "data": data, "status": status, "error": error })).collect::<Vec<_>>(),
    })))
}
