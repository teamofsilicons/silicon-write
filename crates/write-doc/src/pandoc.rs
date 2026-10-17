//! Formats other than Markdown, through Pandoc's document tree (its JSON form).
//!
//! Opening a file: Pandoc reads it into its tree, and [`from_pandoc`] turns that into a doc.
//! Downloading: [`to_pandoc`] turns the doc into Pandoc's tree, and Pandoc writes the format.
//! Word files are written with [`DOCX_FILTER`], which keeps text colour and highlight (Pandoc
//! itself drops them); OpenDocument, rich text and PDF are made from that Word file by
//! LibreOffice, so they keep them too.

use serde_json::{Value, json};

use crate::markdown::inlines_to_markdown;
use crate::model::*;

pub const API_VERSION: [u32; 4] = [1, 23, 1, 2];

/// Options for writing a Pandoc tree.
#[derive(Default)]
pub struct PandocOut<'a> {
    /// Where an image's `src` should point for Pandoc to read it (a local file path).
    pub image_src: Option<&'a dyn Fn(&str) -> String>,
    pub title: Option<String>,
}

/// The doc as a Pandoc document. Returns the document and whether it has a table of contents.
pub fn to_pandoc(doc: &Doc, out: &PandocOut) -> (Value, bool) {
    let mut writer = PWriter {
        out,
        toc: false,
    };
    let blocks: Vec<Value> = doc
        .without_suggestions()
        .blocks
        .iter()
        .flat_map(|b| writer.block(b))
        .collect();
    let mut meta = json!({});
    if let Some(title) = &out.title {
        meta = json!({ "title": { "t": "MetaInlines", "c": str_inlines(title) } });
    }
    (
        json!({ "pandoc-api-version": API_VERSION, "meta": meta, "blocks": blocks }),
        writer.toc,
    )
}

struct PWriter<'a> {
    out: &'a PandocOut<'a>,
    toc: bool,
}

fn attr(classes: &[&str], kv: &[(&str, &str)]) -> Value {
    json!(["", classes, kv.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()])
}

fn no_attr() -> Value {
    json!(["", [], []])
}

