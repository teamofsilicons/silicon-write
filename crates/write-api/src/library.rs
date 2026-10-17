//! Docs and folders: creating, listing, renaming, moving, the trash, copies and transfers.
//!
//! Docs are personal: every doc and folder has exactly one owner. A doc created inside someone
//! else's shared folder belongs to that folder's owner (and shows who created it), so a folder
//! never holds docs its owner doesn't control. Nothing is ever deleted except by an owner
//! permanently deleting it from the trash.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, DOC_COLUMNS, DocRow, FOLDER_COLUMNS, FolderRow, Role};
use crate::accounts::{self, Account};
use crate::activity;
use crate::auth::{Auth, Caller, MaybeAuth};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::rooms::{self, Origin};
use crate::state::AppState;
use crate::views::{self, DocView};

const MAX_TITLE: usize = 300;
const MAX_FOLDER_NAME: usize = 200;

fn clean_title(title: &str) -> ApiResult<String> {
    let title = title.trim();
    if title.chars().count() > MAX_TITLE {
        return Err(ApiError::invalid(format!("A title can be at most {MAX_TITLE} characters.")));
    }
    Ok(title.to_owned())
}

fn clean_folder_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::invalid("A folder needs a name."));
    }
    if name.chars().count() > MAX_FOLDER_NAME {
        return Err(ApiError::invalid(format!("A folder name can be at most {MAX_FOLDER_NAME} characters.")));
    }
    Ok(name.to_owned())
}

// ------------------------------------------------------------------------------------------
// Me and the library
// ------------------------------------------------------------------------------------------

pub async fn me(State(state): State<AppState>, Auth(caller): Auth) -> ApiResult<Json<Value>> {
    let account = accounts::one(&state, &caller.uuid).await?;
    Ok(Json(json!({ "account": account })))
}

#[derive(Deserialize)]
pub struct LibraryQuery {
    view: Option<String>,
    folder: Option<String>,
}

pub async fn library(State(state): State<AppState>, Auth(caller): Auth, Query(q): Query<LibraryQuery>) -> ApiResult<Json<Value>> {
    let view = q.view.as_deref().unwrap_or("mine");
    if let Some(folder_id) = q.folder.as_deref().filter(|f| !f.is_empty() && *f != "root") {
        let (folder, role) = access::require_folder(&state, &caller, folder_id, Role::Viewer).await?;
        let folders: Vec<FolderRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {FOLDER_COLUMNS} from folders where parent_id = $1 and deleted_at is null order by lower(name)"
        )))
        .bind(folder_id)
        .fetch_all(&state.db)
        .await?;
        let docs: Vec<DocRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {DOC_COLUMNS} from docs where folder_id = $1 and deleted_at is null order by updated_at desc"
        )))
        .bind(folder_id)
        .fetch_all(&state.db)
        .await?;
        return Ok(Json(json!({
            "folder": views::folder_view(&state, &folder, role, Some(&caller.uuid)).await?,
            "folders": views::folder_views(&state, folders, &caller).await?,
            "docs": views::doc_views(&state, docs, &caller).await?,
        })));
    }
    let (folders, docs): (Vec<FolderRow>, Vec<DocRow>) = match view {
        "shared" => (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {FOLDER_COLUMNS} from folders where deleted_at is null and owner_uuid <> $1
                 and id in (select folder_id from shares where account_uuid = $1) order by lower(name)"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {DOC_COLUMNS} from docs where deleted_at is null and owner_uuid <> $1
                 and id in (select doc_id from shares where account_uuid = $1) order by updated_at desc"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
        ),
        "trash" => (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {FOLDER_COLUMNS} from folders where owner_uuid = $1 and deleted_at is not null and trashed_with is null order by deleted_at desc"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {DOC_COLUMNS} from docs where owner_uuid = $1 and deleted_at is not null and trashed_with is null order by deleted_at desc"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
        ),
        "recent" => (
            vec![],
            {
                let ids = access::accessible_doc_ids(&state, &caller.uuid).await?;
                sqlx::query_as(sqlx::AssertSqlSafe(format!("select {DOC_COLUMNS} from docs where id = any($1) order by updated_at desc limit 30")))
                    .bind(&ids)
                    .fetch_all(&state.db)
                    .await?
            },
        ),
        "mine" => (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {FOLDER_COLUMNS} from folders where owner_uuid = $1 and parent_id is null and deleted_at is null order by lower(name)"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {DOC_COLUMNS} from docs where owner_uuid = $1 and folder_id is null and deleted_at is null order by updated_at desc"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
        ),
        other => return Err(ApiError::invalid(format!("Unknown view `{other}`.")).hint("Use mine, shared, recent or trash.")),
    };
    Ok(Json(json!({
        "folder": Value::Null,
        "folders": views::folder_views(&state, folders, &caller).await?,
        "docs": views::doc_views(&state, docs, &caller).await?,
    })))
}

