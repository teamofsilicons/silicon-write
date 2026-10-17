//! The history of everything around a doc or folder that isn't its text: renames, moves, sharing,
//! the trash, comments and suggestions. Kept forever.

use axum::Json;
use axum::extract::{Path, State};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub async fn record(state: &AppState, doc_id: Option<&str>, folder_id: Option<&str>, actor: &str, kind: &str, data: Value) -> ApiResult<()> {
    sqlx::query("insert into activity (doc_id, folder_id, actor_uuid, kind, data) values ($1, $2, $3, $4, $5)")
        .bind(doc_id)
        .bind(folder_id)
        .bind(actor)
        .bind(kind)
        .bind(data)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    doc_id: Option<String>,
    #[allow(dead_code)]
    folder_id: Option<String>,
    actor_uuid: String,
    kind: String,
    data: Value,
    created_at: OffsetDateTime,
    undone_at: Option<OffsetDateTime>,
}

#[derive(Serialize)]
pub struct Event {
    id: i64,
    kind: String,
    actor: Account,
    data: Value,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    undoable: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    undone_at: Option<OffsetDateTime>,
}

const UNDOABLE: &[&str] = &["doc.renamed", "doc.moved", "doc.trashed", "doc.created", "folder.renamed", "folder.moved", "folder.trashed", "folder.created"];

async fn events(state: &AppState, rows: Vec<Row>) -> ApiResult<Vec<Event>> {
    let people = accounts::many(state, &rows.iter().map(|r| r.actor_uuid.clone()).collect::<Vec<_>>()).await?;
    Ok(rows
        .into_iter()
        .map(|r| Event {
            id: r.id,
            undoable: UNDOABLE.contains(&r.kind.as_str()) && r.undone_at.is_none(),
            actor: people.get(&r.actor_uuid).cloned().unwrap_or_else(|| Account::unknown(&r.actor_uuid)),
            kind: r.kind,
            data: r.data,
            created_at: r.created_at,
            undone_at: r.undone_at,
        })
        .collect())
}

pub async fn doc_activity(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let rows: Vec<Row> = sqlx::query_as("select id, doc_id, folder_id, actor_uuid, kind, data, created_at, undone_at from activity where doc_id = $1 order by id desc limit 500")
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "events": events(&state, rows).await? })))
}

pub async fn folder_activity(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_folder(&state, &caller, &id, Role::Editor).await?;
    let rows: Vec<Row> = sqlx::query_as("select id, doc_id, folder_id, actor_uuid, kind, data, created_at, undone_at from activity where folder_id = $1 order by id desc limit 500")
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "events": events(&state, rows).await? })))
}

/// Undoes a rename, move, trash or create.
pub async fn undo(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row: Row = sqlx::query_as("select id, doc_id, folder_id, actor_uuid, kind, data, created_at, undone_at from activity where id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This event"))?;
    if row.undone_at.is_some() {
        return Err(ApiError::conflict("This was already undone."));
    }
    let target = |key: &str| row.data.get(key).and_then(Value::as_str).map(str::to_owned);
    match row.kind.as_str() {
        "doc.renamed" | "doc.moved" | "doc.trashed" | "doc.created" => {
            let doc_id = target("doc").or(row.doc_id.clone()).ok_or_else(|| ApiError::invalid("This event has no doc."))?;
            match row.kind.as_str() {
                "doc.renamed" => {
                    access::require_doc(&state, Some(&caller), &doc_id, Role::Editor).await?;
                    crate::library::rename_doc(&state, &caller, &doc_id, target("from").unwrap_or_default()).await?;
                }
                "doc.moved" => {
                    crate::library::move_doc(&state, &caller, &doc_id, target("from_folder")).await?;
                }
                "doc.trashed" => {
                    crate::library::restore_doc_inner(&state, &caller, &doc_id).await?;
                }
                _ => {
                    crate::library::trash_doc_inner(&state, &caller, &doc_id).await?;
                }
            }
        }
        "folder.renamed" | "folder.moved" | "folder.trashed" | "folder.created" => {
            let folder_id = target("folder").ok_or_else(|| ApiError::invalid("This event has no folder."))?;
            match row.kind.as_str() {
                "folder.renamed" => {
                    crate::library::rename_folder(&state, &caller, &folder_id, target("from").unwrap_or_default()).await?;
                }
                "folder.moved" => {
                    crate::library::move_folder(&state, &caller, &folder_id, target("from_parent")).await?;
                }
                "folder.trashed" => {
                    crate::library::restore_folder_inner(&state, &caller, &folder_id).await?;
                }
                _ => {
                    crate::library::trash_folder_inner(&state, &caller, &folder_id).await?;
                }
            }
        }
        _ => return Err(ApiError::invalid("This kind of event can't be undone.")),
    }
    sqlx::query("update activity set undone_at = now() where id = $1").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "undone": true })))
}
