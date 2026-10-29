//! Docs and folders: creating, listing, renaming, moving, the trash, copies and transfers.
//!
//! Docs are personal: every doc and folder has exactly one owner. A doc created inside someone
//! else's shared folder belongs to that folder's owner (and shows who created it), so a folder
//! never holds docs its owner doesn't control. Nothing is ever deleted except by an owner
//! permanently deleting it from the trash.
//!
//! What's in the trash stays as it was until it's restored: it isn't renamed, moved or offered,
//! and nothing is made in it or moved into it. Deleting a folder for good removes it and what
//! went to the trash with it, never what was put there on its own before (which the trash lists
//! on its own) and never anything that isn't in the trash.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, DOC_COLUMNS, DocRow, FOLDER_COLUMNS, FolderRow, Role};
use crate::accounts::{self, Account};
use crate::activity::{self, About};
use crate::auth::{Auth, Caller, MaybeAuth};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::rooms::{self, Origin};
use crate::state::AppState;
use crate::views::{self, DocView};

const MAX_TITLE: usize = 300;
const MAX_FOLDER_NAME: usize = 200;
/// The most Markdown a doc can be made from: as much as can be written to one with
/// `PUT /v1/docs/{id}/markdown`, so whatever it is made from can always be written back whole.
const MAX_MARKDOWN: usize = 5 * 1024 * 1024;

/// A title as it is kept: trimmed, and without NUL characters, which can't be stored or shown.
fn clean_title(title: &str) -> ApiResult<String> {
    let title = title.replace('\0', "");
    let title = title.trim();
    if title.chars().count() > MAX_TITLE {
        return Err(ApiError::invalid(format!("A title can be at most {MAX_TITLE} characters.")));
    }
    Ok(title.to_owned())
}

/// A folder name as it is kept: trimmed, not empty, and without NUL characters.
fn clean_folder_name(name: &str) -> ApiResult<String> {
    let name = name.replace('\0', "");
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::invalid("A folder needs a name."));
    }
    if name.chars().count() > MAX_FOLDER_NAME {
        return Err(ApiError::invalid(format!("A folder name can be at most {MAX_FOLDER_NAME} characters.")));
    }
    Ok(name.to_owned())
}

fn doc_in_trash() -> ApiError {
    ApiError::conflict("This doc is in the trash.").hint("Restore it first.")
}

fn folder_in_trash() -> ApiError {
    ApiError::conflict("This folder is in the trash.").hint("Restore it first.")
}

/// Nothing goes into a folder in the trash, where nobody would see it.
fn into_trash() -> ApiError {
    ApiError::conflict("That folder is in the trash.").hint("Restore it first, or choose another folder.")
}

fn into_itself() -> ApiError {
    ApiError::invalid("A folder can't move into itself or a folder inside it.")
}

/// For a write whose second check failed although the first passed: what it depends on changed
/// in between. Checking again names what changed; this answers when it has changed back since.
fn changed_meanwhile() -> ApiError {
    ApiError::conflict("That changed while this was being done.").hint("Try again.")
}

/// A folder the caller may make and move things into: they edit it, and it isn't in the trash.
///
/// This is checked first, for a clear answer; the write that puts something into the folder then
/// checks again that it is out of the trash and still has the right owner, holding the folder
/// (`for share`) while it does: putting the folder in the trash meanwhile waits for that write and
/// takes what it put there along, or the write waits for the trash and is refused.
async fn open_folder(state: &AppState, caller: &Caller, id: &str) -> ApiResult<FolderRow> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Editor).await?;
    if folder.deleted_at.is_some() {
        return Err(into_trash());
    }
    Ok(folder)
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

/// The trashing a folder in the trash went in: its own, or that of the folder above it that it
/// went with. Everything that went with it is marked with the same folder (`trashed_with`).
async fn trashing(state: &AppState, folder_id: &str) -> ApiResult<String> {
    Ok(sqlx::query_scalar("select coalesce(trashed_with, id) from folders where id = $1").bind(folder_id).fetch_one(&state.db).await?)
}

