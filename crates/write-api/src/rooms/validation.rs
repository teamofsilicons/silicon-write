//! Checks the shared XML before accepting it. The semantic model intentionally ignores unknown
//! data; that must not let a live writer store content the editor cannot open or attribute.

use std::collections::HashMap;

use write_doc::model::names::*;
use write_doc::ydoc;
use yrs::types::text::YChange;
use yrs::{
    Any, BranchID, ID, Out, ReadTxn, Snapshot, StateVector, Text, Transact, Xml, XmlFragment,
    XmlOut,
};

use crate::error::{ApiError, ApiResult};

pub(super) fn validate(doc: &yrs::Doc) -> ApiResult<()> {
    let fragment = ydoc::fragment(doc);
    let txn = doc.transact();
    if txn.root_refs().any(|(name, _)| name != ydoc::FRAGMENT) || !children(&txn, &fragment, "doc")
    {
        return Err(ApiError::invalid(
            "That change contains content the editor can't read.",
        ));
    }
    Ok(())
}

fn block(tag: &str) -> bool {
    matches!(
        tag,
        PARAGRAPH
            | HEADING
            | BULLET_LIST
            | ORDERED_LIST
            | TASK_LIST
            | BLOCKQUOTE
            | CODE_BLOCK
            | HORIZONTAL_RULE
            | IMAGE
            | TABLE
            | BLOCK_MATH
            | TABLE_OF_CONTENTS
    )
}

fn children<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F, tag: &str) -> bool {
    parent.children(txn).all(|child| match child {
        XmlOut::Element(el) => {
            let kind = el.tag().to_string();
            let allowed = match tag {
                "doc" | BLOCKQUOTE | LIST_ITEM | TASK_ITEM | TABLE_CELL | TABLE_HEADER => {
                    block(&kind)
                }
                PARAGRAPH | HEADING => matches!(
                    kind.as_str(),
                    HARD_BREAK | INLINE_MATH | FOOTNOTE | DOC_LINK | INLINE_IMAGE
                ),
                BULLET_LIST | ORDERED_LIST => kind == LIST_ITEM,
                TASK_LIST => kind == TASK_ITEM,
                TABLE => kind == TABLE_ROW,
                TABLE_ROW => matches!(kind.as_str(), TABLE_CELL | TABLE_HEADER),
                _ => false,
            };
            allowed
                && el
                    .attributes(txn)
                    .all(|(key, value)| attribute(&kind, key.as_ref(), &value))
                && children(txn, &el, &kind)
        }
        XmlOut::Text(text) if matches!(tag, PARAGRAPH | HEADING | CODE_BLOCK) => {
            text.diff(txn, YChange::identity).iter().all(|run| {
                matches!(run.insert, Out::Any(Any::String(_)))
                    && run.attributes.as_ref().is_none_or(|attrs| {
                        attrs.iter().all(|(name, value)| {
                            let name = name.split("--").next().unwrap_or(name);
                            (tag != CODE_BLOCK
                                || matches!(name, SUGGESTION_INSERT | SUGGESTION_DELETE))
                                && mark(name, value)
                        })
                    })
            })
        }
        _ => false,
    })
}

fn attribute(tag: &str, key: &str, value: &Out) -> bool {
    let Out::Any(value) = value else { return false };
    if key == "suggestion" {
        return matches!(value, Any::Null | Any::Undefined) || suggestion(value, true);
    }
    let allowed: &[&str] = match tag {
        HEADING => &["level"],
        ORDERED_LIST => &["start"],
        TASK_ITEM => &["checked"],
        CODE_BLOCK => &["language"],
        IMAGE => &["src", "alt", "title", "width", "height"],
        INLINE_IMAGE => &["src", "alt", "title", "link", "linkTitle"],
        TABLE_CELL | TABLE_HEADER => &["colspan", "rowspan", "colwidth", "textAlign"],
        BLOCK_MATH | INLINE_MATH => &["latex"],
        FOOTNOTE => &["content"],
        DOC_LINK => &["title", "alias"],
        _ => &[],
    };
    allowed.contains(&key)
}

fn suggestion(value: &Any, structural: bool) -> bool {
    let Any::Map(attrs) = value else { return false };
    let text = |key: &str| matches!(attrs.get(key), Some(Any::String(s)) if !s.is_empty());
    text("id")
        && text("author")
        && (!structural
            || matches!(attrs.get("kind"), Some(Any::String(s)) if s.as_ref() == "insert" || s.as_ref() == "delete"))
}

fn mark(name: &str, value: &Any) -> bool {
    if matches!(value, Any::Null | Any::Undefined) {
        return true;
    }
    if matches!(name, SUGGESTION_INSERT | SUGGESTION_DELETE) {
        return suggestion(value, false);
    }
    matches!(
        name,
        BOLD | ITALIC
            | UNDERLINE
            | STRIKE
            | CODE
            | SUBSCRIPT
            | SUPERSCRIPT
            | LINK
            | TEXT_STYLE
            | HIGHLIGHT
    ) && matches!(value, Any::Map(_))
}

#[derive(Clone, PartialEq, Eq)]
struct Suggestion {
    id: String,
    author: String,
    kind: String,
}

