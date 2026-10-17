//! The document model every format converts through.
//!
//! It mirrors the web editor's schema node for node: the names in [`names`] are the Tiptap node
//! and mark names, and the live Yjs form ([`crate::ydoc`]) stores exactly what the editor's Yjs
//! binding stores. Anything the server writes into a live doc therefore has to be a valid editor
//! document, so [`Doc::normalize`] repairs the shapes the editor would reject (an empty doc, a
//! list item that doesn't start with a paragraph, an empty table cell).

use serde::{Deserialize, Serialize};

/// Tiptap node and mark names, shared with the web editor (`web/components/editor/schema.ts`).
pub mod names {
    pub const DOC: &str = "doc";
    pub const PARAGRAPH: &str = "paragraph";
    pub const HEADING: &str = "heading";
    pub const BULLET_LIST: &str = "bulletList";
    pub const ORDERED_LIST: &str = "orderedList";
    pub const LIST_ITEM: &str = "listItem";
    pub const TASK_LIST: &str = "taskList";
    pub const TASK_ITEM: &str = "taskItem";
    pub const BLOCKQUOTE: &str = "blockquote";
    pub const CODE_BLOCK: &str = "codeBlock";
    pub const HORIZONTAL_RULE: &str = "horizontalRule";
    pub const IMAGE: &str = "image";
    pub const TABLE: &str = "table";
    pub const TABLE_ROW: &str = "tableRow";
    pub const TABLE_HEADER: &str = "tableHeader";
    pub const TABLE_CELL: &str = "tableCell";
    pub const BLOCK_MATH: &str = "blockMath";
    pub const TABLE_OF_CONTENTS: &str = "tableOfContents";
    pub const HARD_BREAK: &str = "hardBreak";
    pub const INLINE_MATH: &str = "inlineMath";
    pub const FOOTNOTE: &str = "footnote";
    pub const DOC_LINK: &str = "docLink";
    pub const INLINE_IMAGE: &str = "inlineImage";
    pub const SUBSCRIPT: &str = "subscript";
    pub const SUPERSCRIPT: &str = "superscript";

    pub const BOLD: &str = "bold";
    pub const ITALIC: &str = "italic";
    pub const UNDERLINE: &str = "underline";
    pub const STRIKE: &str = "strike";
    pub const CODE: &str = "code";
    pub const LINK: &str = "link";
    pub const TEXT_STYLE: &str = "textStyle";
    pub const HIGHLIGHT: &str = "highlight";
    pub const SUGGESTION_INSERT: &str = "suggestionInsert";
    pub const SUGGESTION_DELETE: &str = "suggestionDelete";

