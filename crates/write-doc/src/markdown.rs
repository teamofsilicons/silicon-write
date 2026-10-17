//! Markdown in and out.
//!
//! Markdown is how Silicons read and write every doc, so the round trip has to be exact: reading a
//! doc's Markdown back must give the same doc (apart from whitespace Markdown can't keep, like the
//! spaces at the start of a line). Formatting Markdown has no syntax for is written as a small set
//! of inline HTML tags (`<u>`, `<mark>`, `<span style="color: …">`, `<br>`), and those tags are read
//! back as the same formatting.
//!
//! Every block's text is checked after it's written: when the plain Markdown would read back
//! differently (emphasis next to punctuation is the usual cause), that block's formatting is
//! written with the HTML tags instead, which always read back exactly.

use std::collections::HashMap;

use comrak::nodes::{ListType, NodeValue};
use comrak::{Arena, Options, parse_document};

use crate::model::*;

/// How pending suggestions appear in the Markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SuggestionView {
    /// The doc as it reads now: suggested insertions are left out and text suggested for
    /// deletion is still there. This is the Markdown Silicons edit.
    #[default]
    Current,
    /// CriticMarkup: `{++inserted++}` and `{--deleted--}`.
    Critic,
}

#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub suggestions: SuggestionView,
    /// Text to place after top-level blocks: (block index, Markdown). Used to show comments next
    /// to the text they're on.
    pub annotations: Vec<(usize, String)>,
}

/// The doc as Markdown.
pub fn to_markdown(doc: &Doc) -> String {
    to_markdown_with(doc, &WriteOptions::default())
}

