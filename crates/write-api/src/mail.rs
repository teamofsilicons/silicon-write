//! Invitation emails, for people invited by an email address that isn't on Silicon Accounts yet.
//! Sent through Postmark when `WRITE_POSTMARK_TOKEN` is set; otherwise they stay in the outbox
//! (local development reads them from `GET /v1/dev/outbox`).

use std::time::Duration;

use serde_json::json;

use crate::state::AppState;

pub async fn queue(state: &AppState, to: &str, subject: &str, body: &str) -> sqlx::Result<()> {
    sqlx::query("insert into email_outbox (to_email, subject, text_body) values ($1, $2, $3)")
        .bind(to)
        .bind(subject)
        .bind(body)
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn worker(state: AppState) {
    loop {
        if let Some(token) = state.config.postmark_token.clone()
            && let Err(e) = send_due(&state, &token).await {
                tracing::warn!(error = %e, "sending email failed");
            }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn send_due(state: &AppState, token: &str) -> anyhow::Result<()> {
    let due: Vec<(i64, String, String, String, i32)> = sqlx::query_as(
        "select id, to_email, subject, text_body, attempts from email_outbox where status = 'pending' order by id limit 20",
    )
    .fetch_all(&state.db)
    .await?;
    for (id, to, subject, body, attempts) in due {
        let result = state
            .http
            .post("https://api.postmarkapp.com/email")
            .header("X-Postmark-Server-Token", token)
            .json(&json!({ "From": state.config.mail_from, "To": to, "Subject": subject, "TextBody": body, "MessageStream": "outbound" }))
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        match result {
            Ok(r) if r.status().is_success() => {
                sqlx::query("update email_outbox set status = 'sent', sent_at = now() where id = $1").bind(id).execute(&state.db).await?;
            }
            Ok(r) => {
                let error = format!("{}: {}", r.status(), r.text().await.unwrap_or_default());
                let status = if attempts >= 5 { "failed" } else { "pending" };
                sqlx::query("update email_outbox set status = $2, attempts = attempts + 1, last_error = $3 where id = $1")
                    .bind(id)
                    .bind(status)
                    .bind(error)
                    .execute(&state.db)
                    .await?;
            }
            Err(e) => {
                sqlx::query("update email_outbox set attempts = attempts + 1, last_error = $2 where id = $1").bind(id).bind(e.to_string()).execute(&state.db).await?;
            }
        }
    }
    Ok(())
}