pub async fn all_docs(State(state): State<AppState>, Auth(caller): Auth) -> ApiResult<Json<Value>> {
    let ids = access::accessible_doc_ids(&state, &caller.uuid).await?;
    let docs: Vec<DocRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {DOC_COLUMNS} from docs where id = any($1) order by lower(title), created_at")))
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "docs": views::doc_views(&state, docs, &caller).await? })))
}

pub async fn all_folders(State(state): State<AppState>, Auth(caller): Auth) -> ApiResult<Json<Value>> {
    let ids = access::accessible_folder_ids(&state, &caller.uuid).await?;
    let folders: Vec<FolderRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {FOLDER_COLUMNS} from folders where id = any($1) order by lower(name)")))
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "folders": views::folder_views(&state, folders, &caller).await? })))
}

// ------------------------------------------------------------------------------------------
// Docs
// ------------------------------------------------------------------------------------------

/// Where a new doc goes, and who owns it: the folder's owner when it's made in a folder.
async fn placement(state: &AppState, caller: &Caller, folder_id: Option<&str>) -> ApiResult<(Option<String>, String)> {
    match folder_id.filter(|f| !f.is_empty() && *f != "root") {
        Some(folder_id) => {
            let (folder, _) = access::require_folder(state, caller, folder_id, Role::Editor).await?;
            Ok((Some(folder.id), folder.owner_uuid))
        }
        None => Ok((None, caller.uuid.clone())),
    }
}

/// Creates a doc, with content when given.
pub async fn create_doc(
    state: &AppState,
    caller: &Caller,
    title: &str,
    folder_id: Option<&str>,
    content: Option<write_doc::Doc>,
    kind: &str,
    origin: Origin,
) -> ApiResult<DocRow> {
    let title = clean_title(title)?;
    let (folder, owner) = placement(state, caller, folder_id).await?;
    let id = ids::new_id("d");
    sqlx::query("insert into docs (id, owner_uuid, folder_id, title, kind, created_by) values ($1, $2, $3, $4, $5, $6)")
        .bind(&id)
        .bind(&owner)
        .bind(&folder)
        .bind(&title)
        .bind(kind)
        .bind(&caller.uuid)
        .execute(&state.db)
        .await?;
    activity::record(state, Some(&id), folder.as_deref(), &caller.uuid, "doc.created", json!({ "doc": id, "title": title })).await?;
    if let Some(content) = content {
        rooms::edit(state, &id, &caller.uuid, origin, None, |y| {
            write_doc::ydoc::with_txn(y, |txn, frag| write_doc::ydoc::write_all(txn, frag, &content));
            Ok(())
        })
        .await?;
    }
    access::load_doc(state, &id).await
}

#[derive(Deserialize)]
pub struct NewDoc {
    title: Option<String>,
    folder_id: Option<String>,
    markdown: Option<String>,
}

pub async fn new_doc(State(state): State<AppState>, Auth(caller): Auth, Json(body): Json<NewDoc>) -> ApiResult<(StatusCode, Json<DocView>)> {
    let content = body.markdown.as_deref().filter(|m| !m.trim().is_empty()).map(write_doc::from_markdown);
    let doc = create_doc(&state, &caller, body.title.as_deref().unwrap_or(""), body.folder_id.as_deref(), content, "doc", Origin::Create).await?;
    let role = access::doc_role(&state, Some(&caller), &doc).await?.unwrap_or(Role::Editor);
    Ok((StatusCode::CREATED, Json(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?)))
}