pub fn to_markdown_with(doc: &Doc, options: &WriteOptions) -> String {
    // Structural changes include their Markdown separators. Diff the two complete readings so
    // accepting/rejecting CriticMarkup also adds/removes those separators and footnote definitions.
    if options.suggestions == SuggestionView::Critic && has_rich_suggestions(doc) {
        let current_options = WriteOptions { suggestions: SuggestionView::Current, annotations: options.annotations.clone() };
        let before = to_markdown_with(doc, &current_options);
        let after = to_markdown_with(&doc.with_suggestions_accepted(), &current_options);
        let diff = similar::TextDiff::configure().timeout(std::time::Duration::from_millis(500)).diff_words(&before, &after);
        let mut out = String::new();
        let mut active = similar::ChangeTag::Equal;
        for change in diff.iter_all_changes() {
            let tag = change.tag();
            if tag != active {
                match active { similar::ChangeTag::Delete => out.push_str("--}"), similar::ChangeTag::Insert => out.push_str("++}"), _ => {} }
                match tag { similar::ChangeTag::Delete => out.push_str("{--"), similar::ChangeTag::Insert => out.push_str("{++"), _ => {} }
                active = tag;
            }
            out.push_str(change.value());
        }
        match active { similar::ChangeTag::Delete => out.push_str("--}"), similar::ChangeTag::Insert => out.push_str("++}"), _ => {} }
        return out;
    }
    let mut writer = Writer {
        options: options.clone(),
        footnotes: vec![],
    };
    let body = if options.annotations.is_empty() {
        writer.blocks(&doc.blocks)
    } else {
        writer.annotated(&doc.blocks, &options.annotations)
    };
    let mut out = body;
    if !writer.footnotes.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        let defs: Vec<String> = writer
            .footnotes
            .iter()
            .enumerate()
            .map(|(i, content)| format!("[^{}]: {}", i + 1, content))
            .collect();
        out.push_str(&defs.join("\n"));
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn has_rich_suggestions(doc: &Doc) -> bool {
    fn inline(i: &Inline) -> bool { matches!(i, Inline::Suggested { .. }) || matches!(i, Inline::Text { marks, .. } if marks.suggestion.is_some() && !marks.without_suggestion().is_plain()) }
    fn block(b: &Block) -> bool {
        match b {
            Block::Suggested { .. } => true,
            Block::Paragraph { content } | Block::Heading { content, .. } => content.iter().any(inline),
            Block::BulletList { items } | Block::OrderedList { items, .. } => items.iter().any(|i| i.blocks.iter().any(block)),
            Block::TaskList { items } => items.iter().any(|i| i.blocks.iter().any(block)),
            Block::Blockquote { blocks } => blocks.iter().any(block),
            Block::Table { rows } => rows.iter().any(|r| r.cells.iter().any(|c| c.blocks.iter().any(block))),
            _ => false,
        }
    }
    doc.blocks.iter().any(block)
}

/// Inline content as Markdown (used for footnote text and table cells).
pub fn inlines_to_markdown(content: &[Inline]) -> String {
    let mut writer = Writer {
        options: WriteOptions::default(),
        footnotes: vec![],
    };
    writer.inline_checked(content, InlineCtx::default())
}

struct Writer {
    options: WriteOptions,
    footnotes: Vec<String>,
}

#[derive(Clone, Copy, Default)]
struct InlineCtx {
    in_table: bool,
    in_heading: bool,
}

impl Writer {
    /// Top-level blocks, each followed by its annotations.
    fn annotated(&mut self, blocks: &[Block], annotations: &[(usize, String)]) -> String {
        let mut parts: Vec<String> = vec![];
        for (i, block) in blocks.iter().enumerate() {
            if !block.is_empty_paragraph() {
                let rendered = self.blocks(std::slice::from_ref(block));
                if !rendered.is_empty() { parts.push(rendered); }
            }
            for (_, note) in annotations.iter().filter(|(at, _)| *at == i) {
                parts.push(note.clone());
            }
        }
        parts.join("\n\n")
    }

    fn blocks(&mut self, blocks: &[Block]) -> String {
        let mut parts: Vec<String> = vec![];
        let mut previous: Option<Block> = None;
        let mut list_alt = false;
        for raw in blocks {
            let current;
            let block = if self.options.suggestions == SuggestionView::Current {
                current = decided_block(raw, &|_| false);
                let Some(block) = current.as_ref() else { continue };
                block
            } else { raw };
            // An empty paragraph has no Markdown form: Markdown collapses blank lines.
            if block.is_empty_paragraph() {
                continue;
            }
            // A paragraph or heading that is only suggested text isn't there yet.
            if let Some(content) = block.inline_content()
                && !content.is_empty() && self.view(content).is_empty() {
                    continue;
                }
            // Two lists of the same kind in a row would read back as one list: alternate the
            // bullet (or the ordered delimiter) to keep them apart.
            let same_kind_list = matches!(
                (previous.as_ref(), block),
                (Some(Block::BulletList { .. }), Block::BulletList { .. })
                    | (Some(Block::TaskList { .. }), Block::TaskList { .. })
                    | (Some(Block::OrderedList { .. }), Block::OrderedList { .. })

            );
            list_alt = same_kind_list && !list_alt;
            if !same_kind_list {
                list_alt = false;
            }
            let rendered = self.block(block, list_alt);
            let mixed_list = matches!((previous.as_ref(), block),
                (Some(Block::BulletList { .. }), Block::TaskList { .. })
                | (Some(Block::TaskList { .. }), Block::BulletList { .. }));
            if mixed_list && let Some(part) = parts.last_mut() {
                part.push('\n');
                part.push_str(&rendered);
            } else { parts.push(rendered); }
            previous = Some(block.clone());
        }
        parts.join("\n\n")
    }

    fn block(&mut self, block: &Block, alt: bool) -> String {
        match block {
            Block::Suggested { suggestion, block } => {
                let text = self.block(block, alt);
                match (suggestion.kind, self.options.suggestions) {
                    (SuggestionKind::Insert, SuggestionView::Current) => String::new(),
                    (_, SuggestionView::Current) => text,
                    (SuggestionKind::Insert, _) => format!("{{++{text}++}}"),
                    (SuggestionKind::Delete, _) => format!("{{--{text}--}}"),
                }
            }
            Block::Paragraph { content } => self.paragraph(content),
            Block::Heading { level, content } => {
                let ctx = InlineCtx {
                    in_heading: true,
                    ..Default::default()
                };
                let mut text = self.inline_checked(content, ctx);
                // A closing run of `#` would be read as the end of the heading.
                if text.ends_with('#') {
                    let trimmed = text.trim_end_matches('#').to_owned();
                    let hashes = text.len() - trimmed.len();
                    text = format!("{trimmed}{}", "\\#".repeat(hashes));
                }
                if text.is_empty() {
                    "#".repeat(*level as usize)
                } else {
                    format!("{} {}", "#".repeat(*level as usize), text)
                }
            }
            Block::BulletList { items } => {
                let bullet = if alt { "*" } else { "-" };
                let rendered: Vec<String> = items
                    .iter()
                    .map(|item| self.list_item(&format!("{bullet} "), &item.blocks))
                    .collect();
                rendered.join("\n")
            }
            Block::OrderedList { start, items } => {
                let delim = if alt { ")" } else { "." };
                let rendered: Vec<String> = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        let number = *start as usize + i;
                        self.list_item(&format!("{number}{delim} "), &item.blocks)
                    })
                    .collect();
                rendered.join("\n")
            }
            Block::TaskList { items } => {
                let bullet = if alt { "*" } else { "-" };
                let rendered: Vec<String> = items
                    .iter()
                    .map(|item| {
                        let check = if item.checked { "x" } else { " " };
                        self.task_item(bullet, check, &item.blocks)
                    })
                    .collect();
                rendered.join("\n")
            }
            Block::Blockquote { blocks } => {
                let inner = self.blocks(blocks);
                prefix_lines(&inner, "> ", ">")
            }
            Block::CodeBlock { language, text } => {
                let longest = longest_run(text, '`');
                let fence = "`".repeat((longest + 1).max(3));
                let lang = language.as_deref().unwrap_or("");
                if text.is_empty() {
                    format!("{fence}{lang}\n{fence}")
                } else {
                    format!("{fence}{lang}\n{text}\n{fence}")
                }
            }
            Block::HorizontalRule => "---".to_owned(),
            Block::Image { src, alt, title } => image_markdown(src, alt.as_deref(), title.as_deref()),
            Block::Table { rows } => self.table(rows),
            Block::BlockMath { latex } => format!("$$\n{}\n$$", latex.trim_matches('\n')),
            Block::TableOfContents => "[[_TOC_]]".to_owned(),
        }
    }

    fn paragraph(&mut self, content: &[Inline]) -> String {
        let text = self.inline_checked(content, InlineCtx::default());
        // A paragraph whose text alone would read as another block keeps its meaning by escaping.
        if text.trim() == "[[_TOC_]]" {
            return "\\[\\[\\_TOC\\_\\]\\]".to_owned();
        }
        text
    }

    fn list_item(&mut self, marker: &str, blocks: &[Block]) -> String {
        let indent = " ".repeat(marker.len());
        let body = self.item_body(blocks);
        if body.is_empty() {
            return marker.trim_end().to_owned();
        }
        let mut out = String::new();
        for (i, line) in body.split('\n').enumerate() {
            if i == 0 {
                out.push_str(marker);
                out.push_str(line);
            } else if line.is_empty() {
                out.push('\n');
            } else {
                out.push('\n');
                out.push_str(&indent);
                out.push_str(line);
            }
        }
        out
    }

    fn task_item(&mut self, bullet: &str, check: &str, blocks: &[Block]) -> String {
        let marker = format!("{bullet} [{check}] ");
        let body = self.item_body(blocks);
        if body.is_empty() {
            return marker.trim_end().to_owned();
        }
        let indent = "  ";
        let mut out = String::new();
        for (i, line) in body.split('\n').enumerate() {
            if i == 0 {
                out.push_str(&marker);
                out.push_str(line);
            } else if line.is_empty() {
                out.push('\n');
            } else {
                out.push('\n');
                out.push_str(indent);
                out.push_str(line);
            }
        }
        out
    }

    /// The blocks of a list item: a nested list follows its paragraph directly (a tight list).
    fn item_body(&mut self, blocks: &[Block]) -> String {
        let mut out = String::new();
        let mut first = true;
        let mut previous: Option<Block> = None;
        for block in blocks {
            if block.is_empty_paragraph() {
                continue;
            }
            let rendered = if block.is_empty_paragraph() {
                String::new()
            } else {
                self.block(block, false)
            };
            if !first {
                let nested_list = matches!(
                    block,
                    Block::BulletList { .. } | Block::OrderedList { .. } | Block::TaskList { .. }
                ) && matches!(previous, Some(Block::Paragraph { .. }));
                out.push_str(if nested_list { "\n" } else { "\n\n" });
            }
            out.push_str(&rendered);
            first = false;
            previous = Some(block.clone());
        }
        out
    }

    fn table(&mut self, rows: &[TableRow]) -> String {
        if rows.is_empty() {
            return String::new();
        }
        if let Some(gfm) = self.gfm_table(rows) {
            return gfm;
        }
        // Spanned cells, several blocks in a cell, or no header row: an HTML table with
        // Markdown in its cells.
        let mut out = String::from("<table>");
        for row in rows {
            out.push_str("\n<tr>");
            for cell in &row.cells {
                let tag = if cell.header { "th" } else { "td" };
                let mut attrs = String::new();
                if cell.colspan > 1 {
                    attrs.push_str(&format!(" colspan=\"{}\"", cell.colspan));
                }
                if cell.rowspan > 1 {
                    attrs.push_str(&format!(" rowspan=\"{}\"", cell.rowspan));
                }
                if let Some(align) = &cell.align { attrs.push_str(&format!(" style=\"text-align: {}\"", attr_escape(align))); }
                let inner = self.blocks(&cell.blocks);
                if inner.is_empty() {
                    out.push_str(&format!("\n<{tag}{attrs}>\n</{tag}>"));
                } else {
                    out.push_str(&format!("\n<{tag}{attrs}>\n\n{inner}\n\n</{tag}>"));
                }
            }
            out.push_str("\n</tr>");
        }
        out.push_str("\n</table>");
        out
    }

    fn gfm_table(&mut self, rows: &[TableRow]) -> Option<String> {
        let columns = rows[0].cells.len();
        if columns == 0 {
            return None;
        }
        let simple_cell = |cell: &TableCell| {
            cell.colspan == 1
                && cell.rowspan == 1
                && cell.blocks.len() == 1
                && matches!(cell.blocks[0], Block::Paragraph { .. })
        };
        for (r, row) in rows.iter().enumerate() {
            if row.cells.len() != columns || !row.cells.iter().all(simple_cell) {
                return None;
            }
            if row.cells.iter().any(|c| c.header != (r == 0)) {
                return None;
            }
        }
        let ctx = InlineCtx {
            in_table: true,
            ..Default::default()
        };
        let mut lines = vec![];
        for (r, row) in rows.iter().enumerate() {
            let cells: Vec<String> = row
                .cells
                .iter()
                .map(|cell| match &cell.blocks[0] {
                    Block::Paragraph { content } => self.inline_checked(content, ctx),
                    _ => String::new(),
                })
                .collect();
            lines.push(format!("| {} |", cells.join(" | ")));
            if r == 0 {
                let alignments: Vec<&str> = row.cells.iter().map(|c| match c.align.as_deref() {
                    Some("left") => ":---", Some("right") => "---:", Some("center") => ":---:", _ => "---"
                }).collect();
                lines.push(format!("| {} |", alignments.join(" | ")));
            }
        }
        Some(lines.join("\n"))
    }

    /// Writes inline content and checks it reads back the same; if it doesn't, writes the
    /// formatting as HTML tags instead.
    fn inline_checked(&mut self, content: &[Inline], ctx: InlineCtx) -> String {
        let content = self.view(content);
        let footnotes_before = self.footnotes.len();
        let pretty = self.inline(&content, ctx, false);
        if self.reads_back(&pretty, &content, ctx, footnotes_before) {
            return pretty;
        }
        self.footnotes.truncate(footnotes_before);
        self.inline(&content, ctx, true)
    }

    /// Applies the suggestion view.
    fn view(&self, content: &[Inline]) -> Vec<Inline> {
        let mut out = vec![];
        for inline in content {
            match inline {
                Inline::Text { text, marks } => match (&marks.suggestion, self.options.suggestions) {
                    (Some(s), SuggestionView::Current) if s.kind == SuggestionKind::Insert => {}
                    (Some(s), SuggestionView::Critic) => {
                        let (open, close) = match s.kind {
                            SuggestionKind::Insert => ("{++", "++}"),
                            SuggestionKind::Delete => ("{--", "--}"),
                        };
                        out.push(Inline::Text {
                            text: format!("{open}{text}{close}"),
                            marks: marks.without_suggestion(),
                        });
                    }
                    _ => out.push(Inline::Text {
                        text: text.clone(),
                        marks: marks.without_suggestion(),
                    }),
                },
                Inline::Suggested { suggestion, inline } => {
                    match (suggestion.kind, self.options.suggestions) {
                        (SuggestionKind::Insert, SuggestionView::Current) => {},
                        (_, SuggestionView::Current) => out.extend(self.view(std::slice::from_ref(inline))),
                        (kind, SuggestionView::Critic) => {
                            let (open, close) = if kind == SuggestionKind::Insert { ("{++", "++}") } else { ("{--", "--}") };
                            out.push(Inline::text(open));
                            out.extend(self.view(std::slice::from_ref(inline)));
                            out.push(Inline::text(close));
                        }
                    }
                }
                other => out.push(other.clone()),
            }
        }
        normalize_inlines(out)
    }

    fn reads_back(
        &self,
        markdown: &str,
        content: &[Inline],
        ctx: InlineCtx,
        footnotes_before: usize,
    ) -> bool {
        if self.options.suggestions == SuggestionView::Critic {
            return true;
        }
        // Read the text back the way it will be read: as a paragraph (or a table cell), with the
        // footnotes it references defined.
        let mut source = if ctx.in_table {
            format!("| {markdown} |\n| --- |")
        } else if ctx.in_heading {
            format!("# {markdown}")
        } else {
            markdown.to_owned()
        };
        if self.footnotes.len() > footnotes_before {
            source.push_str("\n\n");
            for (i, def) in self.footnotes.iter().enumerate().skip(footnotes_before) {
                source.push_str(&format!("[^{}]: {}\n", i + 1, def));
            }
        }
        let doc = from_markdown(&source);
        let read: Vec<Inline> = match doc.blocks.as_slice() {
            [] => vec![],
            [Block::Paragraph { content }] | [Block::Heading { content, .. }] => content.clone(),
            [Block::Table { rows }] => match rows.first().and_then(|r| r.cells.first()) {
                Some(TableCell { blocks, .. }) => match blocks.as_slice() {
                    [Block::Paragraph { content }] => content.clone(),
                    _ => return false,
                },
                None => return false,
            },
            _ => return false,
        };
        comparable(&read) == comparable(content)
    }

    fn inline(&mut self, content: &[Inline], ctx: InlineCtx, html: bool) -> String {
        let runs = to_runs(content);
        let mut out = String::new();
        let mut stack: Vec<MarkKey> = vec![];
        for (i, run) in runs.iter().enumerate() {
            let wanted = run.marks();
            // Close what this run doesn't have (and everything opened after it).
            if let Some(pos) = stack.iter().position(|m| !wanted.contains(m)) {
                while stack.len() > pos {
                    let mark = stack.pop().unwrap();
                    out.push_str(&close_mark(&mark, html));
                }
            }
            // Open what's new: longest-lasting first, so it nests outside.
            let mut opening: Vec<MarkKey> = wanted
                .iter()
                .filter(|m| !stack.contains(m) && !matches!(m, MarkKey::Code))
                .cloned()
                .collect();
            opening.sort_by_key(|m| {
                let lasts = runs[i..]
                    .iter()
                    .take_while(|r| r.marks().contains(m))
                    .count();
                (std::cmp::Reverse(lasts), m.order())
            });
            for mark in opening {
                out.push_str(&open_mark(&mark, html));
                stack.push(mark);
            }
            match run {
                Run::Text { text, marks } => {
                    if marks.code {
                        let code = code_span(text);
                        out.push_str(&if ctx.in_table { code.replace('|', "\\|") } else { code });
                    } else {
                        let at_line_start = out.is_empty() || out.ends_with('\n');
                        out.push_str(&escape_text(text, at_line_start, ctx.in_table));
                    }
                }
                Run::HardBreak => {
                    if ctx.in_table || ctx.in_heading {
                        out.push_str("<br>");
                    } else {
                        out.push_str("\\\n");
                    }
                }
                Run::Math(latex) => {
                    out.push('$');
                    out.push_str(latex);
                    out.push('$');
                }
                Run::Footnote(text) => {
                    self.footnotes.push(text.clone());
                    out.push_str(&format!("[^{}]", self.footnotes.len()));
                }
                Run::Image { src, alt, title, link, link_title } => {
                    let image = image_markdown(src, alt.as_deref(), title.as_deref());
                    if let Some(link) = link { out.push_str(&format!("[{image}]({}{})", link_destination(link), markdown_title(link_title.as_deref()))); }
                    else { out.push_str(&image); }
                }
                Run::DocLink(title, alias) => {
                    out.push_str("[[");
                    out.push_str(title);
                    if let Some(alias) = alias { out.push('|'); out.push_str(alias); }
                    out.push_str("]]");
                }
            }
        }
        while let Some(mark) = stack.pop() {
            out.push_str(&close_mark(&mark, html));
        }
        out
    }
}

