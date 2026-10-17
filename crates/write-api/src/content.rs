//! A doc's content: Markdown in and out (how Silicons work), exact edits, whole versions written
//! from a pulled copy, files in every format, images, links between docs, who wrote what, and
//! search.

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use write_doc::ydoc::{self, EditMode};
use write_doc::{SuggestionView, WriteOptions};
use yrs::ReadTxn;

use crate::access::{self, DOC_COLUMNS, DocRow, Role};
use crate::accounts;
use crate::activity;
use crate::auth::{Auth, Caller, MaybeAuth};
use crate::convert::{self, Opened};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::library;
use crate::rooms::{self, Origin};
use crate::state::AppState;
use crate::views;

const MAX_UPLOAD: usize = 50 * 1024 * 1024;
const MAX_MARKDOWN: usize = 5 * 1024 * 1024;

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct MarkdownQuery {
    suggestions: Option<String>,
    comments: Option<String>,
}

pub async fn get_markdown(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>, Query(q): Query<MarkdownQuery>) -> ApiResult<Json<Value>> {
    let (doc_row, role) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
    let critic = q.suggestions.as_deref() == Some("critic");
    let inline_comments = q.comments.as_deref() == Some("inline");
    if (critic || inline_comments) && role < Role::Commenter {
        return Err(ApiError::forbidden("Only people who can comment see comments and suggestions."));
    }
    let annotations = if inline_comments { crate::comments::annotations(&state, &id).await? } else { vec![] };
    let (doc, seq) = rooms::read(&state, &id).await?;
    let options = WriteOptions { suggestions: if critic { SuggestionView::Critic } else { SuggestionView::Current }, annotations };
    Ok(Json(json!({ "seq": seq, "markdown": write_doc::to_markdown_with(&doc, &options), "title": doc_row.display_title() })))
}

#[derive(Deserialize)]
pub struct SeqQuery {
    seq: Option<i64>,
}

pub async fn get_prosemirror(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>, Query(q): Query<SeqQuery>) -> ApiResult<Json<Value>> {
    let min = if q.seq.is_some() { Role::Editor } else { Role::Viewer };
    let (_, role) = access::require_doc(&state, caller.as_ref(), &id, min).await?;
    let (doc, seq) = match q.seq {
        Some(seq) => (crate::versions::doc_at(&state, &id, seq).await?, seq),
        None => rooms::read(&state, &id).await?,
    };
    // Viewers see the doc as it reads now, without pending suggestions.
    let doc = if role < Role::Commenter { doc.without_suggestions() } else { doc };
    Ok(Json(json!({ "seq": seq, "doc": write_doc::prosemirror::to_json(&doc) })))
}

// ------------------------------------------------------------------------------------------
// Editing
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Edit {
    old: String,
    new: String,
    #[serde(default)]
    all: bool,
}

#[derive(Deserialize)]
pub struct EditsBody {
    edits: Vec<Edit>,
    #[serde(default)]
    suggest: bool,
}

fn commenter_refusal() -> ApiError {
    ApiError::forbidden("Commenters can only suggest changes to the text.")
        .hint("Images, maths, tables and other structure can only be changed by editors; ask one, or comment instead.")
}

fn suggest_mode(caller: &Caller, suggest: bool) -> EditMode {
    EditMode { suggest: suggest.then(|| (ids::new_id("s"), caller.uuid.clone())) }
}

/// Applies exact replacements to Markdown. Each `old` must be there exactly once (or `all`).
pub fn apply_edits(markdown: &str, edits: &[Edit]) -> ApiResult<String> {
    let mut text = markdown.to_owned();
    for (i, edit) in edits.iter().enumerate() {
        if edit.old.is_empty() {
            return Err(ApiError::invalid(format!("Edit {}: `old` is empty.", i + 1)).hint("Give the exact text to replace."));
        }
        let count = text.matches(&edit.old).count();
        if count == 0 {
            return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "no_match", format!("Edit {}: the text to replace isn't in the doc.", i + 1))
                .hint("Read the doc's Markdown again (it may have changed) and copy the text exactly, including formatting characters."));
        }
        if count > 1 && !edit.all {
            return Err(ApiError::new(StatusCode::CONFLICT, "not_unique", format!("Edit {}: the text to replace appears {count} times.", i + 1))
                .hint("Include more of the surrounding text so it appears once, or set `all` to replace every one."));
        }
        text = if edit.all { text.replace(&edit.old, &edit.new) } else { text.replacen(&edit.old, &edit.new, 1) };
    }
    Ok(text)
}