pub async fn get_doc(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>) -> ApiResult<Json<DocView>> {
    let (doc, role) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
    Ok(Json(views::doc_view(&state, &doc, role, caller.as_ref().map(|c| c.uuid.as_str())).await?))
}

#[derive(Deserialize)]
pub struct DocPatch {
    title: Option<String>,
    /// `null` moves the doc to its owner's top level.
    #[serde(default, deserialize_with = "double_option")]
    folder_id: Option<Option<String>>,
}

fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

pub async fn patch_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<DocPatch>) -> ApiResult<Json<DocView>> {
    if let Some(title) = body.title {
        rename_doc(&state, &caller, &id, title).await?;
    }
    if let Some(folder) = body.folder_id {
        move_doc(&state, &caller, &id, folder).await?;
    }
    let (doc, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    Ok(Json(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?))
}

pub async fn rename_doc(state: &AppState, caller: &Caller, id: &str, title: String) -> ApiResult<()> {
    let (doc, _) = access::require_doc(state, Some(caller), id, Role::Editor).await?;
    let title = clean_title(&title)?;
    if title == doc.title {
        return Ok(());
    }
    sqlx::query(
        "update docs set title = $2, updated_at = now(),
            search = setweight(to_tsvector('simple', $2), 'A') || setweight(to_tsvector('simple', plain_text), 'B')
         where id = $1",
    )
    .bind(id)
    .bind(&title)
    .execute(&state.db)
    .await?;
    activity::record(state, Some(id), doc.folder_id.as_deref(), &caller.uuid, "doc.renamed", json!({ "doc": id, "from": doc.title, "to": title })).await?;
    state.rooms.notify(id, json!({ "type": "meta" })).await;
    Ok(())
}

pub async fn move_doc(state: &AppState, caller: &Caller, id: &str, target: Option<String>) -> ApiResult<()> {
    let (doc, role) = access::require_doc(state, Some(caller), id, Role::Editor).await?;
    let target = target.filter(|t| !t.is_empty() && t != "root");
    if target == doc.folder_id {
        return Ok(());
    }
    match &target {
        Some(folder_id) => {
            let (folder, _) = access::require_folder(state, caller, folder_id, Role::Editor).await?;
            if folder.owner_uuid != doc.owner_uuid {
                return Err(ApiError::invalid("A doc can only move into a folder with the same owner.")
                    .hint("Transfer the doc to the folder's owner first."));
            }
        }
        None => {
            if role != Role::Owner {
                return Err(ApiError::forbidden("Only the doc's owner can move it out of its folders."));
            }
        }
    }
    if let Some(from) = &doc.folder_id {
        // Taking a doc out of a folder needs edit access there too.
        access::require_folder(state, caller, from, Role::Editor).await?;
    }
    sqlx::query("update docs set folder_id = $2, updated_at = now() where id = $1").bind(id).bind(&target).execute(&state.db).await?;
    let data = json!({ "doc": id, "from_folder": doc.folder_id, "to_folder": target });
    activity::record(state, Some(id), None, &caller.uuid, "doc.moved", data.clone()).await?;
    if let Some(from) = &doc.folder_id {
        activity::record(state, None, Some(from), &caller.uuid, "doc.moved", data.clone()).await?;
    }
    if let Some(to) = &target {
        activity::record(state, None, Some(to), &caller.uuid, "doc.moved", data).await?;
    }
    // Moving changes who can open the doc.
    state.rooms.recheck(state, id).await;
    state.rooms.notify(id, json!({ "type": "meta" })).await;
    Ok(())
}

pub async fn trash_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<StatusCode> {
    trash_doc_inner(&state, &caller, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn trash_doc_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (doc, _) = access::require_doc(state, Some(caller), id, Role::Owner).await?;
    if doc.deleted_at.is_some() {
        return Ok(());
    }
    sqlx::query("update docs set deleted_at = now(), deleted_by = $2, trashed_with = null where id = $1").bind(id).bind(&caller.uuid).execute(&state.db).await?;
    activity::record(state, Some(id), doc.folder_id.as_deref(), &caller.uuid, "doc.trashed", json!({ "doc": id, "title": doc.display_title() })).await?;
    state.rooms.recheck(state, id).await;
    Ok(())
}

pub async fn restore_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<DocView>> {
    restore_doc_inner(&state, &caller, &id).await?;
    let (doc, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    Ok(Json(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?))
}

pub async fn restore_doc_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (doc, _) = access::require_doc(state, Some(caller), id, Role::Owner).await?;
    if doc.deleted_at.is_none() {
        return Ok(());
    }
    // Back where it was, unless that folder is gone too: then to the top level.
    let folder_alive = match &doc.folder_id {
        Some(f) => access::load_folder(state, f).await.map(|f| f.deleted_at.is_none()).unwrap_or(false),
        None => true,
    };
    let folder = if folder_alive { doc.folder_id.clone() } else { None };
    sqlx::query("update docs set deleted_at = null, deleted_by = null, trashed_with = null, folder_id = $2 where id = $1")
        .bind(id)
        .bind(&folder)
        .execute(&state.db)
        .await?;
    activity::record(state, Some(id), folder.as_deref(), &caller.uuid, "doc.restored", json!({ "doc": id })).await?;
    state.rooms.recheck(state, id).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct Confirm {
    confirm: Option<String>,
}

pub async fn purge_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<Confirm>) -> ApiResult<StatusCode> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    if q.confirm.as_deref() != Some(id.as_str()) {
        return Err(ApiError::invalid("Deleting permanently needs confirming.").hint(format!("Pass ?confirm={id}. This can't be undone.")));
    }
    if doc.deleted_at.is_none() {
        return Err(ApiError::conflict("Only docs in the trash can be deleted permanently.").hint("Move it to the trash first."));
    }
    purge_docs(&state, &[id.clone()]).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes docs and everything about them. The only real deletion in Silicon Write.
async fn purge_docs(state: &AppState, ids: &[String]) -> ApiResult<()> {
    let paths: Vec<String> = sqlx::query_scalar("select path from assets where doc_id = any($1)").bind(ids).fetch_all(&state.db).await?;
    sqlx::query("delete from docs where id = any($1)").bind(ids).execute(&state.db).await?;
    for path in paths {
        let _ = tokio::fs::remove_file(state.config.data_dir.join(path)).await;
    }
    for id in ids {
        state.rooms.drop_room(id).await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CopyBody {
    seq: Option<i64>,
    title: Option<String>,
    folder_id: Option<String>,
}

pub async fn copy_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<CopyBody>) -> ApiResult<(StatusCode, Json<DocView>)> {
    let min = if body.seq.is_some() { Role::Editor } else { Role::Viewer };
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, min).await?;
    let content = match body.seq {
        Some(seq) => crate::versions::doc_at(&state, &id, seq).await?,
        None => rooms::read(&state, &id).await?.0,
    };
    let title = body.title.unwrap_or_else(|| format!("Copy of {}", doc.display_title()));
    let new = create_doc(&state, &caller, &title, body.folder_id.as_deref(), Some(content.without_suggestions()), "doc", Origin::Create).await?;
    activity::record(&state, Some(&new.id), None, &caller.uuid, "doc.copied", json!({ "from": id, "seq": body.seq })).await?;
    let role = access::doc_role(&state, Some(&caller), &new).await?.unwrap_or(Role::Owner);
    Ok((StatusCode::CREATED, Json(views::doc_view(&state, &new, role, Some(&caller.uuid)).await?)))
}

// ------------------------------------------------------------------------------------------
// Folders
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct NewFolder {
    name: String,
    parent_id: Option<String>,
}

pub async fn new_folder(State(state): State<AppState>, Auth(caller): Auth, Json(body): Json<NewFolder>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = clean_folder_name(&body.name)?;
    let (parent, owner) = placement(&state, &caller, body.parent_id.as_deref()).await?;
    let id = ids::new_id("f");
    sqlx::query("insert into folders (id, owner_uuid, parent_id, name, created_by) values ($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(&owner)
        .bind(&parent)
        .bind(&name)
        .bind(&caller.uuid)
        .execute(&state.db)
        .await?;
    activity::record(&state, None, Some(&id), &caller.uuid, "folder.created", json!({ "folder": id, "name": name })).await?;
    if let Some(parent) = &parent {
        activity::record(&state, None, Some(parent), &caller.uuid, "folder.created", json!({ "folder": id, "name": name })).await?;
    }
    let (folder, role) = access::require_folder(&state, &caller, &id, Role::Viewer).await?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(views::folder_view(&state, &folder, role, Some(&caller.uuid)).await?).unwrap())))
}