/// Inline content as compared after a round trip: Markdown can't keep spaces at the start or
/// end of a line, or a link around nothing.
fn comparable(content: &[Inline]) -> Vec<Inline> {
    let mut lines: Vec<Vec<Inline>> = vec![vec![]];
    for inline in content {
        match inline {
            Inline::HardBreak => lines.push(vec![]),
            other => lines.last_mut().unwrap().push(other.clone()),
        }
    }
    let mut out = vec![];
    for (i, mut line) in lines.into_iter().enumerate() {
        if i > 0 {
            out.push(Inline::HardBreak);
        }
        if let Some(Inline::Text { text, .. }) = line.first_mut() {
            *text = text.trim_start().to_owned();
        }
        if let Some(Inline::Text { text, .. }) = line.last_mut() {
            *text = text.trim_end().to_owned();
        }
        out.extend(line);
    }
    normalize_inlines(out)
}

#[derive(Debug, Clone, PartialEq)]
enum MarkKey {
    Link(String, Option<String>),
    Subscript,
    Superscript,
    Color(String),
    Highlight(Option<String>),
    Underline,
    Strike,
    Bold,
    Italic,
    Code,
}

impl MarkKey {
    fn order(&self) -> u8 {
        match self {
            MarkKey::Link(..) => 0,
            MarkKey::Subscript | MarkKey::Superscript => 8,
            MarkKey::Color(_) => 1,
            MarkKey::Highlight(_) => 2,
            MarkKey::Underline => 3,
            MarkKey::Strike => 4,
            MarkKey::Bold => 5,
            MarkKey::Italic => 6,
            MarkKey::Code => 7,
        }
    }
}