    /// The node attribute (on any block, list item, task item, table row or inline node) that holds
    /// the node's pending suggestion: `{kind, id, author}`.
    pub const SUGGESTION: &str = "suggestion";
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct Doc {
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Paragraph {
        content: Vec<Inline>,
    },
    Heading {
        level: u8,
        content: Vec<Inline>,
    },
    BulletList {
        items: Vec<ListItem>,
    },
    OrderedList {
        start: u32,
        items: Vec<ListItem>,
    },
    TaskList {
        items: Vec<TaskItem>,
    },
    Blockquote {
        blocks: Vec<Block>,
    },
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    HorizontalRule,
    Image {
        src: String,
        alt: Option<String>,
        title: Option<String>,
    },
    Table {
        rows: Vec<TableRow>,
    },
    BlockMath {
        latex: String,
    },
    TableOfContents,
    /// A block someone suggests adding (it isn't in the doc until the suggestion is accepted) or
    /// removing (it stays until then). In the live doc this is the block's `suggestion` attribute.
    /// A list item, task item or table row suggested as a whole has each of its blocks (each block
    /// of each of its cells) wrapped with that same suggestion.
    Suggested {
        suggestion: Suggestion,
        block: Box<Block>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct ListItem {
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct TaskItem {
    pub checked: bool,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TableCell {
    pub header: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    pub colspan: u32,
    pub rowspan: u32,
    pub blocks: Vec<Block>,
}

impl Default for TableCell {
    fn default() -> Self {
        TableCell {
            header: false,
            align: None,
            colspan: 1,
            rowspan: 1,
            blocks: vec![Block::empty_paragraph()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text { text: String, marks: Marks },
    HardBreak,
    InlineMath { latex: String },
    /// A footnote, kept where it is referenced. `content` is Markdown inline text.
    Footnote { content: String },
    /// A `[[link]]` to another doc, by its title.
    DocLink {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alias: Option<String>,
    },
    Image {
        src: String,
        alt: Option<String>,
        title: Option<String>,
        link: Option<String>,
        link_title: Option<String>,
    },
    /// An inline node (a line break, maths, a footnote, a doc link) someone suggests adding or
    /// removing: its `suggestion` attribute in the live doc. Text carries its suggestion as a mark.
    Suggested { suggestion: Suggestion, inline: Box<Inline> },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct Marks {
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strike: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub code: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_title: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub subscript: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub superscript: bool,
    /// Text colour (the editor's `textStyle` mark).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Highlight; `Some(None)` is the default highlight colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Suggestion>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Suggestion {
    pub kind: SuggestionKind,
    pub id: String,
    /// The suggesting account's uuid.
    pub author: String,
}

/// One pending suggestion, summarised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionSummary {
    pub id: String,
    pub author: String,
    pub inserted: String,
    pub deleted: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    Insert,
    Delete,
}

impl SuggestionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionKind::Insert => "insert",
            SuggestionKind::Delete => "delete",
        }
    }

    pub fn parse(value: &str) -> Option<SuggestionKind> {
        match value {
            "insert" => Some(SuggestionKind::Insert),
            "delete" => Some(SuggestionKind::Delete),
            _ => None,
        }
    }
}

impl Suggestion {
    /// Whether what this suggestion covers goes when it's decided this way: an accepted deletion
    /// or a rejected insertion.
    pub fn goes_when(&self, accept: bool) -> bool {
        matches!(
            (self.kind, accept),
            (SuggestionKind::Delete, true) | (SuggestionKind::Insert, false)
        )
    }
}

impl Marks {
    pub fn is_plain(&self) -> bool {
        *self == Marks::default()
    }

    /// The marks without the suggestion (what the text looks like once it's accepted).
    pub fn without_suggestion(&self) -> Marks {
        Marks {
            suggestion: None,
            ..self.clone()
        }
    }
}

impl Block {
    pub fn paragraph(content: Vec<Inline>) -> Block {
        Block::Paragraph { content }
    }

    pub fn empty_paragraph() -> Block {
        Block::Paragraph { content: vec![] }
    }

    pub fn text_paragraph(text: &str) -> Block {
        Block::Paragraph {
            content: vec![Inline::text(text)],
        }
    }

    /// The Tiptap node name.
    pub fn type_name(&self) -> &'static str {
        use names::*;
        match self {
            Block::Paragraph { .. } => PARAGRAPH,
            Block::Heading { .. } => HEADING,
            Block::BulletList { .. } => BULLET_LIST,
            Block::OrderedList { .. } => ORDERED_LIST,
            Block::TaskList { .. } => TASK_LIST,
            Block::Blockquote { .. } => BLOCKQUOTE,
            Block::CodeBlock { .. } => CODE_BLOCK,
            Block::HorizontalRule => HORIZONTAL_RULE,
            Block::Image { .. } => IMAGE,
            Block::Table { .. } => TABLE,
            Block::BlockMath { .. } => BLOCK_MATH,
            Block::TableOfContents => TABLE_OF_CONTENTS,
            Block::Suggested { block, .. } => block.type_name(),
        }
    }

    /// `block`, suggested by `suggestion`.
    pub fn suggested(suggestion: Suggestion, block: Block) -> Block {
        Block::Suggested {
            suggestion,
            block: Box::new(block),
        }
    }

    /// The block's own suggestion (the outermost one), and the block under it.
    pub fn split_suggestion(&self) -> (Option<&Suggestion>, &Block) {
        match self {
            Block::Suggested { suggestion, block } => (Some(suggestion), block),
            other => (None, other),
        }
    }

    /// The block under every suggestion wrapping it.
    pub fn unsuggested(&self) -> &Block {
        match self {
            Block::Suggested { block, .. } => block.unsuggested(),
            other => other,
        }
    }

    /// Inline content, for the blocks that hold text directly.
    pub fn inline_content(&self) -> Option<&Vec<Inline>> {
        match self {
            Block::Paragraph { content } | Block::Heading { content, .. } => Some(content),
            _ => None,
        }
    }

    pub fn inline_content_mut(&mut self) -> Option<&mut Vec<Inline>> {
        match self {
            Block::Paragraph { content } | Block::Heading { content, .. } => Some(content),
            _ => None,
        }
    }

    /// An empty paragraph (suggested or not): Markdown has no way to write one.
    pub fn is_empty_paragraph(&self) -> bool {
        matches!(self.unsuggested(), Block::Paragraph { content } if content.is_empty())
    }

    /// A block that isn't in the doc as it reads now, so the Markdown leaves it out: a block
    /// suggested for adding (or holding nothing but suggested additions), or a paragraph or heading
    /// whose text is all a pending suggested insertion.
    pub fn is_suggested_only(&self) -> bool {
        self.is_all_suggested(SuggestionKind::Insert) || decided_block(self, &|_| false).is_none()
    }

    /// A paragraph or heading whose content is all pending suggestions of this kind: resolving them
    /// that way (rejecting insertions, accepting deletions) takes the block away with its text.
    pub fn is_all_suggested(&self, kind: SuggestionKind) -> bool {
        self.inline_content().is_some_and(|content| {
            !content.is_empty() && content.iter().all(|inline| inline.suggestion_kind() == Some(kind))
        })
    }

    /// Plain text, with blocks separated by newlines.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        self.write_plain(&mut out);
        out
    }

    fn write_plain(&self, out: &mut String) {
        match self {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                inline_plain(content, out)
            }
            Block::BulletList { items } | Block::OrderedList { items, .. } => {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    blocks_plain(&item.blocks, out);
                }
            }
            Block::TaskList { items } => {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    blocks_plain(&item.blocks, out);
                }
            }
            Block::Blockquote { blocks } => blocks_plain(blocks, out),
            Block::CodeBlock { text, .. } => out.push_str(text),
            Block::HorizontalRule | Block::TableOfContents => {}
            Block::Image { alt, .. } => out.push_str(alt.as_deref().unwrap_or("")),
            Block::Table { rows } => {
                for (r, row) in rows.iter().enumerate() {
                    if r > 0 {
                        out.push('\n');
                    }
                    for (c, cell) in row.cells.iter().enumerate() {
                        if c > 0 {
                            out.push('\t');
                        }
                        blocks_plain(&cell.blocks, out);
                    }
                }
            }
            Block::BlockMath { latex } => out.push_str(latex),
            Block::Suggested { suggestion, block } => {
                if suggestion.kind != SuggestionKind::Insert {
                    block.write_plain(out)
                }
            }
        }
    }
}

