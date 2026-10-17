//! Sharing docs and folders with Carbons and Silicons (by c:id, si:id or email), and public links.
//!
//! The owner and editors can invite (as editor, commenter or viewer); only the owner changes or
//! removes other people, and anyone can remove themselves. Sharing a folder shares everything in
//! it, now and later. An email that isn't matched to an account yet stays a pending invitation
//! until someone signs in to Silicon Write with that email.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::activity;
use crate::auth::{Auth, Caller};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::state::AppState;
use crate::views;

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Doc,
    Folder,
}

impl Target {
    fn column(self) -> &'static str {
        match self {
            Target::Doc => "doc_id",
            Target::Folder => "folder_id",
        }
    }
    fn kind(self) -> &'static str {
        match self {
            Target::Doc => "doc",
            Target::Folder => "folder",
        }
    }
}

#[derive(sqlx::FromRow)]
struct ShareRow {
    id: String,
    doc_id: Option<String>,
    folder_id: Option<String>,
    account_uuid: Option<String>,
    email: Option<String>,
    role: String,
    invited_by: String,
    created_at: time::OffsetDateTime,
}

const SHARE_COLUMNS: &str = "id, doc_id, folder_id, account_uuid, email, role, invited_by, created_at";

struct Item {
    id: String,
    title: String,
    owner: String,
    /// The folder the item is in (for inherited shares).
    folder: Option<String>,
    role: Role,
    url: String,
}

async fn item(state: &AppState, caller: &Caller, target: Target, id: &str, min: Role) -> ApiResult<Item> {
    match target {
        Target::Doc => {
            let (doc, role) = access::require_doc(state, Some(caller), id, min).await?;
            Ok(Item { id: doc.id.clone(), title: doc.display_title(), owner: doc.owner_uuid.clone(), folder: doc.folder_id.clone(), role, url: state.config.doc_url(&doc.id) })
        }
        Target::Folder => {
            let (folder, role) = access::require_folder(state, caller, id, min).await?;
            let url = format!("{}/folders/{}", state.config.web_url.trim_end_matches('/'), folder.id);
            Ok(Item { id: folder.id.clone(), title: folder.name.clone(), owner: folder.owner_uuid.clone(), folder: folder.parent_id.clone(), role, url })
        }
    }
}

async fn member_view(_state: &AppState, row: &ShareRow, via: Value, people: &std::collections::HashMap<String, Account>) -> Value {
    json!({
        "id": row.id,
        "account": row.account_uuid.as_ref().and_then(|u| people.get(u)),
        "email": row.email,
        "role": row.role,
        "via": via,
        "pending": row.account_uuid.is_none(),
        "invited_by": people.get(&row.invited_by),
        "created_at": row.created_at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    })
}

async fn members(state: &AppState, caller: &Caller, target: Target, id: &str) -> ApiResult<Json<Value>> {
    let item = item(state, caller, target, id, Role::Viewer).await?;
    let direct: Vec<ShareRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where {} = $1 order by created_at", target.column())))
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    let chain = access::ancestors(state, item.folder.as_deref()).await?;
    let chain_ids: Vec<String> = chain.iter().map(|f| f.id.clone()).collect();
    let inherited: Vec<ShareRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where folder_id = any($1) order by created_at")))
        .bind(&chain_ids)
        .fetch_all(&state.db)
        .await?;
    let mut uuids: Vec<String> = vec![item.owner.clone()];
    for row in direct.iter().chain(inherited.iter()) {
        uuids.extend(row.account_uuid.clone());
        uuids.push(row.invited_by.clone());
    }
    let people = accounts::many(state, &uuids).await?;
    let mut out = vec![];
    for row in &direct {
        out.push(member_view(state, row, json!(target.kind()), &people).await);
    }
    for row in &inherited {
        let folder = chain.iter().find(|f| Some(&f.id) == row.folder_id.as_ref());
        let via = json!({ "folder": folder.map(|f| json!({ "id": f.id, "name": f.name })) });
        out.push(member_view(state, row, via, &people).await);
    }
    let public = match target {
        Target::Doc => access::load_doc(state, id).await?.public_access,
        Target::Folder => "none".into(),
    };
    Ok(Json(json!({
        "owner": people.get(&item.owner),
        "public_access": public,
        "members": out,
        "role": item.role,
    })))
}

pub async fn doc_members(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    members(&state, &caller, Target::Doc, &id).await
}

pub async fn folder_members(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    members(&state, &caller, Target::Folder, &id).await
}