enum Run {
    Text { text: String, marks: Marks },
    HardBreak,
    Math(String),
    Footnote(String),
    DocLink(String, Option<String>),
    Image { src: String, alt: Option<String>, title: Option<String>, link: Option<String>, link_title: Option<String> },
}

impl Run {
    fn marks(&self) -> Vec<MarkKey> {
        match self {
            Run::Text { marks, .. } => mark_keys(marks),
            _ => vec![],
        }
    }
}

fn mark_keys(marks: &Marks) -> Vec<MarkKey> {
    let mut keys = vec![];
    if let Some(href) = &marks.link {
        keys.push(MarkKey::Link(href.clone(), marks.link_title.clone()));
    }
    if let Some(color) = &marks.color {
        keys.push(MarkKey::Color(color.clone()));
    }
    if let Some(color) = &marks.highlight {
        keys.push(MarkKey::Highlight(color.clone()));
    }
    if marks.underline {
        keys.push(MarkKey::Underline);
    }
    if marks.strike {
        keys.push(MarkKey::Strike);
    }
    if marks.bold {
        keys.push(MarkKey::Bold);
    }
    if marks.italic {
        keys.push(MarkKey::Italic);
    }
    if marks.subscript { keys.push(MarkKey::Subscript); }
    if marks.superscript { keys.push(MarkKey::Superscript); }
    if marks.code {
        keys.push(MarkKey::Code);
    }
    keys
}