pub async fn library(State(state): State<AppState>, Auth(caller): Auth, Query(q): Query<LibraryQuery>) -> ApiResult<Json<Value>> {
    let view = q.view.as_deref().unwrap_or("mine");
    if let Some(folder_id) = q.folder.as_deref().filter(|f| !f.is_empty() && *f != "root") {
        let (folder, role) = access::require_folder(&state, &caller, folder_id, Role::Viewer).await?;
        let (mut folders, mut docs): (Vec<FolderRow>, Vec<DocRow>) = if folder.deleted_at.is_some() {
            // A folder in the trash (only its owner opens it) shows what went there with it:
            // what deleting it for good removes.
            let with = trashing(&state, folder_id).await?;
            (
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "select {FOLDER_COLUMNS} from folders where parent_id = $1 and trashed_with = $2 order by lower(name)"
                )))
                .bind(folder_id)
                .bind(&with)
                .fetch_all(&state.db)
                .await?,
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "select {DOC_COLUMNS} from docs where folder_id = $1 and trashed_with = $2 order by updated_at desc"
                )))
                .bind(folder_id)
                .bind(&with)
                .fetch_all(&state.db)
                .await?,
            )
        } else {
            (
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "select {FOLDER_COLUMNS} from folders where parent_id = $1 and deleted_at is null order by lower(name)"
                )))
                .bind(folder_id)
                .fetch_all(&state.db)
                .await?,
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "select {DOC_COLUMNS} from docs where folder_id = $1 and deleted_at is null order by updated_at desc"
                )))
                .bind(folder_id)
                .fetch_all(&state.db)
                .await?,
            )
        };
        if folder.deleted_at.is_none() {
            crate::archive::filter(&state, &caller, &mut folders, &mut docs, true).await?;
        }
        return Ok(Json(json!({
            "folder": views::folder_view(&state, &folder, role, Some(&caller.uuid)).await?,
            "folders": views::folder_views(&state, folders, &caller).await?,
            "docs": views::doc_views(&state, docs, &caller).await?,
        })));
    }
    let (mut folders, mut docs): (Vec<FolderRow>, Vec<DocRow>) = match view {
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
        "archive" => (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {FOLDER_COLUMNS} from folders where deleted_at is null and id in (select folder_id from archived_folders where account_uuid = $1) order by lower(name)"
            )))
            .bind(&caller.uuid)
            .fetch_all(&state.db)
            .await?,
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {DOC_COLUMNS} from docs where deleted_at is null and id in (select doc_id from archived_docs where account_uuid = $1) order by updated_at desc"
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
                sqlx::query_as(sqlx::AssertSqlSafe(format!("select {DOC_COLUMNS} from docs where id = any($1) order by updated_at desc")))
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
        other => return Err(ApiError::invalid(format!("Unknown view `{other}`.")).hint("Use mine, shared, recent, archive or trash.")),
    };
    if view != "archive" && view != "trash" {
        crate::archive::filter(&state, &caller, &mut folders, &mut docs, false).await?;
    }
    if view == "recent" { docs.truncate(30); }
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

/// Where a new doc or folder goes, and who owns it: the folder's owner when it's made in a
/// folder, which must be one the caller edits and not in the trash.
async fn placement(state: &AppState, caller: &Caller, folder_id: Option<&str>) -> ApiResult<(Option<String>, String)> {
    match folder_id.filter(|f| !f.is_empty() && *f != "root") {
        Some(folder_id) => {
            let folder = open_folder(state, caller, folder_id).await?;
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
    let made = sqlx::query(
        "insert into docs (id, owner_uuid, folder_id, title, kind, created_by)
         select $1, $2, $3, $4, $5, $6
         where $3::text is null or exists (select 1 from folders where id = $3 and deleted_at is null and owner_uuid = $2 for share)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&folder)
    .bind(&title)
    .bind(kind)
    .bind(&caller.uuid)
    .execute(&state.db)
    .await?
    .rows_affected();
    if made == 0 {
        placement(state, caller, folder.as_deref()).await?;
        return Err(changed_meanwhile());
    }
    activity::record_change(state, About::Doc(&id), &[(Some(&id), folder.as_deref())], &caller.uuid, "doc.created", json!({ "doc": id, "title": title })).await?;
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
    if body.markdown.as_ref().is_some_and(|m| m.len() > MAX_MARKDOWN) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "That's more than 5 MB of Markdown."));
    }
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

/// A doc the caller may rename: they edit it, and it isn't in the trash.
pub async fn renamable_doc(state: &AppState, caller: &Caller, id: &str) -> ApiResult<DocRow> {
    let (doc, _) = access::require_doc(state, Some(caller), id, Role::Editor).await?;
    if doc.deleted_at.is_some() {
        return Err(doc_in_trash());
    }
    Ok(doc)
}

pub async fn rename_doc(state: &AppState, caller: &Caller, id: &str, title: String) -> ApiResult<()> {
    let doc = renamable_doc(state, caller, id).await?;
    let title = clean_title(&title)?;
    if title == doc.title {
        return Ok(());
    }
    let renamed = sqlx::query(
        "update docs set title = $2, updated_at = now(),
            search = setweight(to_tsvector('simple', $2), 'A') || setweight(to_tsvector('simple', plain_text), 'B')
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&title)
    .execute(&state.db)
    .await?
    .rows_affected();
    if renamed == 0 {
        return Err(doc_in_trash());
    }
    let data = json!({ "doc": id, "from": doc.title, "to": title });
    activity::record_change(state, About::Doc(id), &[(Some(id), doc.folder_id.as_deref())], &caller.uuid, "doc.renamed", data).await?;
    state.rooms.notify(id, json!({ "type": "meta" })).await;
    Ok(())
}