fn blocks_plain(blocks: &[Block], out: &mut String) {
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        block.write_plain(out);
    }
}

fn inline_plain(content: &[Inline], out: &mut String) {
    for inline in content {
        match inline {
            Inline::Text { text, marks } => {
                if !matches!(&marks.suggestion, Some(s) if s.kind == SuggestionKind::Insert) {
                    out.push_str(text)
                }
            }
            Inline::HardBreak => out.push('\n'),
            Inline::InlineMath { latex } => out.push_str(latex),
            Inline::Footnote { .. } => {}
            Inline::DocLink { title, alias } => out.push_str(alias.as_deref().unwrap_or(title)),
            Inline::Image { alt, .. } => out.push_str(alt.as_deref().unwrap_or("")),
            Inline::Suggested { suggestion, inline } => {
                if suggestion.kind != SuggestionKind::Insert {
                    inline_plain(std::slice::from_ref(inline), out)
                }
            }
        }
    }
}

impl Inline {
    pub fn text(text: impl Into<String>) -> Inline {
        Inline::Text {
            text: text.into(),
            marks: Marks::default(),
        }
    }

    pub fn marked(text: impl Into<String>, marks: Marks) -> Inline {
        Inline::Text {
            text: text.into(),
            marks,
        }
    }

    /// The Tiptap node name of an inline node that isn't text.
    pub fn atom_name(&self) -> Option<&'static str> {
        match self {
            Inline::Text { .. } => None,
            Inline::HardBreak => Some(names::HARD_BREAK),
            Inline::InlineMath { .. } => Some(names::INLINE_MATH),
            Inline::Footnote { .. } => Some(names::FOOTNOTE),
            Inline::DocLink { .. } => Some(names::DOC_LINK),
            Inline::Image { .. } => Some(names::INLINE_IMAGE),
            Inline::Suggested { inline, .. } => inline.atom_name(),
        }
    }

    /// The kind of suggestion this piece of content is (a mark on text, or an inline node's own).
    pub fn suggestion_kind(&self) -> Option<SuggestionKind> {
        match self {
            Inline::Text { marks, .. } => marks.suggestion.as_ref().map(|s| s.kind),
            Inline::Suggested { suggestion, .. } => Some(suggestion.kind),
            _ => None,
        }
    }

    /// The inline node's own suggestion, and the node under it.
    pub fn split_suggestion(&self) -> (Option<&Suggestion>, &Inline) {
        match self {
            Inline::Suggested { suggestion, inline } => (Some(suggestion), inline),
            other => (None, other),
        }
    }
}