pub async fn get_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (folder, role) = access::require_folder(&state, &caller, &id, Role::Viewer).await?;
    Ok(Json(serde_json::to_value(views::folder_view(&state, &folder, role, Some(&caller.uuid)).await?).unwrap()))
}

#[derive(Deserialize)]
pub struct FolderPatch {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<String>>,
}

pub async fn patch_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<FolderPatch>) -> ApiResult<Json<Value>> {
    if let Some(name) = body.name {
        rename_folder(&state, &caller, &id, name).await?;
    }
    if let Some(parent) = body.parent_id {
        move_folder(&state, &caller, &id, parent).await?;
    }
    get_folder(State(state), Auth(caller), Path(id)).await
}

pub async fn rename_folder(state: &AppState, caller: &Caller, id: &str, name: String) -> ApiResult<()> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Editor).await?;
    let name = clean_folder_name(&name)?;
    if name == folder.name {
        return Ok(());
    }
    sqlx::query("update folders set name = $2, updated_at = now() where id = $1").bind(id).bind(&name).execute(&state.db).await?;
    let data = json!({ "folder": id, "from": folder.name, "to": name });
    activity::record(state, None, Some(id), &caller.uuid, "folder.renamed", data.clone()).await?;
    if let Some(parent) = &folder.parent_id {
        activity::record(state, None, Some(parent), &caller.uuid, "folder.renamed", data).await?;
    }
    Ok(())
}

