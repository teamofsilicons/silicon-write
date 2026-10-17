//! Versions and history (UNDERSTANDING.md, "Versions"). Every stored change is kept, forever.
//! Versions are the stored changes grouped by who made them and when; any version can be opened,
//! compared with any other (with who added and removed what), restored whole or in part, or used
//! to undo everything one Carbon or Silicon changed since. Going back never deletes anything:
//! restoring is itself a new version.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use write_doc::history::{self, StoredUpdate};
use write_doc::ydoc::{self, EditMode};
use write_doc::{Block, Doc};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Transact, Update};

use crate::access::{self, Role};
use crate::accounts::{self, Account};
use crate::activity;
use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::rooms::{self, Origin};
use crate::state::AppState;

/// A gap this long between two changes by the same account starts a new version.
const VERSION_GAP: time::Duration = time::Duration::minutes(5);

/// The doc as it read after change `seq`.
pub async fn doc_at(state: &AppState, doc_id: &str, seq: i64) -> ApiResult<Doc> {
    // Every caller (rendering, downloading and copying too) reads an existing version. Replaying
    // an out-of-range number would otherwise silently give the latest or the empty document.
    let latest: Option<i64> = sqlx::query_scalar("select seq from docs where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.db)
        .await?;
    check_seq(seq, latest.ok_or_else(|| ApiError::not_found("This doc"))?)?;
    Ok(ydoc::read_doc(&ydoc_at(state, doc_id, seq).await?))
}

async fn ydoc_at(state: &AppState, doc_id: &str, seq: i64) -> ApiResult<yrs::Doc> {
    let checkpoint: Option<(i64, Vec<u8>)> = sqlx::query_as("select seq, state from doc_checkpoints where doc_id = $1 and seq <= $2 order by seq desc limit 1")
        .bind(doc_id)
        .bind(seq)
        .fetch_optional(&state.db)
        .await?;
    let from = checkpoint.as_ref().map(|c| c.0).unwrap_or(0);
    let updates: Vec<Vec<u8>> = sqlx::query_scalar(
        "select update from doc_updates where doc_id = $1 and seq > $2 and seq <= $3 order by seq",
    )
    .bind(doc_id)
    .bind(from)
    .bind(seq)
    .fetch_all(&state.db)
    .await?;
    let mut all: Vec<&[u8]> = vec![];
    if let Some((_, state_bytes)) = &checkpoint {
        all.push(state_bytes);
    }
    all.extend(updates.iter().map(|u| u.as_slice()));
    Ok(history::replay(all)?)
}

async fn stored_updates(
    state: &AppState,
    doc_id: &str,
    upto: Option<i64>,
) -> ApiResult<Vec<StoredUpdate>> {
    let rows: Vec<(i64, String, Vec<u8>)> = sqlx::query_as("select seq, author_uuid, update from doc_updates where doc_id = $1 and seq <= $2 order by seq")
        .bind(doc_id)
        .bind(upto.unwrap_or(i64::MAX))
        .fetch_all(&state.db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(seq, author, update)| StoredUpdate {
            seq,
            author,
            update,
        })
        .collect())
}

fn block_md(block: &Block) -> String {
    write_doc::to_markdown(&Doc {
        blocks: vec![block.clone()],
    })
    .trim_end()
    .to_owned()
}

fn heading_text(block: &Block) -> Option<String> {
    match block {
        Block::Heading { .. } => Some(block.plain_text()),
        _ => None,
    }
}

// ------------------------------------------------------------------------------------------
// The list of versions
// ------------------------------------------------------------------------------------------

struct Group {
    from_seq: i64,
    seq: i64,
    author: String,
    origin: String,
    created_at: OffsetDateTime,
}