/// Merges neighbouring text with identical marks and drops empty text.
pub fn normalize_inlines(content: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(content.len());
    for inline in content {
        match inline {
            Inline::Text { text, .. } if text.is_empty() => {}
            Inline::Text { text, marks } => {
                if let Some(Inline::Text {
                    text: prev,
                    marks: prev_marks,
                }) = out.last_mut()
                    && *prev_marks == marks {
                        prev.push_str(&text);
                        continue;
                    }
                out.push(Inline::Text { text, marks });
            }
            other => out.push(other),
        }
    }
    out
}

impl Doc {
    pub fn new(blocks: Vec<Block>) -> Doc {
        let mut doc = Doc { blocks };
        doc.normalize();
        doc
    }

    /// Repairs the shapes the editor's schema would reject, and merges adjacent text.
    pub fn normalize(&mut self) {
        normalize_blocks(&mut self.blocks);
        if self.blocks.is_empty() {
            self.blocks.push(Block::empty_paragraph());
        }
    }

    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        blocks_plain(&self.blocks, &mut out);
        out
    }

    /// The doc as it reads once every pending suggestion is rejected: suggested insertions are
    /// left out, and what was suggested for deletion stays.
    pub fn without_suggestions(&self) -> Doc {
        self.decided(&|_| false)
    }

    /// The doc with every pending suggestion accepted.
    pub fn with_suggestions_accepted(&self) -> Doc {
        self.decided(&|_| true)
    }

    /// The doc once every pending suggestion is decided, each accepted when `accept` says so, the
    /// way deciding them in the live doc leaves it ([`crate::ydoc::resolve_suggestion`]).
    pub fn decided(&self, accept: &dyn Fn(&Suggestion) -> bool) -> Doc {
        let mut blocks = decided_blocks(&self.blocks, accept);
        if blocks.is_empty() {
            blocks.push(Block::empty_paragraph());
        }
        Doc { blocks }
    }

    /// Every pending suggestion, in document order: what it would insert and what it would
    /// delete. Text reads as itself; a suggested block, list item, table row or inline node reads
    /// as its Markdown. Pieces from different places are separated by a blank line.
    pub fn suggestions(&self) -> Vec<SuggestionSummary> {
        let mut found = Summaries::default();
        found.blocks(&self.blocks, &[]);
        found.list
    }

    /// The titles of every `[[doc link]]` in the doc as it reads now (a suggested link isn't one
    /// yet).
    pub fn doc_links(&self) -> Vec<String> {
        let mut titles = vec![];
        let mut blocks = self.without_suggestions().blocks;
        map_inlines(&mut blocks, &mut |content| {
            for inline in content.iter() {
                if let Inline::DocLink { title, .. } = inline
                    && !titles.contains(title) {
                        titles.push(title.clone());
                    }
            }
        });
        titles
    }

    /// The first heading or the first line of text, for naming a doc that has no title.
    pub fn first_line(&self) -> Option<String> {
        self.blocks.iter().find_map(|block| {
            let text = block.plain_text();
            let line = text.lines().find(|l| !l.trim().is_empty())?;
            Some(line.trim().to_owned())
        })
    }
}

