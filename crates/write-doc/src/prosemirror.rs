//! The doc as the editor's ProseMirror JSON (for read-only rendering of versions and public docs).

use serde_json::{Map, Value, json};

use crate::model::names::*;
use crate::model::*;

pub fn to_json(doc: &Doc) -> Value {
    json!({ "type": DOC, "content": blocks(&doc.blocks) })
}

fn blocks(blocks: &[Block]) -> Vec<Value> {
    blocks.iter().map(block).collect()
}

fn node(kind: &str, attrs: Option<Value>, content: Option<Vec<Value>>) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), json!(kind));
    if let Some(attrs) = attrs {
        map.insert("attrs".into(), attrs);
    }
    if let Some(content) = content {
        if !content.is_empty() {
            map.insert("content".into(), Value::Array(content));
        }
    }
    Value::Object(map)
}

fn block(block: &Block) -> Value {
    match block {
        Block::Paragraph { content } => node(PARAGRAPH, None, Some(inlines(content))),
        Block::Heading { level, content } => {
            node(HEADING, Some(json!({ "level": level })), Some(inlines(content)))
        }
        Block::BulletList { items } => node(
            BULLET_LIST,
            None,
            Some(items.iter().map(|i| node(LIST_ITEM, None, Some(blocks(&i.blocks)))).collect()),
        ),
        Block::OrderedList { start, items } => node(
            ORDERED_LIST,
            Some(json!({ "start": start })),
            Some(items.iter().map(|i| node(LIST_ITEM, None, Some(blocks(&i.blocks)))).collect()),
        ),
        Block::TaskList { items } => node(
            TASK_LIST,
            None,
            Some(
                items
                    .iter()
                    .map(|i| node(TASK_ITEM, Some(json!({ "checked": i.checked })), Some(blocks(&i.blocks))))
                    .collect(),
            ),
        ),
        Block::Blockquote { blocks: b } => node(BLOCKQUOTE, None, Some(blocks(b))),
        Block::CodeBlock { language, text } => node(
            CODE_BLOCK,
            Some(json!({ "language": language })),
            Some(if text.is_empty() { vec![] } else { vec![json!({ "type": "text", "text": text })] }),
        ),
        Block::HorizontalRule => node(HORIZONTAL_RULE, None, None),
        Block::Image { src, alt, title } => {
            node(IMAGE, Some(json!({ "src": src, "alt": alt, "title": title })), None)
        }
        Block::Table { rows } => node(
            TABLE,
            None,
            Some(
                rows.iter()
                    .map(|row| {
                        node(
                            TABLE_ROW,
                            None,
                            Some(
                                row.cells
                                    .iter()
                                    .map(|cell| {
                                        node(
                                            if cell.header { TABLE_HEADER } else { TABLE_CELL },
                                            Some(json!({ "colspan": cell.colspan, "rowspan": cell.rowspan })),
                                            Some(blocks(&cell.blocks)),
                                        )
                                    })
                                    .collect(),
                            ),
                        )
                    })
                    .collect(),
            ),
        ),
        Block::BlockMath { latex } => node(BLOCK_MATH, Some(json!({ "latex": latex })), None),
        Block::TableOfContents => node(TABLE_OF_CONTENTS, None, None),
    }
}

fn inlines(content: &[Inline]) -> Vec<Value> {
    content
        .iter()
        .filter_map(|inline| match inline {
            Inline::Text { text, marks } if !text.is_empty() => {
                let marks = mark_list(marks);
                let mut map = Map::new();
                map.insert("type".into(), json!("text"));
                map.insert("text".into(), json!(text));
                if !marks.is_empty() {
                    map.insert("marks".into(), Value::Array(marks));
                }
                Some(Value::Object(map))
            }
            Inline::Text { .. } => None,
            Inline::HardBreak => Some(node(HARD_BREAK, None, None)),
            Inline::InlineMath { latex } => Some(node(INLINE_MATH, Some(json!({ "latex": latex })), None)),
            Inline::Footnote { content } => Some(node(FOOTNOTE, Some(json!({ "content": content })), None)),
            Inline::DocLink { title } => Some(node(DOC_LINK, Some(json!({ "title": title })), None)),
        })
        .collect()
}

fn mark_list(marks: &Marks) -> Vec<Value> {
    let mut out = vec![];
    let simple = |name: &str| json!({ "type": name });
    if let Some(href) = &marks.link {
        out.push(json!({ "type": LINK, "attrs": { "href": href } }));
    }
    if marks.bold {
        out.push(simple(BOLD));
    }
    if marks.italic {
        out.push(simple(ITALIC));
    }
    if marks.underline {
        out.push(simple(UNDERLINE));
    }
    if marks.strike {
        out.push(simple(STRIKE));
    }
    if marks.code {
        out.push(simple(CODE));
    }
    if let Some(color) = &marks.color {
        out.push(json!({ "type": TEXT_STYLE, "attrs": { "color": color } }));
    }
    if let Some(color) = &marks.highlight {
        out.push(json!({ "type": HIGHLIGHT, "attrs": { "color": color } }));
    }
    if let Some(s) = &marks.suggestion {
        let name = match s.kind {
            SuggestionKind::Insert => SUGGESTION_INSERT,
            SuggestionKind::Delete => SUGGESTION_DELETE,
        };
        out.push(json!({ "type": name, "attrs": { "id": s.id, "author": s.author } }));
    }
    out
}
