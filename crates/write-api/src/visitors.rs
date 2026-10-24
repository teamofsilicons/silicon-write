//! Optional public-link email collection. An entered address is a claim, never authentication.
use crate::{
    access::{self, DocRow, Role},
    accounts,
    auth::{Auth, Caller, MaybeAuth},
    error::{ApiError, ApiResult},
    ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "email_required",
        "Enter your email to view this file.",
    )
    .hint("The file owner will see your email. No sign-in or email verification is required.")
}
fn normalize_email(value: &str) -> ApiResult<String> {
    let value = value.trim().to_lowercase();
    let valid = value.len() <= 254
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains('@')
        });
    if !valid {
        return Err(ApiError::invalid("Enter a valid email address."));
    }
    Ok(value)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn account_email(state: &AppState, caller: &Caller) -> ApiResult<Option<String>> {
    let email: Option<String> = sqlx::query_scalar(
        "select coalesce(nullif(email, ''), emails[1]) from accounts where uuid = $1",
    )
    .bind(&caller.uuid)
    .fetch_optional(&state.db)
    .await?
    .flatten();
    if let Some(email) = email.filter(|email| !email.is_empty()) {
        return Ok(Some(email));
    }
    // A later sign-in may have granted email after an earlier profile-only session.
    // Never use an entered address as an account email, or fetch without the caller's token.
    if !caller.token.is_empty() {
        if let Ok(info) = state.app().userinfo(&caller.token).await {
            if let Some(email) = info.account.email.filter(|email| !email.is_empty()) {
                let email = email.trim().to_lowercase();
                sqlx::query("update accounts set email=$2 where uuid=$1")
                    .bind(&caller.uuid)
                    .bind(&email)
                    .execute(&state.db)
                    .await?;
                return Ok(Some(email));
            }
        }
    }
    Ok(None)
}
async fn record(
    state: &AppState,
    doc: &DocRow,
    caller: Option<&Caller>,
    email: &str,
    source: &str,
) -> ApiResult<()> {
    let key = if source == "account" {
        format!("account:{}", caller.unwrap().uuid)
    } else {
        format!("email:{email}")
    };
    sqlx::query("insert into doc_viewers (doc_id, viewer_key, email, account_uuid, email_source) values ($1,$2,$3,$4,$5)
        on conflict (doc_id, viewer_key) do update set email = excluded.email, account_uuid = excluded.account_uuid,
        last_viewed_at = now() where doc_viewers.last_viewed_at < now() - interval '1 minute'")
        .bind(&doc.id).bind(key).bind(email).bind(caller.map(|c| &c.uuid)).bind(source).execute(&state.db).await?;
    Ok(())
}
pub async fn ensure(
    state: &AppState,
    caller: Option<&Caller>,
    doc: &DocRow,
    headers: &HeaderMap,
    log: bool,
) -> ApiResult<()> {
    if !doc.require_email
        || doc.public_access == "none"
        || caller.is_some_and(|c| c.uuid == doc.owner_uuid)
    {
        return Ok(());
    }
    if let Some(caller) = caller {
        if let Some(email) = account_email(state, caller).await? {
            if log {
                record(state, doc, Some(caller), &email, "account").await?;
            }
            return Ok(());
        }
    }
    let hashes: Vec<String> = headers
        .get("x-write-view-grants")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(',')
        .take(32)
        .filter(|v| v.len() >= 20 && v.len() <= 100)
        .map(hash)
        .collect();
    let email: Option<String> = sqlx::query_scalar("select email from doc_view_grants where doc_id=$1 and token_hash=any($2) and gate_version=$3 and expires_at > now() limit 1")
        .bind(&doc.id).bind(&hashes).bind(doc.email_gate_version).fetch_optional(&state.db).await?;
    let Some(email) = email else {
        return Err(required());
    };
    if log {
        record(state, doc, caller, &email, "entered").await?;
    }
    Ok(())
}

/// Applied by both auth extractors, so raw API/export routes cannot skip the prompt.
pub async fn guard(
    state: &AppState,
    caller: Option<&Caller>,
    path: &str,
    headers: &HeaderMap,
    method: &axum::http::Method,
) -> ApiResult<()> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    if parts.len() >= 3
        && parts[0] == "v1"
        && matches!(parts[1], "docs" | "assets")
        && parts[2].contains('%')
    {
        return Err(ApiError::invalid("Use the unencoded file identifier."));
    }
    if parts.len() >= 3 && parts[0] == "v1" && parts[1] == "docs" && parts[2].starts_with("d_") {
        if parts
            .get(3)
            .is_some_and(|p| matches!(*p, "visits" | "viewers" | "public" | "sharing"))
        {
            return Ok(());
        }
        let doc = access::load_doc(state, parts[2]).await?;
        if access::doc_role(state, caller, &doc).await?.is_some() {
            ensure(
                state,
                caller,
                &doc,
                headers,
                (method == axum::http::Method::GET
                    && (parts.len() == 3
                        || parts.get(3).is_some_and(|p| {
                            matches!(*p, "markdown" | "prosemirror" | "export" | "original")
                        })))
                    || (method == axum::http::Method::POST && parts.get(3) == Some(&"live")),
            )
            .await?;
        }
    }
    if parts.len() == 3 && parts[0] == "v1" && parts[1] == "assets" {
        let docs: Vec<DocRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {} from docs where id in (select doc_id from doc_assets where asset_id=$1 union select doc_id from assets where id=$1)", access::DOC_COLUMNS)))
            .bind(parts[2]).fetch_all(&state.db).await?;
        let mut gated = false;
        for doc in docs {
            if access::doc_role(state, caller, &doc).await?.is_some() {
                match ensure(state, caller, &doc, headers, false).await {
                    Ok(()) => return Ok(()),
                    Err(error) if error.code == "email_required" => gated = true,
                    Err(error) => return Err(error),
                }
            }
        }
        if gated {
            return Err(required());
        }
    }
    Ok(())
}
#[derive(Deserialize)]
pub struct VisitBody {
    #[serde(default)]
    email: String,
}
pub async fn visit(
    State(state): State<AppState>,
    MaybeAuth(caller): MaybeAuth,
    Path(id): Path<String>,
    Json(body): Json<VisitBody>,
) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
    if !doc.require_email || doc.public_access == "none" || doc.deleted_at.is_some() {
        return Err(ApiError::conflict(
            "This file isn't collecting viewer emails.",
        ));
    }
    if caller
        .as_ref()
        .is_some_and(|caller| caller.uuid == doc.owner_uuid)
    {
        return Ok(Json(json!({"ok":true})));
    }
    if let Some(caller) = &caller {
        if let Some(email) = account_email(&state, caller).await? {
            if caller.uuid != doc.owner_uuid {
                record(&state, &doc, Some(caller), &email, "account").await?;
            }
            return Ok(Json(json!({"ok":true})));
        }
    }
    let email = normalize_email(&body.email)?;
    let token = format!("{}{}", ids::new_id("v"), ids::new_id("v"));
    sqlx::query("delete from doc_view_grants where doc_id=$1 and expires_at < now()")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "insert into doc_view_grants (token_hash,doc_id,email,gate_version) values ($1,$2,$3,$4)",
    )
    .bind(hash(&token))
    .bind(&id)
    .bind(&email)
    .bind(doc.email_gate_version)
    .execute(&state.db)
    .await?;
    record(&state, &doc, caller.as_ref(), &email, "entered").await?;
    Ok(Json(json!({"ok":true,"view_grant":token})))
}
#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    offset: i64,
}
pub async fn list(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    let offset = query.offset.clamp(0, 1_000_000);
    let rows: Vec<(String, Option<String>, String, time::OffsetDateTime, time::OffsetDateTime)> = sqlx::query_as("select email, account_uuid, email_source, first_viewed_at, last_viewed_at from doc_viewers where doc_id=$1 order by last_viewed_at desc, viewer_key limit 50 offset $2")
        .bind(&id).bind(offset).fetch_all(&state.db).await?;
    let total: i64 = sqlx::query_scalar("select count(*) from doc_viewers where doc_id=$1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let people = accounts::many(
        &state,
        &rows.iter().filter_map(|r| r.1.clone()).collect::<Vec<_>>(),
    )
    .await?;
    let fmt = &time::format_description::well_known::Rfc3339;
    let viewers: Vec<_> = rows.into_iter().map(|r| json!({"email":r.0,"account":r.1.as_ref().and_then(|id| people.get(id)),"email_source":r.2,"first_viewed_at":r.3.format(fmt).ok(),"last_viewed_at":r.4.format(fmt).ok()})).collect();
    Ok(Json(
        json!({"viewers":viewers,"total":total,"next_offset": if offset+50<total {Some(offset+50)} else {None}}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn email_is_a_validated_claim_not_authentication() {
        assert_eq!(
            normalize_email(" Person@Example.com ").unwrap(),
            "person@example.com"
        );
        for bad in [
            "",
            "bad",
            "x@@test.com",
            "x@.com",
            "x@test.",
            "x\n@test.com",
            "x@y com",
        ] {
            assert!(normalize_email(bad).is_err());
        }
    }
}