// ------------------------------------------------------------------------------------------
// Deciding suggestions
// ------------------------------------------------------------------------------------------

/// How a block reads once its pending suggestions are decided, each accepted when `accept` says
/// so; `None` when the block goes with them. A container left with nothing goes too: a list
/// without items, a list item, quote or table row whose every block went, a table without rows.
/// This is what deciding them in the live doc does ([`crate::ydoc::resolve_suggestion`]).
pub fn decided_block(block: &Block, accept: &dyn Fn(&Suggestion) -> bool) -> Option<Block> {
    Some(match block {
        Block::Suggested { suggestion, block } => {
            return if suggestion.goes_when(accept(suggestion)) { None } else { decided_block(block, accept) };
        }
        Block::Paragraph { content } => Block::Paragraph {
            content: decided_inlines(content, accept),
        },
        Block::Heading { level, content } => Block::Heading {
            level: *level,
            content: decided_inlines(content, accept),
        },
        Block::BulletList { items } => {
            let kept: Vec<ListItem> = items
                .iter()
                .filter_map(|item| decided_item(&item.blocks, accept).map(|blocks| ListItem { blocks }))
                .collect();
            if kept.is_empty() && !items.is_empty() {
                return None;
            }
            Block::BulletList { items: kept }
        }
        Block::OrderedList { start, items } => {
            let kept: Vec<ListItem> = items
                .iter()
                .filter_map(|item| decided_item(&item.blocks, accept).map(|blocks| ListItem { blocks }))
                .collect();
            if kept.is_empty() && !items.is_empty() {
                return None;
            }
            Block::OrderedList { start: *start, items: kept }
        }
        Block::TaskList { items } => {
            let kept: Vec<TaskItem> = items
                .iter()
                .filter_map(|item| {
                    decided_item(&item.blocks, accept).map(|blocks| TaskItem {
                        checked: item.checked,
                        blocks,
                    })
                })
                .collect();
            if kept.is_empty() && !items.is_empty() {
                return None;
            }
            Block::TaskList { items: kept }
        }
        Block::Blockquote { blocks } => {
            let kept = decided_blocks(blocks, accept);
            if kept.is_empty() && !blocks.is_empty() {
                return None;
            }
            Block::Blockquote { blocks: kept }
        }
        Block::Table { rows } => {
            let mut kept: Vec<TableRow> = vec![];
            for row in rows {
                let cells: Vec<(TableCell, bool)> = row
                    .cells
                    .iter()
                    .map(|cell| {
                        let blocks = decided_blocks(&cell.blocks, accept);
                        let emptied = blocks.is_empty() && !cell.blocks.is_empty();
                        let blocks = if emptied { vec![Block::empty_paragraph()] } else { blocks };
                        (TableCell { blocks, ..cell.clone() }, emptied)
                    })
                    .collect();
                // A row whose every cell went is a row suggested as a whole.
                if !cells.is_empty() && cells.iter().all(|(_, emptied)| *emptied) {
                    continue;
                }
                kept.push(TableRow {
                    cells: cells.into_iter().map(|(cell, _)| cell).collect(),
                });
            }
            if kept.is_empty() && !rows.is_empty() {
                return None;
            }
            Block::Table { rows: kept }
        }
        other => other.clone(),
    })
}

/// Each of a container's blocks once their suggestions are decided (`None` for the ones that go).
/// A paragraph or heading whose whole content goes goes with it, unless it's all the container
/// has left.
pub fn decided_each(blocks: &[Block], accept: &dyn Fn(&Suggestion) -> bool) -> Vec<Option<Block>> {
    let mut out: Vec<Option<Block>> = blocks.iter().map(|block| decided_block(block, accept)).collect();
    let mut left = out.iter().filter(|b| b.is_some()).count();
    for (i, block) in blocks.iter().enumerate() {
        if left > 1 && out[i].is_some() && all_goes(block, accept) {
            out[i] = None;
            left -= 1;
        }
    }
    out
}

