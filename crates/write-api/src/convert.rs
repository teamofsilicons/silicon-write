//! Opening files and downloading docs in every format.
//!
//! - A file is told by its bytes, not only its name: one that isn't what its name says is
//!   refused, and a Word file named `.doc` (or the other way round) opens as what it is.
//! - Markdown and plain text are read natively, in the encodings editors save text in.
//! - Word files go through Pandoc with Silicon Write's Word reader ([`pandoc::DOCX_READER`],
//!   which keeps text colour and highlight). Word's old format, OpenDocument and rich text are
//!   turned into Word files by LibreOffice first: its Word files keep what Pandoc's own readers
//!   for those formats drop (headings, colours, underline, maths). Web pages go through Pandoc.
//! - Images inside files come out as files the caller uploads, and so do pictures carried inside
//!   a web page or a Markdown file as `data:` addresses.
//! - Downloads: Markdown natively; plain text and web pages through Pandoc; Word through Pandoc
//!   with a filter that keeps colours; OpenDocument, rich text and PDF from that Word file by
//!   LibreOffice.
//! - A PDF opens as it is. Its text is read with pdftotext.
//!
//! Every external tool runs in its own temporary directory with a time limit.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use tokio::process::Command;
use write_doc::pandoc::{self, PandocOut};
use write_doc::{Block, Doc};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const TOOL_TIMEOUT: Duration = Duration::from_secs(120);

pub enum Opened {
    Doc { doc: Doc, images: Vec<(String, Vec<u8>, String)> },
    Pdf,
}

/// The formats that can be opened, by extension.
pub fn openable(filename: &str) -> Option<&'static str> {
    let ext = Path::new(filename).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" | "markdown" | "mdown" => "md",
        "txt" | "text" => "txt",
        "docx" => "docx",
        "doc" => "doc",
        "odt" => "odt",
        "rtf" => "rtf",
        "html" | "htm" | "xhtml" => "html",
        "pdf" => "pdf",
        _ => return None,
    })
}

async fn run(program: &str, args: &[&str], cwd: &Path, stdin: Option<&[u8]>) -> ApiResult<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // LibreOffice keeps its profile per run, so parallel conversions don't collide.
    command.env("HOME", cwd);
    let mut child = command
        .spawn()
        .map_err(|e| ApiError::unavailable(format!("{program} couldn't start: {e}")).hint("The file converters aren't installed on this server."))?;
    if let Some(input) = stdin {
        use tokio::io::AsyncWriteExt;
        let mut pipe = child.stdin.take().unwrap();
        pipe.write_all(input).await.map_err(ApiError::internal)?;
        drop(pipe);
    }
    let output = tokio::time::timeout(TOOL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| ApiError::unavailable(format!("{program} took too long.")))?
        .map_err(ApiError::internal)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_format",
            format!("The file couldn't be read: {}", stderr.lines().last().unwrap_or("unknown error")),
        ));
    }
    Ok(output.stdout)
}

/// A file that isn't what its name says.
fn not_a(what: &str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_format", format!("That isn't {what}."))
        .hint("The file may be damaged, or be another kind of file with that name.")
}

