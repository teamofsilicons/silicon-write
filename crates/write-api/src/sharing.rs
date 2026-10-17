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
    folder_id: Option<String>,
    account_uuid: Option<String>,
    email: Option<String>,
    role: String,
    invited_by: String,
    created_at: time::OffsetDateTime,
}

const SHARE_COLUMNS: &str = "id, folder_id, account_uuid, email, role, invited_by, created_at";

struct Item {
    title: String,
    owner: String,
    /// The folder the item is in (for inherited shares).
    folder: Option<String>,
    role: Role,
    /// The caller's role as its owner or someone it's shared with: what a public link gives
    /// doesn't count for sharing it.
    member_role: Option<Role>,
    deleted: bool,
    url: String,
}

async fn item(state: &AppState, caller: &Caller, target: Target, id: &str, min: Role) -> ApiResult<Item> {
    match target {
        Target::Doc => {
            let (doc, role) = access::require_doc(state, Some(caller), id, min).await?;
            let member_role = access::member_doc_role(state, caller, &doc).await?;
            Ok(Item {
                title: doc.display_title(),
                owner: doc.owner_uuid.clone(),
                folder: doc.folder_id.clone(),
                role,
                member_role,
                deleted: doc.deleted_at.is_some(),
                url: state.config.doc_url(&doc.id),
            })
        }
        Target::Folder => {
            let (folder, role) = access::require_folder(state, caller, id, min).await?;
            // The web shows a folder at /library/{id}.
            let url = format!("{}/library/{}", state.config.web_url.trim_end_matches('/'), folder.id);
            Ok(Item {
                title: folder.name.clone(),
                owner: folder.owner_uuid.clone(),
                folder: folder.parent_id.clone(),
                role,
                member_role: Some(role),
                deleted: folder.deleted_at.is_some(),
                url,
            })
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
    // Who it's shared with (and their email addresses) is for the people it's shared with.
    if item.member_role.is_none() {
        return Err(ApiError::forbidden(format!("Only the people this {} is shared with can see who they are.", target.kind()))
            .hint("You have it through its public link."));
    }
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
    // Folders above the item the caller can't open aren't named.
    let mut visible = std::collections::HashSet::new();
    for folder in &chain {
        if access::folder_role(state, caller, folder).await?.is_some() {
            visible.insert(folder.id.clone());
        }
    }
    for row in &inherited {
        let folder = chain.iter().find(|f| Some(&f.id) == row.folder_id.as_ref()).filter(|f| visible.contains(&f.id));
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
    // A public link lets people edit, not share: the owner can always make the doc private again.
    if item.member_role.is_none_or(|r| r < Role::Editor) {
        return Err(ApiError::forbidden(format!("Only the owner and the editors this {} is shared with can invite people.", target.kind()))
            .hint("You have it through its public link; ask the owner to share it with you."));
    }
    if item.deleted {
        return Err(ApiError::conflict(format!("This {} is in the trash.", target.kind())).hint("Restore it first, then share it."));
    }
    let role = shareable_role(&body.role)?;
    let to = body.to.trim();
    let inviter = accounts::one(state, &caller.uuid).await?;
    let (row, change) = if looks_like_email(to) {
        let email = to.to_lowercase();
        // Someone who already uses Silicon Write with this address gets it straight away.
        match accounts::by_email(state, &email).await? {
            Some(account) => share_with_account(state, caller, &item, target, id, &account, role, &inviter).await?,
            None => invite_email(state, caller, &item, target, id, &email, role, &inviter).await?,
        }
    } else {
        let account = accounts::by_public_id(state, to).await.map_err(|e| {
            if e.code == "not_found" {
                ApiError::not_found(&format!("The account {to}")).hint("Use a c:id, an si:id or an email address.")
            } else {
                e
            }
        })?;
        share_with_account(state, caller, &item, target, id, &account, role, &inviter).await?
    };
    let (doc_id, folder_id) = match target {
        Target::Doc => (Some(id), item.folder.as_deref()),
        Target::Folder => (None, Some(id)),
    };
    let status = match &change {
        Change::Added => {
            activity::record(state, doc_id, folder_id, &caller.uuid, "share.added", json!({ "member": row.id, "account": row.account_uuid, "email": row.email, "role": row.role })).await?;
            StatusCode::CREATED
        }
        Change::Role(from) => {
            activity::record(state, doc_id, folder_id, &caller.uuid, "share.changed", json!({ "member": row.id, "account": row.account_uuid, "email": row.email, "from": from, "to": row.role })).await?;
            StatusCode::OK
        }
        Change::None => StatusCode::OK,
    };
    if !matches!(change, Change::None) {
        after_change(state, target, id).await?;
    }
    let mut uuids = vec![row.invited_by.clone()];
    uuids.extend(row.account_uuid.clone());
    let people = accounts::many(state, &uuids).await?;
    Ok((status, Json(member_view(state, &row, json!(target.kind()), &people).await)))
}

/// What an invitation did.
enum Change {
    Added,
    /// The owner gave someone already invited another role (from this one).
    Role(String),
    /// They were already invited with that role.
    None,
}

/// Someone invited again: the same role changes nothing; another role is the owner's to give.
async fn reinvite(state: &AppState, item: &Item, target: Target, existing: ShareRow, role: Role) -> ApiResult<(ShareRow, Change)> {
    if existing.role == role.as_str() {
        return Ok((existing, Change::None));
    }
    if item.role != Role::Owner {
        return Err(ApiError::forbidden("Only the owner can change someone's role.").hint(format!(
            "They are already {} on this {}.",
            match existing.role.as_str() {
                "editor" => "an editor",
                "commenter" => "a commenter",
                _ => "a viewer",
            },
            target.kind()
        )));
    }
    sqlx::query("update shares set role = $2 where id = $1").bind(&existing.id).bind(role.as_str()).execute(&state.db).await?;
    let from = existing.role.clone();
    Ok((ShareRow { role: role.as_str().to_owned(), ..existing }, Change::Role(from)))
}

#[allow(clippy::too_many_arguments)]
async fn share_with_account(state: &AppState, caller: &Caller, item: &Item, target: Target, id: &str, account: &Account, role: Role, inviter: &Account) -> ApiResult<(ShareRow, Change)> {
    if account.uuid == item.owner {
        return Err(ApiError::invalid(format!("{} owns this {} already.", account.handle(), target.kind())));
    }
    let select = format!("select {SHARE_COLUMNS} from shares where {} = $1 and account_uuid = $2", target.column());
    let existing: Option<ShareRow> = sqlx::query_as(sqlx::AssertSqlSafe(select.clone())).bind(id).bind(&account.uuid).fetch_optional(&state.db).await?;
    if let Some(existing) = existing {
        let (row, change) = reinvite(state, item, target, existing, role).await?;
        if matches!(change, Change::Role(_)) {
            crate::notify::shared(state, target.kind(), id, &item.title, &item.url, &account.uuid, inviter, role.as_str()).await?;
        }
        return Ok((row, change));
    }
    let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
        "insert into shares (id, {col}, account_uuid, role, invited_by) values ($1, $2, $3, $4, $5)
         on conflict ({col}, account_uuid) where {col} is not null and account_uuid is not null do nothing",
        col = target.column()
    )))
    .bind(ids::new_id("m"))
    .bind(id)
    .bind(&account.uuid)
    .bind(role.as_str())
    .bind(&caller.uuid)
    .execute(&state.db)
    .await?
    .rows_affected();
    let row: ShareRow = sqlx::query_as(sqlx::AssertSqlSafe(select)).bind(id).bind(&account.uuid).fetch_one(&state.db).await?;
    if inserted == 0 {
        // Invited at the same moment by another request.
        return reinvite(state, item, target, row, role).await;
    }
    crate::notify::shared(state, target.kind(), id, &item.title, &item.url, &account.uuid, inviter, role.as_str()).await?;
    Ok((row, Change::Added))
}