pub async fn post_edits(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<EditsBody>) -> ApiResult<Json<Value>> {
    let (_, role) = access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    if body.edits.is_empty() {
        return Err(ApiError::invalid("There are no edits."));
    }
    // Commenters can only suggest: what they change becomes a suggestion.
    let suggest = body.suggest || role == Role::Commenter;
    let mode = suggest_mode(&caller, suggest);
    let origin = if suggest { Origin::Suggestion } else { Origin::Edit };
    let commenter = role == Role::Commenter;
    let author = caller.uuid.clone();
    let (markdown, seq) = rooms::edit(&state, &id, &caller.uuid, origin, None, |y| {
        let current = ydoc::read_doc(y);
        let before = write_doc::to_markdown(&current);
        let after = apply_edits(&before, &body.edits)?;
        if after == before {
            return Ok(before);
        }
        let base = write_doc::from_markdown(&before);
        let new = write_doc::from_markdown(&after);
        ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &base, &new, &mode));
        let result = ydoc::read_doc(y);
        if commenter && !rooms::suggestion_only(&current, &result, &author) {
            return Err(commenter_refusal());
        }
        Ok(write_doc::to_markdown(&result))
    })
    .await?;
    Ok(Json(json!({ "seq": seq, "markdown": markdown, "suggested": suggest })))
}

#[derive(Deserialize)]
pub struct PutBody {
    markdown: String,
    base_seq: Option<i64>,
    #[serde(default)]
    suggest: bool,
}

pub async fn put_markdown(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<PutBody>) -> ApiResult<Json<Value>> {
    if body.markdown.len() > MAX_MARKDOWN {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "That's more than 5 MB of Markdown."));
    }
    let (doc_row, role) = access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    if let Some(base) = body.base_seq
        && (base < 0 || base > doc_row.seq) {
            return Err(ApiError::invalid(format!("base_seq {base} isn't a version of this doc (it's at {}).", doc_row.seq)));
        }
    // Commenters can only suggest: what they change becomes a suggestion.
    let suggest = body.suggest || role == Role::Commenter;
    let mode = suggest_mode(&caller, suggest);
    let new = write_doc::from_markdown(&body.markdown);
    let commenter = role == Role::Commenter;
    let author = caller.uuid.clone();
    let written = rooms::write_version(&state, &id, &caller.uuid, body.base_seq, &new, &mode, |before, after| {
        if commenter && !rooms::suggestion_only(before, after, &author) {
            return Err(commenter_refusal());
        }
        Ok(())
    })
    .await?;
    let (doc, seq_now) = rooms::read(&state, &id).await?;
    // Where the new version met changes made since and both changed the same text: the doc keeps
    // its text, and the new text is a suggestion on it.
    let passage = |blocks: &[write_doc::Block]| write_doc::to_markdown(&write_doc::Doc { blocks: blocks.to_vec() });
    let conflicts: Vec<Value> = written
        .conflicts
        .iter()
        .map(|(c, suggestion)| json!({ "was": passage(&c.base), "now": passage(&c.theirs), "yours": passage(&c.yours), "suggestion": suggestion }))
        .collect();
    Ok(Json(json!({ "seq": written.seq.max(seq_now), "markdown": write_doc::to_markdown(&doc), "suggested": suggest, "conflicts": conflicts })))
}

// ------------------------------------------------------------------------------------------
// Files
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ExportQuery {
    format: Option<String>,
    seq: Option<i64>,
}

