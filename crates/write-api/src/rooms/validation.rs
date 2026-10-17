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
                    .all(|(key, value)| attribute(&kind, key, &value))
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

fn nullable(value: &Any) -> bool {
    matches!(value, Any::Null | Any::Undefined)
}

fn string(value: &Any) -> bool {
    matches!(value, Any::String(_))
}

fn integer(value: &Any, min: i64, max: i64) -> bool {
    matches!(value, Any::Number(number) if number.as_i64().is_some_and(|n| n >= min && n <= max))
}

fn dimension(value: &Any) -> bool {
    nullable(value)
        || integer(value, 1, u32::MAX as i64)
        || matches!(value, Any::String(s) if s.parse::<u32>().is_ok_and(|n| n > 0))
}

fn alignment(value: &Any) -> bool {
    nullable(value)
        || matches!(value, Any::String(s) if matches!(s.as_ref(), "left" | "center" | "right" | "justify"))
}

fn attribute(tag: &str, key: &str, value: &Out) -> bool {
    let Out::Any(value) = value else { return false };
    if key == "suggestion" {
        return nullable(value) || suggestion(value, true);
    }
    match (tag, key) {
        (HEADING, "level") => integer(value, 1, 6),
        (ORDERED_LIST, "start") => integer(value, 0, u32::MAX as i64),
        (ORDERED_LIST, "type") => {
            nullable(value)
                || matches!(value, Any::String(s) if matches!(s.as_ref(), "1" | "a" | "A" | "i" | "I"))
        }
        (TASK_ITEM, "checked") => matches!(value, Any::Bool(_)),
        (CODE_BLOCK, "language") => nullable(value) || string(value),
        (IMAGE | INLINE_IMAGE, "src" | "alt" | "title") => nullable(value) || string(value),
        (IMAGE | INLINE_IMAGE, "width" | "height") => dimension(value),
        (INLINE_IMAGE, "link" | "linkTitle") => nullable(value) || string(value),
        (TABLE_CELL | TABLE_HEADER, "colspan" | "rowspan") => integer(value, 1, u32::MAX as i64),
        (TABLE_CELL | TABLE_HEADER, "colwidth") => {
            nullable(value)
                || matches!(value, Any::Array(widths) if !widths.is_empty() && widths.iter().all(|w| integer(w, 0, u32::MAX as i64)))
        }
        // The shared schema's textAlign is canonical. Tiptap also emits its unused align default.
        (TABLE_CELL | TABLE_HEADER, "textAlign") => alignment(value),
        (TABLE_CELL | TABLE_HEADER, "align") => nullable(value),
        (BLOCK_MATH | INLINE_MATH, "latex") | (FOOTNOTE, "content") | (DOC_LINK, "title") => {
            string(value)
        }
        (DOC_LINK, "alias") => nullable(value) || string(value),
        _ => false,
    }
}

fn suggestion(value: &Any, structural: bool) -> bool {
    let Any::Map(attrs) = value else { return false };
    let text = |key: &str| matches!(attrs.get(key), Some(Any::String(s)) if !s.is_empty());
    attrs
        .keys()
        .all(|key| matches!(key.as_str(), "id" | "author") || structural && key == "kind")
        && text("id")
        && text("author")
        && (!structural
            || matches!(attrs.get("kind"), Some(Any::String(s)) if s.as_ref() == "insert" || s.as_ref() == "delete"))
}

