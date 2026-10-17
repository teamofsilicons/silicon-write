//! Formats other than Markdown, through Pandoc's document tree (its JSON form).
//!
//! Opening a file: Pandoc reads it into its tree, and [`from_pandoc`] turns that into a doc.
//! Word files are read with [`DOCX_READER`], Pandoc's own Word reader plus what it drops (text
//! colour and highlight, the title block).
//! Downloading: [`to_pandoc`] turns the doc into Pandoc's tree, and Pandoc writes the format.
//! Word files are written with [`DOCX_FILTER`], which keeps text colour and highlight (Pandoc
//! itself drops them); OpenDocument, rich text and PDF are made from that Word file by
//! LibreOffice, so they keep them too.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::markdown::inlines_to_markdown;
use crate::model::*;

pub const API_VERSION: [u32; 4] = [1, 23, 1, 2];

/// Options for writing a Pandoc tree.
#[derive(Default)]
pub struct PandocOut<'a> {
    /// Where an image's `src` should point for Pandoc to read it (a local file path).
    pub image_src: Option<&'a dyn Fn(&str) -> String>,
    /// The doc's title, as the file's own title where a format keeps one apart from the text (a
    /// web page's `<title>`). It is never written into the text: the doc's title isn't part of
    /// it, so a downloaded file opened again reads exactly as the doc did.
    pub title: Option<String>,
}

/// The doc as a Pandoc document. Returns the document and whether it has a table of contents.
pub fn to_pandoc(doc: &Doc, out: &PandocOut) -> (Value, bool) {
    let mut writer = PWriter {
        out,
        toc: false,
        ids: HashSet::new(),
    };
    let blocks: Vec<Value> = doc
        .without_suggestions()
        .blocks
        .iter()
        .flat_map(|b| writer.block(b))
        .collect();
    let mut meta = json!({});
    if let Some(title) = &out.title {
        meta = json!({ "pagetitle": { "t": "MetaInlines", "c": str_inlines(title) } });
    }
    (
        json!({ "pandoc-api-version": API_VERSION, "meta": meta, "blocks": blocks }),
        writer.toc,
    )
}

struct PWriter<'a> {
    out: &'a PandocOut<'a>,
    toc: bool,
    /// Heading identifiers given so far, so each is unique.
    ids: HashSet<String>,
}

