//! Opening files and downloading docs in every format.
//!
//! - Markdown and plain text are read natively.
//! - Word, OpenDocument, rich text and web pages go through Pandoc (`.doc` is first turned into
//!   `.docx` by LibreOffice). Images inside them come out as files the caller uploads.
//! - Downloads: Markdown natively; plain text and web pages through Pandoc; Word through Pandoc
//!   with a filter that keeps colours; OpenDocument, rich text and PDF from that Word file by
//!   LibreOffice.
//! - A PDF opens as it is. Turning it into a doc reads its text with pdftotext.
//!
//! Every external tool runs in its own temporary directory with a time limit.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use write_doc::Doc;
use write_doc::pandoc::{self, PandocOut};

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
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_format",
            format!("The file couldn't be read: {}", stderr.lines().last().unwrap_or("unknown error")),
        ));
    }
    Ok(output.stdout)
}

/// Opens a file into a doc.
pub async fn open(state: &AppState, filename: &str, bytes: &[u8]) -> ApiResult<Opened> {
    let format = openable(filename).ok_or_else(|| {
        ApiError::new(axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_format", format!("Silicon Write can't open “{filename}”."))
            .hint("Open .md, .txt, .docx, .doc, .odt, .rtf, .html or .pdf files.")
    })?;
    match format {
        "md" => Ok(Opened::Doc { doc: write_doc::from_markdown(&String::from_utf8_lossy(bytes)), images: vec![] }),
        "txt" => Ok(Opened::Doc { doc: pandoc::from_plain_text(&String::from_utf8_lossy(bytes)), images: vec![] }),
        "pdf" => {
            if !bytes.starts_with(b"%PDF") {
                return Err(ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, "unsupported_format", "That isn't a PDF file."));
            }
            Ok(Opened::Pdf)
        }
        _ => {
            let dir = tempfile::tempdir().map_err(ApiError::internal)?;
            let mut input = dir.path().join(format!("input.{format}"));
            tokio::fs::write(&input, bytes).await.map_err(ApiError::internal)?;
            let mut reader = format;
            if format == "doc" {
                run(&state.config.soffice, &["--headless", "--norestore", "--convert-to", "docx", "--outdir", ".", "input.doc"], dir.path(), None).await?;
                input = dir.path().join("input.docx");
                reader = "docx";
            }
            let media = dir.path().join("media");
            let json = run(
                &state.config.pandoc,
                &["-f", reader, "-t", "json", "--extract-media", media.to_str().unwrap(), input.to_str().unwrap()],
                dir.path(),
                None,
            )
            .await?;
            let value: serde_json::Value = serde_json::from_slice(&json).map_err(ApiError::internal)?;
            let doc = pandoc::from_pandoc(&value);
            // Images Pandoc pulled out of the file.
            let mut images = vec![];
            for src in pandoc::images(&doc) {
                let path = PathBuf::from(&src);
                if path.starts_with(dir.path()) || path.starts_with(&media) {
                    if let Ok(data) = tokio::fs::read(&path).await {
                        images.push((src.clone(), data, content_type(&src).to_owned()));
                    }
                }
            }
            Ok(Opened::Doc { doc, images })
        }
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

/// The text of a PDF, as a doc.
pub async fn pdf_text(state: &AppState, bytes: &[u8]) -> ApiResult<Doc> {
    let dir = tempfile::tempdir().map_err(ApiError::internal)?;
    tokio::fs::write(dir.path().join("input.pdf"), bytes).await.map_err(ApiError::internal)?;
    let text = run(&state.config.pdftotext, &["-enc", "UTF-8", "input.pdf", "-"], dir.path(), None).await?;
    let text = String::from_utf8_lossy(&text).replace('\u{c}', "\n\n");
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

/// A doc in a download format.
pub async fn export(state: &AppState, doc: &Doc, title: &str, format: &str) -> ApiResult<Exported> {
    let format = format.to_ascii_lowercase();
    if format == "md" || format == "markdown" {
        return Ok(Exported { bytes: write_doc::to_markdown(doc).into_bytes(), content_type: "text/markdown; charset=utf-8", extension: "md" });
    }
    let dir = tempfile::tempdir().map_err(ApiError::internal)?;
    // Images: copies of the doc's own images, so the converters can read them.
    let images = local_images(state, doc, dir.path()).await;
    let resolve = |src: &str| images.iter().find(|(s, _)| s == src).map(|(_, p)| p.clone()).unwrap_or_else(|| src.to_owned());
    let (tree, toc) = pandoc::to_pandoc(doc, &PandocOut { image_src: Some(&resolve), title: Some(title.to_owned()) });
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
            let (content_type, extension) = match format.as_str() {
                "odt" => ("application/vnd.oasis.opendocument.text", "odt"),
                "rtf" => ("application/rtf", "rtf"),
                _ => ("application/pdf", "pdf"),
            };
            Ok(Exported { bytes, content_type, extension })
        }
        other => Err(ApiError::invalid(format!("Unknown format `{other}`.")).hint("Use md, txt, docx, odt, rtf, html or pdf.")),
    }
}

/// Copies the doc's uploaded images into `dir`; returns (src in the doc, local path).
async fn local_images(state: &AppState, doc: &Doc, dir: &Path) -> Vec<(String, String)> {
    let mut out = vec![];
    for src in pandoc::images(doc) {
        let Some(id) = crate::content::asset_id_from_src(state, &src) else { continue };
        let row: Option<(String, String)> = sqlx::query_as("select path, filename from assets where id = $1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
        if let Some((path, filename)) = row {
            let ext = Path::new(&filename).extension().and_then(|e| e.to_str()).unwrap_or("png");
            let local = dir.join(format!("{id}.{ext}"));
            if tokio::fs::copy(state.config.data_dir.join(&path), &local).await.is_ok() {
                out.push((src.clone(), local.to_string_lossy().into_owned()));
            }
        }
    }
    out
}
