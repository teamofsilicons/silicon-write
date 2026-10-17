//! The live form of a doc: a Yjs document, stored exactly the way the web editor's Yjs binding
//! (y-prosemirror, through Tiptap) stores a ProseMirror document.
//!
//! - The doc is the XML fragment named [`FRAGMENT`]. Every block is an XML element named after its
//!   node type, with the node's attributes as element attributes (left out when null).
//! - Runs of text are XML text with the marks as formatting attributes: the mark name, with the
//!   mark's attributes as an object (`{}` for marks without attributes).
//! - Inline nodes that aren't text (a hard break, maths, a footnote, a doc link) are XML elements
//!   between the texts.
//!
//! Server edits never replace a doc wholesale: [`patch`] turns a new version of the doc into the
//! smallest set of edits against the live structure, so concurrent edits merge, comment anchors
//! stay on their text, and the history shows exactly what changed.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::types::text::{Diff, YChange};
use yrs::types::{Attrs, Delta};
use yrs::types::GetString;
use yrs::{
    Any, ClientID, Doc as YDoc, Number, OffsetKind, Options, ReadTxn, Snapshot, StateVector, Text, Transact,
    TransactionMut, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut,
    XmlTextPrelim, XmlTextRef,
};

use crate::model::names::*;
use crate::model::*;

/// The editor's fragment name (Tiptap's Collaboration extension default).
pub const FRAGMENT: &str = "default";