/// A heading's identifier, made the way Pandoc makes them (so a table of contents can link to
/// it): its words in lower case joined by hyphens, without punctuation, from its first letter;
/// `-1`, `-2`… when another heading has it already.
fn heading_id(content: &[Inline], taken: &mut HashSet<String>) -> String {
    let mut text = String::new();
    for inline in content {
        match inline {
            Inline::Text { text: t, .. } => text.push_str(t),
            Inline::InlineMath { latex } => text.push_str(latex),
            Inline::DocLink { title, alias } => text.push_str(alias.as_deref().unwrap_or(title)),
            Inline::Image { alt, .. } => text.push_str(alt.as_deref().unwrap_or("")),
            Inline::HardBreak => text.push(' '),
            Inline::Footnote { .. } => {}
        }
    }
    let kept: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c == '\u{a0}' { ' ' } else { c })
        .filter(|c| c.is_alphanumeric() || "_-. ".contains(*c))
        .collect();
    let joined = kept.split_whitespace().collect::<Vec<_>>().join("-");
    let base = joined.trim_start_matches(|c: char| !c.is_alphabetic());
    let base = if base.is_empty() { "section" } else { base };
    let mut id = base.to_owned();
    let mut n = 0;
    while !taken.insert(id.clone()) {
        n += 1;
        id = format!("{base}-{n}");
    }
    id
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
                let id = heading_id(content, &mut self.ids);
                json!({"t": "Header", "c": [level, [id, [], []], self.inlines(content)]})
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
                        {"t": match cell.align.as_deref() { Some("left") => "AlignLeft", Some("right") => "AlignRight", Some("center") => "AlignCenter", _ => "AlignDefault" }},
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
                Inline::DocLink { title, alias } => out.push(json!({"t": "Str", "c": alias.as_ref().map(|a| format!("[[{title}|{a}]]")).unwrap_or_else(|| format!("[[{title}]]"))})),
                Inline::Image { src, alt, title, link, link_title } => {
                    let src = self.out.image_src.map(|f| f(src)).unwrap_or_else(|| src.clone());
                    let image = json!({"t": "Image", "c": [no_attr(), str_inlines(alt.as_deref().unwrap_or("")), [src, title.as_deref().unwrap_or("")]]});
                    out.push(match link {
                        Some(href) => json!({"t": "Link", "c": [no_attr(), [image], [href, link_title.as_deref().unwrap_or("")]]}),
                        None => image,
                    });
                }
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
    if marks.subscript {
        inner = wrap("Subscript", inner);
    }
    if marks.superscript {
        inner = wrap("Superscript", inner);
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
        inner = vec![json!({"t": "Link", "c": [no_attr(), inner, [href, marks.link_title.as_deref().unwrap_or("")]]})];
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
  local r, g, b = value:match("rgba?%(%s*(%d+)%s*,%s*(%d+)%s*,%s*(%d+)")
  if r then
    local function byte(v) return math.min(tonumber(v), 255) end
    return string.format("%02X%02X%02X", byte(r), byte(g), byte(b))
  end
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

/// A Pandoc reader for Word files (`pandoc -f docx.lua`): Pandoc's own Word reader, keeping two
/// things it drops.
///
/// - Text colour and highlight. A run's own colour (`w:color`), shading (`w:shd`) and highlight
///   (`w:highlight`) become a span styled with them, which [`from_pandoc`] reads as colour and
///   highlight. Before Pandoc reads the file, the text of each such run is put between two
///   markers (characters from a private-use plane no Word file uses; one that does is read as
///   it is), the first naming the run's colours; once read, what is between them becomes the
///   span. Black text and white shading are left out, as what a page looks like anyway, and so
///   is a link's colour: a link is shown as a link. Shading in the default highlight colour
///   (`#fff3a3`, what [`DOCX_FILTER`] writes for a highlight without a colour) is read back as
///   that highlight.
/// - The title block. Pandoc moves a file's title, subtitle, authors and date out of its text into
///   its metadata; they go back to the top of the text, the title as a heading, so nothing in the
///   file is lost. (Downloads never write the doc's title into the text, so a downloaded file
///   opened again reads as the doc did.)
pub const DOCX_READER: &str = r##"
local CLOSE = 0xF0000
local OPEN = 0xF0001 -- an opening marker is OPEN plus the index of its colours in `styles`, from 0
local styles = {}
local known = {}

-- Word's named highlight colours.
local HIGHLIGHT = {
  yellow = "FFFF00", green = "00FF00", cyan = "00FFFF", magenta = "FF00FF", blue = "0000FF", red = "FF0000",
  darkBlue = "000080", darkCyan = "008080", darkGreen = "008000", darkMagenta = "800080", darkRed = "800000",
  darkYellow = "808000", darkGray = "808080", lightGray = "C0C0C0", black = "000000", white = "FFFFFF",
}
local DEFAULT_HIGHLIGHT = "FFF3A3"
-- The first two bytes of every marker in UTF-8.
local MARKER_BYTES = "\243\176"

local function attr(tag, name)
  return tag:match("%s" .. name .. "%s*=%s*\"([^\"]*)\"") or tag:match("%s" .. name .. "%s*=%s*'([^']*)'")
end

local function hex(value)
  if value and value:match("^%x%x%x%x%x%x$") then return value:upper() end
  return nil
end

-- The index of a run's colours in `styles`, or nil when it has none to keep.
local function style_of(run)
  local color = hex(run.color)
  if color == "000000" then color = nil end
  local fill = nil
  if run.highlight and run.highlight ~= "none" then fill = HIGHLIGHT[run.highlight] end
  if not fill then fill = hex(run.fill) end
  if fill == "FFFFFF" then fill = nil end
  if not color and not fill then return nil end
  local key = (color or "") .. "/" .. (fill or "")
  if not known[key] then
    table.insert(styles, { color = color, fill = fill })
    known[key] = #styles
  end
  return known[key]
end

-- Where the tag that starts before `from` ends, past any quoted attribute value.
local function tag_end(xml, from)
  local i = from
  while true do
    local p = xml:find("[\"'>]", i)
    if not p then return nil end
    if xml:sub(p, p) == ">" then return p end
    local q = xml:find(xml:sub(p, p), p + 1, true)
    if not q then return nil end
    i = q + 1
  end
end

-- A part of the file (its XML) with markers around the text of every coloured run.
local function mark_runs(xml)
  local inserts = {}
  local stack = {} -- the names of the open elements
  local runs = {} -- the open runs: their depth in `stack`, colours and where their text starts and ends
  local fields = {} -- the open fields: whether each is a link and is past its instructions
  local links = 0 -- open w:hyperlink elements
  local pos = 1
  local function in_link()
    if links > 0 then return true end
    for _, field in ipairs(fields) do
      if field.link and field.result then return true end
    end
    return false
  end
  while true do
    local s = xml:find("<", pos, true)
    if not s then break end
    if xml:sub(s, s + 3) == "<!--" then
      local _, e = xml:find("-->", s + 4, true)
      pos = (e or #xml) + 1
    elseif xml:sub(s, s + 1) == "<?" or xml:sub(s, s + 1) == "<!" then
      local e = xml:find(">", s + 2, true)
      pos = (e or #xml) + 1
    else
      local e = tag_end(xml, s + 1)
      if not e then break end
      pos = e + 1
      local tag = xml:sub(s, e)
      local closing = tag:sub(2, 2) == "/"
      local empty = tag:sub(-2) == "/>"
      local name = tag:match("^</?([^%s/>]+)")
      local run = runs[#runs]
      local parent = stack[#stack]
      if closing then
        for i = #stack, 1, -1 do
          if stack[i] == name then
            for _ = #stack, i, -1 do table.remove(stack) end
            break
          end
        end
        if name == "w:r" and run then
          table.remove(runs)
          local index = (not run.link) and run.first and style_of(run)
          if index then
            table.insert(inserts, { at = run.first, text = utf8.char(OPEN + index - 1) })
            table.insert(inserts, { at = run.last, text = utf8.char(CLOSE) })
          end
        elseif name == "w:hyperlink" then
          links = links - 1
        elseif name == "w:fldSimple" then
          table.remove(fields)
        end
      elseif name == "w:t" and run and parent == "w:r" and #stack == run.depth then
        if not empty then
          local close = xml:find("</w:t>", pos, true)
          if not close then break end
          run.first = run.first or pos
          run.last = close
          pos = close + #"</w:t>"
        end
      elseif name == "w:instrText" and not empty then
        local close = xml:find("</w:instrText>", pos, true)
        if not close then break end
        local field = fields[#fields]
        if field and xml:sub(pos, close - 1):find("HYPERLINK", 1, true) then field.link = true end
        pos = close + #"</w:instrText>"
      else
        if name == "w:fldChar" then
          local kind = attr(tag, "w:fldCharType")
          if kind == "begin" then
            table.insert(fields, { link = false, result = false })
          elseif kind == "separate" and fields[#fields] then
            fields[#fields].result = true
          elseif kind == "end" then
            table.remove(fields)
          end
        elseif run and parent == "w:rPr" and #stack == run.depth + 1 then
          if name == "w:color" then
            run.color = attr(tag, "w:val")
          elseif name == "w:shd" then
            run.fill = attr(tag, "w:fill")
          elseif name == "w:highlight" then
            run.highlight = attr(tag, "w:val")
          end
        end
        if not empty then
          table.insert(stack, name)
          if name == "w:r" then
            table.insert(runs, { depth = #stack, link = in_link() })
          elseif name == "w:hyperlink" then
            links = links + 1
          elseif name == "w:fldSimple" then
            table.insert(fields, { link = (attr(tag, "w:instr") or ""):find("HYPERLINK", 1, true) ~= nil, result = true })
          end
        end
      end
    end
  end
  if #inserts == 0 then return xml end
  for i, insert in ipairs(inserts) do insert.order = i end
  table.sort(inserts, function(a, b)
    if a.at ~= b.at then return a.at < b.at end
    return a.order < b.order
  end)
  local out = {}
  local from = 1
  for _, insert in ipairs(inserts) do
    table.insert(out, xml:sub(from, insert.at - 1))
    table.insert(out, insert.text)
    from = insert.at
  end
  table.insert(out, xml:sub(from))
  return table.concat(out)
end

-- A string's text and markers, in order: strings for text, -1 or a style index for markers
-- (nil when it has none).
local function pieces(text)
  if not text:find(MARKER_BYTES, 1, true) then return nil end
  local out = {}
  local start = 1
  for p, code in utf8.codes(text) do
    local marker = nil
    if code == CLOSE then
      marker = -1
    elseif code >= OPEN and code < OPEN + #styles then
      marker = code - OPEN + 1
    end
    if marker then
      if p > start then table.insert(out, text:sub(start, p - 1)) end
      table.insert(out, marker)
      start = p + #utf8.char(code)
    end
  end
  if start <= #text then table.insert(out, text:sub(start)) end
  return out
end

local function span(index, content)
  local style = styles[index]
  local css = {}
  local classes = {}
  if style.color then table.insert(css, "color: #" .. style.color) end
  if style.fill == DEFAULT_HIGHLIGHT then
    table.insert(classes, "mark")
  elseif style.fill then
    table.insert(css, "background-color: #" .. style.fill)
  end
  local attributes = {}
  if #css > 0 then attributes.style = table.concat(css, "; ") end
  return pandoc.Span(content, pandoc.Attr("", classes, attributes))
end

-- Inlines with what is between an opening and a closing marker made a span with its colours.
local function unmark(inlines)
  local found = false
  for _, el in ipairs(inlines) do
    if el.t == "Str" and el.text:find(MARKER_BYTES, 1, true) then
      found = true
      break
    end
  end
  if not found then return nil end
  local out = pandoc.Inlines {}
  local open = nil
  for _, el in ipairs(inlines) do
    local parts = el.t == "Str" and pieces(el.text)
    if parts then
      for _, part in ipairs(parts) do
        if part == -1 then
          if open then
            out:insert(span(open.index, open.content))
            open = nil
          end
        elseif type(part) == "number" then
          if open then out:extend(open.content) end
          open = { index = part, content = pandoc.Inlines {} }
        elseif open then
          open.content:insert(pandoc.Str(part))
        else
          out:insert(pandoc.Str(part))
        end
      end
    elseif open then
      open.content:insert(el)
    else
      out:insert(el)
    end
  end
  if open then out:extend(open.content) end
  return out
end

-- Markers left where a colour can't be kept (in code), dropped.
local function stripped(el)
  local parts = pieces(el.text)
  if not parts then return nil end
  local text = {}
  for _, part in ipairs(parts) do
    if type(part) == "string" then table.insert(text, part) end
  end
  el.text = table.concat(text)
  return el
end

local function inlines_of(value)
  local kind = pandoc.utils.type(value)
  if kind == "Inlines" then return value end
  if kind == "string" then return pandoc.Inlines(value) end
  if kind == "Blocks" then return pandoc.utils.blocks_to_inlines(value) end
  return nil
end

-- The title, subtitle, authors and date, as the text they were at the top of the file.
local function title_block(meta)
  local blocks = pandoc.Blocks {}
  local function add(value, make)
    local inlines = value and inlines_of(value)
    if inlines and #inlines > 0 then blocks:insert(make(inlines)) end
  end
  add(meta.title, function(inlines) return pandoc.Header(1, inlines) end)
  add(meta.subtitle, pandoc.Para)
  local authors = meta.author
  if authors and pandoc.utils.type(authors) ~= "List" then authors = { authors } end
  for _, author in ipairs(authors or {}) do add(author, pandoc.Para) end
  add(meta.date, pandoc.Para)
  return blocks
end

function ByteStringReader(input, opts)
  local archive = pandoc.zip.Archive(input)
  local parts = { ["word/document.xml"] = true, ["word/footnotes.xml"] = true, ["word/endnotes.xml"] = true }
  local entries = {}
  local markable = true
  for _, entry in ipairs(archive.entries) do
    if parts[entry.path] then
      local xml = entry:contents()
      if xml:find(MARKER_BYTES, 1, true) then markable = false end
      entries[entry.path] = xml
    end
  end
  if markable then
    local marked = {}
    for _, entry in ipairs(archive.entries) do
      if entries[entry.path] then
        table.insert(marked, pandoc.zip.Entry(entry.path, mark_runs(entries[entry.path]), entry.modtime))
      else
        table.insert(marked, entry)
      end
    end
    input = pandoc.zip.Archive(marked):bytestring()
  end
  local doc = pandoc.read(input, "docx", opts)
  if #styles > 0 then
    doc = doc:walk { Inlines = unmark }
    doc = doc:walk { Str = stripped, Code = stripped, CodeBlock = stripped, RawInline = stripped, RawBlock = stripped }
  end
  local front = title_block(doc.meta)
  if #front > 0 then
    doc.blocks = front .. doc.blocks
    doc.meta.title = nil
    doc.meta.subtitle = nil
    doc.meta.author = nil
    doc.meta.date = nil
  end
  return doc
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
            // Pandoc's own web pages (Silicon Write's downloads among them) mark a code block
            // `sourceCode`, and `numberSource` when its lines are numbered, next to its language.
            let language = a
                .first()
                .and_then(|attr| arr(attr).get(1))
                .map(arr)
                .unwrap_or(&[])
                .iter()
                .filter_map(Value::as_str)
                .find(|class| !matches!(*class, "sourceCode" | "numberSource" | "numberLines" | "number-lines"))
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
    let align = |v: &Value| match t(v) {
        "AlignLeft" => Some("left".to_owned()),
        "AlignRight" => Some("right".to_owned()),
        "AlignCenter" => Some("center".to_owned()),
        _ => None,
    };
    let colspecs = arr(a.get(2).unwrap_or(&Value::Null));
    let read_rows = |rows_value: &Value, header: bool, rows: &mut Vec<TableRow>| {
        for row in arr(rows_value) {
            let mut column = 0usize;
            let cells = arr(arr(row).get(1).unwrap_or(&Value::Null))
                .iter()
                .map(|cell| {
                    let cell = arr(cell);
                    let colspan = cell.get(3).and_then(Value::as_u64).unwrap_or(1).max(1) as u32;
                    let inherited = colspecs.get(column).and_then(|c| arr(c).first()).and_then(&align);
                    column += colspan as usize;
                    TableCell {
                        align: cell.get(1).and_then(&align).or(inherited),
                        header,
                        rowspan: cell.get(2).and_then(Value::as_u64).unwrap_or(1).max(1) as u32,
                        colspan,
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
    // Keep mixed text and pictures in one paragraph; a standalone picture remains a block.
    if meaningful.len() == 1 && t(meaningful[0]) == "Image" {
        let a = arr(c(meaningful[0]));
        let alt = plain(arr(&a[1]));
        let target = arr(&a[2]);
        return vec![Block::Image {
            src: target.first().and_then(Value::as_str).unwrap_or("").to_owned(),
            alt: (!alt.is_empty()).then_some(alt),
            title: target.get(1).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
        }];
    }
    vec![Block::paragraph(trim(normalize_inlines(read_inlines(inlines, &Marks::default()))))]
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
            "Superscript" => out.extend(read_inlines(arr(content), &with(&|m| m.superscript = true))),
            "Subscript" => out.extend(read_inlines(arr(content), &with(&|m| m.subscript = true))),
            "SmallCaps" => out.extend(read_inlines(arr(content), marks)),
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
                let target = arr(&a[2]);
                let href = target.first().and_then(Value::as_str).unwrap_or("").to_owned();
                let title = target.get(1).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                out.extend(read_inlines(arr(&a[1]), &with(&|m| {
                    m.link = Some(href.clone());
                    m.link_title = title.clone();
                })));
            }
            "Image" => {
                let a = arr(content);
                let target = arr(&a[2]);
                let alt = plain(arr(&a[1]));
                out.push(Inline::Image {
                    src: target.first().and_then(Value::as_str).unwrap_or("").to_owned(),
                    alt: (!alt.is_empty()).then_some(alt),
                    title: target.get(1).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
                    link: marks.link.clone(),
                    link_title: marks.link_title.clone(),
                });
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
                Block::Paragraph { content } | Block::Heading { content, .. } => {
                    for inline in content {
                        match inline {
                            Inline::Image { src, .. } => out.push(src.clone()),
                            Inline::Footnote { content } => out.extend(images(&crate::markdown::from_markdown(content))),
                            _ => {}
                        }
                    }
                }
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
                Block::Paragraph { content } | Block::Heading { content, .. } => {
                    for inline in content {
                        match inline {
                            Inline::Image { src, .. } => {
                                if let Some(new) = map(src) { *src = new; }
                            }
                            Inline::Footnote { content } => {
                                let mut note = crate::markdown::from_markdown(content);
                                replace_images(&mut note, map);
                                *content = crate::markdown::to_markdown(&note).trim().to_owned();
                            }
                            _ => {}
                        }
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

/// A colour however it is written (`#F00`, `#ff0000`, `rgb(255, 0, 0)`, or one of the names
/// [`DOCX_FILTER`] knows), as `#rrggbb`; None for one it can't tell.
fn colour_key(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let named = match value.as_str() {
        "red" => Some("#ff0000"),
        "blue" => Some("#0000ff"),
        "green" => Some("#008000"),
        "yellow" => Some("#ffff00"),
        "orange" => Some("#ffa500"),
        "purple" => Some("#800080"),
        "gray" | "grey" => Some("#808080"),
        "black" => Some("#000000"),
        _ => None,
    };
    if let Some(named) = named {
        return Some(named.to_owned());
    }
    if let Some(hex) = value.strip_prefix('#') {
        if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        return match hex.len() {
            6 => Some(format!("#{hex}")),
            3 => Some(hex.chars().fold(String::from("#"), |mut out, c| {
                out.push(c);
                out.push(c);
                out
            })),
            _ => None,
        };
    }
    let inner = value.strip_prefix("rgba(").or_else(|| value.strip_prefix("rgb("))?.strip_suffix(')')?;
    let channels: Vec<u8> = inner.split(',').take(3).map(|c| c.trim().parse::<u8>().ok()).collect::<Option<_>>()?;
    (channels.len() == 3).then(|| format!("#{:02x}{:02x}{:02x}", channels[0], channels[1], channels[2]))
}

/// Writes the colours of `doc` the way `like` writes the same colours. A file keeps a colour the
/// way its format does (Word writes `FF0000`), so a doc downloaded and opened again on top of
/// itself would otherwise come back with every colour respelled (`#ff0000` as `#FF0000`, `red` as
/// `#FF0000`): the same colour stays written the same way.
pub fn respell_colours(doc: &mut Doc, like: &Doc) {
    let mut spellings: HashMap<String, String> = HashMap::new();
    let mut like_blocks = like.blocks.clone();
    map_inlines(&mut like_blocks, &mut |content| {
        for inline in content.iter() {
            if let Inline::Text { marks, .. } = inline {
                for value in [marks.color.as_ref(), marks.highlight.as_ref().and_then(Option::as_ref)].into_iter().flatten() {
                    if let Some(key) = colour_key(value) {
                        spellings.entry(key).or_insert_with(|| value.clone());
                    }
                }
            }
        }
    });
    if spellings.is_empty() {
        return;
    }
    let respell = |value: &mut String| {
        if let Some(spelling) = colour_key(value).and_then(|key| spellings.get(&key)) {
            value.clone_from(spelling);
        }
    };
    map_inlines(&mut doc.blocks, &mut |content| {
        for inline in content.iter_mut() {
            if let Inline::Text { marks, .. } = inline {
                if let Some(color) = marks.color.as_mut() {
                    respell(color);
                }
                if let Some(Some(color)) = marks.highlight.as_mut() {
                    respell(color);
                }
            }
        }
    });
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