pub async fn list(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let rows: Vec<(i64, String, String, OffsetDateTime)> = sqlx::query_as("select seq, author_uuid, origin, created_at from doc_updates where doc_id = $1 order by seq")
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    let names: HashMap<i64, String> =
        sqlx::query_as::<_, (i64, String)>("select seq, name from version_names where doc_id = $1")
            .bind(&id)
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .collect();
    // Group the changes.
    let standalone =
        |origin: &str| matches!(origin, "create" | "import" | "restore" | "undo" | "review");
    let mut groups: Vec<Group> = vec![];
    for (seq, author, origin, created_at) in rows {
        let extend = groups.last().is_some_and(|g| {
            g.author == author
                && g.origin == origin
                && !standalone(&origin)
                && created_at - g.created_at < VERSION_GAP
                && !names.contains_key(&g.seq)
        });
        if extend {
            let g = groups.last_mut().unwrap();
            g.seq = seq;
            g.created_at = created_at;
        } else {
            groups.push(Group {
                from_seq: seq,
                seq,
                author,
                origin,
                created_at,
            });
        }
    }
    // Summaries: what changed in each version, by section.
    let updates = stored_updates(&state, &id, None).await?;
    let y = ydoc::new_ydoc(1);
    let mut previous = Doc::default();
    let mut summaries: Vec<String> = Vec::with_capacity(groups.len());
    let mut next = 0usize;
    for group in &groups {
        {
            let mut txn = y.transact_mut();
            while next < updates.len() && updates[next].seq <= group.seq {
                if let Ok(u) = Update::decode_v1(&updates[next].update) {
                    let _ = txn.apply_update(u);
                }
                next += 1;
            }
        }
        let current = ydoc::read_doc(&y);
        summaries.push(summary(&group.origin, &previous, &current));
        previous = current;
    }
    let people = accounts::many(
        &state,
        &groups.iter().map(|g| g.author.clone()).collect::<Vec<_>>(),
    )
    .await?;
    let versions: Vec<Value> = groups
        .iter()
        .zip(summaries)
        .rev()
        .map(|(g, what)| {
            let author = people.get(&g.author).cloned().unwrap_or_else(|| Account::unknown(&g.author));
            json!({
                "seq": g.seq,
                "from_seq": g.from_seq,
                "authors": [author.clone()],
                "summary": format!("{} {}", author.handle(), what),
                "name": names.get(&g.seq),
                "origin": g.origin,
                "created_at": g.created_at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "versions": versions })))
}

/// "edited “Introduction”", "added text to “Plan”", "created the doc", …
fn summary(origin: &str, before: &Doc, after: &Doc) -> String {
    match origin {
        "create" if before.blocks.is_empty() => return "created the doc".into(),
        "import" => return "opened a file into the doc".into(),
        "restore" => return "restored an earlier version".into(),
        "undo" => return "undid someone's changes".into(),
        "review" => return "accepted or rejected suggestions".into(),
        _ => {}
    }
    let ops =
        similar::capture_diff_slices(similar::Algorithm::Myers, &before.blocks, &after.blocks);
    let section_of = |blocks: &[Block], index: usize| -> Option<String> {
        blocks[..=index.min(blocks.len().saturating_sub(1))]
            .iter()
            .rev()
            .find_map(heading_text)
            .filter(|t| !t.trim().is_empty())
    };
    let mut sections: Vec<String> = vec![];
    let (mut added, mut removed, mut changed) = (0, 0, 0);
    for op in &ops {
        let (tag, old, new) = op.as_tag_tuple();
        match tag {
            similar::DiffTag::Equal => continue,
            similar::DiffTag::Insert => added += new.len(),
            similar::DiffTag::Delete => removed += old.len(),
            similar::DiffTag::Replace => changed += old.len().max(new.len()),
        }
        let section = if !new.is_empty() && !after.blocks.is_empty() {
            section_of(&after.blocks, new.start)
        } else if !before.blocks.is_empty() {
            section_of(&before.blocks, old.start.min(before.blocks.len() - 1))
        } else {
            None
        };
        if let Some(section) = section
            && !sections.contains(&section)
        {
            sections.push(section);
        }
    }
    let verb = if origin == "suggestion" {
        "suggested changes to"
    } else if added > 0 && removed == 0 && changed == 0 {
        "added to"
    } else if removed > 0 && added == 0 && changed == 0 {
        "removed text from"
    } else {
        "edited"
    };
    let place = match sections.as_slice() {
        [] => "the doc".to_owned(),
        [one] => format!("“{one}”"),
        [a, b] => format!("“{a}” and “{b}”"),
        [a, rest @ ..] => format!("“{a}” and {} other sections", rest.len()),
    };
    format!("{verb} {place}")
}

pub async fn version_markdown(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path((id, seq)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(seq, doc.seq)?;
    let content = doc_at(&state, &id, seq).await?;
    Ok(Json(
        json!({ "seq": seq, "markdown": write_doc::to_markdown(&content) }),
    ))
}

fn check_seq(seq: i64, latest: i64) -> ApiResult<()> {
    if seq < 0 || seq > latest {
        return Err(ApiError::not_found(&format!("Version {seq}"))
            .hint(format!("This doc's versions go from 0 to {latest}.")));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

pub async fn name_version(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path((id, seq)): Path<(String, i64)>,
    Json(body): Json<NameBody>,
) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(seq, doc.seq)?;
    if seq == 0 {
        return Err(ApiError::invalid(
            "Write something before naming a version.",
        ));
    }
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
    }
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::invalid("A version name is 1 to 200 characters."));
    }
    sqlx::query("insert into version_names (doc_id, seq, name, created_by) values ($1, $2, $3, $4) on conflict (doc_id, seq) do update set name = $3, created_by = $4, created_at = now()")
        .bind(&id)
        .bind(seq)
        .bind(name)
        .bind(&caller.uuid)
        .execute(&state.db)
        .await?;
    activity::record(
        &state,
        Some(&id),
        None,
        &caller.uuid,
        "version.named",
        json!({ "seq": seq, "name": name }),
    )
    .await?;
    Ok(Json(json!({ "seq": seq, "name": name })))
}

