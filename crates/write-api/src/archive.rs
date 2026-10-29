//! Personal archive: content and permissions stay intact, including for collaborators.
use std::collections::HashSet;

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    access::{self, DocRow, FolderRow, Role},
    auth::{Auth, Caller},
    error::{ApiError, ApiResult},
    state::AppState,
};

#[derive(Deserialize)]
pub struct ArchiveBody {
    archived: bool,
}

pub async fn doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<ArchiveBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it before archiving it."));
    }
    if body.archived {
        sqlx::query("insert into archived_docs (account_uuid, doc_id) values ($1, $2) on conflict do nothing").bind(&caller.uuid).bind(&id).execute(&state.db).await?;
    } else {
        sqlx::query("delete from archived_docs where account_uuid = $1 and doc_id = $2").bind(&caller.uuid).bind(&id).execute(&state.db).await?;
    }
    Ok(Json(json!({"id": id, "archived": body.archived})))
}

pub async fn folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<ArchiveBody>) -> ApiResult<Json<Value>> {
    let (folder, _) = access::require_folder(&state, &caller, &id, Role::Viewer).await?;
    if folder.deleted_at.is_some() {
        return Err(ApiError::conflict("This folder is in the trash.").hint("Restore it before archiving it."));
    }
    if body.archived {
        sqlx::query("insert into archived_folders (account_uuid, folder_id) values ($1, $2) on conflict do nothing").bind(&caller.uuid).bind(&id).execute(&state.db).await?;
    } else {
        sqlx::query("delete from archived_folders where account_uuid = $1 and folder_id = $2").bind(&caller.uuid).bind(&id).execute(&state.db).await?;
    }
    Ok(Json(json!({"id": id, "archived": body.archived})))
}

pub async fn is_archived(state: &AppState, viewer: Option<&str>, id: &str, folder: bool) -> ApiResult<bool> {
    let Some(viewer) = viewer else {
        return Ok(false);
    };
    let query = if folder {
        "select exists(select 1 from archived_folders where account_uuid = $1 and folder_id = $2)"
    } else {
        "select exists(select 1 from archived_docs where account_uuid = $1 and doc_id = $2)"
    };
    Ok(sqlx::query_scalar(query).bind(viewer).bind(id).fetch_one(&state.db).await?)
}

/// Root/recent listings hide the archived subtree. Opening a folder explicitly still lets
/// someone browse it; only independently archived children are hidden within that folder.
pub async fn filter(state: &AppState, caller: &Caller, folders: &mut Vec<FolderRow>, docs: &mut Vec<DocRow>, inside_folder: bool) -> ApiResult<()> {
    let hidden_folders: Vec<String> = sqlx::query_scalar(
        "with recursive hidden as (
            select folder_id as id from archived_folders where account_uuid = $1
            union select f.id from folders f join hidden h on f.parent_id = h.id where not $2
         ) select id from hidden",
    )
    .bind(&caller.uuid)
    .bind(inside_folder)
    .fetch_all(&state.db)
    .await?;
    let hidden_docs: Vec<String> = sqlx::query_scalar("select doc_id from archived_docs where account_uuid = $1").bind(&caller.uuid).fetch_all(&state.db).await?;
    let folder_ids: HashSet<_> = hidden_folders.into_iter().collect();
    let doc_ids: HashSet<_> = hidden_docs.into_iter().collect();
    folders.retain(|f| !folder_ids.contains(&f.id));
    docs.retain(|d| !doc_ids.contains(&d.id) && (inside_folder || !d.folder_id.as_ref().is_some_and(|f| folder_ids.contains(f))));
    Ok(())
}