/// Opens a file into a doc.
pub async fn open(state: &AppState, filename: &str, bytes: &[u8]) -> ApiResult<Opened> {
    let format = openable(filename).ok_or_else(|| {
        ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_format", format!("Silicon Write can't open “{filename}”."))
            .hint("Open .md, .txt, .docx, .doc, .odt, .rtf, .html or .pdf files.")
    })?;
    match format {
        "md" => {
            let doc = write_doc::from_markdown(&text_of(bytes)?);
            let images = carried_images(state, &doc).await;
            Ok(Opened::Doc { doc, images })
        }
        "txt" => Ok(Opened::Doc { doc: pandoc::from_plain_text(&text_of(bytes)?), images: vec![] }),
        "pdf" => {
            // Readers accept a PDF whose header comes after a little leading junk.
            if !bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
                return Err(not_a("a PDF file"));
            }
            // Validate the whole file before making a doc that would fail to open.
            pdf_pages(state, bytes).await?;
            Ok(Opened::Pdf)
        }
        "html" => {
            let text = text_of(bytes)?;
            let dir = tempfile::tempdir().map_err(ApiError::internal)?;
            tokio::fs::write(dir.path().join("input.html"), text.as_bytes()).await.map_err(ApiError::internal)?;
            // No images are extracted: Pandoc would download whatever a web page's images link to, from this server.
            // Pictures the page carries inside it (data: addresses) are taken from the doc instead.
            let json = run(&state.config.pandoc, &["-f", "html", "-t", "json", "input.html"], dir.path(), None).await?;
            let value: serde_json::Value = serde_json::from_slice(&json).map_err(ApiError::internal)?;
            let doc = pandoc::from_pandoc(&value);
            let images = carried_images(state, &doc).await;
            Ok(Opened::Doc { doc, images })
        }
        _ => {
            let kind = office_kind(bytes).ok_or_else(|| {
                not_a(match format {
                    "odt" => "an OpenDocument file",
                    "rtf" => "a rich text file",
                    _ => "a Word file",
                })
            })?;
            let dir = tempfile::tempdir().map_err(ApiError::internal)?;
            let name = format!("input.{kind}");
            tokio::fs::write(dir.path().join(&name), bytes).await.map_err(ApiError::internal)?;
            if kind != "docx" {
                run(&state.config.soffice, &["--headless", "--norestore", "--convert-to", "docx", "--outdir", ".", &name], dir.path(), None).await?;
                if !tokio::fs::try_exists(dir.path().join("input.docx")).await.unwrap_or(false) {
                    return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_format", "The file couldn't be read.")
                        .hint("It may be damaged, or be another kind of file with that name."));
                }
            }
            tokio::fs::write(dir.path().join("docx.lua"), pandoc::DOCX_READER).await.map_err(ApiError::internal)?;
            let media = dir.path().join("media");
            let media_arg = media.to_string_lossy().into_owned();
            let json = run(&state.config.pandoc, &["-f", "docx.lua", "-t", "json", "--extract-media", &media_arg, "input.docx"], dir.path(), None).await?;
            let value: serde_json::Value = serde_json::from_slice(&json).map_err(ApiError::internal)?;
            let doc = pandoc::from_pandoc(&value);
            // Images Pandoc pulled out of the file. Ones browsers can't show (Word's EMF and WMF drawings,
            // TIFF, BMP) become PNGs.
            let mut images = vec![];
            for src in pandoc::images(&doc) {
                let path = PathBuf::from(&src);
                if (path.starts_with(dir.path()) || path.starts_with(&media))
                    && let Ok(data) = tokio::fs::read(&path).await
                {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                    let image = match image_type(&data) {
                        Some(kind) => (data, kind.to_owned()),
                        None => match as_png(state, &data, &ext).await {
                            Some(png) => (png, "image/png".to_owned()),
                            None => (data, content_type(&src).to_owned()),
                        },
                    };
                    images.push((src.clone(), image.0, image.1));
                }
            }
            Ok(Opened::Doc { doc, images })
        }
    }
}

/// What kind of word-processor file these bytes are, whatever the file is called: a Word file
/// (`docx`), Word's old format (`doc`), OpenDocument (`odt`) or rich text (`rtf`).
fn office_kind(bytes: &[u8]) -> Option<&'static str> {
    const OLE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    let has = |name: &[u8]| bytes.windows(name.len()).any(|w| w == name);
    if bytes.starts_with(&OLE) {
        Some("doc")
    } else if bytes.starts_with(b"PK\x03\x04") {
        // A zip file: a Word file has its parts under word/, an OpenDocument file its content.xml.
        if has(b"word/") {
            Some("docx")
        } else if has(b"content.xml") {
            Some("odt")
        } else {
            None
        }
    } else {
        let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        let start = text.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(text.len());
        text[start..].starts_with(b"{\\rtf").then_some("rtf")
    }
}