fn to_runs(content: &[Inline]) -> Vec<Run> {
    content
        .iter()
        .map(|inline| match inline {
            Inline::Text { text, marks } => Run::Text {
                text: text.clone(),
                marks: marks.clone(),
            },
            Inline::Suggested { inline, .. } => to_runs(std::slice::from_ref(inline)).remove(0),
            Inline::HardBreak => Run::HardBreak,
            Inline::InlineMath { latex } => Run::Math(latex.clone()),
            Inline::Footnote { content } => Run::Footnote(content.clone()),
            Inline::DocLink { title, alias } => Run::DocLink(title.clone(), alias.clone()),
            Inline::Image { src, alt, title, link, link_title } => Run::Image {src:src.clone(),alt:alt.clone(),title:title.clone(),link:link.clone(),link_title:link_title.clone()},
        })
        .collect()
}

fn open_mark(mark: &MarkKey, html: bool) -> String {
    match (mark, html) {
        (MarkKey::Link(..), false) => "[".to_owned(),
        (MarkKey::Link(href, title), true) => format!("<a href=\"{}\"{}>", attr_escape(href), title.as_ref().map(|t| format!(" title=\"{}\"", attr_escape(t))).unwrap_or_default()),
        (MarkKey::Color(color), _) => format!("<span style=\"color: {}\">", attr_escape(color)),
        (MarkKey::Highlight(None), _) => "<mark>".to_owned(),
        (MarkKey::Highlight(Some(color)), _) => {
            format!("<mark style=\"background-color: {}\">", attr_escape(color))
        }
        (MarkKey::Subscript, _) => "<sub>".to_owned(),
        (MarkKey::Superscript, _) => "<sup>".to_owned(),
        (MarkKey::Underline, _) => "<u>".to_owned(),
        (MarkKey::Strike, false) => "~~".to_owned(),
        (MarkKey::Strike, true) => "<s>".to_owned(),
        (MarkKey::Bold, false) => "**".to_owned(),
        (MarkKey::Bold, true) => "<strong>".to_owned(),
        (MarkKey::Italic, false) => "*".to_owned(),
        (MarkKey::Italic, true) => "<em>".to_owned(),
        (MarkKey::Code, _) => String::new(),
    }
}

fn close_mark(mark: &MarkKey, html: bool) -> String {
    match (mark, html) {
        (MarkKey::Link(href, title), false) => format!("]({}{})", link_destination(href), markdown_title(title.as_deref())),
        (MarkKey::Link(..), true) => "</a>".to_owned(),
        (MarkKey::Color(_), _) => "</span>".to_owned(),
        (MarkKey::Highlight(_), _) => "</mark>".to_owned(),
        (MarkKey::Subscript, _) => "</sub>".to_owned(),
        (MarkKey::Superscript, _) => "</sup>".to_owned(),
        (MarkKey::Underline, _) => "</u>".to_owned(),
        (MarkKey::Strike, false) => "~~".to_owned(),
        (MarkKey::Strike, true) => "</s>".to_owned(),
        (MarkKey::Bold, false) => "**".to_owned(),
        (MarkKey::Bold, true) => "</strong>".to_owned(),
        (MarkKey::Italic, false) => "*".to_owned(),
        (MarkKey::Italic, true) => "</em>".to_owned(),
        (MarkKey::Code, _) => String::new(),
    }
}

fn attr_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn link_destination(href: &str) -> String {
    let needs_brackets = href.is_empty()
        || href.chars().any(|c| c.is_whitespace() || c == '(' || c == ')' || c == '<' || c == '>');
    if needs_brackets {
        format!("<{}>", href.replace('<', "%3C").replace('>', "%3E"))
    } else {
        href.replace('\\', "\\\\")
    }
}

