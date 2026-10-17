//! Who can do what. A role on a doc comes from owning it, from a share on the doc, from a share on
//! any folder above it, or from the doc being public; the highest one counts.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Commenter,
    Editor,
    Owner,
}

impl Role {
    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "viewer" | "view" => Some(Role::Viewer),
            "commenter" | "comment" => Some(Role::Commenter),
            "editor" | "edit" => Some(Role::Editor),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Commenter => "commenter",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DocRow {
    pub id: String,
    pub owner_uuid: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub kind: String,
    pub created_by: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub deleted_at: Option<OffsetDateTime>,
    pub public_access: String,
    pub seq: i64,
    pub plain_text: String,
    pub original_asset: Option<String>,
}

pub const DOC_COLUMNS: &str = "id, owner_uuid, folder_id, title, kind, created_by, created_at, updated_at, deleted_at, public_access, seq, plain_text, original_asset";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FolderRow {
    pub id: String,
    pub owner_uuid: String,
    pub parent_id: Option<String>,
    pub name: String,
    #[allow(dead_code)]
    pub created_by: String,
    pub created_at: OffsetDateTime,
    pub deleted_at: Option<OffsetDateTime>,
}

pub const FOLDER_COLUMNS: &str = "id, owner_uuid, parent_id, name, created_by, created_at, deleted_at";

impl DocRow {
    /// The title to show: the doc's title, or its first line, or "Untitled".
    pub fn display_title(&self) -> String {
        if !self.title.trim().is_empty() {
            return self.title.clone();
        }
        let first = self.plain_text.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().chars().take(80).collect::<String>());
        first.unwrap_or_else(|| "Untitled".into())
    }
}