fn decided_blocks(blocks: &[Block], accept: &dyn Fn(&Suggestion) -> bool) -> Vec<Block> {
    decided_each(blocks, accept).into_iter().flatten().collect()
}

/// A list item's blocks once decided; `None` when every block went. An item still starts with a
/// paragraph.
fn decided_item(blocks: &[Block], accept: &dyn Fn(&Suggestion) -> bool) -> Option<Vec<Block>> {
    let mut kept = decided_blocks(blocks, accept);
    if kept.is_empty() && !blocks.is_empty() {
        return None;
    }
    if kept.len() < blocks.len() && !matches!(kept.first(), Some(Block::Paragraph { .. })) {
        kept.insert(0, Block::empty_paragraph());
    }
    Some(kept)
}

/// A paragraph or heading whose content is all suggestions that go when decided this way.
fn all_goes(block: &Block, accept: &dyn Fn(&Suggestion) -> bool) -> bool {
    block.inline_content().is_some_and(|content| {
        !content.is_empty()
            && content.iter().all(|inline| match inline {
                Inline::Text { marks, .. } => marks.suggestion.as_ref().is_some_and(|s| s.goes_when(accept(s))),
                Inline::Suggested { suggestion, .. } => suggestion.goes_when(accept(suggestion)),
                _ => false,
            })
    })
}

fn decided_inlines(content: &[Inline], accept: &dyn Fn(&Suggestion) -> bool) -> Vec<Inline> {
    normalize_inlines(content.iter().filter_map(|inline| decided_inline(inline, accept)).collect())
}

fn decided_inline(inline: &Inline, accept: &dyn Fn(&Suggestion) -> bool) -> Option<Inline> {
    match inline {
        Inline::Text { text, marks } => match &marks.suggestion {
            Some(s) if s.goes_when(accept(s)) => None,
            _ => Some(Inline::Text {
                text: text.clone(),
                marks: marks.without_suggestion(),
            }),
        },
        Inline::Suggested { suggestion, inline } => {
            if suggestion.goes_when(accept(suggestion)) {
                None
            } else {
                decided_inline(inline, accept)
            }
        }
        other => Some(other.clone()),
    }
}

/// The suggestion a list item or table row is suggested as a whole by: the one every block of it
/// is wrapped with.
pub fn common_suggestion<'a>(blocks: impl IntoIterator<Item = &'a Block>) -> Option<Suggestion> {
    let mut common: Option<&Suggestion> = None;
    for block in blocks {
        match block {
            Block::Suggested { suggestion, .. } if common.is_none_or(|c| c == suggestion) => common = Some(suggestion),
            _ => return None,
        }
    }
    common.cloned()
}

/// Blocks without the suggestion they are all wrapped with (see [`common_suggestion`]).
pub fn without_common_suggestion(blocks: &[Block]) -> Vec<Block> {
    blocks
        .iter()
        .map(|block| match block {
            Block::Suggested { block, .. } => (**block).clone(),
            other => other.clone(),
        })
        .collect()
}

// ------------------------------------------------------------------------------------------
// Summaries
// ------------------------------------------------------------------------------------------

/// Collects every suggestion's summary, in document order.
#[derive(Default)]
struct Summaries {
    list: Vec<SuggestionSummary>,
    /// The place (a text block, or a suggested node) each side of a summary was last added from.
    last: std::collections::HashMap<(String, SuggestionKind), usize>,
    place: usize,
}

impl Summaries {
    fn add(&mut self, suggestion: &Suggestion, text: &str) {
        if text.is_empty() {
            return;
        }
        let index = match self.list.iter().position(|f| f.id == suggestion.id) {
            Some(i) => i,
            None => {
                self.list.push(SuggestionSummary {
                    id: suggestion.id.clone(),
                    author: suggestion.author.clone(),
                    inserted: String::new(),
                    deleted: String::new(),
                });
                self.list.len() - 1
            }
        };
        let entry = &mut self.list[index];
        let side = match suggestion.kind {
            SuggestionKind::Insert => &mut entry.inserted,
            SuggestionKind::Delete => &mut entry.deleted,
        };
        let key = (suggestion.id.clone(), suggestion.kind);
        if !side.is_empty() && self.last.get(&key) != Some(&self.place) {
            side.push_str("\n\n");
        }
        side.push_str(text);
        self.last.insert(key, self.place);
    }