fn markdown_title(title: Option<&str>) -> String {
    title.filter(|s| !s.is_empty()).map(|s| format!(" \"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))).unwrap_or_default()
}

fn image_markdown(src: &str, alt: Option<&str>, title: Option<&str>) -> String {
    let alt = alt
        .unwrap_or("")
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    let title = match title {
        Some(t) if !t.is_empty() => format!(" \"{}\"", t.replace('"', "\\\"")),
        _ => String::new(),
    };
    format!("![{alt}]({}{title})", link_destination(src))
}

fn code_span(text: &str) -> String {
    let longest = longest_run(text, '`');
    let fence = "`".repeat(longest + 1);
    let pad = text.starts_with('`')
        || text.ends_with('`')
        || (text.starts_with(' ') && text.ends_with(' ') && !text.trim().is_empty());
    if pad {
        format!("{fence} {text} {fence}")
    } else {
        format!("{fence}{text}{fence}")
    }
}

fn longest_run(text: &str, ch: char) -> usize {
    let mut longest = 0;
    let mut current = 0;
    for c in text.chars() {
        if c == ch {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    longest
}

fn prefix_lines(text: &str, prefix: &str, blank: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                blank.to_owned()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Escapes text so Markdown reads it as plain text.
fn escape_text(text: &str, at_line_start: bool, in_table: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    let mut start = 0;
    for (i, &c) in chars.iter().enumerate() {
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        let next = chars.get(i + 1).copied();
        let line_start = (i == 0 && at_line_start) || prev == Some('\n');
        let escape = match c {
            '\\' | '`' | '*' | '[' | ']' | '~' => true,
            '<' => true,
            '_' => {
                !(prev.is_some_and(char::is_alphanumeric) && next.is_some_and(char::is_alphanumeric))
            }
            '|' => in_table,
            '$' => next.is_some_and(|n| !n.is_whitespace() && !n.is_ascii_digit()),
            '&' => {
                let rest: String = chars[i + 1..].iter().take(32).collect();
                looks_like_entity(&rest)
            }
            '#' | '>' | '+' | '=' if line_start => true,
            '-' if line_start => true,
            '.' | ')' => {
                // `12.` or `3)` at the start of a line would start a list.

                let digits = &chars[start..i];
                (start > 0 || at_line_start)
                    && !digits.is_empty()
                    && digits.len() <= 9
                    && digits.iter().all(char::is_ascii_digit)
            }
            _ => false,
        };
        if escape {
            out.push('\\');
        }
        out.push(c);
        if c == '\n' { start = i + 1; }
    }
    out
}

fn looks_like_entity(rest: &str) -> bool {
    let body: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '#')
        .collect();
    !body.is_empty() && rest[body.len()..].starts_with(';')
}

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.math_dollars = true;
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.autolink = false;
    options
}

/// Reads Markdown into a doc.
pub fn from_markdown(markdown: &str) -> Doc {
    let arena = Arena::new();
    let cleaned;
    let markdown = if markdown.contains('\0') { cleaned = markdown.replace('\0', ""); &cleaned } else { markdown };
    let root = parse_document(&arena, markdown, &options());
    let mut footnotes: HashMap<String, String> = HashMap::new();
    for node in root.children() {
        if let NodeValue::FootnoteDefinition(def) = &node.data().value {
            let blocks = read_blocks(node, &HashMap::new());
            let text: Vec<String> = blocks
                .iter()
                .filter_map(|b| b.inline_content().map(|c| inlines_to_markdown(c)))
                .collect();
            footnotes.insert(def.name.clone(), text.join(" "));
        }
    }
    let blocks = read_blocks(root, &footnotes);
    Doc::new(blocks)
}

type AstNode<'a> = &'a comrak::nodes::AstNode<'a>;

fn read_blocks<'a>(parent: AstNode<'a>, footnotes: &HashMap<String, String>) -> Vec<Block> {
    let mut blocks = vec![];
    let children: Vec<AstNode<'a>> = parent.children().collect();
    let mut i = 0;
    while i < children.len() {
        let node = children[i];
        let value = node.data().value.clone();
        match value {
            NodeValue::Paragraph => blocks.extend(read_paragraph(node, footnotes)),
            NodeValue::Heading(h) => {
                let content = read_inlines(node, footnotes);
                blocks.push(Block::Heading {
                    level: h.level,
                    content,
                });
            }
            NodeValue::List(list) => blocks.extend(read_list(node, list.list_type, list.start, footnotes)),
            NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => blocks.push(Block::Blockquote {
                blocks: read_blocks(node, footnotes),
            }),
            NodeValue::CodeBlock(code) => {
                let language = code
                    .info
                    .split_whitespace()
                    .next()
                    .map(str::to_owned)
                    .filter(|l| !l.is_empty());
                let mut text = code.literal.clone();
                if text.ends_with('\n') {
                    text.pop();
                }
                blocks.push(Block::CodeBlock { language, text });
            }
            NodeValue::ThematicBreak => blocks.push(Block::HorizontalRule),
            NodeValue::Table(_) => blocks.push(read_table(node, footnotes)),
            NodeValue::HtmlBlock(html) => {
                if is_table_tag(&html.literal) {
                    let (table, consumed) = read_html_table(&children[i..], footnotes);
                    if let Some(table) = table {
                        blocks.push(table);
                        i += consumed;
                        continue;
                    }
                }
                let literal = html.literal.trim_end_matches('\n');
                if literal.trim() == "<p></p>" {
                    blocks.push(Block::empty_paragraph());
                } else if !literal.trim().is_empty() {
                    blocks.push(Block::paragraph(vec![Inline::text(literal)]));
                }
            }
            NodeValue::FootnoteDefinition(_) => {}
            NodeValue::DescriptionList => {
                for item in node.children() {
                    for part in item.children() {
                        blocks.extend(read_blocks(part, footnotes));
                    }
                }
            }
            NodeValue::FrontMatter(_) => {}
            _ => {
                let inner = read_blocks(node, footnotes);
                blocks.extend(inner);
            }
        }
        i += 1;
    }
    blocks
}

/// A paragraph, which may really be an image, display maths, the table of contents, or
/// text with images in it (split into paragraphs around them).
fn read_paragraph<'a>(node: AstNode<'a>, footnotes: &HashMap<String, String>) -> Vec<Block> {
    let children: Vec<AstNode<'a>> = node.children().collect();
    let only = |pred: &dyn Fn(&NodeValue) -> bool| {
        let meaningful: Vec<&AstNode<'a>> = children
            .iter()
            .filter(|c| !matches!(&c.data().value, NodeValue::SoftBreak | NodeValue::LineBreak))
            .collect();
        meaningful.len() == 1 && pred(&meaningful[0].data().value)
    };
    if only(&|v| matches!(v, NodeValue::Math(m) if m.display_math)) {
        for child in &children {
            if let NodeValue::Math(m) = &child.data().value {
                return vec![Block::BlockMath {
                    latex: m.literal.trim_matches('\n').to_owned(),
                }];
            }
        }
    }
    if only(&|v| matches!(v, NodeValue::WikiLink(w) if w.url == "_TOC_")) {
        return vec![Block::TableOfContents];
    }
    let has_image = children
        .iter()
        .any(|c| matches!(c.data().value, NodeValue::Image(_)));
    if !has_image {
        return vec![Block::paragraph(read_inlines(node, footnotes))];
    }
    let mut blocks = vec![];
    let mut current: Vec<Inline> = vec![];
    let mut state = InlineState::default();
    for child in children {
        let value = child.data().value.clone();
        if let NodeValue::Image(link) = value {
            let content = normalize_inlines(std::mem::take(&mut current));
            if content.iter().any(|i| !matches!(i, Inline::Text { text, .. } if text.trim().is_empty())) {
                blocks.push(Block::paragraph(trim_inlines(content)));
            }
            let alt = plain_of(child);
            blocks.push(Block::Image {
                src: link.url.clone(),
                alt: (!alt.is_empty()).then_some(alt),
                title: (!link.title.is_empty()).then(|| link.title.clone()),
            });
        } else {
            read_inline_node(child, &mut state, &mut current, footnotes);
        }
    }
    let content = normalize_inlines(current);
    if content.iter().any(|i| !matches!(i, Inline::Text { text, .. } if text.trim().is_empty())) {
        blocks.push(Block::paragraph(trim_inlines(content)));
    }
    blocks
}

fn trim_inlines(mut content: Vec<Inline>) -> Vec<Inline> {
    while matches!(content.first(), Some(Inline::HardBreak)) {
        content.remove(0);
    }
    if let Some(Inline::Text { text, .. }) = content.first_mut() {
        *text = text.trim_start().to_owned();
    }
    if let Some(Inline::Text { text, .. }) = content.last_mut() {
        *text = text.trim_end().to_owned();
    }
    normalize_inlines(content)
}

fn plain_of<'a>(node: AstNode<'a>) -> String {
    let mut out = String::new();
    for child in node.descendants() {
        match &child.data().value {
            NodeValue::Text(t) => out.push_str(t),
            NodeValue::Code(c) => out.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {}
        }
    }
    out
}