pub async fn load_doc(state: &AppState, id: &str) -> ApiResult<DocRow> {
    sqlx::query_as::<_, DocRow>(sqlx::AssertSqlSafe(format!("select {DOC_COLUMNS} from docs where id = $1")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This doc"))
}

pub async fn load_folder(state: &AppState, id: &str) -> ApiResult<FolderRow> {
    sqlx::query_as::<_, FolderRow>(sqlx::AssertSqlSafe(format!("select {FOLDER_COLUMNS} from folders where id = $1")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This folder"))
}

/// The folder and every folder above it, nearest first.
pub async fn ancestors(state: &AppState, folder_id: Option<&str>) -> ApiResult<Vec<FolderRow>> {
    let Some(folder_id) = folder_id else { return Ok(vec![]) };
    let rows = sqlx::query_as::<_, FolderRow>(sqlx::AssertSqlSafe(format!(
        "with recursive chain as (
            select {FOLDER_COLUMNS}, 0 as depth from folders where id = $1
            union all
            select f.id, f.owner_uuid, f.parent_id, f.name, f.created_by, f.created_at, f.deleted_at, c.depth + 1
            from folders f join chain c on f.id = c.parent_id where c.depth < 64
        ) select {FOLDER_COLUMNS} from chain order by depth"
    )))
    .bind(folder_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

async fn share_role(state: &AppState, account: &str, doc_id: Option<&str>, folders: &[FolderRow]) -> ApiResult<Option<Role>> {
    let folder_ids: Vec<String> = folders.iter().map(|f| f.id.clone()).collect();
    let roles: Vec<String> = sqlx::query_scalar(
        "select role from shares where account_uuid = $1 and (doc_id = $2 or folder_id = any($3))",
    )
    .bind(account)
    .bind(doc_id)
    .bind(&folder_ids)
    .fetch_all(&state.db)
    .await?;
    Ok(roles.iter().filter_map(|r| Role::parse(r)).max())
}

/// The caller's role on a doc, if any.
pub async fn doc_role(state: &AppState, caller: Option<&Caller>, doc: &DocRow) -> ApiResult<Option<Role>> {
    let is_owner = caller.is_some_and(|c| c.uuid == doc.owner_uuid);
    if is_owner {
        return Ok(Some(Role::Owner));
    }
    // A doc in the trash is only its owner's.
    if doc.deleted_at.is_some() {
        return Ok(None);
    }
    let mut role = None;
    if let Some(caller) = caller {
        let chain = ancestors(state, doc.folder_id.as_deref()).await?;
        role = share_role(state, &caller.uuid, Some(&doc.id), &chain).await?;
    }
    let public = match doc.public_access.as_str() {
        "view" => Some(Role::Viewer),
        // Commenting or editing through the link needs signing in.
        "comment" => Some(if caller.is_some() { Role::Commenter } else { Role::Viewer }),
        "edit" => Some(if caller.is_some() { Role::Editor } else { Role::Viewer }),
        _ => None,
    };
    Ok(role.max(public))
}

pub async fn folder_role(state: &AppState, caller: &Caller, folder: &FolderRow) -> ApiResult<Option<Role>> {
    if caller.uuid == folder.owner_uuid {
        return Ok(Some(Role::Owner));
    }
    if folder.deleted_at.is_some() {
        return Ok(None);
    }
    let chain = ancestors(state, Some(&folder.id)).await?;
    share_role(state, &caller.uuid, None, &chain).await
}

/// Loads a doc the caller may act on with at least `min`.
pub async fn require_doc(state: &AppState, caller: Option<&Caller>, id: &str, min: Role) -> ApiResult<(DocRow, Role)> {
    let doc = load_doc(state, id).await?;
    let Some(role) = doc_role(state, caller, &doc).await? else {
        return Err(if caller.is_none() { ApiError::unauthorized() } else { ApiError::not_found("This doc") });
    };
    if role < min {
        return Err(ApiError::forbidden(match min {
            Role::Owner => "Only the doc's owner can do this.",
            Role::Editor => "You can't edit this doc.",
            Role::Commenter => "You can't comment on this doc.",
            Role::Viewer => "You can't open this doc.",
        })
        .hint(format!("Your role on this doc is {}.", role.as_str())));
    }
    Ok((doc, role))
}

pub async fn require_folder(state: &AppState, caller: &Caller, id: &str, min: Role) -> ApiResult<(FolderRow, Role)> {
    let folder = load_folder(state, id).await?;
    let Some(role) = folder_role(state, caller, &folder).await? else {
        return Err(ApiError::not_found("This folder"));
    };
    if role < min {
        return Err(ApiError::forbidden(match min {
            Role::Owner => "Only the folder's owner can do this.",
            _ => "You can't change this folder.",
        })
        .hint(format!("Your role on this folder is {}.", role.as_str())));
    }
    Ok((folder, role))
}

/// Every doc id the account can open (owned, shared directly, or inside a shared folder).
pub async fn accessible_doc_ids(state: &AppState, account: &str) -> ApiResult<Vec<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "with recursive tree as (
            select f.id from folders f join shares s on s.folder_id = f.id where s.account_uuid = $1 and f.deleted_at is null
            union
            select f.id from folders f join tree t on f.parent_id = t.id where f.deleted_at is null
        )
        select d.id from docs d where d.deleted_at is null and (
            d.owner_uuid = $1
            or d.id in (select doc_id from shares where account_uuid = $1 and doc_id is not null)
            or d.folder_id in (select id from tree)
        )",
    )
    .bind(account)
    .fetch_all(&state.db)
    .await?;
    Ok(ids)
}

pub async fn accessible_folder_ids(state: &AppState, account: &str) -> ApiResult<Vec<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "with recursive tree as (
            select f.id from folders f join shares s on s.folder_id = f.id where s.account_uuid = $1 and f.deleted_at is null
            union
            select f.id from folders f join tree t on f.parent_id = t.id where f.deleted_at is null
        )
        select id from folders where deleted_at is null and (owner_uuid = $1 or id in (select id from tree))",
    )
    .bind(account)
    .fetch_all(&state.db)
    .await?;
    Ok(ids)
}