pub async fn move_folder(state: &AppState, caller: &Caller, id: &str, target: Option<String>) -> ApiResult<()> {
    let (folder, role) = access::require_folder(state, caller, id, Role::Editor).await?;
    let target = target.filter(|t| !t.is_empty() && t != "root");
    if target == folder.parent_id {
        return Ok(());
    }
    match &target {
        Some(parent_id) => {
            let (parent, _) = access::require_folder(state, caller, parent_id, Role::Editor).await?;
            if parent.owner_uuid != folder.owner_uuid {
                return Err(ApiError::invalid("A folder can only move into a folder with the same owner.").hint("Transfer it to that folder's owner first."));
            }
            // Not into itself or anything inside it.
            let chain = access::ancestors(state, Some(parent_id)).await?;
            if chain.iter().any(|f| f.id == id) {
                return Err(ApiError::invalid("A folder can't move into itself or a folder inside it."));
            }
        }
        None => {
            if role != Role::Owner {
                return Err(ApiError::forbidden("Only the folder's owner can move it to the top level."));
            }
        }
    }
    if let Some(from) = &folder.parent_id {
        access::require_folder(state, caller, from, Role::Editor).await?;
    }
    sqlx::query("update folders set parent_id = $2, updated_at = now() where id = $1").bind(id).bind(&target).execute(&state.db).await?;
    let data = json!({ "folder": id, "from_parent": folder.parent_id, "to_parent": target });
    activity::record(state, None, Some(id), &caller.uuid, "folder.moved", data.clone()).await?;
    for place in [folder.parent_id.as_ref(), target.as_ref()].into_iter().flatten() {
        activity::record(state, None, Some(place), &caller.uuid, "folder.moved", data.clone()).await?;
    }
    for doc in docs_under(state, id, false).await? {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

/// Every folder under a folder (itself included), and every doc in them.
async fn tree(state: &AppState, id: &str, include_deleted: bool) -> ApiResult<(Vec<String>, Vec<String>)> {
    let deleted_filter = if include_deleted { "" } else { "and f.deleted_at is null" };
    let folders: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "with recursive t as (
            select id from folders where id = $1
            union all
            select f.id from folders f join t on f.parent_id = t.id where true {deleted_filter}
        ) select id from t"
    )))
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let docs: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select id from docs where folder_id = any($1) {}",
        if include_deleted { "" } else { "and deleted_at is null" }
    )))
    .bind(&folders)
    .fetch_all(&state.db)
    .await?;
    Ok((folders, docs))
}

