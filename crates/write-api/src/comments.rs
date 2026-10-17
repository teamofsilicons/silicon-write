//! Comments. A thread is anchored to a part of the doc by Yjs relative positions, so it stays on
//! its text while the doc changes around it; if its text is deleted the thread stays, showing the
//! text it was on. Silicons anchor by quoting the text exactly, and Silicon Write finds it.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use unicode_properties::UnicodeEmoji;
use unicode_segmentation::UnicodeSegmentation;
use write_doc::ydoc;

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::activity;
use crate::auth::{Auth, Caller};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::notify;
use crate::rooms;
use crate::state::AppState;

const MAX_BODY: usize = 20_000;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(sqlx::FromRow, Clone)]
struct ThreadRow {
    id: String,
    doc_id: String,
    anchor: Value,
    quote: String,
    status: String,
    created_by: String,
    created_at: OffsetDateTime,
    resolved_by: Option<String>,
    resolved_at: Option<OffsetDateTime>,
}

const THREAD_COLUMNS: &str = "id, doc_id, anchor, quote, status, created_by, created_at, resolved_by, resolved_at";

#[derive(sqlx::FromRow, Clone)]
struct CommentRow {
    id: String,
    thread_id: String,
    author_uuid: String,
    body: String,
    created_at: OffsetDateTime,
    edited_at: Option<OffsetDateTime>,
    deleted_at: Option<OffsetDateTime>,
}

