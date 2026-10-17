//! The history of everything around a doc or folder that isn't its text: renames, moves, sharing,
//! the trash, comments and suggestions. Kept for as long as what it's about exists.
//!
//! One change can be in several histories (a move is in the doc's own and in the folders it left
//! and joined): its rows share a change id, so undoing it from any of them undoes it in all.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::auth::{Auth, Caller};
use crate::error::{ApiError, ApiResult};
use crate::library;
use crate::state::AppState;

/// Records a change in the doc's history, the folder's, or one row shown in both.
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

/// The doc or folder a change is about.
#[derive(Clone, Copy)]
pub enum About<'a> {
    Doc(&'a str),
    Folder(&'a str),
}

/// Records one change about a doc or folder in each of `histories` (a doc's history, a folder's,
/// or one row shown in both): undone together, and deleted with what it's about when that is
/// deleted for good, from every history it's in.
pub async fn record_change(state: &AppState, about: About<'_>, histories: &[(Option<&str>, Option<&str>)], actor: &str, kind: &str, data: Value) -> ApiResult<()> {
    let (about_doc, about_folder) = match about {
        About::Doc(id) => (Some(id), None),
        About::Folder(id) => (None, Some(id)),
    };
    let docs: Vec<Option<String>> = histories.iter().map(|(doc, _)| doc.map(str::to_owned)).collect();
    let folders: Vec<Option<String>> = histories.iter().map(|(_, folder)| folder.map(str::to_owned)).collect();
    sqlx::query(
        "with change as (select nextval('activity_change_seq') as id)
         insert into activity (doc_id, folder_id, actor_uuid, kind, data, change_id, about_doc, about_folder)
         select h.doc_id, h.folder_id, $3, $4, $5, change.id, $6, $7
         from unnest($1::text[], $2::text[]) as h(doc_id, folder_id), change",
    )
    .bind(&docs)
    .bind(&folders)
    .bind(actor)
    .bind(kind)
    .bind(data)
    .bind(about_doc)
    .bind(about_folder)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    change_id: i64,
    doc_id: Option<String>,
    folder_id: Option<String>,
    actor_uuid: String,
    kind: String,
    data: Value,
    created_at: OffsetDateTime,
    undone_at: Option<OffsetDateTime>,
}

const ROW_COLUMNS: &str = "id, change_id, doc_id, folder_id, actor_uuid, kind, data, created_at, undone_at";

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

/// What undoing an event does: the change that takes it back. Renames, moves, the trash and
/// creations can be undone; a creation is undone by putting it in the trash, so nothing is gone.
enum Reverse {
    RenameDoc { doc: String, title: String },
    MoveDoc { doc: String, to: Option<String> },
    RestoreDoc(String),
    TrashDoc(String),
    RenameFolder { folder: String, name: String },
    MoveFolder { folder: String, to: Option<String> },
    RestoreFolder(String),
    TrashFolder(String),
}

impl Reverse {
    fn of(row: &Row) -> Option<Reverse> {
        let text = |key: &str| row.data.get(key).and_then(Value::as_str).map(str::to_owned);
        let doc = || text("doc").or_else(|| row.doc_id.clone());
        Some(match row.kind.as_str() {
            "doc.renamed" => Reverse::RenameDoc { doc: doc()?, title: text("from").unwrap_or_default() },
            "doc.moved" => Reverse::MoveDoc { doc: doc()?, to: text("from_folder") },
            "doc.trashed" => Reverse::RestoreDoc(doc()?),
            "doc.created" => Reverse::TrashDoc(doc()?),
            "folder.renamed" => Reverse::RenameFolder { folder: text("folder")?, name: text("from").unwrap_or_default() },
            "folder.moved" => Reverse::MoveFolder { folder: text("folder")?, to: text("from_parent") },
            "folder.trashed" => Reverse::RestoreFolder(text("folder")?),
            "folder.created" => Reverse::TrashFolder(text("folder")?),
            _ => return None,
        })
    }

    /// What the rights to undo it depend on (renames to different titles need the same rights).
    fn rights(&self) -> String {
        match self {
            Reverse::RenameDoc { doc, .. } => format!("rename doc {doc}"),
            Reverse::MoveDoc { doc, to } => format!("move doc {doc} to {}", to.as_deref().unwrap_or("")),
            Reverse::RestoreDoc(doc) => format!("restore doc {doc}"),
            Reverse::TrashDoc(doc) => format!("trash doc {doc}"),
            Reverse::RenameFolder { folder, .. } => format!("rename folder {folder}"),
            Reverse::MoveFolder { folder, to } => format!("move folder {folder} to {}", to.as_deref().unwrap_or("")),
            Reverse::RestoreFolder(folder) => format!("restore folder {folder}"),
            Reverse::TrashFolder(folder) => format!("trash folder {folder}"),
        }
    }

    /// Whether the caller may make this change now: the same checks the change itself makes.
    async fn allowed(&self, state: &AppState, caller: &Caller) -> ApiResult<()> {
        match self {
            Reverse::RenameDoc { doc, .. } => library::renamable_doc(state, caller, doc).await.map(drop),
            Reverse::MoveDoc { doc, to } => library::movable_doc(state, caller, doc, to.as_deref()).await.map(drop),
            Reverse::RestoreDoc(doc) | Reverse::TrashDoc(doc) => access::require_doc(state, Some(caller), doc, Role::Owner).await.map(drop),
            Reverse::RenameFolder { folder, .. } => library::renamable_folder(state, caller, folder).await.map(drop),
            Reverse::MoveFolder { folder, to } => library::movable_folder(state, caller, folder, to.as_deref()).await.map(drop),
            Reverse::RestoreFolder(folder) | Reverse::TrashFolder(folder) => access::require_folder(state, caller, folder, Role::Owner).await.map(drop),
        }
    }

    async fn apply(self, state: &AppState, caller: &Caller) -> ApiResult<()> {
        match self {
            Reverse::RenameDoc { doc, title } => library::rename_doc(state, caller, &doc, title).await,
            Reverse::MoveDoc { doc, to } => library::move_doc(state, caller, &doc, to).await,
            Reverse::RestoreDoc(doc) => library::restore_doc_inner(state, caller, &doc).await,
            Reverse::TrashDoc(doc) => library::trash_doc_inner(state, caller, &doc).await,
            Reverse::RenameFolder { folder, name } => library::rename_folder(state, caller, &folder, name).await,
            Reverse::MoveFolder { folder, to } => library::move_folder(state, caller, &folder, to).await,
            Reverse::RestoreFolder(folder) => library::restore_folder_inner(state, caller, &folder).await,
            Reverse::TrashFolder(folder) => library::trash_folder_inner(state, caller, &folder).await,
        }
    }
}

/// The events, each `undoable` only when the one reading them could undo it now.
async fn events(state: &AppState, caller: &Caller, rows: Vec<Row>) -> ApiResult<Vec<Event>> {
    let people = accounts::many(state, &rows.iter().map(|r| r.actor_uuid.clone()).collect::<Vec<_>>()).await?;
    // Many events need the same rights (every rename of one doc): each is checked once.
    let mut allowed: HashMap<String, bool> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let undoable = match Reverse::of(&r) {
            Some(reverse) if r.undone_at.is_none() => {
                let key = reverse.rights();
                match allowed.get(&key) {
                    Some(ok) => *ok,
                    None => {
                        let ok = match reverse.allowed(state, caller).await {
                            Ok(()) => true,
                            Err(error) if error.status.is_server_error() => return Err(error),
                            Err(_) => false,
                        };
                        allowed.insert(key, ok);
                        ok
                    }
                }
            }
            _ => false,
        };
        out.push(Event {
            id: r.id,
            undoable,
            actor: people.get(&r.actor_uuid).cloned().unwrap_or_else(|| Account::unknown(&r.actor_uuid)),
            kind: r.kind,
            data: r.data,
            created_at: r.created_at,
            undone_at: r.undone_at,
        });
    }
    Ok(out)
}