async fn docs_under(state: &AppState, id: &str, include_deleted: bool) -> ApiResult<Vec<String>> {
    Ok(tree(state, id, include_deleted).await?.1)
}

pub async fn trash_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<StatusCode> {
    trash_folder_inner(&state, &caller, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn trash_folder_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Owner).await?;
    if folder.deleted_at.is_some() {
        return Ok(());
    }
    let (folders, docs) = tree(state, id, false).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("update folders set deleted_at = now(), deleted_by = $2, trashed_with = null where id = $1").bind(id).bind(&caller.uuid).execute(&mut *tx).await?;
    sqlx::query("update folders set deleted_at = now(), deleted_by = $2, trashed_with = $1 where id = any($3) and id <> $1 and deleted_at is null")
        .bind(id)
        .bind(&caller.uuid)
        .bind(&folders)
        .execute(&mut *tx)
        .await?;
    sqlx::query("update docs set deleted_at = now(), deleted_by = $2, trashed_with = $1 where id = any($3) and deleted_at is null")
        .bind(id)
        .bind(&caller.uuid)
        .bind(&docs)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    activity::record(state, None, Some(id), &caller.uuid, "folder.trashed", json!({ "folder": id, "name": folder.name })).await?;
    if let Some(parent) = &folder.parent_id {
        activity::record(state, None, Some(parent), &caller.uuid, "folder.trashed", json!({ "folder": id, "name": folder.name })).await?;
    }
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

pub async fn restore_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    restore_folder_inner(&state, &caller, &id).await?;
    get_folder(State(state), Auth(caller), Path(id)).await
}

pub async fn restore_folder_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Owner).await?;
    if folder.deleted_at.is_none() {
        return Ok(());
    }
    let parent_alive = match &folder.parent_id {
        Some(p) => access::load_folder(state, p).await.map(|f| f.deleted_at.is_none()).unwrap_or(false),
        None => true,
    };
    let parent = if parent_alive { folder.parent_id.clone() } else { None };
    let mut tx = state.db.begin().await?;
    sqlx::query("update folders set deleted_at = null, deleted_by = null, trashed_with = null, parent_id = $2 where id = $1").bind(id).bind(&parent).execute(&mut *tx).await?;
    sqlx::query("update folders set deleted_at = null, deleted_by = null, trashed_with = null where trashed_with = $1").bind(id).execute(&mut *tx).await?;
    let docs: Vec<String> = sqlx::query_scalar("update docs set deleted_at = null, deleted_by = null, trashed_with = null where trashed_with = $1 returning id")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    activity::record(state, None, Some(id), &caller.uuid, "folder.restored", json!({ "folder": id })).await?;
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