#[derive(Deserialize)]
pub struct ShareBody {
    to: String,
    role: String,
}

fn shareable_role(role: &str) -> ApiResult<Role> {
    match Role::parse(role) {
        Some(Role::Owner) | None => Err(ApiError::invalid("The role must be editor, commenter or viewer.")),
        Some(role) => Ok(role),
    }
}

fn looks_like_email(value: &str) -> bool {
    let value = value.trim();
    let Some((local, domain)) = value.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !value.contains(char::is_whitespace)
}

async fn add(state: &AppState, caller: &Caller, target: Target, id: &str, body: ShareBody) -> ApiResult<(StatusCode, Json<Value>)> {
    let item = item(state, caller, target, id, Role::Editor).await?;
    let role = shareable_role(&body.role)?;
    let to = body.to.trim();
    let inviter = accounts::one(state, &caller.uuid).await?;
    let share_id = ids::new_id("m");
    let row: ShareRow = if looks_like_email(to) {
        let email = to.to_lowercase();
        let existing: Option<ShareRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where {} = $1 and lower(email) = $2", target.column())))
            .bind(id)
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
        if let Some(existing) = existing {
            sqlx::query("update shares set role = $2 where id = $1").bind(&existing.id).bind(role.as_str()).execute(&state.db).await?;
        } else {
            sqlx::query(sqlx::AssertSqlSafe(format!("insert into shares (id, {}, email, role, invited_by) values ($1, $2, $3, $4, $5)", target.column())))
                .bind(&share_id)
                .bind(id)
                .bind(&email)
                .bind(role.as_str())
                .bind(&caller.uuid)
                .execute(&state.db)
                .await?;
            let subject = format!("{} shared “{}” with you", inviter.handle(), item.title);
            let text = format!(
                "{} ({}) invited you to {} the {} “{}” on Silicon Write.\n\nOpen it: {}\n\nSign in to Silicon Write with this email address ({}) to get access. If you don't have a Silicon Accounts account yet, signing in creates one.\n",
                inviter.display_name, inviter.handle(), match role { Role::Editor => "edit", Role::Commenter => "comment on", _ => "view" }, target.kind(), item.title, item.url, email,
            );
            crate::mail::queue(state, &email, &subject, &text).await?;
        }
        sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where {} = $1 and lower(email) = $2", target.column())))
            .bind(id)
            .bind(&email)
            .fetch_one(&state.db)
            .await?
    } else {
        let account = accounts::by_public_id(state, to).await.map_err(|e| {
            if e.code == "not_found" {
                ApiError::not_found(&format!("The account {to}")).hint("Use a c:id, an si:id or an email address.")
            } else {
                e
            }
        })?;
        if account.uuid == item.owner {
            return Err(ApiError::invalid(format!("{} owns this {} already.", account.handle(), target.kind())));
        }
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "insert into shares (id, {col}, account_uuid, role, invited_by) values ($1, $2, $3, $4, $5)
             on conflict ({col}, account_uuid) where {col} is not null and account_uuid is not null do update set role = excluded.role",
            col = target.column()
        )))
        .bind(&share_id)
        .bind(id)
        .bind(&account.uuid)
        .bind(role.as_str())
        .bind(&caller.uuid)
        .execute(&state.db)
        .await?;
        crate::notify::shared(state, target.kind(), id, &item.title, &item.url, &account.uuid, &inviter, role.as_str()).await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where {} = $1 and account_uuid = $2", target.column())))
            .bind(id)
            .bind(&account.uuid)
            .fetch_one(&state.db)
            .await?
    };
    let (doc_id, folder_id) = match target {
        Target::Doc => (Some(id), item.folder.as_deref()),
        Target::Folder => (None, Some(id)),
    };
    activity::record(state, doc_id, folder_id, &caller.uuid, "share.added", json!({ "member": row.id, "account": row.account_uuid, "email": row.email, "role": row.role })).await?;
    after_change(state, target, id).await?;
    let mut uuids = vec![row.invited_by.clone()];
    uuids.extend(row.account_uuid.clone());
    let people = accounts::many(state, &uuids).await?;
    Ok((StatusCode::CREATED, Json(member_view(state, &row, json!(target.kind()), &people).await)))
}

pub async fn share_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<ShareBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    add(&state, &caller, Target::Doc, &id, body).await
}

pub async fn share_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<ShareBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    add(&state, &caller, Target::Folder, &id, body).await
}

#[derive(Deserialize)]
pub struct RoleBody {
    role: String,
}