fn suggested(value: &Any, kind: &str) -> Option<Suggestion> {
    let Any::Map(attrs) = value else { return None };
    let string = |key: &str| match attrs.get(key) {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    };
    Some(Suggestion {
        id: string("id")?,
        author: string("author")?,
        kind: if kind.is_empty() {
            string("kind")?
        } else {
            kind.into()
        },
    })
}

fn branch_id<B: AsRef<yrs::branch::Branch>>(branch: &B) -> Option<ID> {
    match branch.as_ref().id() {
        BranchID::Nested(id) => Some(id),
        _ => None,
    }
}

/// The characters and structural nodes carrying a suggestion, retaining their Yjs identity.
struct Suggested {
    texts: Vec<Vec<(ID, Option<Suggestion>)>>,
    nodes: HashMap<ID, Suggestion>,
}

fn suggestions(doc: &yrs::Doc) -> Suggested {
    fn walk<F: XmlFragment>(
        txn: &mut yrs::TransactionMut,
        parent: &F,
        shown: &Snapshot,
        empty: &Snapshot,
        out: &mut Suggested,
    ) {
        for child in parent.children(txn).collect::<Vec<_>>() {
            match child {
                XmlOut::Element(el) => {
                    if let Some(Out::Any(value)) = el.get_attribute(txn, "suggestion")
                        && let (Some(id), Some(suggestion)) =
                            (branch_id(&el), suggested(&value, ""))
                    {
                        out.nodes.insert(id, suggestion);
                    }
                    walk(txn, &el, shown, empty, out);
                }
                XmlOut::Text(text) => {
                    let mut characters = vec![];
                    for run in text.diff_range(txn, Some(shown), Some(empty), YChange::identity) {
                        let (Some(change), Out::Any(Any::String(text))) = (run.ychange, run.insert)
                        else {
                            continue;
                        };
                        let suggestion = run.attributes.as_ref().and_then(|attrs| {
                            attrs.iter().find_map(|(key, value)| {
                                match key.split("--").next().unwrap_or(key) {
                                    SUGGESTION_INSERT => suggested(value, "insert"),
                                    SUGGESTION_DELETE => suggested(value, "delete"),
                                    _ => None,
                                }
                            })
                        });
                        let mut clock = change.id.clock;
                        for ch in text.chars() {
                            characters.push((ID::new(change.id.client, clock), suggestion.clone()));
                            clock += ch.len_utf16() as u32;
                        }
                    }
                    out.texts.push(characters);
                }
                _ => {}
            }
        }
    }
    let fragment = ydoc::fragment(doc);
    let mut txn = doc.transact_mut();
    let shown = txn.snapshot();
    let empty = Snapshot::new(StateVector::default(), yrs::IdSet::default());
    let mut out = Suggested {
        texts: vec![],
        nodes: HashMap::new(),
    };
    walk(&mut txn, &fragment, &shown, &empty, &mut out);
    out
}

/// Editors may type into an existing suggestion, inheriting its mark. Reusing that mark in a
/// separate passage, or marking existing unrelated characters with it, is a new false attribution.
pub(super) fn foreign_suggestions(before: &yrs::Doc, after: &yrs::Doc, author: &str) -> bool {
    let old = suggestions(before);
    let old_chars: HashMap<ID, Option<Suggestion>> = old.texts.into_iter().flatten().collect();
    let after = suggestions(after);
    if after.nodes.iter().any(|(id, suggestion)| {
        suggestion.author != author && old.nodes.get(id) != Some(suggestion)
    }) {
        return true;
    }
    for characters in after.texts {
        let mut at = 0;
        while at < characters.len() {
            let suggestion = characters[at].1.as_ref();
            let end = characters[at..]
                .iter()
                .position(|(_, s)| s.as_ref() != suggestion)
                .map(|n| at + n)
                .unwrap_or(characters.len());
            if let Some(suggestion) = suggestion.filter(|s| s.author != author) {
                let mut anchored = false;
                for (id, _) in &characters[at..end] {
                    if let Some(old) = old_chars.get(id) {
                        if old.as_ref() != Some(suggestion) {
                            return true;
                        }
                        anchored = true;
                    }
                }
                if !anchored {
                    return true;
                }
            }
            at = end;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{XmlElementPrelim, XmlTextPrelim};

    #[test]
    fn unknown_content_is_rejected_even_when_the_model_ignores_it() {
        let doc = ydoc::new_ydoc(10);
        ydoc::with_txn(&doc, |txn, frag| {
            ydoc::write_all(txn, frag, &write_doc::from_markdown("Known text.\n"))
        });
        assert!(validate(&doc).is_ok());
        let before = ydoc::read_doc(&doc);
        ydoc::with_txn(&doc, |txn, frag| {
            frag.insert(txn, 1, XmlElementPrelim::empty("unrecognized"));
        });
        assert_eq!(ydoc::read_doc(&doc), before);
        assert!(validate(&doc).is_err());
    }

    #[test]
    fn another_root_or_stray_text_is_rejected() {
        let doc = ydoc::new_ydoc(10);
        ydoc::with_txn(&doc, |txn, frag| {
            frag.insert(txn, 0, XmlTextPrelim::new("stray"));
        });
        assert!(validate(&doc).is_err());
        let doc = ydoc::new_ydoc(20);
        doc.get_or_insert_text("elsewhere")
            .insert(&mut doc.transact_mut(), 0, "hidden");
        assert!(validate(&doc).is_err());
    }
}