pub async fn purge_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<Confirm>) -> ApiResult<StatusCode> {
    let (folder, _) = access::require_folder(&state, &caller, &id, Role::Owner).await?;
    if q.confirm.as_deref() != Some(id.as_str()) {
        return Err(ApiError::invalid("Deleting permanently needs confirming.").hint(format!("Pass ?confirm={id}. This can't be undone.")));
    }
    if folder.deleted_at.is_none() {
        return Err(ApiError::conflict("Only folders in the trash can be deleted permanently.").hint("Move it to the trash first."));
    }
    let (folders, docs) = tree(&state, &id, true).await?;
    purge_docs(&state, &docs).await?;
    // Children first.
    sqlx::query("update folders set parent_id = null where id = any($1)").bind(&folders).execute(&state.db).await?;
    sqlx::query("delete from folders where id = any($1)").bind(&folders).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------------------------------
// Transfers
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TransferBody {
    to: String,
}

#[derive(sqlx::FromRow)]
struct TransferRow {
    id: String,
    doc_id: Option<String>,
    folder_id: Option<String>,
    from_uuid: String,
    to_uuid: String,
    status: String,
    created_at: time::OffsetDateTime,
}

async fn transfer_view(state: &AppState, t: &TransferRow) -> ApiResult<Value> {
    let people = accounts::many(state, &[t.from_uuid.clone(), t.to_uuid.clone()]).await?;
    let item = match (&t.doc_id, &t.folder_id) {
        (Some(d), _) => {
            let title = access::load_doc(state, d).await.map(|d| d.display_title()).unwrap_or_default();
            json!({ "kind": "doc", "id": d, "title": title })
        }
        (_, Some(f)) => {
            let name = access::load_folder(state, f).await.map(|f| f.name).unwrap_or_default();
            json!({ "kind": "folder", "id": f, "title": name })
        }
        _ => Value::Null,
    };
    Ok(json!({
        "id": t.id,
        "item": item,
        "from": people.get(&t.from_uuid),
        "to": people.get(&t.to_uuid),
        "status": t.status,
        "created_at": t.created_at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    }))
}

async fn start_transfer(state: &AppState, caller: &Caller, doc: Option<&DocRow>, folder: Option<&FolderRow>, to: &str) -> ApiResult<Value> {
    let target: Account = accounts::by_public_id(state, to).await?;
    if target.uuid == caller.uuid {
        return Err(ApiError::invalid("You already own this."));
    }
    let id = ids::new_id("x");
    sqlx::query("update transfers set status = 'cancelled', decided_at = now() where status = 'pending' and (doc_id = $1 or folder_id = $2)")
        .bind(doc.map(|d| d.id.clone()))
        .bind(folder.map(|f| f.id.clone()))
        .execute(&state.db)
        .await?;
    sqlx::query("insert into transfers (id, doc_id, folder_id, from_uuid, to_uuid) values ($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(doc.map(|d| d.id.clone()))
        .bind(folder.map(|f| f.id.clone()))
        .bind(&caller.uuid)
        .bind(&target.uuid)
        .execute(&state.db)
        .await?;
    activity::record(
        state,
        doc.map(|d| d.id.as_str()),
        folder.map(|f| f.id.as_str()),
        &caller.uuid,
        "transfer.started",
        json!({ "transfer": id, "to": target.uuid }),
    )
    .await?;
    let row: TransferRow = sqlx::query_as("select id, doc_id, folder_id, from_uuid, to_uuid, status, created_at from transfers where id = $1").bind(&id).fetch_one(&state.db).await?;
    transfer_view(state, &row).await
}

pub async fn transfer_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<TransferBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    Ok(Json(start_transfer(&state, &caller, Some(&doc), None, &body.to).await?))
}

pub async fn transfer_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<TransferBody>) -> ApiResult<Json<Value>> {
    let (folder, _) = access::require_folder(&state, &caller, &id, Role::Owner).await?;
    Ok(Json(start_transfer(&state, &caller, None, Some(&folder), &body.to).await?))
}

pub async fn transfers(State(state): State<AppState>, Auth(caller): Auth) -> ApiResult<Json<Value>> {
    let rows: Vec<TransferRow> = sqlx::query_as(
        "select id, doc_id, folder_id, from_uuid, to_uuid, status, created_at from transfers where (to_uuid = $1 or from_uuid = $1) order by created_at desc limit 200",
    )
    .bind(&caller.uuid)
    .fetch_all(&state.db)
    .await?;
    let mut incoming = vec![];
    let mut outgoing = vec![];
    for row in &rows {
        let view = transfer_view(&state, row).await?;
        if row.to_uuid == caller.uuid {
            incoming.push(view);
        } else {
            outgoing.push(view);
        }
    }
    Ok(Json(json!({ "incoming": incoming, "outgoing": outgoing })))
}