async fn change(state: &AppState, caller: &Caller, target: Target, id: &str, member: &str, role: Option<Role>) -> ApiResult<Option<Value>> {
    let row: ShareRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where id = $1 and {} = $2", target.column())))
        .bind(member)
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This member"))?;
    let leaving = role.is_none() && row.account_uuid.as_deref() == Some(caller.uuid.as_str());
    let item = item(state, caller, target, id, if leaving { Role::Viewer } else { Role::Owner }).await?;
    let (doc_id, folder_id) = match target {
        Target::Doc => (Some(id), item.folder.as_deref()),
        Target::Folder => (None, Some(id)),
    };
    match role {
        Some(role) => {
            sqlx::query("update shares set role = $2 where id = $1").bind(member).bind(role.as_str()).execute(&state.db).await?;
            activity::record(state, doc_id, folder_id, &caller.uuid, "share.changed", json!({ "member": member, "account": row.account_uuid, "email": row.email, "from": row.role, "to": role.as_str() })).await?;
        }
        None => {
            sqlx::query("delete from shares where id = $1").bind(member).execute(&state.db).await?;
            activity::record(state, doc_id, folder_id, &caller.uuid, "share.removed", json!({ "member": member, "account": row.account_uuid, "email": row.email, "role": row.role })).await?;
        }
    }
    after_change(state, target, id).await?;
    if role.is_none() {
        return Ok(None);
    }
    let updated: ShareRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {SHARE_COLUMNS} from shares where id = $1"))).bind(member).fetch_one(&state.db).await?;
    let mut uuids = vec![updated.invited_by.clone()];
    uuids.extend(updated.account_uuid.clone());
    let people = accounts::many(state, &uuids).await?;
    Ok(Some(member_view(state, &updated, json!(target.kind()), &people).await))
}

pub async fn change_doc_member(State(state): State<AppState>, Auth(caller): Auth, Path((id, member)): Path<(String, String)>, Json(body): Json<RoleBody>) -> ApiResult<Json<Value>> {
    let role = shareable_role(&body.role)?;
    Ok(Json(change(&state, &caller, Target::Doc, &id, &member, Some(role)).await?.unwrap_or(Value::Null)))
}

pub async fn change_folder_member(State(state): State<AppState>, Auth(caller): Auth, Path((id, member)): Path<(String, String)>, Json(body): Json<RoleBody>) -> ApiResult<Json<Value>> {
    let role = shareable_role(&body.role)?;
    Ok(Json(change(&state, &caller, Target::Folder, &id, &member, Some(role)).await?.unwrap_or(Value::Null)))
}

pub async fn remove_doc_member(State(state): State<AppState>, Auth(caller): Auth, Path((id, member)): Path<(String, String)>) -> ApiResult<StatusCode> {
    change(&state, &caller, Target::Doc, &id, &member, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_folder_member(State(state): State<AppState>, Auth(caller): Auth, Path((id, member)): Path<(String, String)>) -> ApiResult<StatusCode> {
    change(&state, &caller, Target::Folder, &id, &member, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct PublicBody {
    access: String,
}

pub async fn set_public(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<PublicBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    let access_level = body.access.trim();
    if !["none", "view", "comment", "edit"].contains(&access_level) {
        return Err(ApiError::invalid("Public access must be none, view, comment or edit."));
    }
    if access_level != doc.public_access {
        sqlx::query("update docs set public_access = $2 where id = $1").bind(&id).bind(access_level).execute(&state.db).await?;
        activity::record(&state, Some(&id), doc.folder_id.as_deref(), &caller.uuid, "doc.public", json!({ "from": doc.public_access, "to": access_level })).await?;
        state.rooms.recheck(&state, &id).await;
        state.rooms.notify(&id, json!({ "type": "meta" })).await;
    }
    let (doc, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    Ok(Json(serde_json::to_value(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?).unwrap()))
}

/// After a sharing change: everyone with the doc (or a doc in the folder) open gets their new role.
async fn after_change(state: &AppState, target: Target, id: &str) -> ApiResult<()> {
    let docs: Vec<String> = match target {
        Target::Doc => vec![id.to_owned()],
        Target::Folder => sqlx::query_scalar(
            "with recursive t as (select id from folders where id = $1 union all select f.id from folders f join t on f.parent_id = t.id)
             select id from docs where folder_id in (select id from t)",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?,
    };
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
        state.rooms.notify(&doc, json!({ "type": "meta" })).await;
    }
    Ok(())
}