fn safe_filename(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if c.is_alphanumeric() || " -_.()".contains(c) { c } else { '-' }).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() { "Untitled".into() } else { cleaned.chars().take(120).collect() }
}

fn attachment(bytes: Vec<u8>, content_type: &str, filename: &str) -> Response {
    let ascii: String = filename.chars().map(|c| if c.is_ascii() && c != '"' { c } else { '_' }).collect();
    let encoded: String = filename.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let disposition = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}");
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

pub async fn export(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>, Query(q): Query<ExportQuery>) -> ApiResult<Response> {
    let min = if q.seq.is_some() { Role::Editor } else { Role::Viewer };
    let (doc_row, _) = access::require_doc(&state, caller.as_ref(), &id, min).await?;
    let format = q.format.unwrap_or_else(|| "md".into());
    let title = doc_row.display_title();
    let doc = if doc_row.kind == "pdf" {
        // A PDF shown as it is: the file itself, or its text in any other format.
        let (bytes, _, _) = original_file(&state, &doc_row).await?;
        if format == "pdf" {
            return Ok(attachment(bytes, "application/pdf", &format!("{}.pdf", safe_filename(&title))));
        }
        convert::pdf_text(&state, &bytes).await?
    } else {
        match q.seq {
            Some(seq) => crate::versions::doc_at(&state, &id, seq).await?,
            None => rooms::read(&state, &id).await?.0,
        }
        .without_suggestions()
    };
    let exported = convert::export(&state, &doc, &title, &format).await?;
    Ok(attachment(exported.bytes, exported.content_type, &format!("{}.{}", safe_filename(&title), exported.extension)))
}

struct Upload {
    filename: String,
    bytes: Vec<u8>,
    fields: std::collections::HashMap<String, String>,
}

async fn read_upload(mut multipart: Multipart) -> ApiResult<Upload> {
    let mut file: Option<(String, Vec<u8>)> = None;
    let mut fields = std::collections::HashMap::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| ApiError::invalid(format!("The upload couldn't be read: {e}")))? {
        let name = field.name().unwrap_or("").to_owned();
        if name == "file" {
            let filename = field.file_name().unwrap_or("upload").to_owned();
            let data = field.bytes().await.map_err(|e| ApiError::invalid(format!("The upload couldn't be read: {e}")))?;
            if data.len() > MAX_UPLOAD {
                return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "Files can be at most 50 MB."));
            }
            file = Some((filename, data.to_vec()));
        } else {
            let value = field.text().await.unwrap_or_default();
            fields.insert(name, value);
        }
    }
    let (filename, bytes) = file.ok_or_else(|| ApiError::invalid("Send the file in a multipart field named `file`."))?;
    Ok(Upload { filename, bytes, fields })
}

/// Stores an uploaded file for a doc; returns its id and the URL docs refer to it by.
pub async fn store_asset(state: &AppState, doc_id: &str, owner: &str, filename: &str, content_type: &str, bytes: &[u8]) -> ApiResult<(String, String)> {
    let id = ids::new_id("a");
    let relative = format!("assets/{}/{}", &id[2..4], id);
    let path = state.config.data_dir.join(&relative);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(ApiError::internal)?;
    }
    tokio::fs::write(&path, bytes).await.map_err(ApiError::internal)?;
    sqlx::query("insert into assets (id, doc_id, owner_uuid, content_type, filename, size, path) values ($1, $2, $3, $4, $5, $6, $7)")
        .bind(&id)
        .bind(doc_id)
        .bind(owner)
        .bind(content_type)
        .bind(filename)
        .bind(bytes.len() as i64)
        .bind(&relative)
        .execute(&state.db)
        .await?;
    Ok((id.clone(), asset_url(state, &id)))
}

/// Images are linked by an unguessable address on the web editor's origin, so anyone with a
/// doc's text can show its images (like anyone with the link).
pub fn asset_url(state: &AppState, id: &str) -> String {
    format!("{}/assets/{}", state.config.web_url.trim_end_matches('/'), id)
}

