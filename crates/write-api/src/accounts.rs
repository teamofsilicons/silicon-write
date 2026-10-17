//! Accounts as Silicon Write knows them: a cache of Silicon Accounts profiles, keyed by uuid.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde::Serialize;
use time::{Duration, OffsetDateTime};

use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Account {
    pub uuid: String,
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub pfp_url: String,
}

impl Account {
    pub fn unknown(uuid: &str) -> Account {
        Account { uuid: uuid.to_owned(), id: String::new(), kind: "carbon".into(), display_name: String::new(), pfp_url: String::new() }
    }
    /// How the account is named in text: its c:/si: id.
    pub fn handle(&self) -> String {
        if self.id.is_empty() { self.display_name.clone() } else { self.id.clone() }
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    uuid: String,
    kind: String,
    public_id: String,
    display_name: String,
    pfp_url: String,
    refreshed_at: OffsetDateTime,
    ting_enrolled_at: Option<OffsetDateTime>,
    emails_checked_at: Option<OffsetDateTime>,
}

impl From<&Row> for Account {
    fn from(r: &Row) -> Account {
        Account { uuid: r.uuid.clone(), id: r.public_id.clone(), kind: r.kind.clone(), display_name: r.display_name.clone(), pfp_url: r.pfp_url.clone() }
    }
}

/// Called on every signed-in request: keeps the cache fresh and does first-time work.
pub async fn seen(state: &AppState, caller: &Caller) -> ApiResult<()> {
    let row: Option<Row> = sqlx::query_as(
        "select uuid, kind, public_id, display_name, pfp_url, refreshed_at, ting_enrolled_at, emails_checked_at from accounts where uuid = $1",
    )
    .bind(&caller.uuid)
    .fetch_optional(&state.db)
    .await?;
    let now = OffsetDateTime::now_utc();
    match &row {
        None => {
            sqlx::query("insert into accounts (uuid, kind, public_id, refreshed_at) values ($1, $2, $3, 'epoch') on conflict (uuid) do nothing")
                .bind(&caller.uuid)
                .bind(&caller.kind)
                .bind(&caller.id)
                .execute(&state.db)
                .await?;
        }
        Some(r) if !caller.id.is_empty() && r.public_id != caller.id => {
            sqlx::query("update accounts set public_id = $2 where uuid = $1").bind(&caller.uuid).bind(&caller.id).execute(&state.db).await?;
        }
        _ => {}
    }
    let stale = row.as_ref().is_none_or(|r| now - r.refreshed_at > Duration::hours(1));
    if stale {
        // Fill in the profile now (it's shown on everything the account touches).
        let _ = refresh(state, &caller.uuid).await;
    }
    let needs_ting = row.as_ref().is_none_or(|r| r.ting_enrolled_at.is_none());
    if needs_ting && state.config.ting_url.is_some() {
        let state = state.clone();
        let caller = caller.clone();
        tokio::spawn(async move { crate::ting::enroll(&state, &caller).await });
    }
    let never_checked = row.as_ref().is_none_or(|r| r.emails_checked_at.is_none());
    let due = row.as_ref().is_some_and(|r| r.emails_checked_at.is_some_and(|t| now - t > Duration::hours(12)));
    if never_checked {
        // The first time, before answering: an invited Carbon's first request is usually the doc they
        // were invited to, so the invitation has to be theirs by then.
        if let Err(e) = claim_email_invites(state, caller).await {
            tracing::warn!(error = %e.message, "matching email invitations failed");
        }
    } else if due {
        let state = state.clone();
        let caller = caller.clone();
        tokio::spawn(async move {
            if let Err(e) = claim_email_invites(&state, &caller).await {
                tracing::warn!(error = %e.message, "matching email invitations failed");
            }
        });
    }
    Ok(())
}

/// Fetches an account's current profile from Silicon Accounts: its id and kind from the public
/// lookup, and its display name and photo from Silicon Write's user base (accounts that never
/// signed in to Silicon Write show by their id).
pub async fn refresh(state: &AppState, uuid: &str) -> ApiResult<Account> {
    let app = state.app();
    let summary = app.lookup(uuid).await.map_err(|e| ApiError::unavailable(format!("Silicon Accounts didn't answer: {e}")))?;
    let kind = match summary.kind {
        silicon_accounts_client::types::AccountKind::Silicon => "silicon",
        _ => "carbon",
    };
    let (mut display_name, mut pfp_url) = (summary.display_name.clone(), summary.pfp_url.clone());
    if let Ok(member) = app.user(uuid).await {
        if !member.display_name.is_empty() {
            display_name = member.display_name.clone();
        }
        if let Some(pfp) = member.pfp_url.clone().filter(|p| !p.is_empty()) {
            pfp_url = pfp;
        }
    }
    sqlx::query(
        "insert into accounts (uuid, kind, public_id, display_name, pfp_url, refreshed_at) values ($1, $2, $3, $4, $5, now())
         on conflict (uuid) do update set kind = $2, public_id = $3,
            display_name = case when $4 = '' then accounts.display_name else $4 end,
            pfp_url = case when $5 = '' then accounts.pfp_url else $5 end,
            refreshed_at = now()",
    )
    .bind(uuid)
    .bind(kind)
    .bind(&summary.id)
    .bind(&display_name)
    .bind(&pfp_url)
    .execute(&state.db)
    .await?;
    let row: (String, String) = sqlx::query_as("select display_name, pfp_url from accounts where uuid = $1").bind(uuid).fetch_one(&state.db).await?;
    Ok(Account { uuid: uuid.to_owned(), id: summary.id, kind: kind.into(), display_name: row.0, pfp_url: row.1 })
}

/// Whether this is written like a c:id or an si:id.
pub fn is_public_id(id: &str) -> bool {
    let Some((prefix, handle)) = id.split_once(':') else { return false };
    matches!(prefix, "c" | "si")
        && !handle.is_empty()
        && handle.len() <= 64
        && handle.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Looks an account up by its c:/si: id.
pub async fn by_public_id(state: &AppState, id: &str) -> ApiResult<Account> {
    let id = id.trim().to_lowercase();
    if !is_public_id(&id) {
        return Err(ApiError::invalid(format!("“{id}” isn't a c:id or an si:id.")).hint("Carbons are c:<handle> and Silicons si:<handle>."));
    }
    // From the cache while it's fresh: Silicon Accounts limits how often an app may look accounts up.
    let cached: Option<Row> = sqlx::query_as(
        "select uuid, kind, public_id, display_name, pfp_url, refreshed_at, ting_enrolled_at, emails_checked_at from accounts
         where lower(public_id) = $1 and refreshed_at > now() - interval '1 hour' order by refreshed_at desc limit 1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(row) = cached {
        return Ok(Account::from(&row));
    }
    let summary = state.app().lookup_by_id(&id).await.map_err(|e| match e.status() {
        Some(404) => ApiError::not_found(&format!("The account {id}")).hint("Check the c: or si: id."),
        Some(status) if (400..500).contains(&status) => ApiError::invalid(format!("Silicon Accounts didn't accept “{id}”: {e}")),
        _ => ApiError::unavailable(format!("Silicon Accounts didn't answer: {e}")),
    })?;
    refresh(state, &summary.uuid).await
}

/// An account that uses Silicon Write and has proved it owns this email address.
pub async fn by_email(state: &AppState, email: &str) -> ApiResult<Option<Account>> {
    let email = email.trim().to_lowercase();
    let uuid: Option<String> = sqlx::query_scalar("select uuid from accounts where $1 = any(emails) or lower(email) = $1 order by refreshed_at desc limit 1")
        .bind(&email)
        .fetch_optional(&state.db)
        .await?;
    Ok(match uuid {
        Some(uuid) => Some(one(state, &uuid).await?),
        None => None,
    })
}

/// The email addresses an account has proved it owns (as far as Silicon Write has seen).
pub async fn emails_of(state: &AppState, uuid: &str) -> ApiResult<Vec<String>> {
    let row: Option<(Vec<String>, Option<String>)> = sqlx::query_as("select emails, email from accounts where uuid = $1").bind(uuid).fetch_optional(&state.db).await?;
    let Some((mut emails, email)) = row else { return Ok(vec![]) };
    emails.extend(email.map(|e| e.to_lowercase()));
    Ok(emails)
}

/// Many accounts at once, from the cache (fetched from Silicon Accounts when missing).
pub async fn many(state: &AppState, uuids: &[String]) -> ApiResult<HashMap<String, Account>> {
    let mut unique: Vec<String> = uuids.iter().filter(|u| !u.is_empty()).cloned().collect();
    unique.sort();
    unique.dedup();
    let rows: Vec<Row> = sqlx::query_as(
        "select uuid, kind, public_id, display_name, pfp_url, refreshed_at, ting_enrolled_at, emails_checked_at from accounts where uuid = any($1)",
    )
    .bind(&unique)
    .fetch_all(&state.db)
    .await?;
    let mut map: HashMap<String, Account> = rows.iter().map(|r| (r.uuid.clone(), Account::from(r))).collect();
    for uuid in unique {
        let missing = map.get(&uuid).is_none_or(|a| a.id.is_empty());
        if missing {
            let account = refresh(state, &uuid).await.unwrap_or_else(|_| map.get(&uuid).cloned().unwrap_or_else(|| Account::unknown(&uuid)));
            map.insert(uuid, account);
        }
    }
    Ok(map)
}

pub async fn one(state: &AppState, uuid: &str) -> ApiResult<Account> {
    Ok(many(state, &[uuid.to_owned()]).await?.remove(uuid).unwrap_or_else(|| Account::unknown(uuid)))
}

/// One email match at a time per account: the burst of requests a new sign-in makes matches once.
static CLAIMING: LazyLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// Turns pending email invitations into real access once the account proves it owns the email.
pub async fn claim_email_invites(state: &AppState, caller: &Caller) -> ApiResult<()> {
    let lock = CLAIMING.lock().unwrap().entry(caller.uuid.clone()).or_default().clone();
    let held = lock.lock().await;
    let result = claim_once(state, caller).await;
    drop(held);
    let mut claiming = CLAIMING.lock().unwrap();
    // Nobody else is waiting: forget the lock.
    if claiming.get(&caller.uuid).is_some_and(|l| Arc::strong_count(l) <= 2) {
        claiming.remove(&caller.uuid);
    }
    result
}

/// A pending email invitation: its id, its doc or folder, its role, and that item's owner.
type Invitation = (String, Option<String>, Option<String>, String, Option<String>);

async fn claim_once(state: &AppState, caller: &Caller) -> ApiResult<()> {
    // Another request of the same sign-in may have just done it.
    let checked: Option<Option<OffsetDateTime>> = sqlx::query_scalar("select emails_checked_at from accounts where uuid = $1")
        .bind(&caller.uuid)
        .fetch_optional(&state.db)
        .await?;
    if checked.flatten().is_some_and(|t| OffsetDateTime::now_utc() - t < Duration::minutes(1)) {
        return Ok(());
    }
    let info = state.app().userinfo(&caller.token).await.map_err(|e| ApiError::unavailable(e.to_string()))?;
    if !info.account.display_name.is_empty() {
        sqlx::query("update accounts set display_name = $2, pfp_url = case when $3 = '' then pfp_url else $3 end where uuid = $1")
            .bind(&caller.uuid)
            .bind(&info.account.display_name)
            .bind(&info.account.pfp_url)
            .execute(&state.db)
            .await?;
    }
    let mut emails: Vec<String> = info.verified_emails.clone().unwrap_or_default();
    if let Some(email) = info.account.email.clone() {
        emails.push(email);
    }
    let mut emails: Vec<String> = emails.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    emails.sort();
    emails.dedup();
    sqlx::query("update accounts set emails_checked_at = now(), email = coalesce($2, email), emails = $3 where uuid = $1")
        .bind(&caller.uuid)
        .bind(info.account.email.as_ref().map(|e| e.trim().to_lowercase()).or_else(|| emails.first().cloned()))
        .bind(&emails)
        .execute(&state.db)
        .await?;
    if emails.is_empty() {
        return Ok(());
    }
    let pending: Vec<Invitation> = sqlx::query_as(
        "select s.id, s.doc_id, s.folder_id, s.role, coalesce(d.owner_uuid, f.owner_uuid)
         from shares s left join docs d on d.id = s.doc_id left join folders f on f.id = s.folder_id
         where s.account_uuid is null and lower(s.email) = any($1)",
    )
    .bind(&emails)
    .fetch_all(&state.db)
    .await?;
    for (id, doc_id, folder_id, role, owner) in pending {
        let (doc_id, folder_id) = (doc_id.as_deref(), folder_id.as_deref());
        // Someone invited the owner's own address: they have it already.
        if owner.as_deref() == Some(caller.uuid.as_str()) {
            sqlx::query("delete from shares where id = $1").bind(&id).execute(&state.db).await?;
            crate::activity::record(state, doc_id, folder_id, &caller.uuid, "share.removed", serde_json::json!({ "member": id, "role": role, "reason": "owner" })).await?;
            continue;
        }
        // A share the account has already (not this invitation): it keeps whichever role gives more.
        let existing: Option<(String, String)> = sqlx::query_as(
            "select id, role from shares where account_uuid = $1 and id <> $4 and (doc_id = $2 or folder_id = $3)",
        )
        .bind(&caller.uuid)
        .bind(doc_id)
        .bind(folder_id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
        match existing {
            Some((kept, kept_role)) => {
                let higher = [crate::access::Role::parse(&role), crate::access::Role::parse(&kept_role)].into_iter().flatten().max();
                let higher = higher.map(|r| r.as_str()).unwrap_or(kept_role.as_str()).to_owned();
                if higher != kept_role {
                    sqlx::query("update shares set role = $2 where id = $1").bind(&kept).bind(&higher).execute(&state.db).await?;
                }
                sqlx::query("delete from shares where id = $1").bind(&id).execute(&state.db).await?;
                crate::activity::record(state, doc_id, folder_id, &caller.uuid, "share.accepted", serde_json::json!({ "member": kept, "invitation": id, "role": higher, "merged": true })).await?;
            }
            None => {
                sqlx::query("update shares set account_uuid = $2, email = null where id = $1").bind(&id).bind(&caller.uuid).execute(&state.db).await?;
                crate::activity::record(state, doc_id, folder_id, &caller.uuid, "share.accepted", serde_json::json!({ "member": id, "role": role })).await?;
            }
        }
    }
    Ok(())
}