/// Checks the caller may move a doc into `target` (or with `None` to its owner's top level), and
/// returns the doc. It needs edit access to the doc and to the folders it leaves and joins, which
/// have the doc's owner and aren't in the trash; only the owner moves it out to the top level.
/// Moving it where it already is needs only edit access to it.
pub async fn movable_doc(state: &AppState, caller: &Caller, id: &str, target: Option<&str>) -> ApiResult<DocRow> {
    let (doc, role) = access::require_doc(state, Some(caller), id, Role::Editor).await?;
    if doc.deleted_at.is_some() {
        return Err(doc_in_trash());
    }
    let target = target.filter(|t| !t.is_empty() && *t != "root");
    if target == doc.folder_id.as_deref() {
        return Ok(doc);
    }
    match target {
        Some(folder_id) => {
            let folder = open_folder(state, caller, folder_id).await?;
            if folder.owner_uuid != doc.owner_uuid {
                return Err(ApiError::invalid("A doc can only move into a folder with the same owner.").hint("Transfer the doc to the folder's owner first."));
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
    Ok(doc)
}

pub async fn move_doc(state: &AppState, caller: &Caller, id: &str, target: Option<String>) -> ApiResult<()> {
    let target = target.filter(|t| !t.is_empty() && t != "root");
    let doc = movable_doc(state, caller, id, target.as_deref()).await?;
    if target == doc.folder_id {
        return Ok(());
    }
    let moved = sqlx::query(
        "update docs d set folder_id = $2, updated_at = now()
         where d.id = $1 and d.deleted_at is null
           and ($2::text is null or exists (select 1 from folders f where f.id = $2 and f.deleted_at is null and f.owner_uuid = d.owner_uuid for share))",
    )
    .bind(id)
    .bind(&target)
    .execute(&state.db)
    .await?
    .rows_affected();
    if moved == 0 {
        movable_doc(state, caller, id, target.as_deref()).await?;
        return Err(changed_meanwhile());
    }
    // One move, in the doc's history and in the folders it left and joined.
    let data = json!({ "doc": id, "from_folder": doc.folder_id, "to_folder": target });
    let mut histories = vec![(Some(id), None)];
    histories.extend([doc.folder_id.as_deref(), target.as_deref()].into_iter().flatten().map(|f| (None, Some(f))));
    activity::record_change(state, About::Doc(id), &histories, &caller.uuid, "doc.moved", data).await?;
    // Moving changes who can open the doc.
    state.rooms.recheck(state, id).await;
    state.rooms.notify(id, json!({ "type": "meta" })).await;
    Ok(())
}

/// Offers that can no longer be accepted, because what they offer went to the trash or changed
/// owner, are cancelled: nobody is shown an offer they can't accept. (Accepting checks for itself
/// too, so an offer accepted in between is refused all the same.)
async fn cancel_offers<'e>(db: impl sqlx::PgExecutor<'e>, docs: &[String], folders: &[String]) -> ApiResult<()> {
    sqlx::query("update transfers set status = 'cancelled', decided_at = now() where status = 'pending' and (doc_id = any($1) or folder_id = any($2))")
        .bind(docs)
        .bind(folders)
        .execute(db)
        .await?;
    Ok(())
}

/// Holds an owner's folders still until the transaction ends. Moving, trashing and handing over
/// one owner's folders happen one at a time, so none of them works from a tree another is
/// changing, and two moves at once can never put folders inside each other.
async fn hold_folders(db: &mut sqlx::PgConnection, owner: &str) -> ApiResult<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('folders of ' || $1, 0))").bind(owner).execute(&mut *db).await?;
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
    let trashed = sqlx::query("update docs set deleted_at = now(), deleted_by = $2, trashed_with = null where id = $1 and deleted_at is null and owner_uuid = $2")
        .bind(id)
        .bind(&caller.uuid)
        .execute(&state.db)
        .await?
        .rows_affected();
    if trashed == 0 {
        // In the trash already, or handed over meanwhile.
        return match access::load_doc(state, id).await?.deleted_at {
            Some(_) => Ok(()),
            None => Err(ApiError::forbidden("Only the doc's owner can do this.")),
        };
    }
    cancel_offers(&state.db, &[id.to_owned()], &[]).await?;
    let data = json!({ "doc": id, "title": doc.display_title() });
    activity::record_change(state, About::Doc(id), &[(Some(id), doc.folder_id.as_deref())], &caller.uuid, "doc.trashed", data).await?;
    state.rooms.recheck(state, id).await;
    Ok(())
}