/// Text in the encodings editors save it in, or a refusal when it isn't text.
fn text_of(bytes: &[u8]) -> ApiResult<String> {
    decode_text(bytes).ok_or_else(|| not_a("a text file"))
}

/// Text in the encodings editors save it in: UTF-8, with or without a byte-order mark; UTF-16
/// with a byte-order mark (Notepad's "Unicode"), or without one; and, for text that isn't UTF-8,
/// Windows-1252 (Notepad's "ANSI", which Latin-1 is part of). None for bytes that aren't text
/// (it would have NUL characters in it).
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    let utf16 = |bytes: &[u8], little: bool| {
        let units = bytes.as_chunks::<2>().0.iter().map(|&pair| if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) });
        char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)).collect::<String>()
    };
    let text = if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        String::from_utf8_lossy(rest).into_owned()
    } else if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        utf16(rest, true)
    } else if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        utf16(rest, false)
    } else if let Some(little) = utf16_without_mark(bytes) {
        utf16(bytes, little)
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        text.to_owned()
    } else {
        bytes.iter().map(|&b| windows_1252(b)).collect()
    };
    let text = text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text);
    (!text.contains('\0')).then_some(text)
}

/// Whether bytes look like UTF-16 written without a byte-order mark (Some(true) for little
/// endian): Latin text in UTF-16 has a zero byte in every other place.
fn utf16_without_mark(bytes: &[u8]) -> Option<bool> {
    if bytes.len() < 4 || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let sample = &bytes[..bytes.len().min(4096)];
    let pairs = sample.len() / 2;
    let zeros = |offset: usize| sample.iter().skip(offset).step_by(2).filter(|&&b| b == 0).count();
    let (even, odd) = (zeros(0), zeros(1));
    if odd * 2 >= pairs && even == 0 {
        Some(true)
    } else if even * 2 >= pairs && odd == 0 {
        Some(false)
    } else {
        None
    }
}

/// A Windows-1252 byte as a character.
fn windows_1252(byte: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018,
        0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
    ];
    match byte {
        0x80..=0x9F => char::from_u32(HIGH[(byte - 0x80) as usize] as u32).unwrap_or(char::REPLACEMENT_CHARACTER),
        _ => byte as char,
    }
}

/// The media type and bytes of a `data:` address.
fn data_uri(src: &str) -> Option<(String, Vec<u8>)> {
    let scheme = src.get(..5)?;
    if !scheme.eq_ignore_ascii_case("data:") {
        return None;
    }
    let (meta, data) = src[5..].split_once(',')?;
    let mut params = meta.split(';').map(str::trim);
    let media_type = params.next().unwrap_or("").to_ascii_lowercase();
    let base64 = params.any(|p| p.eq_ignore_ascii_case("base64"));
    let data = percent_decode(data);
    let bytes = if base64 {
        let data: Vec<u8> = data.into_iter().filter(|b| !b.is_ascii_whitespace()).collect();
        base64::engine::general_purpose::STANDARD_PAD_INDIFFERENT
            .decode(&data)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_PAD_INDIFFERENT.decode(&data))
            .ok()?
    } else {
        data
    };
    Some((media_type, bytes))
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Pictures a file carries inside it as `data:` addresses (a web page saved with its pictures, a
/// Markdown file with one pasted in), as (src, bytes, content type) for the caller to upload.
/// Ones browsers can't show become PNGs; anything that isn't a picture stays as it is.
async fn carried_images(state: &AppState, doc: &Doc) -> Vec<(String, Vec<u8>, String)> {
    let mut out: Vec<(String, Vec<u8>, String)> = vec![];
    for src in pandoc::images(doc) {
        if out.iter().any(|(s, _, _)| *s == src) {
            continue;
        }
        let Some((media_type, data)) = data_uri(&src) else { continue };
        let image = match image_type(&data) {
            Some(kind) => (data, kind.to_owned()),
            None => {
                let ext = media_type.rsplit(['/', '-']).next().unwrap_or("").to_owned();
                match as_png(state, &data, &ext).await {
                    Some(png) => (png, "image/png".to_owned()),
                    None => continue,
                }
            }
        };
        out.push((src, image.0, image.1));
    }
    out
}

/// An image browsers can't show (`ext` names its kind: emf, wmf, tiff, bmp…), drawn as a PNG by
/// LibreOffice (None when it can't).
async fn as_png(state: &AppState, data: &[u8], ext: &str) -> Option<Vec<u8>> {
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let dir = tempfile::tempdir().ok()?;
    let name = format!("image.{ext}");
    tokio::fs::write(dir.path().join(&name), data).await.ok()?;
    run(&state.config.soffice, &["--headless", "--norestore", "--convert-to", "png", "--outdir", ".", &name], dir.path(), None).await.ok()?;
    let png = tokio::fs::read(dir.path().join("image.png")).await.ok()?;
    (image_type(&png) == Some("image/png")).then_some(png)
}

/// What kind of image these bytes are, from the bytes themselves (never the file's name): PNG,
/// JPEG, GIF, WebP or SVG, the images every browser shows.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
        let start = head.trim_start_matches('\u{feff}').trim_start();
        let xml_like = start.starts_with("<?xml") || start.starts_with("<svg") || start.starts_with("<!--") || start.starts_with("<!DOCTYPE svg");
        (xml_like && head.contains("<svg")).then_some("image/svg+xml")
    }
}