fn rfc3339(t: &OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

/// Where a thread's text is now: the current quote, whether its text is gone, and its top-level block.
type Place = (Option<String>, bool, Option<usize>, Option<usize>);

/// A thread's anchor positions (start, end), as encoded Yjs relative positions.
type Positions = (Option<Vec<u8>>, Option<Vec<u8>>);

/// Where each thread's text is now.
async fn locate(state: &AppState, doc_id: &str, threads: &[ThreadRow]) -> ApiResult<Vec<Place>> {
    let pdf: Vec<bool> = threads.iter().map(|t| t.anchor.get("kind").and_then(Value::as_str) == Some("pdf")).collect();
    let anchors: Vec<Positions> = threads
        .iter()
        .map(|t| {
            let decode = |key: &str| t.anchor.get(key).and_then(Value::as_str).and_then(|s| B64.decode(s).ok());
            (decode("start"), decode("end"))
        })
        .collect();
    rooms::with_ydoc(state, doc_id, |y, _| {
        let frag = ydoc::fragment(y);
        let txn = yrs::Transact::transact(y);
        let map = ydoc::text_map(&txn, &frag);
        anchors
            .iter()
            .zip(pdf)
            .map(|((start, end), is_pdf)| {
                // A comment on an area of a PDF has no text to follow.
                if is_pdf {
                    return (None, false, None, None);
                }
                let start = start.as_ref().and_then(|s| ydoc::resolve_position(&txn, &map, s));
                let end = end.as_ref().and_then(|e| ydoc::resolve_position(&txn, &map, e));
                match (start, end) {
                    (Some(s), Some(e)) if e > s => {
                        let quote = map.slice(s, e).replace('\u{FFFC}', "");
                        let orphaned = quote.trim().is_empty();
                        (Some(quote), orphaned, map.block_at(s), Some(s))
                    }
                    // A range whose start and end met: its text was deleted.
                    (Some(s), Some(_)) => (None, true, map.block_at(s), Some(s)),
                    // A point (a whole section, a cell, an image).
                    (Some(s), None) if end.is_none() => (None, false, map.block_at(s), Some(s)),
                    _ => (None, true, None, None),
                }
            })
            .collect()
    })
    .await
}

async fn thread_views(state: &AppState, threads: Vec<ThreadRow>) -> ApiResult<Vec<Value>> {
    if threads.is_empty() {
        return Ok(vec![]);
    }
    let doc_id = threads[0].doc_id.clone();
    let places = locate(state, &doc_id, &threads).await?;
    let ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
    let comments: Vec<CommentRow> = sqlx::query_as("select id, thread_id, author_uuid, body, created_at, edited_at, deleted_at from comments where thread_id = any($1) order by created_at")
        .bind(&ids)
        .fetch_all(&state.db)
        .await?;
    let comment_ids: Vec<String> = comments.iter().map(|c| c.id.clone()).collect();
    let reactions: Vec<(String, String, String)> = sqlx::query_as("select comment_id, emoji, account_uuid from reactions where comment_id = any($1) order by created_at")
        .bind(&comment_ids)
        .fetch_all(&state.db)
        .await?;
    let mut uuids: Vec<String> = vec![];
    for t in &threads {
        uuids.push(t.created_by.clone());
        uuids.extend(t.resolved_by.clone());
    }
    uuids.extend(comments.iter().map(|c| c.author_uuid.clone()));
    uuids.extend(reactions.iter().map(|r| r.2.clone()));
    let people = accounts::many(state, &uuids).await?;
    let person = |uuid: &str| people.get(uuid).cloned().unwrap_or_else(|| Account::unknown(uuid));
    let mut out = vec![];
    for (thread, (current, orphaned, block, offset)) in threads.iter().zip(places) {
        let thread_comments: Vec<Value> = comments
            .iter()
            .filter(|c| c.thread_id == thread.id)
            .map(|c| {
                let mut grouped: Vec<(String, Vec<Account>)> = vec![];
                for (comment_id, emoji, account) in &reactions {
                    if *comment_id != c.id {
                        continue;
                    }
                    match grouped.iter_mut().find(|(e, _)| e == emoji) {
                        Some((_, accounts)) => accounts.push(person(account)),
                        None => grouped.push((emoji.clone(), vec![person(account)])),
                    }
                }
                json!({
                    "id": c.id,
                    "author": person(&c.author_uuid),
                    "body": if c.deleted_at.is_some() { String::new() } else { c.body.clone() },
                    "created_at": rfc3339(&c.created_at),
                    "edited_at": c.edited_at.as_ref().map(rfc3339),
                    "deleted": c.deleted_at.is_some(),
                    "reactions": grouped.into_iter().map(|(emoji, accounts)| json!({ "emoji": emoji, "accounts": accounts })).collect::<Vec<_>>(),
                })
            })
            .collect();
        out.push(json!({
            "id": thread.id,
            "anchor": thread.anchor,
            "quote": thread.quote,
            "current_quote": current,
            "orphaned": orphaned,
            "block_index": block,
            "text_offset": offset,
            "status": thread.status,
            "created_by": person(&thread.created_by),
            "created_at": rfc3339(&thread.created_at),
            "resolved_by": thread.resolved_by.as_deref().map(person),
            "resolved_at": thread.resolved_at.as_ref().map(rfc3339),
            "comments": thread_comments,
        }));
    }
    out.sort_by(|a, b| {
        let order = |v: &Value| -> [f64; 3] {
            if v.pointer("/anchor/kind").and_then(Value::as_str) == Some("pdf") {
                [v.pointer("/anchor/rect/page"), v.pointer("/anchor/rect/y"), v.pointer("/anchor/rect/x")].map(|n| n.and_then(Value::as_f64).unwrap_or(f64::MAX))
            } else {
                [v.get("block_index").and_then(Value::as_f64).unwrap_or(f64::MAX), v.get("text_offset").and_then(Value::as_f64).unwrap_or(f64::MAX), 0.0]
            }
        };
        order(a).into_iter().zip(order(b)).map(|(a, b)| a.total_cmp(&b)).find(|order| !order.is_eq()).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

#[derive(Deserialize)]
pub struct ListQuery {
    status: Option<String>,
}

pub async fn list(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    let filter = match q.status.as_deref().unwrap_or("open") {
        "open" => "and status = 'open'",
        "resolved" => "and status = 'resolved'",
        "all" => "",
        other => return Err(ApiError::invalid(format!("Unknown status `{other}`.")).hint("Use open, resolved or all.")),
    };
    let threads: Vec<ThreadRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {THREAD_COLUMNS} from threads where doc_id = $1 {filter} order by created_at")))
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    let mut views = thread_views(&state, threads).await?;
    // In document order; threads whose text is gone at the end.
    views.sort_by_key(|t| t.get("block_index").and_then(Value::as_u64).unwrap_or(u64::MAX));
    Ok(Json(json!({ "threads": views })))
}

/// Open threads as Markdown notes placed after the blocks they're on (for reading with comments).
pub async fn annotations(state: &AppState, doc_id: &str) -> ApiResult<Vec<(usize, String)>> {
    let threads: Vec<ThreadRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {THREAD_COLUMNS} from threads where doc_id = $1 and status = 'open' order by created_at")))
        .bind(doc_id)
        .fetch_all(&state.db)
        .await?;
    let views = thread_views(state, threads).await?;
    let mut notes: Vec<(usize, String)> = vec![];
    let last_block = rooms::read(state, doc_id).await?.0.blocks.len().saturating_sub(1);
    for t in views {
        let block = t.get("block_index").and_then(Value::as_u64).map(|b| b as usize).unwrap_or(last_block);
        let quote = t.get("current_quote").and_then(Value::as_str).or_else(|| t.get("quote").and_then(Value::as_str)).unwrap_or("");
        let comments = t.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut lines = vec![];
        for (i, c) in comments.iter().enumerate() {
            let author = c.pointer("/author/id").and_then(Value::as_str).unwrap_or("someone");
            let body = if c.get("deleted").and_then(Value::as_bool) == Some(true) { "(deleted)".to_owned() } else { annotation_text(c.get("body").and_then(Value::as_str).unwrap_or("")) };
            if i == 0 {
                let id = t.get("id").and_then(Value::as_str).unwrap_or("");
                let short = annotation_text(&quote.chars().take(120).collect::<String>());
                lines.push(format!("> [!comment {id} by {author} on \"{short}\"] {body}"));
            } else {
                lines.push(format!("> ↳ {author}: {body}"));
            }
        }
        notes.push((block, lines.join("\n")));
    }
    Ok(notes)
}

fn annotation_text(text: &str) -> String {
    text.chars().map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') { ' ' } else { c }).collect()
}

fn require_active(doc: &access::DocRow) -> ApiResult<()> {
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Anchor {
    kind: Option<String>,
    start: Option<String>,
    end: Option<String>,
    quote: Option<String>,
    rect: Option<Value>,
}

#[derive(Deserialize)]
pub struct NewThread {
    anchor: Anchor,
    body: String,
}

fn check_body(body: &str) -> ApiResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(ApiError::invalid("A comment can't be empty."));
    }
    if body.chars().count() > MAX_BODY {
        return Err(ApiError::invalid(format!("A comment can be at most {MAX_BODY} characters.")));
    }
    if body.contains('\0') {
        return Err(ApiError::invalid("A comment can't contain a NUL character."));
    }
    Ok(body.to_owned())
}

/// Finds `quote` once in the doc's text and anchors to it.
async fn anchor_by_quote(state: &AppState, doc_id: &str, quote: &str) -> ApiResult<(String, String)> {
    let needle: Vec<u16> = quote.encode_utf16().collect();
    rooms::with_ydoc(state, doc_id, |y, _| -> ApiResult<(String, String)> {
        let frag = ydoc::fragment(y);
        let txn = yrs::Transact::transact(y);
        let map = ydoc::text_map(&txn, &frag);
        let (hay, ranges) = ydoc::quote_map(&txn, &frag, &map);
        let mut found = vec![];
        if !needle.is_empty() && needle.len() <= hay.len() {
            for i in 0..=(hay.len() - needle.len()) {
                if hay[i..i + needle.len()] == needle[..] {
                    found.push(i);
                    if found.len() > 1 {
                        break;
                    }
                }
            }
        }
        match found.as_slice() {
            [] => Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "no_match", "The quoted text isn't in the doc.").hint("Quote the doc's text exactly as it reads (without Markdown formatting characters).")),
            [_, _, ..] => Err(ApiError::new(StatusCode::CONFLICT, "not_unique", "The quoted text appears more than once.").hint("Quote more of the surrounding text so it appears once.")),
            [at] => {
                let start = ydoc::position_at(&txn, &map, ranges[*at].0, false);
                let end = ydoc::position_at(&txn, &map, ranges[at + needle.len() - 1].1, true);
                match (start, end) {
                    (Some(s), Some(e)) => Ok((B64.encode(s), B64.encode(e))),
                    _ => Err(ApiError::invalid("That text can't be commented on (it spans more than one paragraph).").hint("Quote text from within one paragraph.")),
                }
            }
        }
    })
    .await?
}

pub async fn create(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<NewThread>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    require_active(&doc)?;
    let text = check_body(&body.body)?;
    let kind = body.anchor.kind.clone().unwrap_or_else(|| "text".into());
    if !["text", "block", "cell", "image", "pdf"].contains(&kind.as_str()) {
        return Err(ApiError::invalid("The anchor kind must be text, block, cell, image or pdf."));
    }
    if kind == "pdf" {
        if doc.kind != "pdf" {
            return Err(ApiError::invalid("A page area needs a PDF doc."));
        }
        let rect = body.anchor.rect.clone().ok_or_else(|| ApiError::invalid("A comment on a PDF needs the area (`rect` with x, y, w, h and page)."))?;
        check_rect(&rect)?;
        let page = rect.get("page").and_then(Value::as_u64).ok_or_else(|| ApiError::invalid("A comment on a PDF needs the page (`rect.page`)."))?;
        let (bytes, _, _) = crate::content::original_file(&state, &doc).await?;
        let pages = crate::convert::pdf_pages(&state, &bytes).await?;
        if page == 0 || page > pages {
            return Err(ApiError::invalid(format!("Choose a page from 1 to {pages}.")));
        }
        let anchor = json!({ "kind": "pdf", "rect": rect });
        return create_thread(&state, &caller, &doc, &id, anchor, body.anchor.quote.clone().unwrap_or_default(), text).await;
    }
    let (start, end, quote) = match (&body.anchor.start, &body.anchor.quote) {
        (Some(start), _) => {
            for s in [Some(start), body.anchor.end.as_ref()].into_iter().flatten() {
                if B64.decode(s).is_err() {
                    return Err(ApiError::invalid("The anchor's positions must be base64 Yjs relative positions."));
                }
            }
            let quote = quote_at_positions(&state, &id, start, body.anchor.end.as_deref()).await?;
            (start.clone(), body.anchor.end.clone(), quote)
        }
        (None, Some(quote)) if !quote.is_empty() => {
            let (s, e) = anchor_by_quote(&state, &id, quote).await?;
            (s, Some(e), quote.clone())
        }
        _ => return Err(ApiError::invalid("Anchor the comment with editor positions (`start`, `end`) or the exact text (`quote`).")),
    };
    let mut anchor = json!({ "kind": kind, "start": start });
    if let Some(end) = end {
        anchor["end"] = json!(end);
    }
    if let Some(rect) = body.anchor.rect {
        if kind != "image" {
            return Err(ApiError::invalid("An area needs an image or PDF page."));
        }
        check_rect(&rect)?;
        anchor["rect"] = rect;
    }
    create_thread(&state, &caller, &doc, &id, anchor, quote, text).await
}

fn check_rect(rect: &Value) -> ApiResult<()> {
    let number = |key| rect.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1.0)
        .ok_or_else(|| ApiError::invalid("An area needs numeric x, y, w and h fractions between 0 and 1."));
    let (x, y, w, h) = (number("x")?, number("y")?, number("w")?, number("h")?);
    if w <= 0.0 || h <= 0.0 || x + w > 1.0 || y + h > 1.0 {
        return Err(ApiError::invalid("The area must fit inside its image or page."));
    }
    Ok(())
}

