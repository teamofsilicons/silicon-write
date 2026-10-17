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
    pub colspan: u32,
    pub rowspan: u32,
    pub blocks: Vec<Block>,
}

impl Default for TableCell {
    fn default() -> Self {
        TableCell {
            header: false,
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
    DocLink { title: String },
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

    pub fn is_empty_paragraph(&self) -> bool {
        matches!(self, Block::Paragraph { content } if content.is_empty())
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
            Inline::DocLink { title } => out.push_str(title),
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
                {
                    if *prev_marks == marks {
                        prev.push_str(&text);
                        continue;
                    }
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
    /// left out, and text suggested for deletion stays.
    pub fn without_suggestions(&self) -> Doc {
        let mut doc = self.clone();
        map_inlines(&mut doc.blocks, &mut |content| {
            let kept = content
                .drain(..)
                .filter_map(|inline| match inline {
                    Inline::Text { text, marks } => match &marks.suggestion {
                        Some(s) if s.kind == SuggestionKind::Insert => None,
                        _ => Some(Inline::Text {
                            text,
                            marks: marks.without_suggestion(),
                        }),
                    },
                    other => Some(other),
                })
                .collect();
            *content = normalize_inlines(kept);
        });
        doc
    }

    /// The doc with every pending suggestion accepted.
    pub fn with_suggestions_accepted(&self) -> Doc {
        let mut doc = self.clone();
        map_inlines(&mut doc.blocks, &mut |content| {
            let kept = content
                .drain(..)
                .filter_map(|inline| match inline {
                    Inline::Text { text, marks } => match &marks.suggestion {
                        Some(s) if s.kind == SuggestionKind::Delete => None,
                        _ => Some(Inline::Text {
                            text,
                            marks: marks.without_suggestion(),
                        }),
                    },
                    other => Some(other),
                })
                .collect();
            *content = normalize_inlines(kept);
        });
        doc
    }

    /// Every pending suggestion, in document order: what it would insert and what it would
    /// delete.
    pub fn suggestions(&self) -> Vec<SuggestionSummary> {
        let mut found: Vec<SuggestionSummary> = vec![];
        let mut blocks = self.blocks.clone();
        map_inlines(&mut blocks, &mut |content| {
            for inline in content.iter() {
                if let Inline::Text {
                    text,
                    marks:
                        Marks {
                            suggestion: Some(s),
                            ..
                        },
                } = inline
                {
                    let entry = match found.iter_mut().position(|f| f.id == s.id) {
                        Some(i) => &mut found[i],
                        None => {
                            found.push(SuggestionSummary {
                                id: s.id.clone(),
                                author: s.author.clone(),
                                inserted: String::new(),
                                deleted: String::new(),
                            });
                            found.last_mut().unwrap()
                        }
                    };
                    match s.kind {
                        SuggestionKind::Insert => entry.inserted.push_str(text),
                        SuggestionKind::Delete => entry.deleted.push_str(text),
                    }
                }
            }
        });
        found
    }

    /// The titles of every `[[doc link]]`.
    pub fn doc_links(&self) -> Vec<String> {
        let mut titles = vec![];
        let mut blocks = self.blocks.clone();
        map_inlines(&mut blocks, &mut |content| {
            for inline in content.iter() {
                if let Inline::DocLink { title } = inline {
                    if !titles.contains(title) {
                        titles.push(title.clone());
                    }
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

/// Calls `f` on the inline content of every text block, depth first.
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
            _ => {}
        }
    }
}

fn normalize_blocks(blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                *content = normalize_inlines(std::mem::take(content));
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
            Block::CodeBlock { language, .. } => {
                if language.as_deref().is_some_and(|l| l.trim().is_empty()) {
                    *language = None;
                }
            }
            _ => {}
        }
    }
    blocks.retain(|block| !matches!(block, Block::Table { rows } if rows.is_empty()));
    for block in blocks.iter_mut() {
        if let Block::Heading { level, .. } = block {
            *level = (*level).clamp(1, 6);
        }
    }
}

/// A list item's content must start with a paragraph.
fn normalize_item_blocks(blocks: &mut Vec<Block>) {
    normalize_blocks(blocks);
    if !matches!(blocks.first(), Some(Block::Paragraph { .. })) {
        blocks.insert(0, Block::empty_paragraph());
    }
}