/// The file extension for an image's content type.
fn image_extension(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

pub fn content_type(name: &str) -> &'static str {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "emf" => "image/emf",
        "wmf" => "image/wmf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// A PDF's actual page count. Poppler installs `pdfinfo` beside `pdftotext`; honour that
/// directory when the latter is configured with an absolute path.
pub async fn pdf_pages(state: &AppState, bytes: &[u8]) -> ApiResult<u64> {
    let dir = tempfile::tempdir().map_err(ApiError::internal)?;
    tokio::fs::write(dir.path().join("input.pdf"), bytes).await.map_err(ApiError::internal)?;
    let program = Path::new(&state.config.pdftotext).with_file_name("pdfinfo");
    let output = run(&program.to_string_lossy(), &["input.pdf"], dir.path(), None).await?;
    String::from_utf8_lossy(&output)
        .lines()
        .find_map(|line| line.strip_prefix("Pages:").and_then(|n| n.trim().parse::<u64>().ok()))
        .filter(|&n| n > 0)
        .ok_or_else(|| not_a("a readable PDF file"))
}

/// The text of a PDF, as a doc.
pub async fn pdf_text(state: &AppState, bytes: &[u8]) -> ApiResult<Doc> {
    let dir = tempfile::tempdir().map_err(ApiError::internal)?;
    tokio::fs::write(dir.path().join("input.pdf"), bytes).await.map_err(ApiError::internal)?;
    let text = run(&state.config.pdftotext, &["-enc", "UTF-8", "input.pdf", "-"], dir.path(), None).await?;
    let text = String::from_utf8_lossy(&text).replace('\u{c}', "\n\n").replace('\0', "");
    // pdftotext breaks every line; join lines inside a paragraph.
    let mut paragraphs = vec![];
    for para in text.split("\n\n") {
        let joined = para.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
        if !joined.is_empty() {
            paragraphs.push(joined);
        }
    }
    Ok(Doc::new(paragraphs.iter().map(|p| write_doc::Block::text_paragraph(p)).collect()))
}

pub struct Exported {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub extension: &'static str,
}

/// A doc in a download format. The doc's title is the file's own title where the format keeps
/// one apart from the text (a web page's `<title>`), and is never added to the text.
pub async fn export(state: &AppState, doc: &Doc, title: &str, format: &str) -> ApiResult<Exported> {
    let format = format.to_ascii_lowercase();
    if format == "md" || format == "markdown" {
        return Ok(Exported { bytes: write_doc::to_markdown(doc).into_bytes(), content_type: "text/markdown; charset=utf-8", extension: "md" });
    }
    let dir = tempfile::tempdir().map_err(ApiError::internal)?;
    // Images: copies of the doc's own images and of pictures it carries inside it, so the converters can read
    // them. Images from elsewhere become a link to the image: the converters would otherwise fetch any address
    // a doc names, from this server.
    let images = local_images(state, doc, dir.path()).await;
    let mut doc = doc.clone();
    keep_only_local_images(&mut doc, &images);
    let resolve = |src: &str| images.iter().find(|(s, _)| s == src).map(|(_, p)| p.clone()).unwrap_or_else(|| src.to_owned());
    let (tree, toc) = pandoc::to_pandoc(&doc, &PandocOut { image_src: Some(&resolve), title: Some(title.to_owned()) });
    let json = serde_json::to_vec(&tree).map_err(ApiError::internal)?;
    let pandoc_bin = state.config.pandoc.clone();
    match format.as_str() {
        "txt" | "text" => {
            let out = run(&pandoc_bin, &["-f", "json", "-t", "plain", "--wrap=none"], dir.path(), Some(&json)).await?;
            Ok(Exported { bytes: out, content_type: "text/plain; charset=utf-8", extension: "txt" })
        }
        "html" => {
            let mut args = vec!["-f", "json", "-t", "html5", "--standalone", "--embed-resources", "--mathml"];
            if toc {
                args.push("--toc");
            }
            let out = run(&pandoc_bin, &args, dir.path(), Some(&json)).await?;
            Ok(Exported { bytes: out, content_type: "text/html; charset=utf-8", extension: "html" })
        }
        "docx" | "odt" | "rtf" | "pdf" => {
            let filter = dir.path().join("colours.lua");
            tokio::fs::write(&filter, pandoc::DOCX_FILTER).await.map_err(ApiError::internal)?;
            let mut args = vec!["-f", "json", "-t", "docx", "--lua-filter", "colours.lua", "-o", "doc.docx"];
            if toc {
                args.push("--toc");
            }
            run(&pandoc_bin, &args, dir.path(), Some(&json)).await?;
            if format == "docx" {
                let bytes = tokio::fs::read(dir.path().join("doc.docx")).await.map_err(ApiError::internal)?;
                return Ok(Exported {
                    bytes,
                    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    extension: "docx",
                });
            }
            run(&state.config.soffice, &["--headless", "--norestore", "--convert-to", &format, "--outdir", ".", "doc.docx"], dir.path(), None).await?;
            let bytes = tokio::fs::read(dir.path().join(format!("doc.{format}"))).await.map_err(ApiError::internal)?;
            let (bytes, content_type, extension) = match format.as_str() {
                "odt" => (bytes, "application/vnd.oasis.opendocument.text", "odt"),
                "rtf" => (mark_heading_rows(bytes, &doc), "application/rtf", "rtf"),
                _ => (bytes, "application/pdf", "pdf"),
            };
            Ok(Exported { bytes, content_type, extension })
        }
        other => Err(ApiError::invalid(format!("Unknown format `{other}`.")).hint("Use md, txt, docx, odt, rtf, html or pdf.")),
    }
}

/// LibreOffice's rich text doesn't mark a table's heading row (`\trhdr`), so a table in it opened
/// again would come back without its heading. This marks the rows that are headings in the doc,
/// and leaves the file as it is when its rows don't line up with the doc's tables.
fn mark_heading_rows(rtf: Vec<u8>, doc: &Doc) -> Vec<u8> {
    // Whether each row of the doc's tables is a heading, in the order they come; None when a table holds another
    // table (rich text writes nested rows its own way).
    fn rows(blocks: &[Block], out: &mut Vec<bool>) -> Option<()> {
        for block in blocks {
            match block {
                Block::Table { rows: table } => {
                    for (i, row) in table.iter().enumerate() {
                        if row.cells.iter().any(|c| c.blocks.iter().any(|b| matches!(b, Block::Table { .. }))) {
                            return None;
                        }
                        out.push(i == 0 && !row.cells.is_empty() && row.cells.iter().all(|c| c.header));
                    }
                }
                Block::BulletList { items } | Block::OrderedList { items, .. } => items.iter().try_for_each(|i| rows(&i.blocks, out))?,
                Block::TaskList { items } => items.iter().try_for_each(|i| rows(&i.blocks, out))?,
                Block::Blockquote { blocks } => rows(blocks, out)?,
                _ => {}
            }
        }
        Some(())
    }
    let mut headings = vec![];
    if rows(&doc.blocks, &mut headings).is_none() || !headings.contains(&true) {
        return rtf;
    }
    // Where each row's definition (`\trowd`) ends, reading control words (a `\\` or `\{` is text).
    let mut ends = vec![];
    let mut i = 0;
    while i < rtf.len() {
        if rtf[i] != b'\\' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < rtf.len() && rtf[end].is_ascii_alphabetic() {
            end += 1;
        }
        if end == start {
            i = start + 1;
            continue;
        }
        if &rtf[start..end] == b"trowd" {
            ends.push(end);
        }
        i = end;
    }
    if ends.len() != headings.len() {
        return rtf;
    }
    let mut out = Vec::with_capacity(rtf.len() + 8 * ends.len());
    let mut from = 0;
    for (end, heading) in ends.into_iter().zip(headings) {
        if heading {
            out.extend_from_slice(&rtf[from..end]);
            out.extend_from_slice(b"\\trhdr");
            from = end;
        }
    }
    out.extend_from_slice(&rtf[from..]);
    out
}

/// Replaces images that aren't the doc's own uploads with a link to them.
fn keep_only_local_images(doc: &mut Doc, local: &[(String, String)]) {
    use write_doc::{Inline, Marks};
    fn walk(blocks: &mut [Block], local: &[(String, String)]) {
        for block in blocks.iter_mut() {
            match block {
                Block::Image { src, alt, .. } if !local.iter().any(|(s, _)| s == src) => {
                    let label = alt.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| "Image".to_owned());
                    *block = Block::paragraph(vec![Inline::marked(label, Marks { link: Some(src.clone()), ..Marks::default() })]);
                }
                Block::Paragraph { content } | Block::Heading { content, .. } => {
                    for inline in content {
                        match inline {
                            Inline::Image { src, alt, .. } if !local.iter().any(|(s, _)| s == src) => {
                                let label = alt.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| "Image".to_owned());
                                *inline = Inline::marked(label, Marks { link: Some(src.clone()), ..Marks::default() });
                            }
                            Inline::Footnote { content } => {
                                let mut note = write_doc::from_markdown(content);
                                walk(&mut note.blocks, local);
                                *content = write_doc::to_markdown(&note).trim().to_owned();
                            }
                            _ => {}
                        }
                    }
                }
                Block::BulletList { items } | Block::OrderedList { items, .. } => items.iter_mut().for_each(|i| walk(&mut i.blocks, local)),
                Block::TaskList { items } => items.iter_mut().for_each(|i| walk(&mut i.blocks, local)),
                Block::Blockquote { blocks } => walk(blocks, local),
                Block::Table { rows } => rows.iter_mut().for_each(|r| r.cells.iter_mut().for_each(|c| walk(&mut c.blocks, local))),
                _ => {}
            }
        }
    }
    walk(&mut doc.blocks, local);
}