pub fn asset_id_from_src(state: &AppState, src: &str) -> Option<String> {
    let candidates = [
        format!("{}/assets/", state.config.web_url.trim_end_matches('/')),
        format!("{}/v1/assets/", state.config.api_url.trim_end_matches('/')),
        "/assets/".to_owned(),
    ];
    candidates.iter().find_map(|prefix| src.strip_prefix(prefix.as_str())).map(|id| id.split(['?', '#']).next().unwrap_or("").to_owned()).filter(|id| id.starts_with("a_"))
}

pub async fn get_asset(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let row: (String, String, String) = sqlx::query_as("select path, content_type, filename from assets where id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This file"))?;
    let bytes = tokio::fs::read(state.config.data_dir.join(&row.0)).await.map_err(|_| ApiError::not_found("This file"))?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&row.1).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    response.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    // An uploaded SVG or HTML file must never run as a page.
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"));
    Ok(response)
}

pub async fn upload_asset(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, multipart: Multipart) -> ApiResult<(StatusCode, Json<Value>)> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    let upload = read_upload(multipart).await?;
    // What the bytes are, whatever the file is called.
    let Some(content_type) = convert::image_type(&upload.bytes) else {
        return Err(ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_format", "Only images can be added to a doc.").hint("Use PNG, JPEG, GIF, WebP or SVG."));
    };
    let (asset, url) = store_asset(&state, &id, &doc.owner_uuid, &upload.filename, content_type, &upload.bytes).await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": asset, "url": url }))))
}

/// Uploads a file's images and points the doc at the copies.
async fn adopt_images(state: &AppState, doc_id: &str, owner: &str, doc: &mut write_doc::Doc, images: Vec<(String, Vec<u8>, String)>) -> ApiResult<()> {
    let mut map = std::collections::HashMap::new();
    for (src, bytes, content_type) in images {
        let name = std::path::Path::new(&src).file_name().and_then(|n| n.to_str()).unwrap_or("image").to_owned();
        let (_, url) = store_asset(state, doc_id, owner, &name, &content_type, &bytes).await?;
        map.insert(src, url);
    }
    write_doc::pandoc::replace_images(doc, &|src| map.get(src).cloned());
    Ok(())
}

pub async fn import_new(State(state): State<AppState>, Auth(caller): Auth, multipart: Multipart) -> ApiResult<(StatusCode, Json<Value>)> {
    let upload = read_upload(multipart).await?;
    let opened = convert::open(&state, &upload.filename, &upload.bytes).await?;
    let title = upload
        .fields
        .get("title")
        .filter(|t| !t.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| std::path::Path::new(&upload.filename).file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_owned());
    let folder = upload.fields.get("folder_id").cloned();
    let doc = match opened {
        Opened::Pdf => {
            let doc = library::create_doc(&state, &caller, &title, folder.as_deref(), None, "pdf", Origin::Import).await?;
            let (asset, _) = store_asset(&state, &doc.id, &doc.owner_uuid, &upload.filename, "application/pdf", &upload.bytes).await?;
            sqlx::query("update docs set original_asset = $2 where id = $1").bind(&doc.id).bind(&asset).execute(&state.db).await?;
            access::load_doc(&state, &doc.id).await?
        }
        Opened::Doc { mut doc, images } => {
            let created = library::create_doc(&state, &caller, &title, folder.as_deref(), None, "doc", Origin::Import).await?;
            adopt_images(&state, &created.id, &created.owner_uuid, &mut doc, images).await?;
            rooms::edit(&state, &created.id, &caller.uuid, Origin::Import, None, |y| {
                ydoc::with_txn(y, |txn, frag| ydoc::write_all(txn, frag, &doc));
                Ok(())
            })
            .await?;
            access::load_doc(&state, &created.id).await?
        }
    };
    activity::record(&state, Some(&doc.id), None, &caller.uuid, "doc.imported", json!({ "filename": upload.filename })).await?;
    let role = access::doc_role(&state, Some(&caller), &doc).await?.unwrap_or(Role::Owner);
    Ok((StatusCode::CREATED, Json(serde_json::to_value(views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?).unwrap())))
}

