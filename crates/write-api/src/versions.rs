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
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::{Any, ReadTxn, Snapshot, StateVector, Text, Transact, Update, XmlFragment, XmlOut};

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
    Ok(ydoc::read_doc(&ydoc_at(state, doc_id, seq).await?))
}

async fn ydoc_at(state: &AppState, doc_id: &str, seq: i64) -> ApiResult<yrs::Doc> {
    let checkpoint: Option<(i64, Vec<u8>)> = sqlx::query_as("select seq, state from doc_checkpoints where doc_id = $1 and seq <= $2 order by seq desc limit 1")
        .bind(doc_id)
        .bind(seq)
        .fetch_optional(&state.db)
        .await?;
    let from = checkpoint.as_ref().map(|c| c.0).unwrap_or(0);
    let updates: Vec<Vec<u8>> = sqlx::query_scalar("select update from doc_updates where doc_id = $1 and seq > $2 and seq <= $3 order by seq")
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

async fn stored_updates(state: &AppState, doc_id: &str, upto: Option<i64>) -> ApiResult<Vec<StoredUpdate>> {
    let rows: Vec<(i64, String, Vec<u8>)> = sqlx::query_as("select seq, author_uuid, update from doc_updates where doc_id = $1 and seq <= $2 order by seq")
        .bind(doc_id)
        .bind(upto.unwrap_or(i64::MAX))
        .fetch_all(&state.db)
        .await?;
    Ok(rows.into_iter().map(|(seq, author, update)| StoredUpdate { seq, author, update }).collect())
}

fn block_md(block: &Block) -> String {
    write_doc::to_markdown(&Doc { blocks: vec![block.clone()] }).trim_end().to_owned()
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

pub async fn list(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let rows: Vec<(i64, String, String, OffsetDateTime)> = sqlx::query_as("select seq, author_uuid, origin, created_at from doc_updates where doc_id = $1 order by seq")
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
    let names: HashMap<i64, String> = sqlx::query_as::<_, (i64, String)>("select seq, name from version_names where doc_id = $1")
        .bind(&id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .collect();
    // Group the changes.
    let standalone = |origin: &str| matches!(origin, "create" | "import" | "restore" | "undo" | "review");
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
            groups.push(Group { from_seq: seq, seq, author, origin, created_at });
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
    let people = accounts::many(&state, &groups.iter().map(|g| g.author.clone()).collect::<Vec<_>>()).await?;
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
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &before.blocks, &after.blocks);
    let section_of = |blocks: &[Block], index: usize| -> Option<String> {
        blocks[..=index.min(blocks.len().saturating_sub(1))].iter().rev().find_map(heading_text).filter(|t| !t.trim().is_empty())
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
            && !sections.contains(&section) {
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

pub async fn version_markdown(State(state): State<AppState>, Auth(caller): Auth, Path((id, seq)): Path<(String, i64)>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(seq, doc.seq)?;
    let content = doc_at(&state, &id, seq).await?;
    Ok(Json(json!({ "seq": seq, "markdown": write_doc::to_markdown(&content) })))
}

fn check_seq(seq: i64, latest: i64) -> ApiResult<()> {
    if seq < 0 || seq > latest {
        return Err(ApiError::not_found(&format!("Version {seq}")).hint(format!("This doc's versions go from 0 to {latest}.")));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

pub async fn name_version(State(state): State<AppState>, Auth(caller): Auth, Path((id, seq)): Path<(String, i64)>, Json(body): Json<NameBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(seq, doc.seq)?;
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
    activity::record(&state, Some(&id), None, &caller.uuid, "version.named", json!({ "seq": seq, "name": name })).await?;
    Ok(Json(json!({ "seq": seq, "name": name })))
}

pub async fn unname_version(State(state): State<AppState>, Auth(caller): Auth, Path((id, seq)): Path<(String, i64)>) -> ApiResult<StatusCode> {
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let old: Option<String> = sqlx::query_scalar("delete from version_names where doc_id = $1 and seq = $2 returning name").bind(&id).bind(seq).fetch_optional(&state.db).await?;
    if let Some(old) = old {
        activity::record(&state, Some(&id), None, &caller.uuid, "version.unnamed", json!({ "seq": seq, "name": old })).await?;
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

/// The top-level elements of a doc, as the model reads them.
fn block_elements<T: ReadTxn>(txn: &T, frag: &yrs::XmlFragmentRef) -> Vec<yrs::XmlElementRef> {
    frag.children(txn)
        .filter_map(|c| match c {
            XmlOut::Element(e) => Some(e),
            _ => None,
        })
        .collect()
}

fn texts_of<T: ReadTxn, F: XmlFragment>(txn: &T, node: &F) -> Vec<yrs::XmlTextRef> {
    let mut out = vec![];
    for child in node.children(txn) {
        match child {
            XmlOut::Text(t) => out.push(t),
            XmlOut::Element(e) => out.extend(texts_of(txn, &e)),
            _ => {}
        }
    }
    out
}

pub async fn compare(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Query(q): Query<CompareQuery>) -> ApiResult<Json<Value>> {
    let (doc_row, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let to = q.to.unwrap_or(doc_row.seq);
    let (from, to) = (q.from.min(to), q.from.max(to));
    check_seq(from, doc_row.seq)?;
    check_seq(to, doc_row.seq)?;
    let updates = stored_updates(&state, &id, Some(to)).await?;
    let clients: HashMap<u64, String> = sqlx::query_as::<_, (i64, String)>("select client_id, author_uuid from doc_clients where doc_id = $1")
        .bind(&id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .map(|(c, a)| (c as u64, a))
        .collect();
    // Who deleted what, between the two versions.
    let deletions: Vec<(String, yrs::IdSet)> = updates
        .iter()
        .filter(|u| u.seq > from)
        .filter_map(|u| history::deletions(&u.update).ok().map(|ds| (u.author.clone(), ds)))
        .collect();
    let deleter = |id: &yrs::ID| -> Option<String> { deletions.iter().find(|(_, ds)| ds.contains(id)).map(|(a, _)| a.clone()) };

    let y = ydoc::new_ydoc(1);
    let frag = ydoc::fragment(&y);
    let mut next = 0;
    {
        let mut txn = y.transact_mut();
        while next < updates.len() && updates[next].seq <= from {
            txn.apply_update(Update::decode_v1(&updates[next].update).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
            next += 1;
        }
    }
    let before = ydoc::read_doc(&y);
    let snap_from = y.transact().snapshot();
    let empty = Snapshot::new(StateVector::default(), yrs::IdSet::default());
    // The first character of each block in the earlier version (to say who removed it).
    let first_ids: Vec<Option<yrs::ID>> = {
        let mut txn = y.transact_mut();
        let elements = block_elements(&txn, &frag);
        elements
            .iter()
            .map(|el| {
                texts_of(&txn, el).into_iter().find_map(|t| {
                    t.diff_range(&mut txn, Some(&snap_from), Some(&empty), YChange::identity).into_iter().find_map(|d| d.ychange.map(|c| c.id))
                })
            })
            .collect()
    };
    {
        let mut txn = y.transact_mut();
        while next < updates.len() {
            txn.apply_update(Update::decode_v1(&updates[next].update).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
            next += 1;
        }
    }
    let after = ydoc::read_doc(&y);
    let snap_to = y.transact().snapshot();

    let mut uuids: Vec<String> = clients.values().cloned().collect();
    uuids.extend(deletions.iter().map(|(a, _)| a.clone()));
    let people = accounts::many(&state, &uuids).await?;
    let person = |uuid: &str| people.get(uuid).map(|a| serde_json::to_value(a).unwrap_or(Value::Null)).unwrap_or(Value::Null);

    // Inline parts of a block in the later version: same, added (by whom), removed (by whom).
    let parts_of = |index: usize| -> (Vec<Value>, Vec<String>) {
        let mut txn = y.transact_mut();
        let elements = block_elements(&txn, &frag);
        let Some(el) = elements.get(index) else { return (vec![], vec![]) };
        let mut parts: Vec<Value> = vec![];
        let mut authors: Vec<String> = vec![];
        for text in texts_of(&txn, el) {
            for d in text.diff_range(&mut txn, Some(&snap_to), Some(&snap_from), YChange::identity) {
                let chunk = match &d.insert {
                    yrs::Out::Any(Any::String(s)) => s.to_string(),
                    _ => continue,
                };
                let (op, by) = match d.ychange {
                    Some(c) if c.kind == yrs::types::text::ChangeKind::Added => ("added", clients.get(&c.id.client.get()).cloned()),
                    Some(c) => ("removed", deleter(&c.id)),
                    None => ("same", None),
                };
                if let Some(by) = &by
                    && !authors.contains(by) {
                        authors.push(by.clone());
                    }
                match parts.last_mut() {
                    Some(last) if last["op"] == op && last.get("by_uuid").and_then(Value::as_str) == by.as_deref() => {
                        let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), chunk);
                        last["text"] = json!(joined);
                    }
                    _ => parts.push(json!({ "op": op, "text": chunk, "by_uuid": by })),
                }
            }
        }
        (parts, authors)
    };

    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &before.blocks, &after.blocks);
    let mut blocks: Vec<Value> = vec![];
    for op in ops {
        let (tag, old, new) = op.as_tag_tuple();
        match tag {
            similar::DiffTag::Equal => {
                for (i, j) in old.zip(new) {
                    blocks.push(json!({ "change": "same", "after": block_md(&after.blocks[j]), "before_index": i, "after_index": j }));
                }
            }
            similar::DiffTag::Delete => {
                for i in old {
                    let by = first_ids.get(i).cloned().flatten().and_then(|id| deleter(&id));
                    blocks.push(json!({ "change": "removed", "before": block_md(&before.blocks[i]), "before_index": i, "by": by.as_deref().map(person).into_iter().collect::<Vec<_>>() }));
                }
            }
            similar::DiffTag::Insert => {
                for j in new {
                    let (_, authors) = parts_of(j);
                    blocks.push(json!({ "change": "added", "after": block_md(&after.blocks[j]), "after_index": j, "by": authors.iter().map(|a| person(a)).collect::<Vec<_>>() }));
                }
            }
            similar::DiffTag::Replace => {
                let olds: Vec<usize> = old.collect();
                let news: Vec<usize> = new.collect();
                for k in 0..olds.len().max(news.len()) {
                    match (olds.get(k), news.get(k)) {
                        (Some(&i), Some(&j)) => {
                            let (mut parts, mut authors) = parts_of(j);
                            // A block rewritten as a new element has no shared text: show the old text as removed.
                            let shares_text = parts.iter().any(|p| p["op"] == "same" || p["op"] == "removed");
                            let old_text = before.blocks[i].plain_text();
                            if !shares_text && !old_text.is_empty() {
                                let by = first_ids.get(i).cloned().flatten().and_then(|id| deleter(&id));
                                if let Some(by) = &by
                                    && !authors.contains(by) {
                                        authors.push(by.clone());
                                    }
                                parts.insert(0, json!({ "op": "removed", "text": old_text, "by_uuid": by }));
                            }
                            let parts: Vec<Value> = parts
                                .into_iter()
                                .map(|mut p| {
                                    let by = p.get("by_uuid").and_then(Value::as_str).map(&person);
                                    p.as_object_mut().map(|m| m.remove("by_uuid"));
                                    if let Some(by) = by {
                                        p["by"] = by;
                                    }
                                    p
                                })
                                .collect();
                            blocks.push(json!({
                                "change": "changed",
                                "before_index": i,
                                "after_index": j,
                                "before": block_md(&before.blocks[i]),
                                "after": block_md(&after.blocks[j]),
                                "parts": parts,
                                "by": authors.iter().map(|a| person(a)).collect::<Vec<_>>(),
                            }));
                        }
                        (Some(&i), None) => {
                            let by = first_ids.get(i).cloned().flatten().and_then(|id| deleter(&id));
                            blocks.push(json!({ "change": "removed", "before": block_md(&before.blocks[i]), "before_index": i, "by": by.as_deref().map(person).into_iter().collect::<Vec<_>>() }));
                        }
                        (None, Some(&j)) => {
                            let (_, authors) = parts_of(j);
                            blocks.push(json!({ "change": "added", "after": block_md(&after.blocks[j]), "after_index": j, "by": authors.iter().map(|a| person(a)).collect::<Vec<_>>() }));
                        }
                        (None, None) => {}
                    }
                }
            }
        }
    }
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

/// Puts blocks `range` of `old` back into `current`: replacing what they turned into, or back
/// where they were if they were removed.
fn splice(current: &Doc, old: &Doc, range: std::ops::RangeInclusive<usize>) -> Doc {
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old.blocks, &current.blocks);
    let mut replace: Vec<(usize, Block)> = vec![];
    let mut insert: Vec<(usize, Block)> = vec![];
    for op in ops {
        let (tag, o, n) = op.as_tag_tuple();
        for k in o.clone() {
            if !range.contains(&k) {
                continue;
            }
            let offset = k - o.start;
            match tag {
                similar::DiffTag::Equal => {}
                similar::DiffTag::Replace if offset < n.len() => replace.push((n.start + offset, old.blocks[k].clone())),
                _ => insert.push((n.end, old.blocks[k].clone())),
            }
        }
    }
    let mut blocks = current.blocks.clone();
    for (at, block) in replace {
        blocks[at] = block;
    }
    // Insert removed blocks back, keeping their order.
    for (at, block) in insert.into_iter().rev() {
        blocks.insert(at.min(blocks.len()), block);
    }
    Doc::new(blocks)
}

pub async fn restore(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<RestoreBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(body.seq, doc.seq)?;
    let old = doc_at(&state, &id, body.seq).await?;
    if let Some([a, b]) = body.blocks
        && (a > b || b >= old.blocks.len()) {
            return Err(ApiError::invalid(format!("Version {} has blocks 0 to {}.", body.seq, old.blocks.len().saturating_sub(1))));
        }
    let ((), seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Restore, None, |y| {
        let current = ydoc::read_doc(y);
        let target = match body.blocks {
            None => old.clone(),
            Some([a, b]) => splice(&current, &old, a..=b),
        };
        ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &current, &target, &EditMode::default()));
        Ok(())
    })
    .await?;
    activity::record(&state, Some(&id), None, &caller.uuid, "version.restored", json!({ "seq": body.seq, "blocks": body.blocks, "new_seq": seq })).await?;
    Ok(Json(json!({ "seq": seq })))
}

#[derive(Deserialize)]
pub struct UndoBody {
    account: String,
    since: i64,
}

pub async fn undo_account(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>, Json(body): Json<UndoBody>) -> ApiResult<Json<Value>> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    check_seq(body.since, doc.seq)?;
    let account = accounts::by_public_id(&state, &body.account).await?;
    let clients: Vec<i64> = sqlx::query_scalar("select client_id from doc_clients where doc_id = $1 and author_uuid = $2")
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
        match rooms::edit_expecting(&state, &id, &caller.uuid, Origin::Undo, None, Some(latest), |y| {
            let current = ydoc::read_doc(y);
            ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &current, &target, &EditMode::default()));
            Ok(())
        })
        .await
        {
            Ok(((), seq)) => {
                activity::record(&state, Some(&id), None, &caller.uuid, "version.undone", json!({ "account": account.uuid, "since": body.since, "new_seq": seq })).await?;
                return Ok(Json(json!({ "seq": seq })));
            }
            Err(e) if e.code == "conflict" && e.message.contains("meanwhile") => continue,
            Err(e) => return Err(e),
        }
    }
    Err(ApiError::conflict("The doc kept changing; try again in a moment."))
}

// ------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------

pub async fn suggestions(State(state): State<AppState>, Auth(caller): Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::require_doc(&state, Some(&caller), &id, Role::Commenter).await?;
    let (doc, _) = rooms::read(&state, &id).await?;
    let list = doc.suggestions();
    let people = accounts::many(&state, &list.iter().map(|s| s.author.clone()).collect::<Vec<_>>()).await?;
    let items: Vec<Value> = list
        .into_iter()
        .map(|s| json!({ "id": s.id, "author": people.get(&s.author), "inserted": s.inserted, "deleted": s.deleted }))
        .collect();
    Ok(Json(json!({ "suggestions": items })))
}

pub async fn decide(State(state): State<AppState>, Auth(caller): Auth, Path((id, sid, action)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    let accept = match action.as_str() {
        "accept" => true,
        "reject" => false,
        _ => return Err(ApiError::not_found("This action")),
    };
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let (found, seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Review, None, |y| {
        let found = ydoc::with_txn(y, |txn, frag| ydoc::resolve_suggestion(txn, frag, &sid, accept));
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

pub async fn decide_all(State(state): State<AppState>, Auth(caller): Auth, Path((id, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let accept = match action.as_str() {
        "accept-all" => true,
        "reject-all" => false,
        _ => return Err(ApiError::not_found("This action")),
    };
    access::require_doc(&state, Some(&caller), &id, Role::Editor).await?;
    let (ids, seq) = rooms::edit(&state, &id, &caller.uuid, Origin::Review, None, |y| {
        let ids: Vec<String> = ydoc::read_doc(y).suggestions().into_iter().map(|s| s.id).collect();
        for sid in &ids {
            ydoc::with_txn(y, |txn, frag| ydoc::resolve_suggestion(txn, frag, sid, accept));
        }
        Ok(ids)
    })
    .await?;
    for sid in &ids {
        record_decision(&state, &id, sid, accept, &caller.uuid).await?;
    }
    Ok(Json(json!({ "seq": seq, "count": ids.len() })))
}

async fn record_decision(state: &AppState, doc_id: &str, sid: &str, accept: bool, by: &str) -> ApiResult<()> {
    let resolution = if accept { "accepted" } else { "rejected" };
    sqlx::query("update suggestions set resolution = $3, resolved_by = $4, resolved_at = now() where doc_id = $1 and id = $2")
        .bind(doc_id)
        .bind(sid)
        .bind(resolution)
        .bind(by)
        .execute(&state.db)
        .await?;
    activity::record(state, Some(doc_id), None, by, &format!("suggestion.{resolution}"), json!({ "suggestion": sid })).await?;
    Ok(())
}