/// Copies the doc's uploaded images, and the pictures it carries inside it (`data:` addresses),
/// into `dir`; returns (src in the doc, local path).
async fn local_images(state: &AppState, doc: &Doc, dir: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for src in pandoc::images(doc) {
        if out.iter().any(|(s, _)| *s == src) {
            continue;
        }
        if let Some((_, data)) = data_uri(&src) {
            if let Some(kind) = image_type(&data) {
                let local = dir.join(format!("carried-{}.{}", out.len(), image_extension(kind)));
                if tokio::fs::write(&local, &data).await.is_ok() {
                    out.push((src.clone(), local.to_string_lossy().into_owned()));
                }
            }
            continue;
        }
        let Some(id) = crate::content::asset_id_from_src(state, &src) else { continue };
        let row: Option<(String, String)> = sqlx::query_as("select path, content_type from assets where id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
        if let Some((path, content_type)) = row {
            // Upload names can be misleading, and converted Word drawings still have their old name.
            let ext = image_extension(&content_type);
            let local = dir.join(format!("{id}.{ext}"));
            if tokio::fs::copy(state.config.data_dir.join(&path), &local).await.is_ok() {
                out.push((src.clone(), local.to_string_lossy().into_owned()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_in_the_encodings_editors_save() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFHello there.\n").as_deref(), Some("Hello there.\n"));
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("Hello UTF-16 café\n".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text(&utf16).as_deref(), Some("Hello UTF-16 café\n"));
        let mut big = vec![0xFE, 0xFF];
        big.extend("Big end\n".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode_text(&big).as_deref(), Some("Big end\n"));
        let bare: Vec<u8> = "No mark at all\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_text(&bare).as_deref(), Some("No mark at all\n"));
        assert_eq!(decode_text(b"Caf\xE9 cr\xE8me br\xFBl\xE9e \x93quoted\x94 \x80\n").as_deref(), Some("Café crème brûlée “quoted” €\n"));
        assert_eq!(decode_text("Ünïcödé ✓\n".as_bytes()).as_deref(), Some("Ünïcödé ✓\n"));
        assert_eq!(decode_text(b"binary\x00\x01\x02"), None);
        let random: Vec<u8> = (0..4096u32).map(|i| ((i * 7919 + 13) % 256) as u8).collect();
        assert_eq!(decode_text(&random), None);
    }

    #[test]
    fn office_files_are_told_by_their_bytes() {
        assert_eq!(office_kind(b"PK\x03\x04....[Content_Types].xml....word/document.xml"), Some("docx"));
        assert_eq!(office_kind(b"PK\x03\x04....mimetypeapplication/vnd.oasis.opendocument.text....content.xml"), Some("odt"));
        assert_eq!(office_kind(b"PK\x03\x04....just a zip"), None);
        assert_eq!(office_kind(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]), Some("doc"));
        assert_eq!(office_kind(b"{\\rtf1\\ansi hello}"), Some("rtf"));
        assert_eq!(office_kind(b"\xEF\xBB\xBF\r\n{\\rtf1 hello}"), Some("rtf"));
        assert_eq!(office_kind(b"plain words, no rich text header"), None);
        assert_eq!(office_kind(b""), None);
    }

    #[test]
    fn data_addresses() {
        let (kind, bytes) = data_uri("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(kind, "image/png");
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
        let (_, bytes) = data_uri("DATA:image/png;BASE64,iVBO\nRw0KGgo").unwrap();
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
        let (kind, bytes) = data_uri("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E").unwrap();
        assert_eq!(kind, "image/svg+xml");
        assert_eq!(image_type(&bytes), Some("image/svg+xml"));
        assert_eq!(data_uri("https://example.com/a.png"), None);
        assert_eq!(data_uri("data:image/png;base64,***"), None);
    }

    #[test]
    fn heading_rows_are_marked_in_rich_text() {
        let doc = write_doc::from_markdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n| C |\n| --- |\n| 3 |\n");
        let rtf = b"{\\rtf1 \\trowd\\trql\\cellx1 A\\cell\\row \\trowd\\trql\\cellx1 1\\cell\\row \\trowd \\cellx1 C\\cell\\row \\trowd\\cellx1 3\\row \\\\trowd}".to_vec();
        let marked = String::from_utf8(mark_heading_rows(rtf.clone(), &doc)).unwrap();
        assert_eq!(marked.matches("\\trhdr").count(), 2, "{marked}");
        assert!(marked.contains("\\trowd\\trhdr\\trql\\cellx1 A") && marked.contains("\\trowd\\trhdr \\cellx1 C"), "{marked}");
        assert!(marked.contains("\\trowd\\trql\\cellx1 1") && marked.contains("\\trowd\\cellx1 3"), "{marked}");
        // Rows that don't line up with the doc's tables: the file stays as it is.
        let fewer = b"{\\rtf1 \\trowd\\cellx1 A\\cell\\row}".to_vec();
        assert_eq!(mark_heading_rows(fewer.clone(), &doc), fewer);
    }
}