fn str_inlines(text: &str) -> Vec<Value> {
    let mut out = vec![];
    let mut word = String::new();
    for c in text.chars() {
        if c == ' ' {
            if !word.is_empty() {
                out.push(json!({"t": "Str", "c": word}));
                word = String::new();
            }
            out.push(json!({"t": "Space"}));
        } else if c == '\n' {
            if !word.is_empty() {
                out.push(json!({"t": "Str", "c": word}));
                word = String::new();
            }
            out.push(json!({"t": "SoftBreak"}));
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        out.push(json!({"t": "Str", "c": word}));
    }
    out
}

impl PWriter<'_> {
    fn block(&mut self, block: &Block) -> Vec<Value> {
        vec![match block {
            Block::Paragraph { content } => json!({"t": "Para", "c": self.inlines(content)}),
            Block::Heading { level, content } => {
                json!({"t": "Header", "c": [level, no_attr(), self.inlines(content)]})
            }
            Block::BulletList { items } => json!({"t": "BulletList", "c": items
                .iter()
                .map(|i| self.blocks(&i.blocks))
                .collect::<Vec<_>>()}),
            Block::OrderedList { start, items } => json!({"t": "OrderedList", "c": [
                [start, {"t": "Decimal"}, {"t": "Period"}],
                items.iter().map(|i| self.blocks(&i.blocks)).collect::<Vec<_>>()
            ]}),
            Block::TaskList { items } => json!({"t": "BulletList", "c": items
                .iter()
                .map(|i| {
                    let mut blocks = self.blocks(&i.blocks);
                    let box_char = if i.checked { "☒" } else { "☐" };
                    if let Some(first) = blocks.first_mut()
                        && let Some(c) = first.get_mut("c").and_then(Value::as_array_mut) {
                            c.insert(0, json!({"t": "Space"}));
                            c.insert(0, json!({"t": "Str", "c": box_char}));
                        }
                    blocks
                })
                .collect::<Vec<_>>()}),
            Block::Blockquote { blocks } => json!({"t": "BlockQuote", "c": self.blocks(blocks)}),
            Block::CodeBlock { language, text } => {
                let classes: Vec<&str> = language.iter().map(String::as_str).collect();
                json!({"t": "CodeBlock", "c": [attr(&classes, &[]), text]})
            }
            Block::HorizontalRule => json!({"t": "HorizontalRule"}),
            Block::Image { src, alt, title } => {
                let src = match self.out.image_src {
                    Some(f) => f(src),
                    None => src.clone(),
                };
                json!({"t": "Para", "c": [{"t": "Image", "c": [
                    no_attr(),
                    str_inlines(alt.as_deref().unwrap_or("")),
                    [src, title.clone().unwrap_or_default()]
                ]}]})
            }
            Block::Table { rows } => self.table(rows),
            Block::BlockMath { latex } => {
                json!({"t": "Para", "c": [{"t": "Math", "c": [{"t": "DisplayMath"}, latex]}]})
            }
            Block::TableOfContents => {
                self.toc = true;
                return vec![];
            }
        }]
    }

    fn blocks(&mut self, blocks: &[Block]) -> Vec<Value> {
        blocks.iter().flat_map(|b| self.block(b)).collect()
    }

    fn table(&mut self, rows: &[TableRow]) -> Value {
        let columns = rows
            .iter()
            .map(|r| r.cells.iter().map(|c| c.colspan as usize).sum::<usize>())
            .max()
            .unwrap_or(0);
        let colspecs: Vec<Value> = (0..columns)
            .map(|_| json!([{"t": "AlignDefault"}, {"t": "ColWidthDefault"}]))
            .collect();
        let head_rows = if rows.first().is_some_and(|r| r.cells.iter().all(|c| c.header)) {
            1
        } else {
            0
        };
        let mut row_values = |rows: &[TableRow]| -> Vec<Value> {
            rows.iter()
                .map(|row| {
                    json!([no_attr(), row.cells.iter().map(|cell| json!([
                        no_attr(),
                        {"t": "AlignDefault"},
                        cell.rowspan,
                        cell.colspan,
                        self.blocks(&cell.blocks)
                    ])).collect::<Vec<_>>()])
                })
                .collect()
        };
        let head = row_values(&rows[..head_rows]);
        let body = row_values(&rows[head_rows..]);
        json!({"t": "Table", "c": [
            no_attr(),
            [null, []],
            colspecs,
            [no_attr(), head],
            [[no_attr(), 0, [], body]],
            [no_attr(), []]
        ]})
    }

    fn inlines(&mut self, content: &[Inline]) -> Vec<Value> {
        let mut out = vec![];
        for inline in content {
            match inline {
                Inline::Text { text, marks } => out.extend(wrap_marks(marks, str_text(text, marks))),
                Inline::HardBreak => out.push(json!({"t": "LineBreak"})),
                Inline::InlineMath { latex } => {
                    out.push(json!({"t": "Math", "c": [{"t": "InlineMath"}, latex]}))
                }
                Inline::Footnote { content } => {
                    let note = crate::markdown::from_markdown(content);
                    out.push(json!({"t": "Note", "c": self.blocks(&note.blocks)}));
                }
                Inline::DocLink { title } => out.push(json!({"t": "Str", "c": format!("[[{title}]]")})),
            }
        }
        out
    }
}

fn str_text(text: &str, marks: &Marks) -> Vec<Value> {
    if marks.code {
        vec![json!({"t": "Code", "c": [no_attr(), text]})]
    } else {
        str_inlines(text)
    }
}