/// Opening a file on top of a doc makes it the doc's next version.
pub async fn import_into(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, multipart: Multipart) -> ApiResult<Json<Value>> {
    let (doc_row, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    if doc_row.kind == "pdf" {
        return Err(ApiError::conflict("This is a PDF shown as it is.").hint("Turn it into a doc first."));
    }
    let upload = read_upload(multipart).await?;
    let Opened::Doc { mut doc, images } = convert::open(&state, &upload.filename, &upload.bytes).await? else {
        return Err(ApiError::invalid("A PDF can't be opened on top of a doc.").hint("Open it as a new doc instead."));
    };
    adopt_images(&state, &id, &doc_row.owner_uuid, &mut doc, images).await?;
    let ((), seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Import, None, |y| {
        let current = ydoc::read_doc(y);
        ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &current, &doc, &EditMode::default()));
        Ok(())
    })
    .await?;
    activity::record(&state, Some(&id), None, &caller.uuid, "doc.imported", json!({ "filename": upload.filename, "seq": seq })).await?;
    Ok(Json(json!({ "seq": seq })))
}

/// The file a PDF doc was opened from: its bytes, content type and file name.
async fn original_file(state: &AppState, doc: &DocRow) -> ApiResult<(Vec<u8>, String, String)> {
    let asset = doc.original_asset.clone().ok_or_else(|| ApiError::not_found("An original file for this doc"))?;
    let (path, content_type, filename): (String, String, String) =
        sqlx::query_as("select path, content_type, filename from assets where id = $1").bind(&asset).fetch_one(&state.db).await?;
    let bytes = tokio::fs::read(state.config.data_dir.join(&path)).await.map_err(ApiError::internal)?;
    Ok((bytes, content_type, filename))
}

pub async fn original(State(state): State<AppState>, MaybeAuth(caller): MaybeAuth, Path(id): Path<String>) -> ApiResult<Response> {
    let (doc, _) = access::require_doc(&state, caller.as_ref(), &id, Role::Viewer).await?;
    let (bytes, content_type, filename) = original_file(&state, &doc).await?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/pdf")));
    let name = format!("inline; filename=\"{}\"", filename.replace('"', "_"));
    if let Ok(value) = HeaderValue::from_str(&name) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

/// Turns a PDF shown as it is into a normal doc, from its text. The PDF stays as the original.
pub async fn convert_pdf(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (doc_row, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    if doc_row.kind != "pdf" {
        return Err(ApiError::conflict("This is already a doc."));
    }
    let (bytes, _, _) = original_file(&state, &doc_row).await?;
    let doc = convert::pdf_text(&state, &bytes).await?;
    sqlx::query("update docs set kind = 'doc' where id = $1").bind(&id).execute(&state.db).await?;
    rooms::edit(&state, &id, &caller.uuid, Origin::Import, None, |y| {
        let current = ydoc::read_doc(y);
        ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &current, &doc, &EditMode::default()));
        Ok(())
    })
    .await?;
    activity::record(&state, Some(&id), None, &caller.uuid, "doc.converted", json!({})).await?;
    state.rooms.notify(&id, json!({ "type": "meta" })).await;
    let (doc_row, role) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    Ok(Json(serde_json::to_value(views::doc_view(&state, &doc_row, role, Some(&caller.uuid)).await?).unwrap()))
}

// ------------------------------------------------------------------------------------------
// Links, authorship, search
// ------------------------------------------------------------------------------------------

pub async fn backlinks(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Viewer).await?;
    let title = doc.display_title().trim().to_lowercase();
    let ids = access::accessible_doc_ids(&state, &caller.uuid).await?;
    let docs: Vec<DocRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {DOC_COLUMNS} from docs where id = any($1) and id <> $2 and links @> array[$3]::text[] order by updated_at desc")))
        .bind(&ids)
        .bind(&id)
        .bind(&title)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "docs": views::doc_views(&state, docs, &caller).await? })))
}