/// A new live doc. History is never garbage collected: deleted text stays in the structure, which
/// is what versions, comparisons and per-author undo read.
pub fn new_ydoc(client_id: u64) -> YDoc {
    YDoc::with_options(Options {
        client_id: ClientID::new(client_id),
        skip_gc: true,
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub fn fragment(doc: &YDoc) -> XmlFragmentRef {
    doc.get_or_insert_xml_fragment(FRAGMENT)
}

/// Reads the whole doc.
pub fn read<T: ReadTxn>(txn: &T, frag: &XmlFragmentRef) -> Doc {
    let mut doc = Doc {
        blocks: read_children(txn, frag),
    };
    if doc.blocks.is_empty() {
        doc.blocks.push(Block::empty_paragraph());
    }
    doc
}

/// Reads a whole live doc from its document.
pub fn read_doc(ydoc: &YDoc) -> Doc {
    let frag = fragment(ydoc);
    let txn = ydoc.transact();
    read(&txn, &frag)
}

fn read_children<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Vec<Block> {
    parent
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(el) => read_block(txn, &el),
            _ => None,
        })
        .collect()
}

fn attr_string<T: ReadTxn>(txn: &T, el: &XmlElementRef, key: &str) -> Option<String> {
    match el.get_attribute(txn, key)? {
        yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
        yrs::Out::Any(Any::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn attr_number<T: ReadTxn>(txn: &T, el: &XmlElementRef, key: &str) -> Option<i64> {
    match el.get_attribute(txn, key)? {
        yrs::Out::Any(Any::Number(n)) => n.as_i64(),
        yrs::Out::Any(Any::String(s)) => s.parse().ok(),
        _ => None,
    }
}

fn attr_bool<T: ReadTxn>(txn: &T, el: &XmlElementRef, key: &str) -> bool {
    matches!(el.get_attribute(txn, key), Some(yrs::Out::Any(Any::Bool(true))))
}

fn read_block<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Option<Block> {
    let tag = el.tag().to_string();
    Some(match tag.as_str() {
        PARAGRAPH => Block::Paragraph {
            content: read_inline(txn, el),
        },
        HEADING => Block::Heading {
            level: attr_number(txn, el, "level").unwrap_or(1).clamp(1, 6) as u8,
            content: read_inline(txn, el),
        },
        BULLET_LIST => Block::BulletList {
            items: read_list_items(txn, el),
        },
        ORDERED_LIST => Block::OrderedList {
            start: attr_number(txn, el, "start").unwrap_or(1).max(0) as u32,
            items: read_list_items(txn, el),
        },
        TASK_LIST => Block::TaskList {
            items: el
                .children(txn)
                .filter_map(|c| match c {
                    XmlOut::Element(item) => Some(TaskItem {
                        checked: attr_bool(txn, &item, "checked"),
                        blocks: read_children(txn, &item),
                    }),
                    _ => None,
                })
                .collect(),
        },
        BLOCKQUOTE => Block::Blockquote {
            blocks: read_children(txn, el),
        },
        CODE_BLOCK => Block::CodeBlock {
            language: attr_string(txn, el, "language").filter(|l| !l.is_empty()),
            text: el
                .children(txn)
                .filter_map(|c| match c {
                    XmlOut::Text(t) => Some(plain(txn, &t)),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        },
        HORIZONTAL_RULE => Block::HorizontalRule,
        IMAGE => Block::Image {
            src: attr_string(txn, el, "src").unwrap_or_default(),
            alt: attr_string(txn, el, "alt"),
            title: attr_string(txn, el, "title"),
        },
        TABLE => Block::Table {
            rows: el
                .children(txn)
                .filter_map(|row| match row {
                    XmlOut::Element(row) => Some(TableRow {
                        cells: row
                            .children(txn)
                            .filter_map(|cell| match cell {
                                XmlOut::Element(cell) => Some(TableCell {
                                    header: cell.tag().as_ref() == TABLE_HEADER,
                                    colspan: attr_number(txn, &cell, "colspan").unwrap_or(1).max(1)
                                        as u32,
                                    rowspan: attr_number(txn, &cell, "rowspan").unwrap_or(1).max(1)
                                        as u32,
                                    blocks: read_children(txn, &cell),
                                }),
                                _ => None,
                            })
                            .collect(),
                    }),
                    _ => None,
                })
                .collect(),
        },
        BLOCK_MATH => Block::BlockMath {
            latex: attr_string(txn, el, "latex").unwrap_or_default(),
        },
        TABLE_OF_CONTENTS => Block::TableOfContents,
        _ => return None,
    })
}

fn read_list_items<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Vec<ListItem> {
    el.children(txn)
        .filter_map(|c| match c {
            XmlOut::Element(item) => Some(ListItem {
                blocks: read_children(txn, &item),
            }),
            _ => None,
        })
        .collect()
}

fn read_inline<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Vec<Inline> {
    let mut out = vec![];
    for child in el.children(txn) {
        match child {
            XmlOut::Text(text) => {
                for (chunk, marks) in text_runs(txn, &text) {
                    out.push(Inline::Text { text: chunk, marks });
                }
            }
            XmlOut::Element(atom) => {
                if let Some(inline) = read_atom(txn, &atom) {
                    out.push(inline);
                }
            }
            _ => {}
        }
    }
    normalize_inlines(out)
}

fn read_atom<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Option<Inline> {
    Some(match el.tag().as_ref() {
        HARD_BREAK => Inline::HardBreak,
        INLINE_MATH => Inline::InlineMath {
            latex: attr_string(txn, el, "latex").unwrap_or_default(),
        },
        FOOTNOTE => Inline::Footnote {
            content: attr_string(txn, el, "content").unwrap_or_default(),
        },
        DOC_LINK => Inline::DocLink {
            title: attr_string(txn, el, "title").unwrap_or_default(),
        },
        _ => return None,
    })
}

/// The plain text of an XML text (`get_string` would render its formatting as XML tags).
pub fn plain<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> String {
    text_runs(txn, text).into_iter().map(|(s, _)| s).collect()
}

/// The runs of an XML text, with their marks.
pub fn text_runs<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> Vec<(String, Marks)> {
    text.diff(txn, YChange::identity)
        .into_iter()
        .filter_map(|d: Diff<YChange>| match d.insert {
            yrs::Out::Any(Any::String(s)) => Some((s.to_string(), attrs_to_marks(d.attributes.as_deref()))),
            _ => None,
        })
        .collect()
}

fn map_get<'a>(value: &'a Any, key: &str) -> Option<&'a Any> {
    match value {
        Any::Map(map) => map.get(key),
        _ => None,
    }
}

fn any_str(value: Option<&Any>) -> Option<String> {
    match value? {
        Any::String(s) => Some(s.to_string()),
        _ => None,
    }
}

pub fn attrs_to_marks(attrs: Option<&Attrs>) -> Marks {
    let mut marks = Marks::default();
    let Some(raw) = attrs else {
        return marks;
    };
    // y-prosemirror names a mark that may overlap itself `name--hash`; read it by its name.
    let attrs: Attrs = raw
        .iter()
        .map(|(k, v)| (Arc::from(k.split("--").next().unwrap_or(k)), v.clone()))
        .collect();
    let attrs = &attrs;
    let present = |key: &str| attrs.get(key).is_some_and(|v| !matches!(v, Any::Null | Any::Undefined));
    marks.bold = present(BOLD);
    marks.italic = present(ITALIC);
    marks.underline = present(UNDERLINE);
    marks.strike = present(STRIKE);
    marks.code = present(CODE);
    if let Some(link) = attrs.get(LINK).filter(|v| !matches!(v, Any::Null | Any::Undefined)) {
        marks.link = Some(any_str(map_get(link, "href")).unwrap_or_default());
    }
    if let Some(style) = attrs.get(TEXT_STYLE) {
        marks.color = any_str(map_get(style, "color"));
    }
    if let Some(hl) = attrs.get(HIGHLIGHT).filter(|v| !matches!(v, Any::Null | Any::Undefined)) {
        marks.highlight = Some(any_str(map_get(hl, "color")));
    }
    for (key, kind) in [
        (SUGGESTION_INSERT, SuggestionKind::Insert),
        (SUGGESTION_DELETE, SuggestionKind::Delete),
    ] {
        if let Some(value) = attrs.get(key).filter(|v| !matches!(v, Any::Null | Any::Undefined)) {
            marks.suggestion = Some(Suggestion {
                kind,
                id: any_str(map_get(value, "id")).unwrap_or_default(),
                author: any_str(map_get(value, "author")).unwrap_or_default(),
            });
        }
    }
    marks
}

fn obj(entries: &[(&str, Any)]) -> Any {
    let map: HashMap<String, Any> = entries
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Any::Map(Arc::new(map))
}

fn empty_obj() -> Any {
    Any::Map(Arc::new(HashMap::new()))
}

/// The formatting attributes for a set of marks.
pub fn marks_to_attrs(marks: &Marks) -> Attrs {
    let mut attrs = Attrs::new();
    let mut set = |key: &str, value: Any| {
        attrs.insert(Arc::from(key), value);
    };
    if marks.bold {
        set(BOLD, empty_obj());
    }
    if marks.italic {
        set(ITALIC, empty_obj());
    }
    if marks.underline {
        set(UNDERLINE, empty_obj());
    }
    if marks.strike {
        set(STRIKE, empty_obj());
    }
    if marks.code {
        set(CODE, empty_obj());
    }
    if let Some(href) = &marks.link {
        set(LINK, obj(&[("href", Any::String(Arc::from(href.as_str())))]));
    }
    if let Some(color) = &marks.color {
        set(TEXT_STYLE, obj(&[("color", Any::String(Arc::from(color.as_str())))]));
    }
    if let Some(color) = &marks.highlight {
        let color = match color {
            Some(c) => Any::String(Arc::from(c.as_str())),
            None => Any::Null,
        };
        set(HIGHLIGHT, obj(&[("color", color)]));
    }
    if let Some(s) = &marks.suggestion {
        let key = match s.kind {
            SuggestionKind::Insert => SUGGESTION_INSERT,
            SuggestionKind::Delete => SUGGESTION_DELETE,
        };
        set(
            key,
            obj(&[
                ("id", Any::String(Arc::from(s.id.as_str()))),
                ("author", Any::String(Arc::from(s.author.as_str()))),
            ]),
        );
    }
    attrs
}

/// The formatting change from `old` to `new` marks, leaving any suggestion mark alone.
fn mark_change(old: &Marks, new: &Marks) -> Attrs {
    let old = old.without_suggestion();
    let new = new.without_suggestion();
    let old_attrs = marks_to_attrs(&old);
    let mut new_attrs = marks_to_attrs(&new);
    for key in old_attrs.keys() {
        if !new_attrs.contains_key(key) {
            new_attrs.insert(key.clone(), Any::Null);
        }
    }
    new_attrs.retain(|key, value| old_attrs.get(key) != Some(value));
    new_attrs
}

// ------------------------------------------------------------------------------------------
// Writing
// ------------------------------------------------------------------------------------------

/// Replaces the whole content of the fragment with `doc` (for a brand-new live doc).
pub fn write_all(txn: &mut TransactionMut, frag: &XmlFragmentRef, doc: &Doc) {
    let len = frag.len(txn);
    if len > 0 {
        frag.remove_range(txn, 0, len);
    }
    for (i, block) in doc.blocks.iter().enumerate() {
        insert_block(txn, frag, i as u32, block, None);
    }
}

fn set_attr(txn: &mut TransactionMut, el: &XmlElementRef, key: &str, value: Any) {
    el.insert_attribute(txn, key, value);
}

fn num(n: impl Into<i64>) -> Any {
    Any::Number(Number::Int(n.into()))
}

fn string(s: &str) -> Any {
    Any::String(Arc::from(s))
}

/// Options for edits made on someone's behalf.
#[derive(Debug, Clone, Default)]
pub struct EditMode {
    /// Make the edit as a suggestion with this id, by this account.
    pub suggest: Option<(String, String)>,
}

impl EditMode {
    fn inserted_marks(&self, marks: &Marks) -> Marks {
        match &self.suggest {
            Some((id, author)) => Marks {
                suggestion: Some(Suggestion {
                    kind: SuggestionKind::Insert,
                    id: id.clone(),
                    author: author.clone(),
                }),
                ..marks.clone()
            },
            None => marks.clone(),
        }
    }
}

fn insert_block<F: XmlFragment>(
    txn: &mut TransactionMut,
    parent: &F,
    index: u32,
    block: &Block,
    mode: Option<&EditMode>,
) -> XmlElementRef {
    let el = parent.insert(txn, index, XmlElementPrelim::empty(block.type_name()));
    fill_block(txn, &el, block, mode);
    el
}

fn fill_block(txn: &mut TransactionMut, el: &XmlElementRef, block: &Block, mode: Option<&EditMode>) {
    match block {
        Block::Paragraph { content } => write_inline(txn, el, content, mode),
        Block::Heading { level, content } => {
            set_attr(txn, el, "level", num(*level));
            write_inline(txn, el, content, mode);
        }
        Block::BulletList { items } => {
            for (i, item) in items.iter().enumerate() {
                let li = el.insert(txn, i as u32, XmlElementPrelim::empty(LIST_ITEM));
                write_children(txn, &li, &item.blocks, mode);
            }
        }
        Block::OrderedList { start, items } => {
            set_attr(txn, el, "start", num(*start));
            for (i, item) in items.iter().enumerate() {
                let li = el.insert(txn, i as u32, XmlElementPrelim::empty(LIST_ITEM));
                write_children(txn, &li, &item.blocks, mode);
            }
        }
        Block::TaskList { items } => {
            for (i, item) in items.iter().enumerate() {
                let li = el.insert(txn, i as u32, XmlElementPrelim::empty(TASK_ITEM));
                set_attr(txn, &li, "checked", Any::Bool(item.checked));
                write_children(txn, &li, &item.blocks, mode);
            }
        }
        Block::Blockquote { blocks } => write_children(txn, el, blocks, mode),
        Block::CodeBlock { language, text } => {
            if let Some(language) = language {
                set_attr(txn, el, "language", string(language));
            }
            let t = el.insert(txn, 0, XmlTextPrelim::new(""));
            if !text.is_empty() {
                let marks = mode.map(|m| m.inserted_marks(&Marks::default())).unwrap_or_default();
                t.insert_with_attributes(txn, 0, text, marks_to_attrs(&marks));
            }
        }
        Block::HorizontalRule | Block::TableOfContents => {}
        Block::Image { src, alt, title } => {
            set_attr(txn, el, "src", string(src));
            if let Some(alt) = alt {
                set_attr(txn, el, "alt", string(alt));
            }
            if let Some(title) = title {
                set_attr(txn, el, "title", string(title));
            }
        }
        Block::Table { rows } => {
            for (r, row) in rows.iter().enumerate() {
                let tr = el.insert(txn, r as u32, XmlElementPrelim::empty(TABLE_ROW));
                for (c, cell) in row.cells.iter().enumerate() {
                    let tag = if cell.header { TABLE_HEADER } else { TABLE_CELL };
                    let td = tr.insert(txn, c as u32, XmlElementPrelim::empty(tag));
                    set_attr(txn, &td, "colspan", num(cell.colspan));
                    set_attr(txn, &td, "rowspan", num(cell.rowspan));
                    write_children(txn, &td, &cell.blocks, mode);
                }
            }
        }
        Block::BlockMath { latex } => set_attr(txn, el, "latex", string(latex)),
    }
}

fn write_children(txn: &mut TransactionMut, el: &XmlElementRef, blocks: &[Block], mode: Option<&EditMode>) {
    for (i, block) in blocks.iter().enumerate() {
        insert_block(txn, el, i as u32, block, mode);
    }
}

/// Writes inline content at the end of an element: text runs into XML texts, other inline nodes
/// as elements between them.
fn write_inline(txn: &mut TransactionMut, el: &XmlElementRef, content: &[Inline], mode: Option<&EditMode>) {
    let mut index = el.len(txn);
    let mut current: Option<(XmlTextRef, u32)> = None;
    for inline in content {
        match inline {
            Inline::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                let (t, len) = match current.take() {
                    Some(open) => open,
                    None => {
                        let t = el.insert(txn, index, XmlTextPrelim::new(""));
                        index += 1;
                        (t, 0)
                    }
                };
                let marks = mode.map(|m| m.inserted_marks(marks)).unwrap_or_else(|| marks.clone());
                t.insert_with_attributes(txn, len, text, marks_to_attrs(&marks));
                current = Some((t, len + utf16_len(text)));
            }
            atom => {
                current = None;
                let atom_el = el.insert(txn, index, XmlElementPrelim::empty(atom.atom_name().unwrap()));
                index += 1;
                write_atom_attrs(txn, &atom_el, atom);
            }
        }
    }
}

fn write_atom_attrs(txn: &mut TransactionMut, el: &XmlElementRef, atom: &Inline) {
    match atom {
        Inline::InlineMath { latex } => set_attr(txn, el, "latex", string(latex)),
        Inline::Footnote { content } => set_attr(txn, el, "content", string(content)),
        Inline::DocLink { title } => set_attr(txn, el, "title", string(title)),
        _ => {}
    }
}

pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

// ------------------------------------------------------------------------------------------
// Patching
// ------------------------------------------------------------------------------------------

/// Edits the live doc so it reads as `new`.
///
/// `base` is the doc as the editor of `new` saw it: when `new` came from Markdown, `base` is that
/// Markdown read back (so whitespace Markdown can't keep doesn't count as a change). Blocks equal in
/// `base` and `new` are left untouched; changed blocks are edited in place, down to the
/// characters that changed.
pub fn patch(txn: &mut TransactionMut, frag: &XmlFragmentRef, base: &Doc, new: &Doc, mode: &EditMode) {
    patch_children(txn, frag, &base.blocks, &new.blocks, mode);
    // The editor's doc always has at least one block.
    if frag.len(txn) == 0 {
        insert_block(txn, frag, 0, &Block::empty_paragraph(), None);
    }
}

/// The live children of a container: each element with its block.
fn live_blocks<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Vec<(u32, XmlElementRef, Block)> {
    let mut out = vec![];
    for (i, child) in parent.children(txn).enumerate() {
        if let XmlOut::Element(el) = child {
            if let Some(block) = read_block(txn, &el) {
                out.push((i as u32, el, block));
            }
        }
    }
    out
}

fn patch_children<F: XmlFragment>(
    txn: &mut TransactionMut,
    parent: &F,
    base: &[Block],
    new: &[Block],
    mode: &EditMode,
) {
    let live = live_blocks(txn, parent);
    // Markdown has no empty paragraphs, so `base` has none either: line the live blocks up with
    // `base` by skipping them. When that doesn't line up, compare against the live blocks.
    let visible: Vec<usize> = live
        .iter()
        .enumerate()
        .filter(|(_, (_, _, b))| !b.is_empty_paragraph())
        .map(|(i, _)| i)
        .collect();
    let lined_up = visible.len() == base.len()
        && visible
            .iter()
            .zip(base)
            .all(|(&i, b)| std::mem::discriminant(&live[i].2) == std::mem::discriminant(b));
    let (base_blocks, map): (Vec<Block>, Vec<usize>) = if lined_up {
        (base.to_vec(), visible)
    } else {
        (
            live.iter().map(|(_, _, b)| b.clone()).collect(),
            (0..live.len()).collect(),
        )
    };

    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &base_blocks, new);
    // Apply from the end so earlier positions stay valid.
    for op in ops.iter().rev() {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        match tag {
            similar::DiffTag::Equal => {}
            similar::DiffTag::Delete => {
                for i in old_range.rev() {
                    delete_live(txn, parent, &live[map[i]], mode);
                }
            }
            similar::DiffTag::Insert => {
                let at = insert_position(txn, parent, &live, &map, old_range.start);
                for (k, block) in new[new_range].iter().enumerate() {
                    insert_block(txn, parent, at + k as u32, block, Some(mode));
                }
            }
            similar::DiffTag::Replace => {
                let olds: Vec<usize> = old_range.clone().collect();
                let news: Vec<usize> = new_range.clone().collect();
                let paired = olds.len().min(news.len());
                // Extra new blocks go after the paired ones; extra old ones are removed.
                if news.len() > paired {
                    let after_index = live[map[olds[paired - 1]]].0 + 1;
                    for (k, j) in news[paired..].iter().enumerate() {
                        insert_block(txn, parent, after_index + k as u32, &new[*j], Some(mode));
                    }
                }
                for i in olds[paired..].iter().rev() {
                    delete_live(txn, parent, &live[map[*i]], mode);
                }
                for k in (0..paired).rev() {
                    let (index, el, exact) = &live[map[olds[k]]];
                    let target = &new[news[k]];
                    if !patch_block(txn, el, exact, &base_blocks[olds[k]], target, mode) {
                        // Different kinds of block: replace it.
                        insert_block(txn, parent, *index + 1, target, Some(mode));
                        delete_live(txn, parent, &live[map[olds[k]]], mode);
                    }
                }
            }
        }
    }
}

fn insert_position<F: XmlFragment>(
    txn: &TransactionMut,
    parent: &F,
    live: &[(u32, XmlElementRef, Block)],
    map: &[usize],
    base_index: usize,
) -> u32 {
    if base_index < map.len() {
        live[map[base_index]].0
    } else if let Some(last) = map.last() {
        live[*last].0 + 1
    } else {
        parent.len(txn)
    }
}

fn delete_live<F: XmlFragment>(
    txn: &mut TransactionMut,
    parent: &F,
    (index, el, _): &(u32, XmlElementRef, Block),
    mode: &EditMode,
) {
    match &mode.suggest {
        Some((id, author)) => suggest_delete_all(txn, el, id, author),
        None => {
            // Find the element's current index (earlier deletions may have moved it).
            let mut current = *index;
            for (i, child) in parent.children(txn).enumerate() {
                if let XmlOut::Element(c) = child {
                    if c == *el {
                        current = i as u32;
                        break;
                    }
                }
            }
            parent.remove_range(txn, current, 1);
        }
    }
}

/// Marks every character in an element as suggested for deletion.
fn suggest_delete_all(txn: &mut TransactionMut, el: &XmlElementRef, id: &str, author: &str) {
    let texts = all_texts(txn, el);
    for text in texts {
        let runs = text_runs(txn, &text);
        let mut pos = 0;
        for (chunk, marks) in runs {
            let len = utf16_len(&chunk);
            if marks.suggestion.is_none() {
                let attrs = marks_to_attrs(&Marks {
                    suggestion: Some(Suggestion {
                        kind: SuggestionKind::Delete,
                        id: id.to_owned(),
                        author: author.to_owned(),
                    }),
                    ..Marks::default()
                });
                text.format(txn, pos, len, attrs);
            }
            pos += len;
        }
    }
}

fn all_texts<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Vec<XmlTextRef> {
    let mut out = vec![];
    for child in parent.children(txn) {
        match child {
            XmlOut::Text(t) => out.push(t),
            XmlOut::Element(el) => out.extend(all_texts(txn, &el)),
            _ => {}
        }
    }
    out
}

/// Edits one block in place. Returns false when the blocks are different kinds.
fn patch_block(
    txn: &mut TransactionMut,
    el: &XmlElementRef,
    exact: &Block,
    base: &Block,
    new: &Block,
    mode: &EditMode,
) -> bool {
    match (exact, base, new) {
        (Block::Paragraph { content }, Block::Paragraph { .. }, Block::Paragraph { content: target }) => {
            patch_inline(txn, el, content, target, mode);
        }
        (
            Block::Heading { level, content },
            Block::Heading { .. },
            Block::Heading { level: new_level, content: target },
        ) => {
            if level != new_level {
                set_attr(txn, el, "level", num(*new_level));
            }
            patch_inline(txn, el, content, target, mode);
        }
        (Block::CodeBlock { language, text }, Block::CodeBlock { .. }, Block::CodeBlock { language: new_language, text: new_text }) => {
            if language != new_language {
                match new_language {
                    Some(l) => set_attr(txn, el, "language", string(l)),
                    None => el.remove_attribute(txn, &"language"),
                }
            }
            if text != new_text {
                let t = match el.children(txn).find_map(|c| match c {
                    XmlOut::Text(t) => Some(t),
                    _ => None,
                }) {
                    Some(t) => t,
                    None => el.insert(txn, 0, XmlTextPrelim::new("")),
                };
                let old_runs = text_runs(txn, &t);
                patch_text(txn, &t, &old_runs, &[(new_text.clone(), Marks::default())], mode);
            }
        }
        (Block::BulletList { .. }, Block::BulletList { items: base_items }, Block::BulletList { items }) => {
            patch_items(txn, el, base_items.iter().map(|i| &i.blocks).collect(), items.iter().map(|i| (&i.blocks, None)).collect(), LIST_ITEM, mode);
        }
        (
            Block::OrderedList { start, .. },
            Block::OrderedList { items: base_items, .. },
            Block::OrderedList { start: new_start, items },
        ) => {
            if start != new_start {
                set_attr(txn, el, "start", num(*new_start));
            }
            patch_items(txn, el, base_items.iter().map(|i| &i.blocks).collect(), items.iter().map(|i| (&i.blocks, None)).collect(), LIST_ITEM, mode);
        }
        (Block::TaskList { .. }, Block::TaskList { items: base_items }, Block::TaskList { items }) => {
            patch_items(
                txn,
                el,
                base_items.iter().map(|i| &i.blocks).collect(),
                items.iter().map(|i| (&i.blocks, Some(i.checked))).collect(),
                TASK_ITEM,
                mode,
            );
        }
        (Block::Blockquote { .. }, Block::Blockquote { blocks: base_blocks }, Block::Blockquote { blocks }) => {
            patch_children(txn, el, base_blocks, blocks, mode);
        }
        (Block::Table { rows: live_rows }, Block::Table { rows: base_rows }, Block::Table { rows }) => {
            let same_shape = |a: &[TableRow], b: &[TableRow]| {
                a.len() == b.len()
                    && a.iter().zip(b).all(|(x, y)| {
                        x.cells.len() == y.cells.len()
                            && x.cells.iter().zip(&y.cells).all(|(c, d)| {
                                c.header == d.header && c.colspan == d.colspan && c.rowspan == d.rowspan
                            })
                    })
            };
            if !same_shape(live_rows, rows) || !same_shape(base_rows, rows) {
                return false;
            }
            let row_els: Vec<XmlElementRef> = el
                .children(txn)
                .filter_map(|c| match c {
                    XmlOut::Element(e) => Some(e),
                    _ => None,
                })
                .collect();
            for (r, row) in rows.iter().enumerate() {
                let cell_els: Vec<XmlElementRef> = row_els[r]
                    .children(txn)
                    .filter_map(|c| match c {
                        XmlOut::Element(e) => Some(e),
                        _ => None,
                    })
                    .collect();
                for (c, cell) in row.cells.iter().enumerate() {
                    if base_rows[r].cells[c].blocks != cell.blocks {
                        patch_children(txn, &cell_els[c], &base_rows[r].cells[c].blocks, &cell.blocks, mode);
                    }
                }
            }
        }
        (Block::Image { .. }, Block::Image { .. }, Block::Image { src, alt, title }) => {
            set_attr(txn, el, "src", string(src));
            match alt {
                Some(a) => set_attr(txn, el, "alt", string(a)),
                None => el.remove_attribute(txn, &"alt"),
            }
            match title {
                Some(t) => set_attr(txn, el, "title", string(t)),
                None => el.remove_attribute(txn, &"title"),
            }
        }
        (Block::BlockMath { .. }, Block::BlockMath { .. }, Block::BlockMath { latex }) => {
            set_attr(txn, el, "latex", string(latex));
        }
        (Block::HorizontalRule, Block::HorizontalRule, Block::HorizontalRule)
        | (Block::TableOfContents, Block::TableOfContents, Block::TableOfContents) => {}
        _ => return false,
    }
    true
}

fn patch_items(
    txn: &mut TransactionMut,
    list: &XmlElementRef,
    base: Vec<&Vec<Block>>,
    new: Vec<(&Vec<Block>, Option<bool>)>,
    item_tag: &str,
    mode: &EditMode,
) {
    let items: Vec<XmlElementRef> = list
        .children(txn)
        .filter_map(|c| match c {
            XmlOut::Element(e) => Some(e),
            _ => None,
        })
        .collect();
    let lined_up = items.len() == base.len();
    let base_keys: Vec<Vec<Block>> = if lined_up {
        base.iter().map(|b| (*b).clone()).collect()
    } else {
        items.iter().map(|i| read_children(txn, i)).collect()
    };
    let new_keys: Vec<Vec<Block>> = new.iter().map(|(b, _)| (*b).clone()).collect();
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &base_keys, &new_keys);
    let insert_item = |txn: &mut TransactionMut, at: u32, blocks: &Vec<Block>, checked: Option<bool>| {
        let li = list.insert(txn, at, XmlElementPrelim::empty(item_tag));
        if let Some(checked) = checked {
            set_attr(txn, &li, "checked", Any::Bool(checked));
        }
        write_children(txn, &li, blocks, Some(mode));
    };
    for op in ops.iter().rev() {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        match tag {
            similar::DiffTag::Equal => {
                for (o, n) in old_range.zip(new_range) {
                    if let Some(checked) = new[n].1 {
                        if attr_bool(txn, &items[o], "checked") != checked {
                            set_attr(txn, &items[o], "checked", Any::Bool(checked));
                        }
                    }
                }
            }
            similar::DiffTag::Delete => {
                for o in old_range.rev() {
                    match &mode.suggest {
                        Some((id, author)) => suggest_delete_all(txn, &items[o], id, author),
                        None => list.remove_range(txn, o as u32, 1),
                    }
                }
            }
            similar::DiffTag::Insert => {
                for (k, n) in new_range.enumerate() {
                    insert_item(txn, (old_range.start + k) as u32, new[n].0, new[n].1);
                }
            }
            similar::DiffTag::Replace => {
                let olds: Vec<usize> = old_range.collect();
                let news: Vec<usize> = new_range.collect();
                let paired = olds.len().min(news.len());
                if news.len() > paired {
                    let after = olds[paired - 1] as u32 + 1;
                    for (k, n) in news[paired..].iter().enumerate() {
                        insert_item(txn, after + k as u32, new[*n].0, new[*n].1);
                    }
                }
                for o in olds[paired..].iter().rev() {
                    match &mode.suggest {
                        Some((id, author)) => suggest_delete_all(txn, &items[*o], id, author),
                        None => list.remove_range(txn, *o as u32, 1),
                    }
                }
                for k in (0..paired).rev() {
                    let item = &items[olds[k]];
                    if let Some(checked) = new[news[k]].1 {
                        if attr_bool(txn, item, "checked") != checked {
                            set_attr(txn, item, "checked", Any::Bool(checked));
                        }
                    }
                    patch_children(txn, item, &base_keys[olds[k]], new[news[k]].0, mode);
                }
            }
        }
    }
}

enum Segment {
    Text(XmlTextRef),
    Atom(XmlElementRef, Inline),
}

/// Edits a text block's inline content in place.
fn patch_inline(txn: &mut TransactionMut, el: &XmlElementRef, exact: &[Inline], target: &[Inline], mode: &EditMode) {
    let segments: Vec<Segment> = el
        .children(txn)
        .filter_map(|c| match c {
            XmlOut::Text(t) => Some(Segment::Text(t)),
            XmlOut::Element(e) => read_atom(txn, &e).map(|a| Segment::Atom(e, a)),
            _ => None,
        })
        .collect();
    let live_atoms: Vec<&Inline> = segments
        .iter()
        .filter_map(|s| match s {
            Segment::Atom(_, a) => Some(a),
            _ => None,
        })
        .collect();
    let target_atoms: Vec<&Inline> = target.iter().filter(|i| !matches!(i, Inline::Text { .. })).collect();
    // One text between each pair of inline nodes (or none, when that stretch is empty).
    let simple = {
        let mut ok = true;
        let mut last_text = false;
        for s in &segments {
            match s {
                Segment::Text(_) => {
                    if last_text {
                        ok = false;
                    }
                    last_text = true;
                }
                Segment::Atom(..) => last_text = false,
            }
        }
        ok
    };
    if live_atoms == target_atoms && simple {
        // Split the target into the stretches between inline nodes.
        let mut stretches: Vec<Vec<(String, Marks)>> = vec![vec![]];
        for inline in target {
            match inline {
                Inline::Text { text, marks } => stretches.last_mut().unwrap().push((text.clone(), marks.clone())),
                _ => stretches.push(vec![]),
            }
        }
        // Walk the live segments; a missing text is created where its stretch begins.
        let mut stretch = 0;
        let mut index: u32 = 0;
        let mut seen_text = false;
        let mut child_count = segments.len() as u32;
        let mut pending: Vec<(Option<XmlTextRef>, u32, usize)> = vec![];
        for s in &segments {
            match s {
                Segment::Text(t) => {
                    pending.push((Some(t.clone()), index, stretch));
                    seen_text = true;
                }
                Segment::Atom(..) => {
                    if !seen_text {
                        pending.push((None, index, stretch));
                    }
                    stretch += 1;
                    seen_text = false;
                }
            }
            index += 1;
        }
        if !seen_text {
            pending.push((None, index, stretch));
        }
        // Apply from the end, so creating a text doesn't move the ones before it.
        for (text, at, k) in pending.into_iter().rev() {
            let target_runs = &stretches[k];
            match text {
                Some(t) => {
                    let old_runs = text_runs(txn, &t);
                    patch_text(txn, &t, &old_runs, target_runs, mode);
                }
                None => {
                    if target_runs.iter().any(|(s, _)| !s.is_empty()) {
                        let t = el.insert(txn, at, XmlTextPrelim::new(""));
                        child_count += 1;
                        patch_text(txn, &t, &[], target_runs, mode);
                    }
                }
            }
        }
        let _ = child_count;
        let _ = exact;
        return;
    }
    // The inline nodes changed: rewrite the block's content (as a suggestion, mark the old text
    // deleted and add the new content).
    match &mode.suggest {
        Some((id, author)) => {
            suggest_delete_all(txn, el, id, author);
            write_inline(txn, el, target, Some(mode));
        }
        None => {
            let len = el.len(txn);
            if len > 0 {
                el.remove_range(txn, 0, len);
            }
            write_inline(txn, el, target, None);
        }
    }
}

#[derive(Clone)]
struct Unit {
    ch: char,
    marks: Marks,
    hidden: bool,
}

fn units(runs: &[(String, Marks)], hide_suggested: bool) -> Vec<Unit> {
    let mut out = vec![];
    for (text, marks) in runs {
        let hidden = hide_suggested
            && matches!(&marks.suggestion, Some(s) if s.kind == SuggestionKind::Insert);
        for ch in text.chars() {
            out.push(Unit {
                ch,
                marks: marks.clone(),
                hidden,
            });
        }
    }
    out
}

enum TextOp {
    Delete { from: usize, to: usize },
    Insert { at: usize, runs: Vec<(String, Marks)> },
    Format { from: usize, to: usize, attrs: Attrs },
}

/// Edits one XML text so its visible content reads as `target`. Text suggested for insertion is
/// invisible here (Markdown leaves it out), so it is kept and never counts as a change.
fn patch_text(
    txn: &mut TransactionMut,
    text: &XmlTextRef,
    old_runs: &[(String, Marks)],
    target: &[(String, Marks)],
    mode: &EditMode,
) {
    let old_units = units(old_runs, true);
    let new_units = units(target, false);
    // Where each visible character sits in the live text (UTF-16).
    let mut y_pos: Vec<u32> = Vec::new();
    let mut visible: Vec<&Unit> = Vec::new();
    let mut pos: u32 = 0;
    for u in &old_units {
        if !u.hidden {
            y_pos.push(pos);
            visible.push(u);
        }
        pos += u.ch.len_utf16() as u32;
    }
    let total = pos;
    let y_at = |v: usize| -> u32 { if v < y_pos.len() { y_pos[v] } else { total } };

    let old_string: String = visible.iter().map(|u| u.ch).collect();
    let new_string: String = new_units.iter().map(|u| u.ch).collect();
    let chunks = dissimilar::diff(&old_string, &new_string);

    let mut ops: Vec<TextOp> = vec![];
    let mut vi = 0usize; // index into visible old units
    let mut ni = 0usize; // index into new units
    for chunk in chunks {
        match chunk {
            dissimilar::Chunk::Equal(s) => {
                let n = s.chars().count();
                // Formatting differences inside equal text.
                let mut k = 0;
                while k < n {
                    let change = mark_change(&visible[vi + k].marks, &new_units[ni + k].marks);
                    if change.is_empty() {
                        k += 1;
                        continue;
                    }
                    let start = k;
                    while k < n && mark_change(&visible[vi + k].marks, &new_units[ni + k].marks) == change {
                        k += 1;
                    }
                    ops.push(TextOp::Format {
                        from: vi + start,
                        to: vi + k,
                        attrs: change,
                    });
                }
                vi += n;
                ni += n;
            }
            dissimilar::Chunk::Delete(s) => {
                let n = s.chars().count();
                ops.push(TextOp::Delete { from: vi, to: vi + n });
                vi += n;
            }
            dissimilar::Chunk::Insert(s) => {
                let n = s.chars().count();
                let mut runs: Vec<(String, Marks)> = vec![];
                for u in &new_units[ni..ni + n] {
                    let marks = mode.inserted_marks(&u.marks);
                    match runs.last_mut() {
                        Some((t, m)) if *m == marks => t.push(u.ch),
                        _ => runs.push((u.ch.to_string(), marks)),
                    }
                }
                ops.push(TextOp::Insert { at: vi, runs });
                ni += n;
            }
        }
    }

    // Apply from the end of the text so earlier positions don't move.
    for op in ops.into_iter().rev() {
        match op {
            TextOp::Delete { from, to } => {
                // Contiguous live stretches of the deleted visible characters.
                let mut ranges: Vec<(u32, u32)> = vec![];
                for v in from..to {
                    let start = y_pos[v];
                    let len = visible[v].ch.len_utf16() as u32;
                    match ranges.last_mut() {
                        Some((s, l)) if *s + *l == start => *l += len,
                        _ => ranges.push((start, len)),
                    }
                }
                for (start, len) in ranges.into_iter().rev() {
                    match &mode.suggest {
                        Some((id, author)) => {
                            let attrs = marks_to_attrs(&Marks {
                                suggestion: Some(Suggestion {
                                    kind: SuggestionKind::Delete,
                                    id: id.clone(),
                                    author: author.clone(),
                                }),
                                ..Marks::default()
                            });
                            text.format(txn, start, len, attrs);
                        }
                        None => text.remove_range(txn, start, len),
                    }
                }
            }
            TextOp::Insert { at, runs } => {
                let mut p = y_at(at);
                for (s, marks) in runs {
                    text.insert_with_attributes(txn, p, &s, marks_to_attrs(&marks));
                    p += utf16_len(&s);
                }
            }
            TextOp::Format { from, to, attrs } => {
                let mut ranges: Vec<(u32, u32)> = vec![];
                for v in from..to {
                    let start = y_pos[v];
                    let len = visible[v].ch.len_utf16() as u32;
                    match ranges.last_mut() {
                        Some((s, l)) if *s + *l == start => *l += len,
                        _ => ranges.push((start, len)),
                    }
                }
                for (start, len) in ranges.into_iter().rev() {
                    text.format(txn, start, len, attrs.clone());
                }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------

/// Accepts or rejects one suggestion. Returns whether anything was found.
pub fn resolve_suggestion(txn: &mut TransactionMut, frag: &XmlFragmentRef, id: &str, accept: bool) -> bool {
    let mut found = false;
    let containers = text_containers(txn, frag);
    for (el, texts) in containers.into_iter().rev() {
        let mut touched = false;
        let mut was_all_suggested = true;
        for text in texts.iter().rev() {
            let runs = text_runs(txn, text);
            let mut pos = 0u32;
            let mut ranges: Vec<(u32, u32, SuggestionKind)> = vec![];
            for (chunk, marks) in &runs {
                let len = utf16_len(chunk);
                match &marks.suggestion {
                    Some(s) if s.id == id => ranges.push((pos, len, s.kind)),
                    _ => {
                        if !chunk.is_empty() {
                            was_all_suggested = false;
                        }
                    }
                }
                pos += len;
            }
            for (start, len, kind) in ranges.into_iter().rev() {
                found = true;
                touched = true;
                let remove = matches!(
                    (kind, accept),
                    (SuggestionKind::Delete, true) | (SuggestionKind::Insert, false)
                );
                if remove {
                    text.remove_range(txn, start, len);
                } else {
                    let key = match kind {
                        SuggestionKind::Insert => SUGGESTION_INSERT,
                        SuggestionKind::Delete => SUGGESTION_DELETE,
                    };
                    let mut attrs = Attrs::new();
                    attrs.insert(Arc::from(key), Any::Null);
                    text.format(txn, start, len, attrs);
                }
            }
        }
        // A block that held only this suggestion's text and is now empty goes with it.
        if touched && was_all_suggested {
            if let Some(el) = el {
                let empty = all_texts(txn, &el).iter().all(|t| plain(txn, t).is_empty())
                    && !el.children(txn).any(|c| matches!(c, XmlOut::Element(_)));
                if empty {
                    if let Some(XmlOut::Element(parent)) = el.parent() {
                        if parent.len(txn) > 1 {
                            remove_child(txn, &parent, &el);
                        }
                    } else if let Some(XmlOut::Fragment(parent)) = el.parent() {
                        if parent.len(txn) > 1 {
                            remove_child(txn, &parent, &el);
                        }
                    }
                }
            }
        }
    }
    found
}

fn remove_child<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, child: &XmlElementRef) {
    let index = parent
        .children(txn)
        .position(|c| matches!(c, XmlOut::Element(e) if e == *child));
    if let Some(index) = index {
        parent.remove_range(txn, index as u32, 1);
    }
}

/// Every element that holds text directly, with its texts, in document order.
fn text_containers<T: ReadTxn, F: XmlFragment>(txn: &T, frag: &F) -> Vec<(Option<XmlElementRef>, Vec<XmlTextRef>)> {
    let mut out = vec![];
    fn walk<T: ReadTxn, F: XmlFragment>(txn: &T, node: &F, el: Option<XmlElementRef>, out: &mut Vec<(Option<XmlElementRef>, Vec<XmlTextRef>)>) {
        let mut texts = vec![];
        for child in node.children(txn) {
            match child {
                XmlOut::Text(t) => texts.push(t),
                XmlOut::Element(e) => walk(txn, &e, Some(e.clone()), out),
                _ => {}
            }
        }
        if !texts.is_empty() {
            out.push((el, texts));
        }
    }
    walk(txn, frag, None, &mut out);
    out
}

// ------------------------------------------------------------------------------------------
// Linear text, anchors and authorship
// ------------------------------------------------------------------------------------------

/// The doc's text as one string (UTF-16 units), blocks separated by newlines, with where each
/// live text starts in it. Comment anchors are resolved against this.
pub struct TextMap {
    pub text: Vec<u16>,
    pub starts: HashMap<yrs::BranchID, usize>,
    /// For elements holding inline content: where each child starts.
    pub child_starts: HashMap<yrs::BranchID, Vec<usize>>,
    /// Which top-level block each offset belongs to: (start, end, block index).
    pub blocks: Vec<(usize, usize, usize)>,
    /// Every live text with where it starts.
    pub texts: Vec<(usize, XmlTextRef)>,
}

impl TextMap {
    pub fn slice(&self, from: usize, to: usize) -> String {
        let to = to.min(self.text.len());
        let from = from.min(to);
        String::from_utf16_lossy(&self.text[from..to])
    }

    pub fn block_at(&self, offset: usize) -> Option<usize> {
        self.blocks
            .iter()
            .find(|(s, e, _)| offset >= *s && offset <= *e)
            .map(|(_, _, i)| *i)
    }
}

pub fn text_map<T: ReadTxn>(txn: &T, frag: &XmlFragmentRef) -> TextMap {
    let mut map = TextMap {
        text: vec![],
        starts: HashMap::new(),
        child_starts: HashMap::new(),
        blocks: vec![],
        texts: vec![],
    };
    for (i, child) in frag.children(txn).enumerate() {
        if let XmlOut::Element(el) = child {
            if !map.text.is_empty() {
                map.text.push(b'\n' as u16);
            }
            let start = map.text.len();
            walk_text(txn, &el, &mut map);
            map.blocks.push((start, map.text.len(), i));
        }
    }
    map
}

fn walk_text<T: ReadTxn>(txn: &T, el: &XmlElementRef, map: &mut TextMap) {
    let mut first_block = true;
    let mut starts = vec![];
    for child in el.children(txn) {
        starts.push(map.text.len());
        match child {
            XmlOut::Text(t) => {
                map.starts.insert(AsRef::<yrs::branch::Branch>::as_ref(&t).id(), map.text.len());
                map.texts.push((map.text.len(), t.clone()));
                map.text.extend(plain(txn, &t).encode_utf16());
            }
            XmlOut::Element(e) => {
                let is_block = read_atom(txn, &e).is_none();
                if is_block {
                    if !first_block {
                        map.text.push(b'\n' as u16);
                    }
                    first_block = false;
                    walk_text(txn, &e, map);
                } else {
                    // Inline nodes take one place.
                    map.text.push(0xFFFC);
                }
            }
            _ => {}
        }
    }
    map.child_starts.insert(AsRef::<yrs::branch::Branch>::as_ref(el).id(), starts);
}

/// A Yjs relative position (encoded the way the editor encodes them) at an offset in the text
/// map. `end` positions stick to the character before them, so typing right after a commented
/// range doesn't extend it.
pub fn position_at<T: ReadTxn>(txn: &T, map: &TextMap, offset: usize, end: bool) -> Option<Vec<u8>> {
    use yrs::IndexedSequence;
    use yrs::updates::encoder::Encode;
    let found = map.texts.iter().find(|(start, text)| {
        let len = text.len(txn) as usize;
        if end { offset > *start && offset <= start + len } else { offset >= *start && offset < start + len }
    })?;
    let (start, text) = found;
    let assoc = if end { yrs::Assoc::Before } else { yrs::Assoc::After };
    let sticky = text.sticky_index(txn, (offset - start) as u32, assoc)?;
    Some(sticky.encode_v1())
}

/// Resolves a Yjs relative position (as the editor encodes it) to an offset in the text map.
pub fn resolve_position<T: ReadTxn>(txn: &T, map: &TextMap, encoded: &[u8]) -> Option<usize> {
    use yrs::updates::decoder::Decode;
    let sticky = yrs::StickyIndex::decode_v1(encoded).ok()?;
    let offset = sticky.get_offset(txn)?;
    let id = offset.branch.id();
    if let Some(start) = map.starts.get(&id) {
        return Some(start + offset.index as usize);
    }
    if let Some(children) = map.child_starts.get(&id) {
        let i = offset.index as usize;
        return Some(match children.get(i) {
            Some(s) => *s,
            None => children.last().map(|s| *s + 1).unwrap_or(0),
        });
    }
    None
}

/// Who wrote each part: for every top-level block, runs of (client id, length in characters),
/// suggested insertions included.
pub fn authorship(ydoc: &YDoc) -> Vec<Vec<(u64, usize)>> {
    let frag = fragment(ydoc);
    let mut txn = ydoc.transact_mut();
    let hi = txn.snapshot();
    let lo = Snapshot::new(StateVector::default(), yrs::IdSet::default());
    let blocks: Vec<XmlElementRef> = frag
        .children(&txn)
        .filter_map(|c| match c {
            XmlOut::Element(e) => Some(e),
            _ => None,
        })
        .collect();
    let mut out = vec![];
    for block in blocks {
        let texts = all_texts(&txn, &block);
        let mut runs: Vec<(u64, usize)> = vec![];
        for text in texts {
            for d in text.diff_range(&mut txn, Some(&hi), Some(&lo), YChange::identity) {
                let len = match &d.insert {
                    yrs::Out::Any(Any::String(s)) => s.chars().count(),
                    _ => 1,
                };
                let client = d.ychange.map(|c| c.id.client.get()).unwrap_or(0);
                match runs.last_mut() {
                    Some((c, l)) if *c == client => *l += len,
                    _ => runs.push((client, len)),
                }
            }
        }
        out.push(runs);
    }
    out
}

/// The client ids that wrote anything still visible in each block, most characters first.
pub fn block_authors(ydoc: &YDoc) -> Vec<Vec<u64>> {
    authorship(ydoc)
        .into_iter()
        .map(|runs| {
            let mut totals: HashMap<u64, usize> = HashMap::new();
            for (c, l) in runs {
                *totals.entry(c).or_default() += l;
            }
            let mut v: Vec<(u64, usize)> = totals.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1));
            v.into_iter().map(|(c, _)| c).collect()
        })
        .collect()
}

/// Re-exported so callers can build deltas without importing yrs internals.
pub type YDelta = Delta;

/// Applies a closure to a fresh transaction on a doc's fragment.
pub fn with_txn<R>(ydoc: &YDoc, f: impl FnOnce(&mut TransactionMut, &XmlFragmentRef) -> R) -> R {
    let frag = fragment(ydoc);
    let mut txn = ydoc.transact_mut();
    f(&mut txn, &frag)
}