async fn quote_at_positions(state: &AppState, doc_id: &str, start: &str, end: Option<&str>) -> ApiResult<String> {
    let start = B64.decode(start).map_err(|_| ApiError::invalid("Invalid comment position."))?;
    let end = end.map(|s| B64.decode(s)).transpose().map_err(|_| ApiError::invalid("Invalid comment position."))?;
    rooms::with_ydoc(state, doc_id, |y, _| {
        let frag = ydoc::fragment(y);
        let txn = yrs::Transact::transact(y);
        let map = ydoc::text_map(&txn, &frag);
        let from = ydoc::resolve_position(&txn, &map, &start).ok_or_else(|| ApiError::invalid("The comment's start isn't in this doc."))?;
        let to = match &end {
            Some(end) => ydoc::resolve_position(&txn, &map, end).filter(|to| *to > from).ok_or_else(|| ApiError::invalid("The comment's range isn't in this doc."))?,
            None => map.blocks.iter().find(|(s, e, _)| from >= *s && from <= *e).map(|(_, e, _)| *e).ok_or_else(|| ApiError::invalid("The comment isn't on a block in this doc."))?,
        };
        Ok(map.slice(from, to).replace('\u{FFFC}', ""))
    }).await?
}

async fn create_thread(state: &AppState, caller: &Caller, doc: &access::DocRow, id: &str, anchor: Value, quote: String, text: String) -> ApiResult<(StatusCode, Json<Value>)> {
    let state = state.clone();
    let thread_id = ids::new_id("t");
    let comment_id = ids::new_id("c");
    let quote: String = quote.chars().take(2000).collect();
    let mut tx = state.db.begin().await?;
    sqlx::query("insert into threads (id, doc_id, anchor, quote, created_by) values ($1, $2, $3, $4, $5)")
        .bind(&thread_id)
        .bind(id)
        .bind(&anchor)
        .bind(&quote)
        .bind(&caller.uuid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("insert into comments (id, thread_id, doc_id, author_uuid, body) values ($1, $2, $3, $4, $5)")
        .bind(&comment_id)
        .bind(&thread_id)
        .bind(id)
        .bind(&caller.uuid)
        .bind(&text)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let author = accounts::one(&state, &caller.uuid).await?;
    notify::comment(&state, doc, &thread_id, &comment_id, &author, &text, &quote, false, false).await?;
    state.rooms.notify(id, json!({ "type": "threads" })).await;
    Ok((StatusCode::CREATED, Json(one_thread(&state, &thread_id).await?)))
}

async fn one_thread(state: &AppState, thread_id: &str) -> ApiResult<Value> {
    let thread: ThreadRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {THREAD_COLUMNS} from threads where id = $1")))
        .bind(thread_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This thread"))?;
    Ok(thread_views(state, vec![thread]).await?.into_iter().next().unwrap_or(Value::Null))
}

async fn thread_for(state: &AppState, caller: &Caller, thread_id: &str) -> ApiResult<(ThreadRow, access::DocRow, Role)> {
    let thread: ThreadRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {THREAD_COLUMNS} from threads where id = $1")))
        .bind(thread_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This thread"))?;
    let (doc, role) = access::require_doc(state, Some(caller), &thread.doc_id, Role::Commenter).await?;
    Ok((thread, doc, role))
}

#[derive(Deserialize)]
pub struct Body {
    body: String,
}

pub async fn reply(State(state): State<AppState>, Auth(caller): Auth, Path(thread_id): Path<String>, Json(body): Json<Body>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (thread, doc, _) = thread_for(&state, &caller, &thread_id).await?;
    require_active(&doc)?;
    let text = check_body(&body.body)?;
    let comment_id = ids::new_id("c");
    sqlx::query("insert into comments (id, thread_id, doc_id, author_uuid, body) values ($1, $2, $3, $4, $5)")
        .bind(&comment_id)
        .bind(&thread_id)
        .bind(&thread.doc_id)
        .bind(&caller.uuid)
        .bind(&text)
        .execute(&state.db)
        .await?;
    let author = accounts::one(&state, &caller.uuid).await?;
    notify::comment(&state, &doc, &thread_id, &comment_id, &author, &text, &thread.quote, true, false).await?;
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok((StatusCode::CREATED, Json(comment_view(&state, &comment_id).await?)))
}

async fn comment_view(state: &AppState, comment_id: &str) -> ApiResult<Value> {
    let thread_id: String = sqlx::query_scalar("select thread_id from comments where id = $1").bind(comment_id).fetch_one(&state.db).await?;
    let thread = one_thread(state, &thread_id).await?;
    Ok(thread
        .get("comments")
        .and_then(Value::as_array)
        .and_then(|cs| cs.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(comment_id)).cloned())
        .unwrap_or(Value::Null))
}

async fn comment_for(state: &AppState, caller: &Caller, comment_id: &str) -> ApiResult<(CommentRow, ThreadRow, access::DocRow, Role)> {
    let comment: CommentRow = sqlx::query_as("select id, thread_id, author_uuid, body, created_at, edited_at, deleted_at from comments where id = $1")
        .bind(comment_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("This comment"))?;
    let (thread, doc, role) = thread_for(state, caller, &comment.thread_id).await?;
    Ok((comment, thread, doc, role))
}

pub async fn edit(State(state): State<AppState>, Auth(caller): Auth, Path(comment_id): Path<String>, Json(body): Json<Body>) -> ApiResult<Json<Value>> {
    let (comment, thread, doc, _) = comment_for(&state, &caller, &comment_id).await?;
    require_active(&doc)?;
    if comment.author_uuid != caller.uuid {
        return Err(ApiError::forbidden("Only the comment's author can edit it."));
    }
    if comment.deleted_at.is_some() {
        return Err(ApiError::conflict("This comment was deleted."));
    }
    let text = check_body(&body.body)?;
    let mut tx = state.db.begin().await?;
    // Serialize replacements so every accepted text is the current body or a revision.
    let previous: Option<(String, Option<OffsetDateTime>)> = sqlx::query_as("select body, deleted_at from comments where id = $1 for update")
        .bind(&comment_id).fetch_optional(&mut *tx).await?;
    let (previous, deleted_at) = previous.ok_or_else(|| ApiError::not_found("This comment"))?;
    if deleted_at.is_some() {
        return Err(ApiError::conflict("This comment was deleted."));
    }
    if previous == text {
        tx.rollback().await?;
        return Ok(Json(comment_view(&state, &comment_id).await?));
    }
    sqlx::query("insert into comment_revisions (comment_id, body) values ($1, $2)").bind(&comment_id).bind(&previous).execute(&mut *tx).await?;
    sqlx::query("update comments set body = $2, edited_at = now() where id = $1").bind(&comment_id).bind(&text).execute(&mut *tx).await?;
    sqlx::query("insert into activity (doc_id, actor_uuid, kind, data) values ($1, $2, 'comment.edited', $3)")
        .bind(&thread.doc_id).bind(&caller.uuid).bind(json!({ "thread": thread.id, "comment": comment_id, "before": previous, "after": text })).execute(&mut *tx).await?;
    tx.commit().await?;
    // Newly mentioned people hear about it (the others were told already).
    let author = accounts::one(&state, &caller.uuid).await?;
    notify::comment(&state, &doc, &thread.id, &comment_id, &author, &text, &thread.quote, false, true).await?;
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok(Json(comment_view(&state, &comment_id).await?))
}

pub async fn delete(State(state): State<AppState>, Auth(caller): Auth, Path(comment_id): Path<String>) -> ApiResult<StatusCode> {
    let (comment, thread, _, role) = comment_for(&state, &caller, &comment_id).await?;
    if comment.author_uuid != caller.uuid && role != Role::Owner {
        return Err(ApiError::forbidden("Only the comment's author or the doc's owner can delete it."));
    }
    let deleted: Option<String> = sqlx::query_scalar("update comments set deleted_at = now() where id = $1 and deleted_at is null returning body")
        .bind(&comment_id).fetch_optional(&state.db).await?;
    if let Some(body) = deleted {
        activity::record(&state, Some(&thread.doc_id), None, &caller.uuid, "comment.deleted", json!({ "thread": thread.id, "comment": comment_id, "body": body, "author": comment.author_uuid })).await?;
    }
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Reaction {
    emoji: String,
}

fn is_emoji(emoji: &str) -> bool {
    emoji.graphemes(true).count() == 1
        && emoji.chars().all(|c| c.is_emoji_char_or_emoji_component())
        && emoji.chars().any(|c| (!c.is_ascii() && c.is_emoji_char() && !matches!(c, '\u{1f3fb}'..='\u{1f3ff}')) || c == '\u{20e3}')
}

pub async fn react(State(state): State<AppState>, Auth(caller): Auth, Path(comment_id): Path<String>, Json(body): Json<Reaction>) -> ApiResult<Json<Value>> {
    let (comment, thread, doc, _) = comment_for(&state, &caller, &comment_id).await?;
    require_active(&doc)?;
    if comment.deleted_at.is_some() {
        return Err(ApiError::conflict("This comment was deleted."));
    }
    let emoji = body.emoji.trim();
    if !is_emoji(emoji) {
        return Err(ApiError::invalid("A reaction is one emoji."));
    }
    let removed = sqlx::query("delete from reactions where comment_id = $1 and account_uuid = $2 and emoji = $3")
        .bind(&comment_id)
        .bind(&caller.uuid)
        .bind(emoji)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed == 0 {
        sqlx::query("insert into reactions (comment_id, account_uuid, emoji) values ($1, $2, $3) on conflict do nothing")
            .bind(&comment_id)
            .bind(&caller.uuid)
            .bind(emoji)
            .execute(&state.db)
            .await?;
    }
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok(Json(comment_view(&state, &comment_id).await?))
}

pub async fn resolve(State(state): State<AppState>, Auth(caller): Auth, Path(thread_id): Path<String>) -> ApiResult<Json<Value>> {
    let (thread, doc, _) = thread_for(&state, &caller, &thread_id).await?;
    require_active(&doc)?;
    if sqlx::query("update threads set status = 'resolved', resolved_by = $2, resolved_at = now() where id = $1 and status != 'resolved'").bind(&thread_id).bind(&caller.uuid).execute(&state.db).await?.rows_affected() != 0 {
        activity::record(&state, Some(&thread.doc_id), None, &caller.uuid, "thread.resolved", json!({ "thread": thread_id, "quote": thread.quote })).await?;
        let resolver = accounts::one(&state, &caller.uuid).await?;
        notify::thread_resolved(&state, &doc, &thread_id, &thread.created_by, &resolver, &thread.quote).await?;
    }
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok(Json(one_thread(&state, &thread_id).await?))
}

pub async fn reopen(State(state): State<AppState>, Auth(caller): Auth, Path(thread_id): Path<String>) -> ApiResult<Json<Value>> {
    let (thread, doc, _) = thread_for(&state, &caller, &thread_id).await?;
    require_active(&doc)?;
    if sqlx::query("update threads set status = 'open', resolved_by = null, resolved_at = null where id = $1 and status != 'open'").bind(&thread_id).execute(&state.db).await?.rows_affected() != 0 {
        activity::record(&state, Some(&thread.doc_id), None, &caller.uuid, "thread.reopened", json!({ "thread": thread_id })).await?;
    }
    state.rooms.notify(&thread.doc_id, json!({ "type": "threads" })).await;
    Ok(Json(one_thread(&state, &thread_id).await?))
}
