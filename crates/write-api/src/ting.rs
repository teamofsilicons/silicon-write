//! Silicon Ting: every notification Silicon Write sends goes through it.
//!
//! - When an account first uses Silicon Write, it is registered with Ting as a recipient, with a
//!   User verification proof (receiving app Ting, scope `subscriptions.register`) issued from that
//!   account's own access token.
//! - Notifications are written to an outbox in the same step as what caused them, and a worker
//!   sends them with Silicon Write's App verification proof (scope `tings.send`), retrying until
//!   Ting accepts them. Ting de-duplicates on each notification's key.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use silicon_accounts_client::types::{IssueAppVerification, IssueUserVerification};
use time::OffsetDateTime;
use tokio::sync::Mutex;

use crate::auth::Caller;
use crate::state::AppState;

static SEND_PROOF: LazyLock<Mutex<Option<(String, OffsetDateTime)>>> = LazyLock::new(|| Mutex::new(None));
/// Accounts being registered right now (a burst of first requests registers once).
static ENROLLING: LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> = LazyLock::new(Default::default);

/// Registers an account with Ting as a recipient of Silicon Write's notifications.
pub async fn enroll(state: &AppState, caller: &Caller) {
    let Some(ting) = state.config.ting_url.clone() else { return };
    if !ENROLLING.lock().unwrap().insert(caller.uuid.clone()) {
        return;
    }
    enroll_once(state, caller, &ting).await;
    ENROLLING.lock().unwrap().remove(&caller.uuid);
}

async fn enroll_once(state: &AppState, caller: &Caller, ting: &str) {
    let request = IssueUserVerification {
        subject_token: caller.token.clone(),
        receiving_app: state.config.ting_app_id.clone(),
        scopes: vec!["subscriptions.register".into()],
        access_ttl_seconds: Some(300),
    };
    let key = format!("write-ting-enroll-{}-{}", caller.uuid, OffsetDateTime::now_utc().unix_timestamp() / 600);
    let proof = match state.app().issue_user_verification(&request, Some(&key)).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(account = %caller.id, error = %e, "couldn't get a proof to register with Ting");
            return;
        }
    };
    let response = state
        .http
        .post(format!("{}/v1/subscriptions", ting.trim_end_matches('/')))
        .bearer_auth(proof.proof_token.expose())
        .json(&json!({ "app_id": state.config.app_id, "for": caller.id }))
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => {
            let body: Value = r.json().await.unwrap_or(Value::Null);
            let id = body.get("id").or_else(|| body.pointer("/subscription/id")).and_then(Value::as_str).map(str::to_owned);
            let _ = sqlx::query("update accounts set ting_subscription = $2, ting_enrolled_at = now() where uuid = $1")
                .bind(&caller.uuid)
                .bind(id)
                .execute(&state.db)
                .await;
            tracing::info!(account = %caller.id, "registered with Ting");
            // Notifications that waited for them go out now (including ones given up on before
            // waiting was a thing).
            let _ = sqlx::query(
                "update ting_outbox set status = 'pending', next_at = now(), attempts = 0
                 where for_uuid = $1 and (status = 'waiting' or (status = 'failed' and last_error like '%no_subscription%'))",
            )
            .bind(&caller.uuid)
            .execute(&state.db)
            .await;
        }
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            tracing::warn!(account = %caller.id, %status, body = %body.chars().take(300).collect::<String>(), "Ting refused the registration");
        }
        Err(e) => tracing::warn!(account = %caller.id, error = %e, "Ting didn't answer the registration"),
    }
}