fn mark(name: &str, value: &Any) -> bool {
    let allowed: &[&str] = match name {
        SUGGESTION_INSERT | SUGGESTION_DELETE => {
            return nullable(value) || suggestion(value, false);
        }
        BOLD | ITALIC | UNDERLINE | STRIKE | CODE | SUBSCRIPT | SUPERSCRIPT => &[],
        LINK => &["href", "target", "rel", "class", "title"],
        TEXT_STYLE | HIGHLIGHT => &["color"],
        _ => return false,
    };
    if nullable(value) {
        return true;
    }
    let Any::Map(attrs) = value else { return false };
    attrs
        .iter()
        .all(|(key, value)| allowed.contains(&key.as_str()) && (nullable(value) || string(value)))
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

/// Older interrupted builds stored text proposals inside code blocks. Keep those unchanged,
/// but new code proposals use node attributes because the editor's code blocks have no marks.
pub(super) fn new_code_marks(before: &yrs::Doc, after: &yrs::Doc) -> bool {
    fn collect(doc: &yrs::Doc) -> HashMap<ID, yrs::types::Attrs> {
        fn walk<F: XmlFragment>(
            txn: &mut yrs::TransactionMut,
            parent: &F,
            shown: &Snapshot,
            empty: &Snapshot,
            code: bool,
            out: &mut HashMap<ID, yrs::types::Attrs>,
        ) {
            for child in parent.children(txn).collect::<Vec<_>>() {
                match child {
                    XmlOut::Element(el) => {
                        walk(txn, &el, shown, empty, el.tag().as_ref() == CODE_BLOCK, out)
                    }
                    XmlOut::Text(text) if code => {
                        for run in text.diff_range(txn, Some(shown), Some(empty), YChange::identity)
                        {
                            let (Some(change), Out::Any(Any::String(text)), Some(attrs)) =
                                (run.ychange, run.insert, run.attributes)
                            else {
                                continue;
                            };
                            if attrs.is_empty() {
                                continue;
                            }
                            let mut clock = change.id.clock;
                            for ch in text.chars() {
                                out.insert(ID::new(change.id.client, clock), (*attrs).clone());
                                clock += ch.len_utf16() as u32;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let fragment = ydoc::fragment(doc);
        let mut txn = doc.transact_mut();
        let shown = txn.snapshot();
        let empty = Snapshot::new(StateVector::default(), yrs::IdSet::default());
        let mut out = HashMap::new();
        walk(&mut txn, &fragment, &shown, &empty, false, &mut out);
        out
    }
    let old = collect(before);
    collect(after)
        .iter()
        .any(|(id, attrs)| old.get(id) != Some(attrs))
}

/// Browser formatting not represented in the semantic model must not let a commenter make
/// direct edits. Defaults are equivalent to absent attributes; a proposed insertion can carry
/// its own formatting, since rejecting that proposal removes the whole insertion.
pub(super) fn unmodeled_changes(before: &yrs::Doc, after: &yrs::Doc, author: &str) -> bool {
    fn collect(doc: &yrs::Doc, author: &str) -> HashMap<ID, HashMap<String, Any>> {
        fn walk<F: XmlFragment>(
            txn: &mut yrs::TransactionMut,
            parent: &F,
            shown: &Snapshot,
            empty: &Snapshot,
            author: &str,
            out: &mut HashMap<ID, HashMap<String, Any>>,
        ) {
            for child in parent.children(txn).collect::<Vec<_>>() {
                match child {
                    XmlOut::Element(el) => {
                        if let Some(Out::Any(value)) = el.get_attribute(txn, "suggestion")
                            && suggested(&value, "")
                                .is_some_and(|s| s.kind == "insert" && s.author == author)
                        {
                            continue;
                        }
                        let attrs: HashMap<String, Any> = el
                            .attributes(txn)
                            .filter_map(|(key, value)| {
                                let Out::Any(value) = value else { return None };
                                let ignored = matches!(
                                    (el.tag().as_ref(), key),
                                    (IMAGE | INLINE_IMAGE, "width" | "height")
                                        | (TABLE_CELL | TABLE_HEADER, "colwidth")
                                        | (ORDERED_LIST, "type")
                                );
                                (ignored && !nullable(&value)).then(|| (key.to_string(), value))
                            })
                            .collect();
                        if !attrs.is_empty()
                            && let Some(id) = branch_id(&el)
                        {
                            out.insert(id, attrs);
                        }
                        walk(txn, &el, shown, empty, author, out);
                    }
                    XmlOut::Text(text) => {
                        for run in text.diff_range(txn, Some(shown), Some(empty), YChange::identity)
                        {
                            let (Some(change), Out::Any(Any::String(text)), Some(attrs)) =
                                (run.ychange, run.insert, run.attributes)
                            else {
                                continue;
                            };
                            if attrs.iter().any(|(name, value)| {
                                name.split("--").next() == Some(SUGGESTION_INSERT)
                                    && suggested(value, "insert")
                                        .is_some_and(|s| s.author == author)
                            }) {
                                continue;
                            }
                            let mut ignored = HashMap::new();
                            for (name, value) in attrs.iter() {
                                if name.split("--").next() != Some(LINK) {
                                    continue;
                                }
                                let Any::Map(values) = value else { continue };
                                for key in ["target", "rel", "class"] {
                                    if let Some(value) = values.get(key)
                                        && !nullable(value)
                                    {
                                        let default = matches!((key, value), ("target", Any::String(s)) if s.as_ref() == "_blank")
                                            || matches!((key, value), ("rel", Any::String(s)) if s.as_ref() == "noopener noreferrer nofollow");
                                        if !default {
                                            ignored.insert(key.to_owned(), value.clone());
                                        }
                                    }
                                }
                            }
                            if !ignored.is_empty() {
                                let mut clock = change.id.clock;
                                for ch in text.chars() {
                                    out.insert(ID::new(change.id.client, clock), ignored.clone());
                                    clock += ch.len_utf16() as u32;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let fragment = ydoc::fragment(doc);
        let mut txn = doc.transact_mut();
        let shown = txn.snapshot();
        let empty = Snapshot::new(StateVector::default(), yrs::IdSet::default());
        let mut out = HashMap::new();
        walk(&mut txn, &fragment, &shown, &empty, author, &mut out);
        out
    }
    collect(before, author) != collect(after, author)
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

    fn clone_doc(doc: &yrs::Doc, client: u64) -> yrs::Doc {
        use yrs::updates::decoder::Decode;
        let copy = ydoc::new_ydoc(client);
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        copy.transact_mut()
            .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
            .unwrap();
        copy
    }

    fn proposal(author: &str) -> Any {
        Any::Map(std::sync::Arc::new(HashMap::from([
            ("id".into(), Any::String("s_proposal".into())),
            ("author".into(), Any::String(author.into())),
            ("kind".into(), Any::String("insert".into())),
        ])))
    }

    #[test]
    fn browser_defaults_and_structural_proposals_are_valid_but_wrong_values_are_not() {
        let doc = ydoc::new_ydoc(10);
        ydoc::with_txn(&doc, |txn, frag| {
            ydoc::write_all(
                txn,
                frag,
                &write_doc::from_markdown(
                    "# Heading\n\n1. item\n\n![picture](picture.png)\n\n|A|B|\n|-|-|\n|a|b|\n",
                ),
            );
            for child in frag.children(txn).collect::<Vec<_>>() {
                if let XmlOut::Element(el) = child {
                    el.insert_attribute(txn, "suggestion", proposal("author"));
                }
            }
        });
        assert!(validate(&doc).is_ok());
        for (tag, key, value) in [
            (ORDERED_LIST, "type", Any::Null),
            (TABLE_CELL, "align", Any::Null),
            (TABLE_HEADER, "textAlign", Any::String("center".into())),
            (INLINE_IMAGE, "width", Any::Null),
            (IMAGE, "width", Any::String("120".into())),
            (CODE_BLOCK, "language", Any::Null),
        ] {
            assert!(attribute(tag, key, &Out::Any(value)), "{tag}.{key}");
        }
        for (tag, key, value) in [
            (HEADING, "level", Any::from(999)),
            (HEADING, "level", Any::from(1.5)),
            (IMAGE, "src", Any::Map(Default::default())),
            (TABLE_CELL, "colspan", Any::from(0)),
            (TABLE_CELL, "colwidth", Any::String("100,100".into())),
            (TASK_ITEM, "checked", Any::String("true".into())),
            (TABLE_CELL, "textAlign", Any::String("broken".into())),
        ] {
            assert!(!attribute(tag, key, &Out::Any(value)), "{tag}.{key}");
        }
        assert!(!mark("unknown", &Any::Null));
        assert!(!mark(
            BOLD,
            &Any::Map(std::sync::Arc::new(HashMap::from([(
                "script".into(),
                Any::String("hidden".into())
            )])))
        ));
    }

    #[test]
    fn commenter_formatting_cannot_hide_outside_the_semantic_model() {
        let before = ydoc::new_ydoc(10);
        ydoc::with_txn(&before, |txn, frag| {
            ydoc::write_all(
                txn,
                frag,
                &write_doc::from_markdown("![picture](picture.png)\n"),
            )
        });
        let after = clone_doc(&before, 20);
        ydoc::with_txn(&after, |txn, frag| {
            let XmlOut::Element(image) = frag.get(txn, 0).unwrap() else {
                panic!()
            };
            image.insert_attribute(txn, "width", Any::from(120));
        });
        assert!(validate(&after).is_ok());
        assert_eq!(ydoc::read_doc(&before), ydoc::read_doc(&after));
        assert!(unmodeled_changes(&before, &after, "author"));
        let proposed = clone_doc(&before, 30);
        ydoc::with_txn(&proposed, |txn, frag| {
            let image = frag.insert(txn, 1, XmlElementPrelim::empty(IMAGE));
            image.insert_attribute(txn, "src", "proposed.png");
            image.insert_attribute(txn, "width", Any::from(120));
            image.insert_attribute(txn, "suggestion", proposal("author"));
        });
        assert!(validate(&proposed).is_ok());
        assert!(!unmodeled_changes(&before, &proposed, "author"));
    }

    #[test]
    fn structural_proposals_cannot_be_reused_to_forge_a_new_nodes_author() {
        let before = ydoc::new_ydoc(10);
        ydoc::with_txn(&before, |txn, frag| {
            let image = frag.insert(txn, 0, XmlElementPrelim::empty(IMAGE));
            image.insert_attribute(txn, "src", "picture.png");
            image.insert_attribute(txn, "suggestion", proposal("alice"));
        });
        let after = clone_doc(&before, 20);
        assert!(!foreign_suggestions(&before, &after, "bob"));
        ydoc::with_txn(&after, |txn, frag| {
            let image = frag.insert(txn, 1, XmlElementPrelim::empty(IMAGE));
            image.insert_attribute(txn, "src", "forged.png");
            image.insert_attribute(txn, "suggestion", proposal("alice"));
        });
        assert!(foreign_suggestions(&before, &after, "bob"));
    }

    #[test]
    fn legacy_code_suggestions_remain_but_new_code_text_marks_are_refused() {
        let before = ydoc::new_ydoc(10);
        ydoc::with_txn(&before, |txn, frag| {
            let code = frag.insert(txn, 0, XmlElementPrelim::empty(CODE_BLOCK));
            let text = code.insert(txn, 0, XmlTextPrelim::new("legacy"));
            let mut attrs = yrs::types::Attrs::new();
            let Any::Map(proposal) = proposal("author") else {
                panic!()
            };
            let mut proposal = (*proposal).clone();
            proposal.remove("kind");
            attrs.insert(
                SUGGESTION_INSERT.into(),
                Any::Map(std::sync::Arc::new(proposal)),
            );
            text.format(txn, 0, 6, attrs);
        });
        let after = clone_doc(&before, 20);
        assert!(!new_code_marks(&before, &after));
        ydoc::with_txn(&after, |txn, frag| {
            let XmlOut::Element(code) = frag.get(txn, 0).unwrap() else {
                panic!()
            };
            let XmlOut::Text(text) = code.get(txn, 0).unwrap() else {
                panic!()
            };
            text.insert(txn, 3, "new");
        });
        assert!(new_code_marks(&before, &after));
    }
}