pub async fn restore_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<DocView>> {
    let doc = access::load_doc(&state, &id).await?;
    if doc.deleted_at.is_none() && doc.owner_uuid == caller.uuid {
        return Err(ApiError::conflict("This doc isn't in the trash.").hint("To bring back an earlier version, use POST /v1/docs/{id}/restore-version."));
    }
    restore_doc_inner(&state, &caller, &id).await?;
    let (doc, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    Ok(Json(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?))
}

pub async fn restore_doc_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (doc, _) = access::require_doc(state, Some(caller), id, Role::Owner).await?;
    if doc.deleted_at.is_none() {
        return Ok(());
    }
    // Back where it was, unless that folder is in the trash, gone, or someone else's now: then to
    // the top level.
    let restored: Option<Option<String>> = sqlx::query_scalar(
        "update docs d set deleted_at = null, deleted_by = null, trashed_with = null,
            folder_id = (select f.id from folders f where f.id = d.folder_id and f.deleted_at is null and f.owner_uuid = d.owner_uuid for share)
         where d.id = $1 and d.deleted_at is not null
         returning d.folder_id",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let Some(folder) = restored else { return Ok(()) };
    activity::record_change(state, About::Doc(id), &[(Some(id), folder.as_deref())], &caller.uuid, "doc.restored", json!({ "doc": id })).await?;
    state.rooms.recheck(state, id).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct Confirm {
    confirm: Option<String>,
}

pub async fn purge_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<Confirm>) -> ApiResult<StatusCode> {
    access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    if q.confirm.as_deref() != Some(id.as_str()) {
        return Err(ApiError::invalid("Deleting permanently needs confirming.").hint(format!("Pass ?confirm={id}. This can't be undone.")));
    }
    purge(&state, Purge::Doc(&id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What is deleted for good: a doc, or a folder with what went to the trash with it.
enum Purge<'a> {
    Doc(&'a str),
    Folder(&'a str),
}

/// Deletes docs and folders for good, and everything about them in every history: the only real
/// deletion in Silicon Write, and only from the trash. An uploaded image or PDF goes with them
/// unless a doc that stays still shows it (a copy). What stays but sat in a folder that goes moves
/// out to its owner's top level, in the trash or not as it was, and keeps its own history whole.
async fn purge(state: &AppState, what: Purge<'_>) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    // What goes is held in the trash meanwhile: a restore at the same moment waits, and finds it gone.
    let (docs, folders): (Vec<String>, Vec<String>) = match what {
        Purge::Doc(id) => {
            let held: Option<String> = sqlx::query_scalar("select id from docs where id = $1 and deleted_at is not null for update").bind(id).fetch_optional(&mut *tx).await?;
            if held.is_none() {
                return Err(ApiError::conflict("Only docs in the trash can be deleted permanently.").hint("Move it to the trash first."));
            }
            (vec![id.to_owned()], vec![])
        }
        Purge::Folder(id) => {
            let held: Option<String> = sqlx::query_scalar("select id from folders where id = $1 and deleted_at is not null for update").bind(id).fetch_optional(&mut *tx).await?;
            if held.is_none() {
                return Err(ApiError::conflict("Only folders in the trash can be deleted permanently.").hint("Move it to the trash first."));
            }
            let mut folders: Vec<String> = sqlx::query_scalar("select id from folders where trashed_with = $1 and deleted_at is not null for update")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
            folders.push(id.to_owned());
            let docs: Vec<String> = sqlx::query_scalar("select id from docs where trashed_with = $1 and deleted_at is not null for update")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
            (docs, folders)
        }
    };
    // The files these docs uploaded, show or open, to look at again once the docs are gone.
    let files: Vec<String> = sqlx::query_scalar(
        "select id from assets where doc_id = any($1)
         union select asset_id from doc_assets where doc_id = any($1)
         union select original_asset from docs where id = any($1) and original_asset is not null",
    )
    .bind(&docs)
    .fetch_all(&mut *tx)
    .await?;
    let moved_out: Vec<String> = sqlx::query_scalar("update docs set folder_id = null where folder_id = any($1) and not (id = any($2)) returning id")
        .bind(&folders)
        .bind(&docs)
        .fetch_all(&mut *tx)
        .await?;
    sqlx::query("update folders set parent_id = null where parent_id = any($1)").bind(&folders).execute(&mut *tx).await?;
    // A change shown in both a staying doc's history and a going folder's stays in the doc's.
    sqlx::query("update activity set folder_id = null where folder_id = any($1) and doc_id is not null and not (doc_id = any($2))")
        .bind(&folders)
        .bind(&docs)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from docs where id = any($1)").bind(&docs).execute(&mut *tx).await?;
    sqlx::query("delete from folders where id = any($1)").bind(&folders).execute(&mut *tx).await?;
    let paths: Vec<String> = sqlx::query_scalar(
        "delete from assets a
         where a.id = any($1) and a.doc_id is null
           and not exists (select 1 from doc_assets s where s.asset_id = a.id)
           and not exists (select 1 from docs d where d.original_asset = a.id)
         returning a.path",
    )
    .bind(&files)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    for path in paths {
        let _ = tokio::fs::remove_file(state.config.data_dir.join(path)).await;
    }
    for id in &docs {
        state.rooms.drop_room(id).await;
    }
    for id in &moved_out {
        state.rooms.recheck(state, id).await;
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
    if let Some(seq) = body.seq
        && !(0..=doc.seq).contains(&seq)
    {
        return Err(ApiError::not_found(&format!("Version {seq}")).hint(format!("This doc's versions go from 0 to {}.", doc.seq)));
    }
    let title = body.title.unwrap_or_else(|| format!("Copy of {}", doc.display_title()));
    let new = if doc.kind == "pdf" {
        // A PDF shown as it is: its copy shows the same file.
        let new = create_doc(&state, &caller, &title, body.folder_id.as_deref(), None, "pdf", Origin::Create).await?;
        if let Some(asset) = &doc.original_asset {
            sqlx::query("update docs set original_asset = $2 where id = $1").bind(&new.id).bind(asset).execute(&state.db).await?;
            sqlx::query("insert into doc_assets (doc_id, asset_id) values ($1, $2) on conflict do nothing")
                .bind(&new.id)
                .bind(asset)
                .execute(&state.db)
                .await?;
        }
        access::load_doc(&state, &new.id).await?
    } else {
        let content = match body.seq {
            Some(seq) => crate::versions::doc_at(&state, &id, seq).await?,
            None => rooms::read(&state, &id).await?.0,
        };
        create_doc(&state, &caller, &title, body.folder_id.as_deref(), Some(content.without_suggestions()), "doc", Origin::Create).await?
    };
    activity::record_change(&state, About::Doc(&new.id), &[(Some(&new.id), None)], &caller.uuid, "doc.copied", json!({ "from": id, "seq": body.seq })).await?;
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
    let made = sqlx::query(
        "insert into folders (id, owner_uuid, parent_id, name, created_by)
         select $1, $2, $3, $4, $5
         where $3::text is null or exists (select 1 from folders where id = $3 and deleted_at is null and owner_uuid = $2 for share)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&parent)
    .bind(&name)
    .bind(&caller.uuid)
    .execute(&state.db)
    .await?
    .rows_affected();
    if made == 0 {
        placement(&state, &caller, parent.as_deref()).await?;
        return Err(changed_meanwhile());
    }
    let mut histories = vec![(None, Some(id.as_str()))];
    histories.extend(parent.as_deref().map(|p| (None, Some(p))));
    activity::record_change(&state, About::Folder(&id), &histories, &caller.uuid, "folder.created", json!({ "folder": id, "name": name })).await?;
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

/// A folder the caller may rename: they edit it, and it isn't in the trash.
pub async fn renamable_folder(state: &AppState, caller: &Caller, id: &str) -> ApiResult<FolderRow> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Editor).await?;
    if folder.deleted_at.is_some() {
        return Err(folder_in_trash());
    }
    Ok(folder)
}

pub async fn rename_folder(state: &AppState, caller: &Caller, id: &str, name: String) -> ApiResult<()> {
    let folder = renamable_folder(state, caller, id).await?;
    let name = clean_folder_name(&name)?;
    if name == folder.name {
        return Ok(());
    }
    let renamed = sqlx::query("update folders set name = $2, updated_at = now() where id = $1 and deleted_at is null")
        .bind(id)
        .bind(&name)
        .execute(&state.db)
        .await?
        .rows_affected();
    if renamed == 0 {
        return Err(folder_in_trash());
    }
    let data = json!({ "folder": id, "from": folder.name, "to": name });
    let mut histories = vec![(None, Some(id))];
    histories.extend(folder.parent_id.as_deref().map(|p| (None, Some(p))));
    activity::record_change(state, About::Folder(id), &histories, &caller.uuid, "folder.renamed", data).await?;
    Ok(())
}

/// Whether folder `id` is `ancestor` or somewhere inside it, however deep (walking up from it
/// can't go round forever, even through a loop).
async fn inside<'e>(db: impl sqlx::PgExecutor<'e>, id: &str, ancestor: &str) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "with recursive up as (
            select id, parent_id from folders where id = $1
            union
            select f.id, f.parent_id from folders f join up on f.id = up.parent_id
         ) select exists (select 1 from up where id = $2)",
    )
    .bind(id)
    .bind(ancestor)
    .fetch_one(db)
    .await?)
}