#[allow(clippy::too_many_arguments)]
async fn invite_email(state: &AppState, caller: &Caller, item: &Item, target: Target, id: &str, email: &str, role: Role, inviter: &Account) -> ApiResult<(ShareRow, Change)> {
    if accounts::emails_of(state, &item.owner).await?.iter().any(|e| e == email) {
        return Err(ApiError::invalid(format!("{email} is the owner's own address.")).hint(format!("The owner has this {} already.", target.kind())));
    }
    let select = format!("select {SHARE_COLUMNS} from shares where {} = $1 and lower(email) = $2", target.column());
    let existing: Option<ShareRow> = sqlx::query_as(sqlx::AssertSqlSafe(select.clone())).bind(id).bind(email).fetch_optional(&state.db).await?;
    if let Some(existing) = existing {
        return reinvite(state, item, target, existing, role).await;
    }
    let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
        "insert into shares (id, {col}, email, role, invited_by) values ($1, $2, $3, $4, $5)
         on conflict ({col}, lower(email)) where {col} is not null and email is not null do nothing",
        col = target.column()
    )))
    .bind(ids::new_id("m"))
    .bind(id)
    .bind(email)
    .bind(role.as_str())
    .bind(&caller.uuid)
    .execute(&state.db)
    .await?
    .rows_affected();
    let row: ShareRow = sqlx::query_as(sqlx::AssertSqlSafe(select)).bind(id).bind(email).fetch_one(&state.db).await?;
    if inserted == 0 {
        // Invited at the same moment by another request (a double click): one invitation, one email.
        return reinvite(state, item, target, row, role).await;
    }
    let subject = format!("{} shared “{}” with you", inviter.handle(), item.title);
    let text = format!(
        "{} ({}) invited you to {} the {} “{}” on Silicon Write.\n\nOpen it: {}\n\nSign in to Silicon Write with this email address ({}) to get access. If you don't have a Silicon Accounts account yet, signing in creates one.\n",
        inviter.display_name,
        inviter.handle(),
        match role {
            Role::Editor => "edit",
            Role::Commenter => "comment on",
            _ => "view",
        },
        target.kind(),
        item.title,
        item.url,
        email,
    );
    crate::mail::queue(state, email, &subject, &text).await?;
    Ok((row, Change::Added))
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
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
    }
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
            "with recursive t as (select id from folders where id = $1 union select f.id from folders f join t on f.parent_id = t.id)
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
