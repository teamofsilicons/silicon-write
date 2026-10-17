//! The JSON shapes of docs and folders (docs/api.md, "Shapes").

use serde::Serialize;
use time::OffsetDateTime;

use crate::access::{self, DocRow, FolderRow, Role};
use crate::accounts::{self, Account};
use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Serialize)]
pub struct PathPart {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct DocView {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub owner: Account,
    pub created_by: Account,
    pub folder_id: Option<String>,
    pub path: Vec<PathPart>,
    pub role: Role,
    pub public_access: String,
    pub seq: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
    pub url: String,
}

#[derive(Serialize)]
pub struct FolderView {
    pub id: String,
    pub name: String,
    pub owner: Account,
    pub parent_id: Option<String>,
    pub path: Vec<PathPart>,
    pub role: Role,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
}

/// The folders above, top first, limited to the ones the viewer can see.
async fn visible_path(state: &AppState, folder_id: Option<&str>, viewer: Option<&str>) -> ApiResult<Vec<PathPart>> {
    let chain = access::ancestors(state, folder_id).await?;
    let mut parts: Vec<PathPart> = vec![];
    // Walk from the nearest folder up and stop at the first one the viewer has no access to.
    for folder in &chain {
        let visible = match viewer {
            Some(v) if v == folder.owner_uuid => true,
            Some(v) => {
                let ids: Vec<String> = chain.iter().map(|f| f.id.clone()).collect();
                let pos = ids.iter().position(|i| *i == folder.id).unwrap_or(0);
                let above: Vec<String> = ids[pos..].to_vec();
                let shared: Option<String> = sqlx::query_scalar("select id from shares where account_uuid = $1 and folder_id = any($2) limit 1")
                    .bind(v)
                    .bind(&above)
                    .fetch_optional(&state.db)
                    .await?;
                shared.is_some()
            }
            None => false,
        };
        if !visible {
            break;
        }
        parts.push(PathPart { id: folder.id.clone(), name: folder.name.clone() });
    }
    parts.reverse();
    Ok(parts)
}

pub async fn doc_view(state: &AppState, doc: &DocRow, role: Role, viewer: Option<&str>) -> ApiResult<DocView> {
    let people = accounts::many(state, &[doc.owner_uuid.clone(), doc.created_by.clone()]).await?;
    Ok(DocView {
        id: doc.id.clone(),
        title: doc.display_title(),
        kind: doc.kind.clone(),
        owner: people.get(&doc.owner_uuid).cloned().unwrap_or_else(|| Account::unknown(&doc.owner_uuid)),
        created_by: people.get(&doc.created_by).cloned().unwrap_or_else(|| Account::unknown(&doc.created_by)),
        folder_id: doc.folder_id.clone(),
        path: visible_path(state, doc.folder_id.as_deref(), viewer).await?,
        role,
        public_access: doc.public_access.clone(),
        seq: doc.seq,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        deleted_at: doc.deleted_at,
        url: state.config.doc_url(&doc.id),
    })
}

pub async fn folder_view(state: &AppState, folder: &FolderRow, role: Role, viewer: Option<&str>) -> ApiResult<FolderView> {
    Ok(FolderView {
        id: folder.id.clone(),
        name: folder.name.clone(),
        owner: accounts::one(state, &folder.owner_uuid).await?,
        parent_id: folder.parent_id.clone(),
        path: visible_path(state, folder.parent_id.as_deref(), viewer).await?,
        role,
        created_at: folder.created_at,
        deleted_at: folder.deleted_at,
    })
}

/// Views for many docs, each with the viewer's role.
pub async fn doc_views(state: &AppState, docs: Vec<DocRow>, viewer: &crate::auth::Caller) -> ApiResult<Vec<DocView>> {
    let mut out = Vec::with_capacity(docs.len());
    for doc in docs {
        if let Some(role) = access::doc_role(state, Some(viewer), &doc).await? {
            out.push(doc_view(state, &doc, role, Some(&viewer.uuid)).await?);
        }
    }
    Ok(out)
}

pub async fn folder_views(state: &AppState, folders: Vec<FolderRow>, viewer: &crate::auth::Caller) -> ApiResult<Vec<FolderView>> {
    let mut out = Vec::with_capacity(folders.len());
    for folder in folders {
        if let Some(role) = access::folder_role(state, viewer, &folder).await? {
            out.push(folder_view(state, &folder, role, Some(&viewer.uuid)).await?);
        }
    }
    Ok(out)
}