fn wrap_marks(marks: &Marks, mut inner: Vec<Value>) -> Vec<Value> {
    let wrap = |t: &str, inner: Vec<Value>| vec![json!({"t": t, "c": inner})];
    if marks.italic {
        inner = wrap("Emph", inner);
    }
    if marks.bold {
        inner = wrap("Strong", inner);
    }
    if marks.strike {
        inner = wrap("Strikeout", inner);
    }
    if marks.underline {
        inner = wrap("Underline", inner);
    }
    if let Some(color) = &marks.highlight {
        let style = format!("background-color: {}", color.as_deref().unwrap_or("#fff3a3"));
        inner = vec![json!({"t": "Span", "c": [attr(&["mark"], &[("style", &style)]), inner]})];
    }
    if let Some(color) = &marks.color {
        let style = format!("color: {color}");
        inner = vec![json!({"t": "Span", "c": [attr(&[], &[("style", &style)]), inner]})];
    }
    if let Some(href) = &marks.link {
        inner = vec![json!({"t": "Link", "c": [no_attr(), inner, [href, ""]]})];
    }
    inner
}

/// A Pandoc Lua filter for Word files: turns coloured and highlighted spans into Word runs with
/// that colour or shading.
pub const DOCX_FILTER: &str = r##"
local function hex(value)
  if not value then return nil end
  local h = value:match("#(%x%x%x%x%x%x)")
  if h then return h:upper() end
  local s = value:match("#(%x%x%x)")
  if s then return (s:sub(1,1):rep(2) .. s:sub(2,2):rep(2) .. s:sub(3,3):rep(2)):upper() end
  local named = { red = "FF0000", blue = "0000FF", green = "008000", yellow = "FFFF00",
    orange = "FFA500", purple = "800080", gray = "808080", grey = "808080", black = "000000" }
  return named[value:lower()]
end

local function style_value(style, prop)
  if not style then return nil end
  for decl in style:gmatch("[^;]+") do
    local k, v = decl:match("^%s*([%w-]+)%s*:%s*(.-)%s*$")
    if k == prop then return v end
  end
  return nil
end

local function escape(text)
  return text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
end

-- Word run properties for the formatting directly around the text.
local function runs(inlines, props)
  local out = {}
  for _, el in ipairs(inlines) do
    if el.t == "Str" then
      table.insert(out, pandoc.RawInline("openxml",
        "<w:r><w:rPr>" .. props .. "</w:rPr><w:t xml:space=\"preserve\">" .. escape(el.text) .. "</w:t></w:r>"))
    elseif el.t == "Space" or el.t == "SoftBreak" then
      table.insert(out, pandoc.RawInline("openxml",
        "<w:r><w:rPr>" .. props .. "</w:rPr><w:t xml:space=\"preserve\"> </w:t></w:r>"))
    elseif el.t == "Strong" then
      for _, r in ipairs(runs(el.content, props .. "<w:b/>")) do table.insert(out, r) end
    elseif el.t == "Emph" then
      for _, r in ipairs(runs(el.content, props .. "<w:i/>")) do table.insert(out, r) end
    elseif el.t == "Underline" then
      for _, r in ipairs(runs(el.content, props .. "<w:u w:val=\"single\"/>")) do table.insert(out, r) end
    elseif el.t == "Strikeout" then
      for _, r in ipairs(runs(el.content, props .. "<w:strike/>")) do table.insert(out, r) end
    else
      table.insert(out, el)
    end
  end
  return out
end

function Span(el)
  local style = el.attributes["style"]
  local color = hex(style_value(style, "color"))
  local fill = hex(style_value(style, "background-color"))
  if not color and not fill then return nil end
  local props = ""
  if color then props = props .. "<w:color w:val=\"" .. color .. "\"/>" end
  if fill then props = props .. "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"" .. fill .. "\"/>" end
  return runs(el.content, props)
end
"##;

// ------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------

/// Reads a Pandoc document into a doc. Images keep the `src` Pandoc gives them; the caller
/// replaces the ones it uploads (see [`images`]).
pub fn from_pandoc(value: &Value) -> Doc {
    let blocks = value
        .get("blocks")
        .and_then(Value::as_array)
        .map(|b| read_blocks(b))
        .unwrap_or_default();
    Doc::new(blocks)
}