pub async fn decide_transfer(State(state): State<AppState>, Auth(caller): Auth, Path((id, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let row: TransferRow = sqlx::query_as("select id, doc_id, folder_id, from_uuid, to_uuid, status, created_at from transfers where id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This transfer"))?;
    if row.status != "pending" {
        return Err(ApiError::conflict(format!("This transfer is already {}.", row.status)));
    }
    match action.as_str() {
        "accept" | "decline" if row.to_uuid != caller.uuid => return Err(ApiError::not_found("This transfer")),
        "cancel" if row.from_uuid != caller.uuid => return Err(ApiError::not_found("This transfer")),
        "accept" | "decline" | "cancel" => {}
        _ => return Err(ApiError::not_found("This action")),
    }
    let status = match action.as_str() {
        "accept" => "accepted",
        "decline" => "declined",
        _ => "cancelled",
    };
    if action == "accept" {
        accept_transfer(&state, &row).await?;
    }
    sqlx::query("update transfers set status = $2, decided_at = now() where id = $1").bind(&id).bind(status).execute(&state.db).await?;
    let updated: TransferRow = sqlx::query_as("select id, doc_id, folder_id, from_uuid, to_uuid, status, created_at from transfers where id = $1").bind(&id).fetch_one(&state.db).await?;
    Ok(Json(transfer_view(&state, &updated).await?))
}

/// Moves ownership. The previous owner keeps edit access, and the item moves to the new owner's
/// top level when it sat in a folder of someone else.
async fn accept_transfer(state: &AppState, t: &TransferRow) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let mut touched_docs = vec![];
    if let Some(doc_id) = &t.doc_id {
        let doc = access::load_doc(state, doc_id).await?;
        if doc.owner_uuid != t.from_uuid {
            return Err(ApiError::conflict("The doc changed owner since this transfer started."));
        }
        sqlx::query("update docs set owner_uuid = $2, folder_id = null, updated_at = now() where id = $1").bind(doc_id).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("delete from shares where doc_id = $1 and account_uuid = $2").bind(doc_id).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("insert into shares (id, doc_id, account_uuid, role, invited_by) values ($1, $2, $3, 'editor', $4) on conflict do nothing")
            .bind(ids::new_id("m"))
            .bind(doc_id)
            .bind(&t.from_uuid)
            .bind(&t.to_uuid)
            .execute(&mut *tx)
            .await?;
        touched_docs.push(doc_id.clone());
    }
    if let Some(folder_id) = &t.folder_id {
        let folder = access::load_folder(state, folder_id).await?;
        if folder.owner_uuid != t.from_uuid {
            return Err(ApiError::conflict("The folder changed owner since this transfer started."));
        }
        let (folders, docs) = tree(state, folder_id, true).await?;
        sqlx::query("update folders set owner_uuid = $2 where id = any($1)").bind(&folders).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("update folders set parent_id = null where id = $1").bind(folder_id).execute(&mut *tx).await?;
        sqlx::query("update docs set owner_uuid = $2 where id = any($1)").bind(&docs).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("delete from shares where folder_id = $1 and account_uuid = $2").bind(folder_id).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("insert into shares (id, folder_id, account_uuid, role, invited_by) values ($1, $2, $3, 'editor', $4) on conflict do nothing")
            .bind(ids::new_id("m"))
            .bind(folder_id)
            .bind(&t.from_uuid)
            .bind(&t.to_uuid)
            .execute(&mut *tx)
            .await?;
        touched_docs.extend(docs);
    }
    tx.commit().await?;
    activity::record(state, t.doc_id.as_deref(), t.folder_id.as_deref(), &t.to_uuid, "transfer.accepted", json!({ "transfer": t.id, "from": t.from_uuid, "to": t.to_uuid })).await?;
    for doc in touched_docs {
        state.rooms.recheck(state, &doc).await;
        state.rooms.notify(&doc, json!({ "type": "meta" })).await;
    }
    Ok(())
}