pub async fn unname_version(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path((id, seq)): Path<(String, i64)>,
) -> ApiResult<StatusCode> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(seq, doc.seq)?;
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
    }
    let old: Option<String> = sqlx::query_scalar(
        "delete from version_names where doc_id = $1 and seq = $2 returning name",
    )
    .bind(&id)
    .bind(seq)
    .fetch_optional(&state.db)
    .await?;
    if let Some(old) = old {
        activity::record(
            &state,
            Some(&id),
            None,
            &caller.uuid,
            "version.unnamed",
            json!({ "seq": seq, "name": old }),
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------------------------------
// Comparing
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CompareQuery {
    from: i64,
    to: Option<i64>,
}

pub async fn compare(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Query(q): Query<CompareQuery>,
) -> ApiResult<Json<Value>> {
    let (doc_row, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let to = q.to.unwrap_or(doc_row.seq);
    let (from, to) = (q.from.min(to), q.from.max(to));
    check_seq(from, doc_row.seq)?;
    check_seq(to, doc_row.seq)?;
    let updates = stored_updates(&state, &id, Some(to)).await?;
    let compared = history::compare::compare(&updates, from, to)?;
    let uuids: Vec<String> = compared
        .iter()
        .flat_map(|b| {
            b.by.iter()
                .cloned()
                .chain(b.parts.iter().filter_map(|p| p.by.clone()))
        })
        .collect();
    let people = accounts::many(&state, &uuids).await?;
    let person = |uuid: &str| {
        people
            .get(uuid)
            .cloned()
            .unwrap_or_else(|| Account::unknown(uuid))
    };
    let blocks: Vec<Value> = compared.into_iter().map(|block| {
        use history::compare::{Kind, Op};
        let kind = match block.kind { Kind::Same => "same", Kind::Added => "added", Kind::Removed => "removed", Kind::Changed => "changed" };
        let mut value = json!({ "change": kind });
        if let Some(before) = &block.before { value["before"] = json!(block_md(before)); }
        if let Some(after) = &block.after { value["after"] = json!(block_md(after)); }
        if let Some(index) = block.before_index { value["before_index"] = json!(index); }
        if let Some(index) = block.after_index { value["after_index"] = json!(index); }
        if block.kind != Kind::Same { value["by"] = json!(block.by.iter().map(|id| person(id)).collect::<Vec<_>>()); }
        if block.kind == Kind::Changed {
            value["parts"] = json!(block.parts.into_iter().map(|part| {
                let mut value = json!({ "op": match part.op { Op::Same => "same", Op::Added => "added", Op::Removed => "removed" }, "text": part.text });
                if let Some(by) = part.by { value["by"] = json!(person(&by)); }
                value
            }).collect::<Vec<_>>());
        }
        value
    }).collect();
    Ok(Json(json!({ "from": from, "to": to, "blocks": blocks })))
}

// ------------------------------------------------------------------------------------------
// Going back
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RestoreBody {
    seq: i64,
    /// Only these top-level blocks of that version: [from, to] (inclusive).
    blocks: Option<[usize; 2]>,
}

pub async fn restore(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Json(body): Json<RestoreBody>,
) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(body.seq, doc.seq)?;
    let old_y = ydoc_at(&state, &id, body.seq).await?;
    let old_frag = ydoc::fragment(&old_y);
    let (old, old_placed) = history::blocks::placed(&old_y.transact(), &old_frag);
    let changes = history::changes::Changes::new(&stored_updates(&state, &id, None).await?)?;
    if let Some([a, b]) = body.blocks
        && (a > b || b >= old.blocks.len())
    {
        return Err(ApiError::invalid(format!(
            "Version {} has blocks 0 to {}.",
            body.seq,
            old.blocks.len().saturating_sub(1)
        )));
    }
    let (changed, seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Restore, None, |y| {
        let frag = ydoc::fragment(y);
        let (current, current_placed) = history::blocks::placed(&y.transact(), &frag);
        let target = match body.blocks {
            None => old.clone(),
            Some([a, b]) => history::blocks::bring_back(
                &old,
                &old_placed,
                &current,
                &current_placed,
                a..=b,
                |a, b| changes.replaced(a, b),
            ),
        };
        let before = y.transact().snapshot();
        ydoc::with_txn(y, |txn, frag| {
            ydoc::patch(txn, frag, &current, &target, &EditMode::default())
        });
        Ok(before != y.transact().snapshot())
    })
    .await?;
    if changed {
        activity::record(
            &state,
            Some(&id),
            None,
            &caller.uuid,
            "version.restored",
            json!({ "seq": body.seq, "blocks": body.blocks, "new_seq": seq }),
        )
        .await?;
    }
    Ok(Json(json!({ "seq": seq })))
}

#[derive(Deserialize)]
pub struct UndoBody {
    account: String,
    since: i64,
}

pub async fn undo_account(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    Json(body): Json<UndoBody>,
) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(body.since, doc.seq)?;
    let account = accounts::by_public_id(&state, &body.account).await?;
    let clients: Vec<i64> = sqlx::query_scalar(
        "select client_id from doc_clients where doc_id = $1 and author_uuid = $2",
    )
    .bind(&id)
    .bind(&account.uuid)
    .fetch_all(&state.db)
    .await?;
    let clients: std::collections::HashSet<u64> = clients.into_iter().map(|c| c as u64).collect();
    // Computed from the stored history; if the doc moves on meanwhile, compute again.
    for _ in 0..5 {
        let updates = stored_updates(&state, &id, None).await?;
        let latest = updates.last().map(|u| u.seq).unwrap_or(0);
        let target = history::undo_author_since(&updates, &account.uuid, &clients, body.since)?;
        match rooms::edit_expecting(
            &state,
            &id,
            &caller.uuid,
            Origin::Undo,
            None,
            Some(latest),
            |y| {
                let current = ydoc::read_doc(y);
                ydoc::with_txn(y, |txn, frag| {
                    ydoc::patch(txn, frag, &current, &target, &EditMode::default())
                });
                Ok(())
            },
        )
        .await
        {
            Ok(((), seq)) => {
                if seq != latest {
                    activity::record(
                        &state,
                        Some(&id),
                        None,
                        &caller.uuid,
                        "version.undone",
                        json!({ "account": account.uuid, "since": body.since, "new_seq": seq }),
                    )
                    .await?;
                }
                return Ok(Json(json!({ "seq": seq })));
            }
            Err(e) if e.code == "conflict" && e.message.contains("meanwhile") => continue,
            Err(e) => return Err(e),
        }
    }
    Err(ApiError::conflict(
        "The doc kept changing; try again in a moment.",
    ))
}

// ------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------

pub async fn suggestions(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    let (doc, _) = rooms::read(&state, &id).await?;
    let list = doc.suggestions();
    let people = accounts::many(
        &state,
        &list.iter().map(|s| s.author.clone()).collect::<Vec<_>>(),
    )
    .await?;
    let items: Vec<Value> = list
        .into_iter()
        .map(|s| json!({ "id": s.id, "author": people.get(&s.author), "inserted": s.inserted, "deleted": s.deleted }))
        .collect();
    Ok(Json(json!({ "suggestions": items })))
}

pub async fn decide(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path((id, sid, action)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    let accept = match action.as_str() {
        "accept" => true,
        "reject" => false,
        _ => return Err(ApiError::not_found("This action")),
    };
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let (found, seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Review, None, |y| {
        let found = ydoc::with_txn(y, |txn, frag| {
            ydoc::resolve_suggestion(txn, frag, &sid, accept)
        });
        if !found {
            return Err(ApiError::not_found("This suggestion"));
        }
        Ok(found)
    })
    .await?;
    let _ = found;
    record_decision(&state, &id, &sid, accept, &caller.uuid).await?;
    Ok(Json(json!({ "seq": seq })))
}

pub async fn decide_all(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let accept = match action.as_str() {
        "accept-all" => true,
        "reject-all" => false,
        _ => return Err(ApiError::not_found("This action")),
    };
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let (ids, seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Review, None, |y| {
        let ids: Vec<String> = ydoc::read_doc(y)
            .suggestions()
            .into_iter()
            .map(|s| s.id)
            .collect();
        for sid in &ids {
            ydoc::with_txn(y, |txn, frag| {
                ydoc::resolve_suggestion(txn, frag, sid, accept)
            });
        }
        Ok(ids)
    })
    .await?;
    for sid in &ids {
        record_decision(&state, &id, sid, accept, &caller.uuid).await?;
    }
    Ok(Json(json!({ "seq": seq, "count": ids.len() })))
}

async fn record_decision(
    state: &AppState,
    doc_id: &str,
    sid: &str,
    accept: bool,
    by: &str,
) -> ApiResult<()> {
    let resolution = if accept { "accepted" } else { "rejected" };
    sqlx::query("update suggestions set resolution = $3, resolved_by = $4, resolved_at = now() where doc_id = $1 and id = $2")
        .bind(doc_id)
        .bind(sid)
        .bind(resolution)
        .bind(by)
        .execute(&state.db)
        .await?;
    activity::record(
        state,
        Some(doc_id),
        None,
        by,
        &format!("suggestion.{resolution}"),
        json!({ "suggestion": sid }),
    )
    .await?;
    Ok(())
}