fn read_list<'a>(node: AstNode<'a>, list_type: ListType, start: usize, footnotes: &HashMap<String, String>) -> Vec<Block> {
    let mut out = vec![];
    for item in node.children() {
        let blocks = read_blocks(item, footnotes);
        if let NodeValue::TaskItem(task) = &item.data().value {
            let task = TaskItem { checked: task.symbol.is_some(), blocks };
            if let Some(Block::TaskList { items }) = out.last_mut() { items.push(task); }
            else { out.push(Block::TaskList { items: vec![task] }); }
        } else {
            let item = ListItem { blocks };
            match (list_type, out.last_mut()) {
                (ListType::Bullet, Some(Block::BulletList { items })) | (ListType::Ordered, Some(Block::OrderedList { items, .. })) => items.push(item),
                (ListType::Bullet, _) => out.push(Block::BulletList { items: vec![item] }),
                (ListType::Ordered, _) => out.push(Block::OrderedList { start: start as u32, items: vec![item] }),
            }
        }
    }
    out
}

fn read_table<'a>(node: AstNode<'a>, footnotes: &HashMap<String, String>) -> Block {
    let alignments = if let NodeValue::Table(table) = &node.data().value { table.alignments.clone() } else { vec![] };
    let mut rows = vec![];
    for row in node.children() {
        let header = matches!(row.data().value, NodeValue::TableRow(true));
        let cells = row
            .children().enumerate()
            .map(|(i, cell)| TableCell {
                header,
                align: alignments.get(i).and_then(|a| match a { comrak::nodes::TableAlignment::Left => Some("left"), comrak::nodes::TableAlignment::Right => Some("right"), comrak::nodes::TableAlignment::Center => Some("center"), _ => None }).map(str::to_owned),
                colspan: 1,
                rowspan: 1,
                blocks: vec![Block::paragraph(read_inlines(cell, footnotes))],
            })
            .collect();
        rows.push(TableRow { cells });
    }
    Block::Table { rows }
}

fn is_table_tag(literal: &str) -> bool {
    literal.trim_start().to_ascii_lowercase().starts_with("<table")
}

/// Reads an HTML table written by [`Writer::table`]: HTML blocks for the structure with
/// Markdown blocks inside the cells. Returns the table and how many top-level nodes it used.
fn read_html_table<'a>(
    nodes: &[AstNode<'a>],
    footnotes: &HashMap<String, String>,
) -> (Option<Block>, usize) {
    let mut rows: Vec<TableRow> = vec![];
    let mut cell: Option<TableCell> = None;
    let mut consumed = 0;
    for node in nodes {
        consumed += 1;
        let value = node.data().value.clone();
        match value {
            NodeValue::HtmlBlock(html) => {
                let mut done = false;
                for tag in html_tags(&html.literal) {
                    match tag.name.as_str() {
                        "table" if !tag.closing => {}
                        "tr" if !tag.closing => rows.push(TableRow::default()),
                        "th" | "td" if !tag.closing => {
                            let span = |name: &str| {
                                tag.attr(name)
                                    .and_then(|v| v.parse::<u32>().ok())
                                    .unwrap_or(1)
                            };
                            cell = Some(TableCell {
                                header: tag.name == "th",
                                align: tag.attr("style").and_then(|s| style_value(s, "text-align")),
                                colspan: span("colspan"),
                                rowspan: span("rowspan"),
                                blocks: vec![],
                            });
                        }
                        "th" | "td" => {
                            if let (Some(mut finished), Some(row)) = (cell.take(), rows.last_mut()) {
                                if finished.blocks.is_empty() {
                                    finished.blocks.push(Block::empty_paragraph());
                                }
                                row.cells.push(finished);
                            }
                        }
                        "table" => done = true,
                        _ => {}
                    }
                }
                if done {
                    return (Some(Block::Table { rows }), consumed);
                }
            }
            _ => {
                let Some(open) = cell.as_mut() else {
                    return (None, 0);
                };
                // Read this one node as a block list of its own.
                let blocks = read_single(node, footnotes);
                open.blocks.extend(blocks);
            }
        }
    }
    (None, 0)
}

fn read_single<'a>(node: AstNode<'a>, footnotes: &HashMap<String, String>) -> Vec<Block> {
    let value = node.data().value.clone();
    match value {
        NodeValue::Paragraph => read_paragraph(node, footnotes),
        NodeValue::Heading(h) => vec![Block::Heading {
            level: h.level,
            content: read_inlines(node, footnotes),
        }],
        NodeValue::List(list) => read_list(node, list.list_type, list.start, footnotes),
        NodeValue::BlockQuote => vec![Block::Blockquote {
            blocks: read_blocks(node, footnotes),
        }],
        NodeValue::CodeBlock(code) => {
            let mut text = code.literal.clone();
            if text.ends_with('\n') {
                text.pop();
            }
            vec![Block::CodeBlock {
                language: code.info.split_whitespace().next().map(str::to_owned),
                text,
            }]
        }
        NodeValue::ThematicBreak => vec![Block::HorizontalRule],
        NodeValue::Table(_) => vec![read_table(node, footnotes)],
        _ => vec![],
    }
}

struct Tag {
    name: String,
    closing: bool,
    attrs: Vec<(String, String)>,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// A small tag reader for the handful of tags Silicon Write writes.
fn html_tags(source: &str) -> Vec<Tag> {
    let mut tags = vec![];
    let mut rest = source;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>') else {
            break;
        };
        let inner = &rest[start + 1..start + end];
        rest = &rest[start + end + 1..];
        if let Some(tag) = parse_tag(inner) {
            tags.push(tag);
        }
    }
    tags
}