/// Resolves `[[title]]` links from a doc to the docs the caller can open.
pub async fn resolve_link(State(state): State<AppState>, Auth(caller): Auth, Query(q): Query<std::collections::HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let title = q.get("title").map(|t| t.trim().to_lowercase()).unwrap_or_default();
    let ids = access::accessible_doc_ids(&state, &caller.uuid).await?;
    let doc: Option<DocRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {DOC_COLUMNS} from docs where id = any($1) and (lower(title) = $2 or (title = '' and lower(split_part(plain_text, E'\\n', 1)) = $2)) order by updated_at desc limit 1"
    )))
    .bind(&ids)
    .bind(&title)
    .fetch_optional(&state.db)
    .await?;
    match doc {
        Some(doc) => {
            let role = access::doc_role(&state, Some(&caller), &doc).await?.unwrap_or(Role::Viewer);
            Ok(Json(json!({ "doc": views::doc_view(&state, &doc, role, Some(&caller.uuid)).await? })))
        }
        None => Ok(Json(json!({ "doc": null }))),
    }
}

pub async fn authorship(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let room = state.rooms.get(&state, &id).await?;
    let (per_block, clients) = {
        let inner = room.inner.lock().await;
        // Authorship splits items, so it reads a copy.
        let copy = ydoc::new_ydoc(1);
        let full = yrs::Transact::transact(&inner.ydoc).encode_state_as_update_v1(&yrs::StateVector::default());
        {
            use yrs::updates::decoder::Decode;
            let mut txn = yrs::Transact::transact_mut(&copy);
            txn.apply_update(yrs::Update::decode_v1(&full).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
        }
        (ydoc::block_authors(&copy), inner.clients.clone())
    };
    let uuids: Vec<String> = clients.values().cloned().collect();
    let people = accounts::many(&state, &uuids).await?;
    let blocks: Vec<Value> = per_block
        .into_iter()
        .enumerate()
        .map(|(index, ids)| {
            let mut authors: Vec<Value> = vec![];
            let mut seen = std::collections::HashSet::new();
            for client in ids {
                if let Some(uuid) = clients.get(&client)
                    && seen.insert(uuid.clone())
                        && let Some(account) = people.get(uuid) {
                            authors.push(serde_json::to_value(account).unwrap_or(Value::Null));
                        }
            }
            json!({ "index": index, "authors": authors })
        })
        .collect();
    Ok(Json(json!({ "blocks": blocks })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

pub async fn search(State(state): State<AppState>, Auth(caller): Auth, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let query = q.q.unwrap_or_default();
    let query = query.trim();
    if query.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }
    let ids = access::accessible_doc_ids(&state, &caller.uuid).await?;
    let like = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select id, ts_headline('simple', plain_text, websearch_to_tsquery('simple', $2), 'MaxWords=24, MinWords=10, StartSel=**, StopSel=**') as snippet
         from docs
         where id = any($1) and (search @@ websearch_to_tsquery('simple', $2) or title ilike $3 or plain_text ilike $3)
         order by ts_rank(search, websearch_to_tsquery('simple', $2)) desc, updated_at desc
         limit 50",
    )
    .bind(&ids)
    .bind(query)
    .bind(&like)
    .fetch_all(&state.db)
    .await?;
    let mut results = vec![];
    for (doc_id, snippet) in rows {
        let doc = access::load_doc(&state, &doc_id).await?;
        if let Some(role) = access::doc_role(&state, Some(&caller), &doc).await? {
            results.push(json!({ "doc": views::doc_view(&state, &doc, role, Some(&caller.uuid)).await?, "snippet": snippet }));
        }
    }
    Ok(Json(json!({ "results": results })))
}

impl IntoResponse for crate::views::DocView {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}