pub async fn doc_activity(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {ROW_COLUMNS} from activity where doc_id = $1 order by id desc limit 500")))
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "events": events(&state, &caller, rows).await? })))
}

pub async fn folder_activity(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_folder(&state, &caller, &id, Role::Editor).await?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {ROW_COLUMNS} from activity where folder_id = $1 order by id desc limit 500")))
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "events": events(&state, &caller, rows).await? })))
}

/// Whether the caller can open the doc or folder whose history shows the row. Nothing about a
/// history is told to someone who can't: event ids are numbers in order.
async fn visible(state: &AppState, caller: &Caller, row: &Row) -> ApiResult<bool> {
    if let Some(doc_id) = &row.doc_id
        && let Ok(doc) = access::load_doc(state, doc_id).await
        && access::doc_role(state, Some(caller), &doc).await?.is_some()
    {
        return Ok(true);
    }
    if let Some(folder_id) = &row.folder_id
        && let Ok(folder) = access::load_folder(state, folder_id).await
        && access::folder_role(state, caller, &folder).await?.is_some()
    {
        return Ok(true);
    }
    Ok(false)
}

/// Undoes a rename, move, trash or create, in every history the change is in.
pub async fn undo(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {ROW_COLUMNS} from activity where id = $1")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found("This event"));
    };
    if !visible(&state, &caller, &row).await? {
        return Err(ApiError::not_found("This event"));
    }
    if row.undone_at.is_some() {
        return Err(ApiError::conflict("This was already undone."));
    }
    let Some(reverse) = Reverse::of(&row) else {
        return Err(ApiError::invalid("This kind of event can't be undone."));
    };
    reverse.apply(&state, &caller).await?;
    sqlx::query("update activity set undone_at = now() where change_id = $1 and undone_at is null")
        .bind(row.change_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "undone": true })))
}
