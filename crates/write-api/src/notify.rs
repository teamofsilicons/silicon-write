//! Which notification goes to whom (UNDERSTANDING.md, "Mentions and notifications"). Each one
//! carries enough for a Silicon to act straight away: the doc, the text the comment is on, and
//! the comment itself.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::access::DocRow;
use crate::accounts::{self, Account};
use crate::error::ApiResult;
use crate::state::AppState;
use crate::ting;

fn person(a: &Account) -> Value {
    json!({ "uuid": a.uuid, "id": a.id, "display_name": a.display_name, "kind": a.kind })
}

fn doc_data(state: &AppState, doc: &DocRow) -> Value {
    json!({ "id": doc.id, "title": doc.display_title(), "url": state.config.doc_url(&doc.id) })
}

/// `@c:id` and `@si:id` mentions in a comment.
pub fn mentions(body: &str) -> Vec<String> {
    let mut found = vec![];
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let rest: String = chars[i + 1..].iter().collect();
            for prefix in ["c:", "si:"] {
                if let Some(after) = rest.strip_prefix(prefix) {
                    let handle: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
                    let handle = handle.trim_end_matches(['-', '_']).to_lowercase();
                    if handle.len() >= 3 {
                        let id = format!("{prefix}{handle}");
                        if !found.contains(&id) {
                            found.push(id);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    found
}

/// A new comment (a new thread or a reply): mentions, the owner, and the thread's participants.
#[allow(clippy::too_many_arguments)]
pub async fn comment(
    state: &AppState,
    doc: &DocRow,
    thread_id: &str,
    comment_id: &str,
    author: &Account,
    body: &str,
    quote: &str,
    is_reply: bool,
) -> ApiResult<()> {
    let mut notified: HashSet<String> = HashSet::from([author.uuid.clone()]);
    let base = json!({
        "doc": doc_data(state, doc),
        "thread_id": thread_id,
        "comment_id": comment_id,
        "quote": quote,
        "comment": body,
        "by": person(author),
        "url": format!("{}?thread={}", state.config.doc_url(&doc.id), thread_id),
    });
    for id in mentions(body) {
        if let Ok(account) = accounts::by_public_id(state, &id).await
            && notified.insert(account.uuid.clone()) {
                // Only people who can open the doc hear about it.
                let caller = crate::auth::Caller { uuid: account.uuid.clone(), id: account.id.clone(), kind: account.kind.clone(), token: String::new() };
                if crate::access::doc_role(state, Some(&caller), doc).await?.is_some() {
                    ting::queue(state, "write.mention.received", &account.uuid, &format!("mention:{comment_id}:{}", account.uuid), base.clone()).await?;
                }
            }
    }
    if is_reply {
        let participants: Vec<String> = sqlx::query_scalar(
            "select distinct author_uuid from comments where thread_id = $1 and deleted_at is null",
        )
        .bind(thread_id)
        .fetch_all(&state.db)
        .await?;
        for uuid in participants {
            if notified.insert(uuid.clone()) {
                ting::queue(state, "write.comment.replied", &uuid, &format!("reply:{comment_id}:{uuid}"), base.clone()).await?;
            }
        }
    }
    if notified.insert(doc.owner_uuid.clone()) {
        ting::queue(state, "write.comment.created", &doc.owner_uuid, &format!("comment:{comment_id}:{}", doc.owner_uuid), base).await?;
    }
    Ok(())
}

pub async fn thread_resolved(state: &AppState, doc: &DocRow, thread_id: &str, starter: &str, resolver: &Account, quote: &str) -> ApiResult<()> {
    if starter == resolver.uuid {
        return Ok(());
    }
    let key = format!("resolved:{thread_id}:{}", time::OffsetDateTime::now_utc().unix_timestamp());
    ting::queue(
        state,
        "write.thread.resolved",
        starter,
        &key,
        json!({ "doc": doc_data(state, doc), "thread_id": thread_id, "quote": quote, "by": person(resolver) }),
    )
    .await?;
    Ok(())
}

pub async fn suggestion_created(state: &AppState, doc_id: &str, suggestion: &write_doc::SuggestionSummary, seq: i64) -> ApiResult<()> {
    let doc = crate::access::load_doc(state, doc_id).await?;
    if suggestion.author == doc.owner_uuid {
        return Ok(());
    }
    let author = accounts::one(state, &suggestion.author).await?;
    ting::queue(
        state,
        "write.suggestion.created",
        &doc.owner_uuid,
        &format!("suggestion:{doc_id}:{}", suggestion.id),
        json!({
            "doc": doc_data(state, &doc),
            "suggestion_id": suggestion.id,
            "inserted": suggestion.inserted,
            "deleted": suggestion.deleted,
            "by": person(&author),
            "seq": seq,
        }),
    )
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn shared(state: &AppState, kind: &str, item_id: &str, title: &str, url: &str, to: &str, by: &Account, role: &str) -> ApiResult<()> {
    if to == by.uuid {
        return Ok(());
    }
    ting::queue(
        state,
        "write.doc.shared",
        to,
        &format!("shared:{item_id}:{to}:{role}"),
        json!({ "kind": kind, "id": item_id, "title": title, "url": url, "role": role, "by": person(by) }),
    )
    .await?;
    Ok(())
}