/// Queues a notification. `key` makes it unique: queuing the same key twice sends it once.
pub async fn queue(state: &AppState, kind: &str, for_uuid: &str, key: &str, data: Value) -> sqlx::Result<()> {
    sqlx::query("insert into ting_outbox (type, for_uuid, key, data) values ($1, $2, $3, $4) on conflict (key) do nothing")
        .bind(kind)
        .bind(for_uuid)
        .bind(key)
        .bind(data)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn send_proof(state: &AppState) -> anyhow::Result<String> {
    let mut cached = SEND_PROOF.lock().await;
    if let Some((token, expires)) = cached.as_ref()
        && *expires - OffsetDateTime::now_utc() > time::Duration::minutes(2) {
            return Ok(token.clone());
        }
    let request = IssueAppVerification {
        receiving_app: state.config.ting_app_id.clone(),
        scopes: vec!["tings.send".into()],
        access_ttl_seconds: Some(1800),
    };
    let key = format!("write-ting-send-{}", OffsetDateTime::now_utc().unix_timestamp() / 60);
    let proof = state.app().issue_app_verification(&request, Some(&key)).await?;
    let expires = proof.expires_at.unwrap_or_else(|| OffsetDateTime::now_utc() + time::Duration::minutes(25));
    let token = proof.proof_token.expose().to_owned();
    *cached = Some((token.clone(), expires));
    Ok(token)
}

#[derive(sqlx::FromRow)]
struct Pending {
    id: i64,
    #[sqlx(rename = "type")]
    kind: String,
    for_uuid: String,
    key: String,
    data: Value,
    attempts: i32,
}

/// Sends queued notifications, forever.
pub async fn worker(state: AppState) {
    loop {
        if state.config.ting_url.is_some()
            && let Err(e) = send_due(&state).await {
                tracing::warn!(error = %e, "sending notifications failed");
            }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

async fn send_due(state: &AppState) -> anyhow::Result<()> {
    let Some(ting) = state.config.ting_url.clone() else { return Ok(()) };
    let due: Vec<Pending> = sqlx::query_as(
        "select id, type, for_uuid, key, data, attempts from ting_outbox where status = 'pending' and next_at <= now() order by id limit 50",
    )
    .fetch_all(&state.db)
    .await?;
    if due.is_empty() {
        return Ok(());
    }
    let proof = send_proof(state).await?;
    for item in due {
        let response = state
            .http
            .post(format!("{}/v1/tings", ting.trim_end_matches('/')))
            .bearer_auth(&proof)
            .json(&json!({ "type": item.kind, "for": item.for_uuid, "key": item.key, "data": item.data, "metadata": {} }))
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        let attempts = item.attempts + 1;
        match response {
            Ok(r) if r.status().is_success() => {
                sqlx::query("update ting_outbox set status = 'sent', sent_at = now(), attempts = $2, last_error = null where id = $1")
                    .bind(item.id)
                    .bind(attempts)
                    .execute(&state.db)
                    .await?;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                    *SEND_PROOF.lock().await = None;
                }
                // Someone who hasn't allowed Silicon Write at Ting yet (they haven't used it): the
                // notification waits for them, and goes out once they do (see `enroll`).
                if status == reqwest::StatusCode::CONFLICT {
                    sqlx::query("update ting_outbox set status = 'waiting', attempts = $2, last_error = $3 where id = $1")
                        .bind(item.id)
                        .bind(attempts)
                        .bind(format!("{status}: {}", body.chars().take(500).collect::<String>()))
                        .execute(&state.db)
                        .await?;
                    continue;
                }
                // A recipient who never registered can't be notified; keep the record and stop after a while.
                let give_up = status.is_client_error() && status != reqwest::StatusCode::TOO_MANY_REQUESTS && attempts >= 6;
                let delay = backoff(attempts);
                sqlx::query("update ting_outbox set status = $2, attempts = $3, last_error = $4, next_at = now() + make_interval(secs => $5) where id = $1")
                    .bind(item.id)
                    .bind(if give_up { "failed" } else { "pending" })
                    .bind(attempts)
                    .bind(format!("{status}: {}", body.chars().take(500).collect::<String>()))
                    .bind(delay)
                    .execute(&state.db)
                    .await?;
            }
            Err(e) => {
                sqlx::query("update ting_outbox set attempts = $2, last_error = $3, next_at = now() + make_interval(secs => $4) where id = $1")
                    .bind(item.id)
                    .bind(attempts)
                    .bind(e.to_string())
                    .bind(backoff(attempts))
                    .execute(&state.db)
                    .await?;
            }
        }
    }
    Ok(())
}

fn backoff(attempts: i32) -> f64 {
    (2f64.powi(attempts.min(16))).min(3600.0)
}