    /// `within`: the suggestions the blocks are part of as a whole (they're summarised already).
    fn blocks(&mut self, blocks: &[Block], within: &[String]) {
        for block in blocks {
            self.block(block, within);
        }
    }

    fn block(&mut self, block: &Block, within: &[String]) {
        match block {
            Block::Suggested { suggestion, block: inner } => {
                if !within.contains(&suggestion.id) {
                    self.place += 1;
                    self.add(suggestion, &node_markdown(inner, suggestion));
                    self.place += 1;
                }
                let within = [within, std::slice::from_ref(&suggestion.id)].concat();
                self.block(inner, &within);
            }
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                self.place += 1;
                self.inlines(content, within);
            }
            Block::BulletList { items } => {
                for item in items {
                    self.item(&item.blocks, within, &|blocks| Block::BulletList { items: vec![ListItem { blocks }] });
                }
            }
            Block::OrderedList { start, items } => {
                for (i, item) in items.iter().enumerate() {
                    let start = *start + i as u32;
                    self.item(&item.blocks, within, &|blocks| Block::OrderedList { start, items: vec![ListItem { blocks }] });
                }
            }
            Block::TaskList { items } => {
                for item in items {
                    let checked = item.checked;
                    self.item(&item.blocks, within, &|blocks| Block::TaskList { items: vec![TaskItem { checked, blocks }] });
                }
            }
            Block::Blockquote { blocks } => self.blocks(blocks, within),
            Block::Table { rows } => {
                for row in rows {
                    match common_suggestion(row.cells.iter().flat_map(|c| &c.blocks)).filter(|s| !within.contains(&s.id)) {
                        Some(suggestion) => {
                            self.place += 1;
                            let cells: Vec<String> = row
                                .cells
                                .iter()
                                .map(|cell| {
                                    let doc = Doc { blocks: without_common_suggestion(&cell.blocks) };
                                    let doc = doc.decided(&|s| adds_with(s, &suggestion));
                                    crate::markdown::to_markdown(&doc).trim().replace('\n', " ")
                                })
                                .collect();
                            self.add(&suggestion, &format!("| {} |", cells.join(" | ")));
                            self.place += 1;
                            let within = [within, std::slice::from_ref(&suggestion.id)].concat();
                            for cell in &row.cells {
                                self.blocks(&without_common_suggestion(&cell.blocks), &within);
                            }
                        }
                        None => {
                            for cell in &row.cells {
                                self.blocks(&cell.blocks, within);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// A list item: summarised whole when it's suggested whole (`list` makes a one-item list of it).
    fn item(&mut self, blocks: &[Block], within: &[String], list: &dyn Fn(Vec<Block>) -> Block) {
        match common_suggestion(blocks).filter(|s| !within.contains(&s.id)) {
            Some(suggestion) => {
                self.place += 1;
                let inner = without_common_suggestion(blocks);
                self.add(&suggestion, &node_markdown(&list(inner.clone()), &suggestion));
                self.place += 1;
                let within = [within, std::slice::from_ref(&suggestion.id)].concat();
                self.blocks(&inner, &within);
            }
            None => self.blocks(blocks, within),
        }
    }

    fn inlines(&mut self, content: &[Inline], within: &[String]) {
        for inline in content {
            match inline {
                Inline::Text {
                    text,
                    marks: Marks { suggestion: Some(s), .. },
                } if !within.contains(&s.id) => self.add(s, text),
                Inline::Suggested { suggestion, inline } if !within.contains(&suggestion.id) => {
                    self.add(suggestion, &inline_markdown(inline))
                }
                _ => {}
            }
        }
    }
}

/// Whether `s`, inside a node `suggestion` adds, is part of what it adds (the rest is decided
/// against, to show the node without other suggestions in it).
fn adds_with(s: &Suggestion, suggestion: &Suggestion) -> bool {
    suggestion.kind == SuggestionKind::Insert && s.id == suggestion.id && s.kind == SuggestionKind::Insert
}

/// A suggested node's Markdown, as the suggestion would make it: what it adds, or what it takes
/// away (other suggestions inside it left out).
fn node_markdown(block: &Block, suggestion: &Suggestion) -> String {
    match decided_block(block, &|s| adds_with(s, suggestion)) {
        Some(block) => crate::markdown::to_markdown(&Doc { blocks: vec![block] }).trim_end().to_owned(),
        None => String::new(),
    }
}

/// An inline node as Markdown (a footnote as its note, `^[…]`).
fn inline_markdown(inline: &Inline) -> String {
    match inline {
        Inline::Text { text, .. } => text.clone(),
        Inline::HardBreak => "\n".to_owned(),
        Inline::InlineMath { latex } => format!("${latex}$"),
        Inline::Footnote { content } => format!("^[{content}]"),
        Inline::DocLink { title } => format!("[[{title}]]"),
        Inline::Suggested { inline, .. } => inline_markdown(inline),
    }
}

pub fn map_inlines(blocks: &mut [Block], f: &mut dyn FnMut(&mut Vec<Inline>)) {
    for block in blocks {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => f(content),
            Block::BulletList { items } | Block::OrderedList { items, .. } => {
                for item in items {
                    map_inlines(&mut item.blocks, f);
                }
            }
            Block::TaskList { items } => {
                for item in items {
                    map_inlines(&mut item.blocks, f);
                }
            }
            Block::Blockquote { blocks } => map_inlines(blocks, f),
            Block::Table { rows } => {
                for row in rows {
                    for cell in &mut row.cells {
                        map_inlines(&mut cell.blocks, f);
                    }
                }
            }
            Block::Suggested { block, .. } => map_inlines(std::slice::from_mut(block.as_mut()), f),
            _ => {}
        }
    }
}

fn normalize_blocks(blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        normalize_block(block);
    }
    blocks.retain(|block| !matches!(block.unsuggested(), Block::Table { rows } if rows.is_empty()));
}

fn normalize_block(block: &mut Block) {
    match block {
        Block::Paragraph { content } => {
            *content = normalize_inlines(std::mem::take(content));
        }
        Block::Heading { level, content } => {
            *content = normalize_inlines(std::mem::take(content));
            *level = (*level).clamp(1, 6);
        }
        Block::BulletList { items } | Block::OrderedList { items, .. } => {
            for item in items.iter_mut() {
                normalize_item_blocks(&mut item.blocks);
            }
            if items.is_empty() {
                items.push(ListItem {
                    blocks: vec![Block::empty_paragraph()],
                });
            }
        }
        Block::TaskList { items } => {
            for item in items.iter_mut() {
                normalize_item_blocks(&mut item.blocks);
            }
            if items.is_empty() {
                items.push(TaskItem {
                    checked: false,
                    blocks: vec![Block::empty_paragraph()],
                });
            }
        }
        Block::Blockquote { blocks } => {
            normalize_blocks(blocks);
            if blocks.is_empty() {
                blocks.push(Block::empty_paragraph());
            }
        }
        Block::Table { rows } => {
            rows.retain(|row| !row.cells.is_empty());
            for row in rows.iter_mut() {
                for cell in row.cells.iter_mut() {
                    normalize_blocks(&mut cell.blocks);
                    if cell.blocks.is_empty() {
                        cell.blocks.push(Block::empty_paragraph());
                    }
                    cell.colspan = cell.colspan.max(1);
                    cell.rowspan = cell.rowspan.max(1);
                }
            }
        }
        Block::CodeBlock { language, .. }
            if language.as_deref().is_some_and(|l| l.trim().is_empty()) => {
                *language = None;
            }
        Block::Suggested { block, .. } => normalize_block(block),
        _ => {}
    }
}

/// A list item's content must start with a paragraph (suggested or not).
fn normalize_item_blocks(blocks: &mut Vec<Block>) {
    normalize_blocks(blocks);
    if !matches!(blocks.first().map(Block::unsuggested), Some(Block::Paragraph { .. })) {
        blocks.insert(0, Block::empty_paragraph());
    }
}