/// Checks the caller may move a folder into `target` (or with `None` to its owner's top level),
/// and returns it. It needs edit access to the folder and to the folders it leaves and joins,
/// which have its owner and aren't in the trash; it never goes into itself or a folder inside it,
/// and only the owner moves it to the top level. Moving it where it already is needs only edit
/// access to it.
pub async fn movable_folder(state: &AppState, caller: &Caller, id: &str, target: Option<&str>) -> ApiResult<FolderRow> {
    let (folder, role) = access::require_folder(state, caller, id, Role::Editor).await?;
    if folder.deleted_at.is_some() {
        return Err(folder_in_trash());
    }
    let target = target.filter(|t| !t.is_empty() && *t != "root");
    if target == folder.parent_id.as_deref() {
        return Ok(folder);
    }
    match target {
        Some(parent_id) => {
            let parent = open_folder(state, caller, parent_id).await?;
            if parent.owner_uuid != folder.owner_uuid {
                return Err(ApiError::invalid("A folder can only move into a folder with the same owner.").hint("Transfer it to that folder's owner first."));
            }
            if inside(&state.db, parent_id, id).await? {
                return Err(into_itself());
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
    Ok(folder)
}

pub async fn move_folder(state: &AppState, caller: &Caller, id: &str, target: Option<String>) -> ApiResult<()> {
    let target = target.filter(|t| !t.is_empty() && t != "root");
    let folder = movable_folder(state, caller, id, target.as_deref()).await?;
    if target == folder.parent_id {
        return Ok(());
    }
    let mut tx = state.db.begin().await?;
    hold_folders(&mut tx, &folder.owner_uuid).await?;
    // Checked again now that no other move can come in between.
    if let Some(parent) = &target
        && inside(&mut *tx, parent, id).await?
    {
        return Err(into_itself());
    }
    let moved = sqlx::query(
        "update folders m set parent_id = $2, updated_at = now()
         where m.id = $1 and m.deleted_at is null
           and ($2::text is null or exists (select 1 from folders f where f.id = $2 and f.deleted_at is null and f.owner_uuid = m.owner_uuid for share))",
    )
    .bind(id)
    .bind(&target)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if moved == 0 {
        drop(tx);
        movable_folder(state, caller, id, target.as_deref()).await?;
        return Err(changed_meanwhile());
    }
    tx.commit().await?;
    // One move, in the folder's history and in the folders it left and joined.
    let data = json!({ "folder": id, "from_parent": folder.parent_id, "to_parent": target });
    let mut histories = vec![(None, Some(id))];
    histories.extend([folder.parent_id.as_deref(), target.as_deref()].into_iter().flatten().map(|f| (None, Some(f))));
    activity::record_change(state, About::Folder(id), &histories, &caller.uuid, "folder.moved", data).await?;
    let (_, docs) = live_tree(&mut *state.db.acquire().await?, id).await?;
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

/// Every folder under a folder (itself included) and every doc in them, leaving out what's in the
/// trash.
async fn live_tree(db: &mut sqlx::PgConnection, id: &str) -> ApiResult<(Vec<String>, Vec<String>)> {
    let folders: Vec<String> = sqlx::query_scalar(
        "with recursive t as (
            select id from folders where id = $1
            union
            select f.id from folders f join t on f.parent_id = t.id where f.deleted_at is null
         ) select id from t",
    )
    .bind(id)
    .fetch_all(&mut *db)
    .await?;
    let docs: Vec<String> = sqlx::query_scalar("select id from docs where folder_id = any($1) and deleted_at is null")
        .bind(&folders)
        .fetch_all(&mut *db)
        .await?;
    Ok((folders, docs))
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
    let mut tx = state.db.begin().await?;
    hold_folders(&mut tx, &folder.owner_uuid).await?;
    // The folder first: from here on nothing new goes into it.
    let trashed = sqlx::query("update folders set deleted_at = now(), deleted_by = $2, trashed_with = null where id = $1 and deleted_at is null and owner_uuid = $2")
        .bind(id)
        .bind(&caller.uuid)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if trashed == 0 {
        drop(tx);
        // In the trash already, or handed over meanwhile.
        return match access::load_folder(state, id).await?.deleted_at {
            Some(_) => Ok(()),
            None => Err(ApiError::forbidden("Only the folder's owner can do this.")),
        };
    }
    // Then everything inside that isn't in the trash already goes with it.
    sqlx::query(
        "with recursive inside as (
            select id from folders where parent_id = $1 and deleted_at is null
            union
            select f.id from folders f join inside on f.parent_id = inside.id where f.deleted_at is null
         )
         update folders set deleted_at = now(), deleted_by = $2, trashed_with = $1 where id in (select id from inside)",
    )
    .bind(id)
    .bind(&caller.uuid)
    .execute(&mut *tx)
    .await?;
    let folders: Vec<String> = sqlx::query_scalar("select id from folders where id = $1 or trashed_with = $1").bind(id).fetch_all(&mut *tx).await?;
    let docs: Vec<String> = sqlx::query_scalar(
        "update docs set deleted_at = now(), deleted_by = $2, trashed_with = $1
         where deleted_at is null and folder_id = any($3)
         returning id",
    )
    .bind(id)
    .bind(&caller.uuid)
    .bind(&folders)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    cancel_offers(&state.db, &docs, &folders).await?;
    let data = json!({ "folder": id, "name": folder.name });
    let mut histories = vec![(None, Some(id))];
    histories.extend(folder.parent_id.as_deref().map(|p| (None, Some(p))));
    activity::record_change(state, About::Folder(id), &histories, &caller.uuid, "folder.trashed", data).await?;
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

pub async fn restore_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let folder = access::load_folder(&state, &id).await?;
    if folder.deleted_at.is_none() && folder.owner_uuid == caller.uuid {
        return Err(ApiError::conflict("This folder isn't in the trash."));
    }
    restore_folder_inner(&state, &caller, &id).await?;
    get_folder(State(state), Auth(caller), Path(id)).await
}

/// Brings a folder back with what went to the trash when it did (with it, or with a folder above
/// it), and not what was put in the trash on its own before.
pub async fn restore_folder_inner(state: &AppState, caller: &Caller, id: &str) -> ApiResult<()> {
    let (folder, _) = access::require_folder(state, caller, id, Role::Owner).await?;
    if folder.deleted_at.is_none() {
        return Ok(());
    }
    let mut tx = state.db.begin().await?;
    let with: Option<Option<String>> = sqlx::query_scalar("select trashed_with from folders where id = $1 and deleted_at is not null for update")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(with) = with else { return Ok(()) };
    let with = with.unwrap_or_else(|| id.to_owned());
    // Back where it was, unless that folder is in the trash, gone, or someone else's now: then to
    // the top level.
    sqlx::query(
        "update folders m set deleted_at = null, deleted_by = null, trashed_with = null,
            parent_id = (select p.id from folders p where p.id = m.parent_id and p.deleted_at is null and p.owner_uuid = m.owner_uuid for share)
         where m.id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let mut folders: Vec<String> = sqlx::query_scalar(
        "with recursive inside as (
            select id from folders where parent_id = $1 and trashed_with = $2
            union
            select f.id from folders f join inside on f.parent_id = inside.id where f.trashed_with = $2
         )
         update folders set deleted_at = null, deleted_by = null, trashed_with = null where id in (select id from inside) returning id",
    )
    .bind(id)
    .bind(&with)
    .fetch_all(&mut *tx)
    .await?;
    folders.push(id.to_owned());
    let docs: Vec<String> = sqlx::query_scalar(
        "update docs set deleted_at = null, deleted_by = null, trashed_with = null where trashed_with = $1 and folder_id = any($2) returning id",
    )
    .bind(&with)
    .bind(&folders)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    activity::record_change(state, About::Folder(id), &[(None, Some(id))], &caller.uuid, "folder.restored", json!({ "folder": id })).await?;
    for doc in docs {
        state.rooms.recheck(state, &doc).await;
    }
    Ok(())
}

pub async fn purge_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<Confirm>) -> ApiResult<StatusCode> {
    access::require_folder(&state, &caller, &id, Role::Owner).await?;
    if q.confirm.as_deref() != Some(id.as_str()) {
        return Err(ApiError::invalid("Deleting permanently needs confirming.").hint(format!("Pass ?confirm={id}. This can't be undone.")));
    }
    purge(&state, Purge::Folder(&id)).await?;
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

const TRANSFER_COLUMNS: &str = "id, doc_id, folder_id, from_uuid, to_uuid, status, created_at";

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

async fn load_transfer(state: &AppState, id: &str) -> ApiResult<TransferRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("select {TRANSFER_COLUMNS} from transfers where id = $1")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This transfer"))
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
    let about = match (doc, folder) {
        (Some(doc), _) => About::Doc(&doc.id),
        (_, Some(folder)) => About::Folder(&folder.id),
        _ => return Err(ApiError::invalid("There is nothing to transfer.")),
    };
    let histories = [(doc.map(|d| d.id.as_str()), folder.map(|f| f.id.as_str()))];
    activity::record_change(state, about, &histories, &caller.uuid, "transfer.started", json!({ "transfer": id, "to": target.uuid })).await?;
    transfer_view(state, &load_transfer(state, &id).await?).await
}

pub async fn transfer_doc(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<TransferBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Owner).await?;
    if doc.deleted_at.is_some() {
        return Err(doc_in_trash());
    }
    Ok(Json(start_transfer(&state, &caller, Some(&doc), None, &body.to).await?))
}