fn parse_tag(inner: &str) -> Option<Tag> {
    let inner = inner.trim().trim_end_matches('/').trim();
    let (closing, inner) = match inner.strip_prefix('/') {
        Some(rest) => (true, rest.trim()),
        None => (false, inner),
    };
    let name_end = inner
        .find(|c: char| c.is_whitespace())
        .unwrap_or(inner.len());
    let name = inner[..name_end].to_ascii_lowercase();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let mut attrs = vec![];
    let mut rest = inner[name_end..].trim();
    while !rest.is_empty() {
        let key_end = rest
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(rest.len());
        let key = rest[..key_end].to_ascii_lowercase();
        rest = rest[key_end..].trim_start();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            let (value, remaining) = if let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let body = &after[1..];
                let close = body.find(q).unwrap_or(body.len());
                (&body[..close], body.get(close + 1..).unwrap_or(""))
            } else {
                let end = after.find(char::is_whitespace).unwrap_or(after.len());
                (&after[..end], &after[end..])
            };
            attrs.push((key, html_unescape(value)));
            rest = remaining.trim_start();
        } else {
            attrs.push((key, String::new()));
        }
    }
    Some(Tag {
        name,
        closing,
        attrs,
    })
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn style_value(style: &str, property: &str) -> Option<String> {
    style.split(';').find_map(|decl| {
        let (key, value) = decl.split_once(':')?;
        (key.trim().eq_ignore_ascii_case(property)).then(|| value.trim().to_owned())
    })
}

#[derive(Default, Clone)]
struct InlineState {
    marks: Marks,
    /// Marks opened by inline HTML tags, to close them by tag name.
    html_stack: Vec<(String, Marks)>,
}

fn read_inlines<'a>(node: AstNode<'a>, footnotes: &HashMap<String, String>) -> Vec<Inline> {
    let mut out = vec![];
    let mut state = InlineState::default();
    for child in node.children() {
        read_inline_node(child, &mut state, &mut out, footnotes);
    }
    trim_inlines(out)
}

fn read_inline_node<'a>(
    node: AstNode<'a>,
    state: &mut InlineState,
    out: &mut Vec<Inline>,
    footnotes: &HashMap<String, String>,
) {
    let value = node.data().value.clone();
    let with = |state: &mut InlineState, out: &mut Vec<Inline>, f: &dyn Fn(&mut Marks)| {
        let saved = state.marks.clone();
        f(&mut state.marks);
        for child in node.children() {
            read_inline_node(child, state, out, footnotes);
        }
        state.marks = saved;
    };
    match value {
        NodeValue::Text(text) => out.push(Inline::marked(text.to_string(), state.marks.clone())),
        NodeValue::SoftBreak => out.push(Inline::marked(" ", state.marks.clone())),
        NodeValue::LineBreak => out.push(Inline::HardBreak),
        NodeValue::Code(code) => {
            let mut marks = state.marks.clone();
            marks.code = true;
            out.push(Inline::marked(code.literal.clone(), marks));
        }
        NodeValue::Emph => with(state, out, &|m| m.italic = true),
        NodeValue::Strong => with(state, out, &|m| m.bold = true),
        NodeValue::Strikethrough => with(state, out, &|m| m.strike = true),
        NodeValue::Underline => with(state, out, &|m| m.underline = true),
        NodeValue::Highlight => with(state, out, &|m| m.highlight = Some(None)),
        NodeValue::Link(link) => {
            let url = link.url.clone();
            with(state, out, &|m| {m.link = Some(url.clone()); m.link_title = (!link.title.is_empty()).then(|| link.title.clone());})
        }
        NodeValue::Image(link) => {
            let alt = plain_of(node);
            out.push(Inline::Image { src: link.url, alt: (!alt.is_empty()).then_some(alt), title: (!link.title.is_empty()).then_some(link.title), link: state.marks.link.clone(), link_title: state.marks.link_title.clone() });
        }
        NodeValue::FootnoteReference(reference) => out.push(Inline::Footnote {
            content: footnotes
                .get(&reference.name)
                .cloned()
                .unwrap_or_default(),
        }),
        NodeValue::Math(math) => out.push(Inline::InlineMath {
            latex: math.literal.clone(),
        }),
        NodeValue::WikiLink(link) => out.push(Inline::DocLink {
            title: link.url.clone(),
            alias: { let label = plain_of(node); (!label.is_empty() && label != link.url).then_some(label) },
        }),
        NodeValue::HtmlInline(raw) => read_html_inline(&raw, state, out),
        NodeValue::Escaped | NodeValue::EscapedTag(_) => {
            for child in node.children() {
                read_inline_node(child, state, out, footnotes);
            }
        }
        _ => {
            for child in node.children() {
                read_inline_node(child, state, out, footnotes);
            }
        }
    }
}

fn read_html_inline(raw: &str, state: &mut InlineState, out: &mut Vec<Inline>) {
    let trimmed = raw.trim();
    let Some(tag) = trimmed
        .strip_prefix('<')
        .and_then(|t| t.strip_suffix('>'))
        .and_then(parse_tag)
    else {
        out.push(Inline::marked(raw, state.marks.clone()));
        return;
    };
    if tag.name == "br" {
        out.push(Inline::HardBreak);
        return;
    }
    let known = ["u", "ins", "s", "del", "strike", "strong", "b", "em", "i", "mark", "span", "a", "sub", "sup"];
    if !known.contains(&tag.name.as_str()) {
        out.push(Inline::marked(raw, state.marks.clone()));
        return;
    }
    if tag.closing {
        if let Some(pos) = state.html_stack.iter().rposition(|(name, _)| *name == tag.name) {
            let (_, saved) = state.html_stack.remove(pos);
            state.marks = saved;
        }
        return;
    }
    let saved = state.marks.clone();
    let marks = &mut state.marks;
    match tag.name.as_str() {
        "sub" => marks.subscript = true,
        "sup" => marks.superscript = true,
        "u" | "ins" => marks.underline = true,
        "s" | "del" | "strike" => marks.strike = true,
        "strong" | "b" => marks.bold = true,
        "em" | "i" => marks.italic = true,
        "mark" => {
            marks.highlight = Some(
                tag.attr("style")
                    .and_then(|s| style_value(s, "background-color")),
            )
        }
        "span" => {
            if let Some(color) = tag.attr("style").and_then(|s| style_value(s, "color")) {
                marks.color = Some(color);
            }
        }
        "a" => {
            if let Some(href) = tag.attr("href") {
                marks.link = Some(href.to_owned());
                marks.link_title = tag.attr("title").map(str::to_owned);
            }
        }
        _ => {}
    }
    state.html_stack.push((tag.name.clone(), saved));
}