fn t(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn c(v: &Value) -> &Value {
    v.get("c").unwrap_or(&Value::Null)
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn read_blocks(blocks: &[Value]) -> Vec<Block> {
    blocks.iter().flat_map(read_block).collect()
}

fn read_block(block: &Value) -> Vec<Block> {
    let content = c(block);
    match t(block) {
        "Para" | "Plain" => paragraph_blocks(arr(content)),
        "LineBlock" => {
            let mut inlines = vec![];
            for (i, line) in arr(content).iter().enumerate() {
                if i > 0 {
                    inlines.push(Inline::HardBreak);
                }
                inlines.extend(read_inlines(arr(line), &Marks::default()));
            }
            vec![Block::paragraph(normalize_inlines(inlines))]
        }
        "Header" => {
            let a = arr(content);
            let level = a.first().and_then(Value::as_u64).unwrap_or(1).clamp(1, 6) as u8;
            vec![Block::Heading {
                level,
                content: normalize_inlines(read_inlines(arr(&a[2]), &Marks::default())),
            }]
        }
        "CodeBlock" => {
            let a = arr(content);
            let language = a
                .first()
                .and_then(|attr| arr(attr).get(1))
                .and_then(|classes| arr(classes).first())
                .and_then(Value::as_str)
                .map(str::to_owned);
            vec![Block::CodeBlock {
                language,
                text: a.get(1).and_then(Value::as_str).unwrap_or("").to_owned(),
            }]
        }
        "BlockQuote" => vec![Block::Blockquote {
            blocks: read_blocks(arr(content)),
        }],
        "BulletList" => vec![read_bullets(arr(content))],
        "OrderedList" => {
            let a = arr(content);
            let start = a
                .first()
                .and_then(|attrs| arr(attrs).first())
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32;
            vec![Block::OrderedList {
                start,
                items: arr(&a[1])
                    .iter()
                    .map(|item| ListItem {
                        blocks: read_blocks(arr(item)),
                    })
                    .collect(),
            }]
        }
        "DefinitionList" => {
            let mut out = vec![];
            for entry in arr(content) {
                let e = arr(entry);
                let term = read_inlines(arr(&e[0]), &Marks { bold: true, ..Marks::default() });
                out.push(Block::paragraph(normalize_inlines(term)));
                for def in arr(&e[1]) {
                    out.extend(read_blocks(arr(def)));
                }
            }
            out
        }
        "HorizontalRule" => vec![Block::HorizontalRule],
        "Table" => read_table(arr(content)),
        "Figure" => {
            let a = arr(content);
            read_blocks(arr(a.get(2).unwrap_or(&Value::Null)))
        }
        "Div" => {
            let a = arr(content);
            read_blocks(arr(a.get(1).unwrap_or(&Value::Null)))
        }
        "RawBlock" => {
            let a = arr(content);
            let format = a.first().and_then(Value::as_str).unwrap_or("");
            let text = a.get(1).and_then(Value::as_str).unwrap_or("");
            if format == "html" || format == "tex" || format == "latex" {
                if text.trim().is_empty() {
                    vec![]
                } else {
                    vec![Block::text_paragraph(text.trim())]
                }
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

fn read_bullets(items: &[Value]) -> Block {
    let parsed: Vec<Vec<Block>> = items.iter().map(|i| read_blocks(arr(i))).collect();
    // Pandoc writes task lists as bullets starting with a box character.
    let is_task = !parsed.is_empty()
        && parsed.iter().all(|blocks| {
            matches!(blocks.first(), Some(Block::Paragraph { content }) if matches!(content.first(), Some(Inline::Text { text, .. }) if text.starts_with('☐') || text.starts_with('☒')))
        });
    if is_task {
        let items = parsed
            .into_iter()
            .map(|mut blocks| {
                let mut checked = false;
                if let Some(Block::Paragraph { content }) = blocks.first_mut() {
                    if let Some(Inline::Text { text, .. }) = content.first_mut() {
                        checked = text.starts_with('☒');
                        *text = text.chars().skip(1).collect::<String>().trim_start().to_owned();
                    }
                    *content = normalize_inlines(std::mem::take(content));
                }
                TaskItem { checked, blocks }
            })
            .collect();
        return Block::TaskList { items };
    }
    Block::BulletList {
        items: parsed.into_iter().map(|blocks| ListItem { blocks }).collect(),
    }
}

fn read_table(a: &[Value]) -> Vec<Block> {
    let mut rows = vec![];
    let read_rows = |rows_value: &Value, header: bool, rows: &mut Vec<TableRow>| {
        for row in arr(rows_value) {
            let cells = arr(arr(row).get(1).unwrap_or(&Value::Null))
                .iter()
                .map(|cell| {
                    let cell = arr(cell);
                    TableCell {
                        header,
                        rowspan: cell.get(2).and_then(Value::as_u64).unwrap_or(1).max(1) as u32,
                        colspan: cell.get(3).and_then(Value::as_u64).unwrap_or(1).max(1) as u32,
                        blocks: read_blocks(arr(cell.get(4).unwrap_or(&Value::Null))),
                    }
                })
                .collect();
            rows.push(TableRow { cells });
        }
    };
    if let Some(head) = a.get(3) {
        read_rows(arr(head).get(1).unwrap_or(&Value::Null), true, &mut rows);
    }
    if let Some(bodies) = a.get(4) {
        for body in arr(bodies) {
            let body = arr(body);
            read_rows(body.get(2).unwrap_or(&Value::Null), true, &mut rows);
            read_rows(body.get(3).unwrap_or(&Value::Null), false, &mut rows);
        }
    }
    if let Some(foot) = a.get(5) {
        read_rows(arr(foot).get(1).unwrap_or(&Value::Null), false, &mut rows);
    }
    if rows.is_empty() {
        return vec![];
    }
    vec![Block::Table { rows }]
}

/// A paragraph, split around the images in it (images are blocks in the editor).
fn paragraph_blocks(inlines: &[Value]) -> Vec<Block> {
    // Display maths alone in a paragraph is a maths block.
    let meaningful: Vec<&Value> = inlines
        .iter()
        .filter(|i| !matches!(t(i), "Space" | "SoftBreak"))
        .collect();
    if meaningful.len() == 1 && t(meaningful[0]) == "Math" {
        let m = arr(c(meaningful[0]));
        if a_type(&m[0]) == "DisplayMath" {
            return vec![Block::BlockMath {
                latex: m.get(1).and_then(Value::as_str).unwrap_or("").to_owned(),
            }];
        }
    }
    let mut out = vec![];
    let mut current: Vec<Value> = vec![];
    let flush = |current: &mut Vec<Value>, out: &mut Vec<Block>| {
        let content = normalize_inlines(read_inlines(current, &Marks::default()));
        let has_text = content
            .iter()
            .any(|i| !matches!(i, Inline::Text { text, .. } if text.trim().is_empty()));
        if has_text {
            out.push(Block::paragraph(trim(content)));
        }
        current.clear();
    };
    for inline in inlines {
        if t(inline) == "Image" {
            flush(&mut current, &mut out);
            let a = arr(c(inline));
            let alt = plain(arr(&a[1]));
            let target = arr(&a[2]);
            out.push(Block::Image {
                src: target.first().and_then(Value::as_str).unwrap_or("").to_owned(),
                alt: (!alt.is_empty()).then_some(alt),
                title: target
                    .get(1)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            });
        } else {
            current.push(inline.clone());
        }
    }
    flush(&mut current, &mut out);
    if out.is_empty() {
        out.push(Block::empty_paragraph());
    }
    out
}

fn a_type(v: &Value) -> &str {
    t(v)
}

fn trim(mut content: Vec<Inline>) -> Vec<Inline> {
    if let Some(Inline::Text { text, .. }) = content.first_mut() {
        *text = text.trim_start().to_owned();
    }
    if let Some(Inline::Text { text, .. }) = content.last_mut() {
        *text = text.trim_end().to_owned();
    }
    normalize_inlines(content)
}

fn plain(inlines: &[Value]) -> String {
    let mut out = String::new();
    for inline in inlines {
        match t(inline) {
            "Str" => out.push_str(c(inline).as_str().unwrap_or("")),
            "Space" | "SoftBreak" | "LineBreak" => out.push(' '),
            "Code" | "Math" => out.push_str(arr(c(inline)).get(1).and_then(Value::as_str).unwrap_or("")),
            "Emph" | "Strong" | "Strikeout" | "Underline" | "Superscript" | "Subscript" | "SmallCaps" => {
                out.push_str(&plain(arr(c(inline))))
            }
            "Span" | "Quoted" | "Cite" => {
                let a = arr(c(inline));
                out.push_str(&plain(arr(a.get(1).unwrap_or(&Value::Null))))
            }
            "Link" | "Image" => {
                let a = arr(c(inline));
                out.push_str(&plain(arr(a.get(1).unwrap_or(&Value::Null))))
            }
            _ => {}
        }
    }
    out
}

fn style_of(attr: &Value) -> Option<String> {
    arr(arr(attr).get(2)?).iter().find_map(|kv| {
        let kv = arr(kv);
        (kv.first()?.as_str()? == "style").then(|| kv.get(1)?.as_str().map(str::to_owned))?
    })
}

fn css(style: &str, property: &str) -> Option<String> {
    style.split(';').find_map(|decl| {
        let (k, v) = decl.split_once(':')?;
        k.trim().eq_ignore_ascii_case(property).then(|| v.trim().to_owned())
    })
}

fn read_inlines(inlines: &[Value], marks: &Marks) -> Vec<Inline> {
    let mut out = vec![];
    for inline in inlines {
        let content = c(inline);
        let with = |f: &dyn Fn(&mut Marks)| {
            let mut m = marks.clone();
            f(&mut m);
            m
        };
        match t(inline) {
            "Str" => out.push(Inline::marked(content.as_str().unwrap_or(""), marks.clone())),
            "Space" | "SoftBreak" => out.push(Inline::marked(" ", marks.clone())),
            "LineBreak" => out.push(Inline::HardBreak),
            "Emph" => out.extend(read_inlines(arr(content), &with(&|m| m.italic = true))),
            "Strong" => out.extend(read_inlines(arr(content), &with(&|m| m.bold = true))),
            "Underline" => out.extend(read_inlines(arr(content), &with(&|m| m.underline = true))),
            "Strikeout" => out.extend(read_inlines(arr(content), &with(&|m| m.strike = true))),
            "Superscript" | "Subscript" | "SmallCaps" => out.extend(read_inlines(arr(content), marks)),
            "Quoted" => {
                let a = arr(content);
                let (open, close) = if t(&a[0]) == "SingleQuote" { ("‘", "’") } else { ("“", "”") };
                out.push(Inline::marked(open, marks.clone()));
                out.extend(read_inlines(arr(&a[1]), marks));
                out.push(Inline::marked(close, marks.clone()));
            }
            "Cite" => {
                let a = arr(content);
                out.extend(read_inlines(arr(a.get(1).unwrap_or(&Value::Null)), marks));
            }
            "Code" => {
                let a = arr(content);
                out.push(Inline::marked(
                    a.get(1).and_then(Value::as_str).unwrap_or(""),
                    with(&|m| m.code = true),
                ));
            }
            "Math" => {
                let a = arr(content);
                out.push(Inline::InlineMath {
                    latex: a.get(1).and_then(Value::as_str).unwrap_or("").to_owned(),
                });
            }
            "RawInline" => {
                let a = arr(content);
                if a.first().and_then(Value::as_str) == Some("html") {
                    let raw = a.get(1).and_then(Value::as_str).unwrap_or("");
                    if raw.eq_ignore_ascii_case("<br>") || raw.eq_ignore_ascii_case("<br/>") {
                        out.push(Inline::HardBreak);
                    }
                }
            }
            "Link" => {
                let a = arr(content);
                let href = arr(&a[2]).first().and_then(Value::as_str).unwrap_or("").to_owned();
                out.extend(read_inlines(arr(&a[1]), &with(&|m| m.link = Some(href.clone()))));
            }
            "Image" => {
                let a = arr(content);
                out.push(Inline::marked(plain(arr(&a[1])), marks.clone()));
            }
            "Note" => {
                let blocks = read_blocks(arr(content));
                let text: Vec<String> = blocks
                    .iter()
                    .filter_map(|b| b.inline_content().map(|c| inlines_to_markdown(c)))
                    .collect();
                out.push(Inline::Footnote {
                    content: text.join(" "),
                });
            }
            "Span" => {
                let a = arr(content);
                let style = style_of(&a[0]).unwrap_or_default();
                let classes: Vec<&str> = arr(arr(&a[0]).get(1).unwrap_or(&Value::Null))
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                let mut m = marks.clone();
                if let Some(color) = css(&style, "color") {
                    m.color = Some(color);
                }
                if let Some(bg) = css(&style, "background-color") {
                    m.highlight = Some(Some(bg));
                } else if classes.contains(&"mark") {
                    m.highlight = Some(None);
                }
                if classes.contains(&"underline") {
                    m.underline = true;
                }
                out.extend(read_inlines(arr(a.get(1).unwrap_or(&Value::Null)), &m));
            }
            _ => {}
        }
    }
    out
}

/// The `src` of every image, so the caller can upload them and point the doc at the copies.
pub fn images(doc: &Doc) -> Vec<String> {
    fn walk(blocks: &[Block], out: &mut Vec<String>) {
        for block in blocks {
            match block {
                Block::Image { src, .. } => out.push(src.clone()),
                Block::BulletList { items } | Block::OrderedList { items, .. } => {
                    for i in items {
                        walk(&i.blocks, out)
                    }
                }
                Block::TaskList { items } => {
                    for i in items {
                        walk(&i.blocks, out)
                    }
                }
                Block::Blockquote { blocks } => walk(blocks, out),
                Block::Table { rows } => {
                    for r in rows {
                        for c in &r.cells {
                            walk(&c.blocks, out)
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = vec![];
    walk(&doc.blocks, &mut out);
    out
}

/// Points images at new sources.
pub fn replace_images(doc: &mut Doc, map: &dyn Fn(&str) -> Option<String>) {
    fn walk(blocks: &mut [Block], map: &dyn Fn(&str) -> Option<String>) {
        for block in blocks {
            match block {
                Block::Image { src, .. } => {
                    if let Some(new) = map(src) {
                        *src = new;
                    }
                }
                Block::BulletList { items } | Block::OrderedList { items, .. } => {
                    for i in items {
                        walk(&mut i.blocks, map)
                    }
                }
                Block::TaskList { items } => {
                    for i in items {
                        walk(&mut i.blocks, map)
                    }
                }
                Block::Blockquote { blocks } => walk(blocks, map),
                Block::Table { rows } => {
                    for r in rows {
                        for c in &mut r.cells {
                            walk(&mut c.blocks, map)
                        }
                    }
                }
                _ => {}
            }
        }
    }
    walk(&mut doc.blocks, map);
}

/// Plain text into a doc: blank lines separate paragraphs, single line breaks are kept.
pub fn from_plain_text(text: &str) -> Doc {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = vec![];
    for para in normalized.split("\n\n") {
        let para = para.trim_matches('\n');
        if para.trim().is_empty() {
            continue;
        }
        let mut content = vec![];
        for (i, line) in para.split('\n').enumerate() {
            if i > 0 {
                content.push(Inline::HardBreak);
            }
            content.push(Inline::text(line));
        }
        blocks.push(Block::paragraph(normalize_inlines(content)));
    }
    Doc::new(blocks)
}