pub async fn transfer_folder(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<TransferBody>) -> ApiResult<Json<Value>> {
    let (folder, _) = access::require_folder(&state, &caller, &id, Role::Owner).await?;
    if folder.deleted_at.is_some() {
        return Err(folder_in_trash());
    }
    Ok(Json(start_transfer(&state, &caller, None, Some(&folder), &body.to).await?))
}

pub async fn transfers(State(state): State<AppState>, Auth(caller): Auth) -> ApiResult<Json<Value>> {
    let rows: Vec<TransferRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {TRANSFER_COLUMNS} from transfers where (to_uuid = $1 or from_uuid = $1) order by created_at desc limit 200"
    )))
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

fn already_decided(status: &str) -> ApiError {
    ApiError::conflict(format!("This transfer is already {status}."))
}

pub async fn decide_transfer(State(state): State<AppState>, Auth(caller): Auth, Path((id, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let row = load_transfer(&state, &id).await?;
    if row.status != "pending" {
        return Err(already_decided(&row.status));
    }
    match action.as_str() {
        "accept" | "decline" if row.to_uuid != caller.uuid => return Err(ApiError::not_found("This transfer")),
        "cancel" if row.from_uuid != caller.uuid => return Err(ApiError::not_found("This transfer")),
        "accept" | "decline" | "cancel" => {}
        _ => return Err(ApiError::not_found("This action")),
    }
    if action == "accept" {
        if let Err(error) = accept_transfer(&state, &row).await {
            // An offer that can no longer be accepted doesn't stay pending.
            if error.code == "conflict" {
                sqlx::query("update transfers set status = 'cancelled', decided_at = now() where id = $1 and status = 'pending'")
                    .bind(&id)
                    .execute(&state.db)
                    .await?;
            }
            return Err(error);
        }
    } else {
        let status = if action == "decline" { "declined" } else { "cancelled" };
        let decided = sqlx::query("update transfers set status = $2, decided_at = now() where id = $1 and status = 'pending'")
            .bind(&id)
            .bind(status)
            .execute(&state.db)
            .await?
            .rows_affected();
        if decided == 0 {
            return Err(already_decided(&load_transfer(&state, &id).await?.status));
        }
    }
    Ok(Json(transfer_view(&state, &load_transfer(&state, &id).await?).await?))
}

/// Moves ownership, once. The previous owner keeps edit access, and the item moves to the new
/// owner's top level when it sat in a folder of someone else; that folder's history keeps that it
/// left. Only what isn't in the trash moves: what the previous owner had deleted stays in their
/// trash. Answers `conflict` when the offer can no longer be accepted.
async fn accept_transfer(state: &AppState, t: &TransferRow) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    hold_folders(&mut tx, &t.from_uuid).await?;
    let decided = sqlx::query("update transfers set status = 'accepted', decided_at = now() where id = $1 and status = 'pending'")
        .bind(&t.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if decided == 0 {
        let status: String = sqlx::query_scalar("select status from transfers where id = $1").bind(&t.id).fetch_one(&mut *tx).await?;
        return Err(already_decided(&status));
    }
    let mut touched_docs = vec![];
    // What moved, the folder it sat in (with the key the history names that folder by), and what
    // the history says.
    let (about, left, mut data) = if let Some(doc_id) = &t.doc_id {
        let doc: Option<(String, Option<String>, Option<time::OffsetDateTime>)> =
            sqlx::query_as("select owner_uuid, folder_id, deleted_at from docs where id = $1 for update").bind(doc_id).fetch_optional(&mut *tx).await?;
        let Some((owner, folder, deleted)) = doc else { return Err(ApiError::not_found("This doc")) };
        if owner != t.from_uuid {
            return Err(ApiError::conflict("The doc changed owner since this transfer started."));
        }
        if deleted.is_some() {
            return Err(doc_in_trash().hint("Its owner can restore it and offer it again."));
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
        (About::Doc(doc_id), folder.map(|f| ("from_folder", f)), json!({ "transfer": t.id, "doc": doc_id, "from": t.from_uuid, "to": t.to_uuid }))
    } else if let Some(folder_id) = &t.folder_id {
        let folder: Option<(String, Option<String>, Option<time::OffsetDateTime>)> =
            sqlx::query_as("select owner_uuid, parent_id, deleted_at from folders where id = $1 for update").bind(folder_id).fetch_optional(&mut *tx).await?;
        let Some((owner, parent, deleted)) = folder else { return Err(ApiError::not_found("This folder")) };
        if owner != t.from_uuid {
            return Err(ApiError::conflict("The folder changed owner since this transfer started."));
        }
        if deleted.is_some() {
            return Err(folder_in_trash().hint("Its owner can restore it and offer it again."));
        }
        // The folders hold still (`hold_folders`); docs can still move or go to the trash meanwhile,
        // so the docs that move are the ones in those folders and out of the trash as they move.
        let (folders, _) = live_tree(&mut tx, folder_id).await?;
        sqlx::query("update folders set owner_uuid = $2 where id = any($1)").bind(&folders).bind(&t.to_uuid).execute(&mut *tx).await?;
        sqlx::query("update folders set parent_id = null where id = $1").bind(folder_id).execute(&mut *tx).await?;
        let docs: Vec<String> = sqlx::query_scalar("update docs set owner_uuid = $2 where folder_id = any($1) and deleted_at is null returning id")
            .bind(&folders)
            .bind(&t.to_uuid)
            .fetch_all(&mut *tx)
            .await?;
        // What stays in the previous owner's trash no longer sits in folders that are now someone
        // else's: restoring it brings it back to their top level.
        sqlx::query("update docs set folder_id = null where folder_id = any($1) and deleted_at is not null").bind(&folders).execute(&mut *tx).await?;
        sqlx::query("update folders set parent_id = null where parent_id = any($1) and deleted_at is not null").bind(&folders).execute(&mut *tx).await?;
        // The new owner owns all of it now, so isn't also a member of any of it.
        sqlx::query("delete from shares where account_uuid = $3 and (folder_id = any($1) or doc_id = any($2))")
            .bind(&folders)
            .bind(&docs)
            .bind(&t.to_uuid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("insert into shares (id, folder_id, account_uuid, role, invited_by) values ($1, $2, $3, 'editor', $4) on conflict do nothing")
            .bind(ids::new_id("m"))
            .bind(folder_id)
            .bind(&t.from_uuid)
            .bind(&t.to_uuid)
            .execute(&mut *tx)
            .await?;
        // Offers for anything inside were the previous owner's to make.
        cancel_offers(&mut *tx, &docs, &folders).await?;
        touched_docs.extend(docs);
        (About::Folder(folder_id), parent.map(|p| ("from_parent", p)), json!({ "transfer": t.id, "folder": folder_id, "from": t.from_uuid, "to": t.to_uuid }))
    } else {
        return Err(ApiError::invalid("There is nothing to transfer."));
    };
    tx.commit().await?;
    // In the history of what moved, and in that of the folder it left.
    let mut histories = vec![(t.doc_id.as_deref(), t.folder_id.as_deref())];
    if let Some((key, folder)) = &left {
        data[*key] = json!(folder);
        histories.push((None, Some(folder)));
    }
    activity::record_change(state, about, &histories, &t.to_uuid, "transfer.accepted", data).await?;
    for doc in touched_docs {
        state.rooms.recheck(state, &doc).await;
        state.rooms.notify(&doc, json!({ "type": "meta" })).await;
    }
    Ok(())
}
