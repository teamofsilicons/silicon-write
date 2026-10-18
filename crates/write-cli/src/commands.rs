//! Library, content, sharing, comment, suggestion and version commands.

use std::collections::HashMap;
use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use silicon_write_client::*;

use crate::ctx::Ctx;
use crate::error::{CliError, CliResult};
use crate::resolve::{self, ItemId};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

/// `2026-10-17T09:12:33Z` → `2026-10-17 09:12`.
pub fn when(ts: &str) -> String {
    if ts.len() >= 16 {
        ts[..16].replace('T', " ")
    } else {
        ts.to_owned()
    }
}

/// Reads `-` from stdin, anything else from that file.
pub fn read_input(arg: &str, what: &str) -> CliResult<String> {
    if arg == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| CliError::io(format!("Could not read {what} from stdin: {e}."), e))?;
        return Ok(buf);
    }
    std::fs::read_to_string(arg).map_err(|e| {
        CliError::new(
            "io",
            format!("Could not read {what} from {arg}: {e}."),
            "Check the path, or pass - to read from stdin.",
        )
    })
}

/// A `--body` value: the text, or stdin for `-`.
fn body_text(body: &str) -> CliResult<String> {
    let text = if body == "-" {
        read_input("-", "the comment")?
    } else {
        body.to_owned()
    };
    let text = text.trim_end_matches('\n').to_owned();
    if text.trim().is_empty() {
        return Err(CliError::invalid(
            "The comment is empty.",
            "Pass the text with --body TEXT (or --body - to read stdin).",
        ));
    }
    Ok(text)
}

fn table(rows: &[Vec<String>]) -> String {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..cols)
        .map(|c| {
            rows.iter()
                .filter_map(|r| r.get(c))
                .map(|s| s.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|row| {
            let mut line = String::new();
            for (c, cell) in row.iter().enumerate() {
                if c + 1 == row.len() {
                    line.push_str(cell);
                } else {
                    line.push_str(cell);
                    line.push_str(&" ".repeat(widths[c] - cell.chars().count() + 2));
                }
            }
            line.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn doc_row(d: &Doc) -> Vec<String> {
    let mut info = d.role.clone();
    if d.public_access != "none" && !d.public_access.is_empty() {
        info.push_str(&format!(" · public {}", d.public_access));
    }
    if d.kind == "pdf" {
        info.push_str(" · PDF");
    }
    vec![
        d.title.clone(),
        d.id.clone(),
        info,
        when(if d.updated_at.is_empty() {
            &d.created_at
        } else {
            &d.updated_at
        }),
    ]
}

fn folder_row(f: &Folder) -> Vec<String> {
    vec![
        format!("{}/", f.name),
        f.id.clone(),
        f.role.clone(),
        when(&f.created_at),
    ]
}

fn doc_summary(d: &Doc) -> String {
    format!("{} ({})", d.title, d.id)
}

// ── library ─────────────────────────────────────────────────────────────────────────────────

pub async fn ls(
    ctx: &Ctx,
    folder: Option<String>,
    shared: bool,
    trash: bool,
    recent: bool,
) -> CliResult<()> {
    ctx.require_session()?;
    let view = if trash {
        LibraryView::Trash
    } else if shared {
        LibraryView::Shared
    } else if recent {
        LibraryView::Recent
    } else {
        LibraryView::Mine
    };
    let folder = match folder {
        Some(f) => resolve::folder_id(ctx, &f, trash).await?,
        None => None,
    };
    let library = ctx.client.library(view, folder.as_deref()).await?;
    ctx.emit(&library, || {
        let mut rows: Vec<Vec<String>> = library.folders.iter().map(folder_row).collect();
        rows.extend(library.docs.iter().map(doc_row));
        let place = match (&library.folder, view) {
            (Some(f), _) => format!("“{}”", f.name),
            (None, LibraryView::Trash) => "your trash".into(),
            (None, LibraryView::Shared) => "what is shared with you".into(),
            (None, LibraryView::Recent) => "your recent docs".into(),
            (None, LibraryView::Mine) => "your docs".into(),
        };
        if rows.is_empty() {
            format!("Nothing in {place}.")
        } else {
            table(&rows)
        }
    });
    Ok(())
}

pub async fn tree(ctx: &Ctx) -> CliResult<()> {
    ctx.require_session()?;
    let (me, docs, folders) =
        tokio::try_join!(ctx.client.me(), ctx.client.docs(), ctx.client.folders())?;
    let value = json!({ "folders": folders, "docs": docs });
    ctx.emit(&value, || {
        let open: HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
        let key = |parent: Option<&String>, owner: &str| match parent
            .filter(|p| open.contains_key(p.as_str()))
        {
            Some(p) => p.clone(),
            None if owner == me.uuid => "@mine".to_owned(),
            None => "@shared".to_owned(),
        };
        let mut sub_folders: HashMap<String, Vec<&Folder>> = HashMap::new();
        for f in &folders {
            sub_folders
                .entry(key(f.parent_id.as_ref(), &f.owner.uuid))
                .or_default()
                .push(f);
        }
        let mut sub_docs: HashMap<String, Vec<&Doc>> = HashMap::new();
        for d in &docs {
            sub_docs
                .entry(key(d.folder_id.as_ref(), &d.owner.uuid))
                .or_default()
                .push(d);
        }
        fn walk(
            out: &mut String,
            key: &str,
            depth: usize,
            sub_folders: &HashMap<String, Vec<&Folder>>,
            sub_docs: &HashMap<String, Vec<&Doc>>,
        ) {
            let pad = "  ".repeat(depth);
            let mut fs = sub_folders.get(key).cloned().unwrap_or_default();
            fs.sort_by_key(|a| a.name.to_lowercase());
            for f in fs {
                out.push_str(&format!("{pad}{}/  {}\n", f.name, f.id));
                walk(out, &f.id, depth + 1, sub_folders, sub_docs);
            }
            let mut ds = sub_docs.get(key).cloned().unwrap_or_default();
            ds.sort_by_key(|a| a.title.to_lowercase());
            for d in ds {
                out.push_str(&format!("{pad}{}  {}\n", d.title, d.id));
            }
        }
        let mut out = String::from("Your docs\n");
        walk(&mut out, "@mine", 1, &sub_folders, &sub_docs);
        if sub_folders.contains_key("@shared") || sub_docs.contains_key("@shared") {
            out.push_str("Shared with you\n");
            walk(&mut out, "@shared", 1, &sub_folders, &sub_docs);
        }
        out
    });
    Ok(())
}

pub async fn info(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, true).await?;
    let d = ctx.client.doc(&id).await?;
    ctx.emit(&d, || {
        let place = if d.path.is_empty() { "top level".to_owned() } else { d.folder_path() };
        let mut out = format!(
            "{}\n{}  {}\nin       {place}\nowner    {}  (created by {})\nyou      {}\npublic   {}\nseq      {}\nupdated  {}",
            d.title,
            d.id,
            d.url,
            d.owner.label(),
            d.created_by.label(),
            d.role,
            d.public_access,
            d.seq,
            when(&d.updated_at)
        );
        if d.deleted_at.is_some() {
            out.push_str("\nin the trash (`write restore` brings it back)");
        }
        out
    });
    Ok(())
}

pub async fn new_doc(
    ctx: &Ctx,
    title: Option<String>,
    folder: Option<String>,
    file: Option<String>,
) -> CliResult<()> {
    ctx.require_session()?;
    let folder_id = match folder {
        Some(f) => resolve::folder_id(ctx, &f, false).await?,
        None => None,
    };
    if let Some(path) = &file
        && path != "-"
    {
        let ext = Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "md" | "markdown" | "") {
            // Other formats go through import.
            return import(ctx, path, folder_id, title, None).await;
        }
    }
    let markdown = match &file {
        Some(path) => Some(read_input(path, "the Markdown")?),
        None => None,
    };
    let title = title.or_else(|| {
        file.as_ref()
            .filter(|p| *p != "-")
            .and_then(|p| Path::new(p).file_stem())
            .map(|s| s.to_string_lossy().into_owned())
    });
    let doc = ctx
        .client
        .create_doc(&NewDoc {
            title,
            folder_id,
            markdown,
        })
        .await?;
    ctx.emit(&doc, || {
        format!("Created {}\n{}", doc_summary(&doc), doc.url)
    });
    Ok(())
}

pub async fn import(
    ctx: &Ctx,
    file: &str,
    folder_id: Option<String>,
    title: Option<String>,
    into: Option<String>,
) -> CliResult<()> {
    ctx.require_session()?;
    let upload = Upload::from_path(file).await?;
    if let Some(into) = into {
        let id = resolve::doc_id(ctx, &into, false).await?;
        let result = ctx.client.import_into(&id, &upload).await?;
        let value = json!({ "doc": id, "seq": result.seq });
        ctx.emit(&value, || {
            format!(
                "Opened {file} on top of {id}: it is now version {}.",
                result.seq
            )
        });
        return Ok(());
    }
    let doc = ctx
        .client
        .import_doc(&upload, folder_id.as_deref(), title.as_deref())
        .await?;
    ctx.emit(&doc, || {
        let extra = if doc.kind == "pdf" {
            "\nA PDF is shown as it is; `write convert` turns it into a doc you can edit."
        } else {
            ""
        };
        format!(
            "Imported {file} as {}\n{}{extra}",
            doc_summary(&doc),
            doc.url
        )
    });
    Ok(())
}

pub async fn import_cmd(
    ctx: &Ctx,
    file: &str,
    folder: Option<String>,
    title: Option<String>,
    into: Option<String>,
) -> CliResult<()> {
    let folder_id = match folder {
        Some(f) => resolve::folder_id(ctx, &f, false).await?,
        None => None,
    };
    import(ctx, file, folder_id, title, into).await
}

async fn save_download(
    ctx: &Ctx,
    download: Download,
    output: Option<PathBuf>,
    fallback_name: String,
) -> CliResult<Value> {
    let to_stdout = output.as_deref().is_some_and(|p| p == Path::new("-"));
    if to_stdout {
        if ctx.json {
            return Err(CliError::invalid(
                "--json can't be combined with -o - (the file goes to stdout).",
                "Drop --json, or pass -o PATH.",
            ));
        }
        let bytes = download.bytes().await?;
        std::io::stdout()
            .write_all(&bytes)
            .map_err(|e| CliError::io(format!("Could not write to stdout: {e}."), e))?;
        return Ok(json!({ "bytes": bytes.len() }));
    }
    let name = download
        .file_name
        .clone()
        .map(|n| crate::sync::safe_name(&n))
        .unwrap_or(fallback_name);
    let path = match output {
        Some(p) if p.is_dir() => p.join(name),
        Some(p) => p,
        None => PathBuf::from(name),
    };
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
        CliError::new(
            "io",
            format!("Could not create {}: {e}.", path.display()),
            "Pass another path with -o.",
        )
    })?;
    let bytes = download.write_to(&mut file).await?;
    Ok(json!({ "path": path.display().to_string(), "bytes": bytes }))
}

pub async fn export(
    ctx: &Ctx,
    doc: &str,
    format: &str,
    seq: Option<i64>,
    output: Option<PathBuf>,
) -> CliResult<()> {
    let format: ExportFormat = format.parse().map_err(|e: String| {
        CliError::invalid(e, "Pick one of md, txt, docx, doc, odt, rtf, html, pdf.")
    })?;
    let id = resolve::doc_id(ctx, doc, false).await?;
    let download = ctx.client.export(&id, format, seq).await?;
    let fallback = format!("{id}.{format}");
    let saved = save_download(ctx, download, output, fallback).await?;
    if let Some(path) = saved.get("path").and_then(Value::as_str) {
        let path = path.to_owned();
        ctx.emit(&saved, || {
            format!("Saved {path} ({} bytes).", saved["bytes"])
        });
    }
    Ok(())
}

pub async fn original(ctx: &Ctx, doc: &str, output: Option<PathBuf>) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let download = ctx.client.original(&id).await?;
    let saved = save_download(ctx, download, output, format!("{id}.pdf")).await?;
    if let Some(path) = saved.get("path").and_then(Value::as_str) {
        let path = path.to_owned();
        ctx.emit(&saved, || {
            format!("Saved {path} ({} bytes).", saved["bytes"])
        });
    }
    Ok(())
}

pub async fn convert(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let d = ctx.client.convert_doc(&id).await?;
    ctx.emit(&d, || {
        format!(
            "{} is now a doc you can edit (the PDF stays as its original).",
            doc_summary(&d)
        )
    });
    Ok(())
}

pub async fn mv(ctx: &Ctx, item: &str, to: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    let target = resolve::folder_id(ctx, to, false).await?;
    let where_ = target.clone().unwrap_or_else(|| "the top level".into());
    match item {
        ItemId::Doc(id) => {
            let d = ctx
                .client
                .update_doc(
                    &id,
                    &DocPatch {
                        folder_id: Some(target),
                        ..Default::default()
                    },
                )
                .await?;
            ctx.emit(&d, || format!("Moved {} to {where_}.", doc_summary(&d)));
        }
        ItemId::Folder(id) => {
            let f = ctx
                .client
                .update_folder(
                    &id,
                    &FolderPatch {
                        parent_id: Some(target),
                        ..Default::default()
                    },
                )
                .await?;
            ctx.emit(&f, || {
                format!("Moved folder {} ({}) to {where_}.", f.name, f.id)
            });
        }
    }
    Ok(())
}

pub async fn rename(ctx: &Ctx, item: &str, name: &str) -> CliResult<()> {
    if name.trim().is_empty() {
        return Err(CliError::invalid(
            "The new name is empty.",
            "Pass the new title or folder name.",
        ));
    }
    match resolve::item_id(ctx, item, false).await? {
        ItemId::Doc(id) => {
            let d = ctx
                .client
                .update_doc(
                    &id,
                    &DocPatch {
                        title: Some(name.to_owned()),
                        ..Default::default()
                    },
                )
                .await?;
            ctx.emit(&d, || format!("Renamed to {}.", doc_summary(&d)));
        }
        ItemId::Folder(id) => {
            let f = ctx
                .client
                .update_folder(
                    &id,
                    &FolderPatch {
                        name: Some(name.to_owned()),
                        ..Default::default()
                    },
                )
                .await?;
            ctx.emit(&f, || format!("Renamed folder to {} ({}).", f.name, f.id));
        }
    }
    Ok(())
}

pub async fn rm(ctx: &Ctx, item: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    match &item {
        ItemId::Doc(id) => ctx.client.delete_doc(id).await?,
        ItemId::Folder(id) => ctx.client.delete_folder(id).await?,
    }
    let value = json!({ "trashed": item.id() });
    ctx.emit(&value, || {
        format!(
            "Moved {} to the trash. `write restore {}` brings it back.",
            item.id(),
            item.id()
        )
    });
    Ok(())
}

pub async fn restore(ctx: &Ctx, item: &str) -> CliResult<()> {
    match resolve::item_id(ctx, item, true).await? {
        ItemId::Doc(id) => {
            let d = ctx.client.restore_doc(&id).await?;
            ctx.emit(&d, || format!("Restored {}.", doc_summary(&d)));
        }
        ItemId::Folder(id) => {
            let f = ctx.client.restore_folder(&id).await?;
            ctx.emit(&f, || format!("Restored folder {} ({}).", f.name, f.id));
        }
    }
    Ok(())
}

pub async fn purge(ctx: &Ctx, item: &str, confirm: bool) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, true).await?;
    if !confirm {
        return Err(CliError::invalid(
            format!(
                "Deleting {} permanently can't be undone, so it needs --confirm.",
                item.id()
            ),
            format!(
                "Run `write purge {} --confirm`. Only items in the trash can be purged.",
                item.id()
            ),
        ));
    }
    match &item {
        ItemId::Doc(id) => ctx.client.purge_doc(id).await?,
        ItemId::Folder(id) => ctx.client.purge_folder(id).await?,
    }
    let value = json!({ "purged": item.id() });
    ctx.emit(&value, || format!("{} is permanently deleted.", item.id()));
    Ok(())
}

pub async fn copy(
    ctx: &Ctx,
    doc: &str,
    title: Option<String>,
    folder: Option<String>,
    seq: Option<i64>,
) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let folder_id = match folder {
        Some(f) => resolve::folder_id(ctx, &f, false).await?,
        None => None,
    };
    let d = ctx
        .client
        .copy_doc(
            &id,
            &CopyDoc {
                seq,
                title,
                folder_id,
            },
        )
        .await?;
    ctx.emit(&d, || format!("Copied to {}\n{}", doc_summary(&d), d.url));
    Ok(())
}

pub async fn folder_new(ctx: &Ctx, name: &str, parent: Option<String>) -> CliResult<()> {
    ctx.require_session()?;
    let parent_id = match parent {
        Some(p) => resolve::folder_id(ctx, &p, false).await?,
        None => None,
    };
    let f = ctx.client.create_folder(name, parent_id.as_deref()).await?;
    ctx.emit(&f, || format!("Created folder {} ({}).", f.name, f.id));
    Ok(())
}

pub async fn folder_show(ctx: &Ctx, folder: &str) -> CliResult<()> {
    let id = resolve::folder_id(ctx, folder, true)
        .await?
        .ok_or_else(|| {
            CliError::invalid(
                "`/` is the top level, not a folder.",
                "Pass a folder path or id; `write ls` lists the top level.",
            )
        })?;
    let f = ctx.client.folder(&id).await?;
    ctx.emit(&f, || {
        let mut path: Vec<String> = f.path.iter().map(|p| p.name.clone()).collect();
        path.push(f.name.clone());
        format!(
            "{}\n{}\nowner  {}\nyou    {}\ncreated {}",
            path.join(" / "),
            f.id,
            f.owner.label(),
            f.role,
            when(&f.created_at)
        )
    });
    Ok(())
}

pub async fn link(ctx: &Ctx, title: &str) -> CliResult<()> {
    ctx.require_session()?;
    let title = title.trim().trim_start_matches("[[").trim_end_matches("]]");
    let doc = ctx.client.resolve_link(title).await?;
    match doc {
        Some(d) => {
            ctx.emit(&d, || {
                format!("[[{title}]] opens {}\n{}", doc_summary(&d), d.url)
            });
            Ok(())
        }
        None => Err(CliError::not_found(
            format!("[[{title}]] doesn't open any doc you can open."),
            "Links match a doc's title, ignoring case; create the doc with `write new --title`.",
        )),
    }
}

pub async fn search(ctx: &Ctx, query: &str) -> CliResult<()> {
    ctx.require_session()?;
    let results = ctx.client.search(query).await?;
    let value = json!({ "results": results });
    ctx.emit(&value, || {
        if results.is_empty() {
            return format!("Nothing matches “{query}”.");
        }
        results
            .iter()
            .map(|r| {
                format!(
                    "{}  {}\n  {}",
                    r.doc.title,
                    r.doc.id,
                    r.snippet.replace('\n', " ")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

pub async fn backlinks(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let docs = ctx.client.backlinks(&id).await?;
    let value = json!({ "docs": docs });
    ctx.emit(&value, || {
        if docs.is_empty() {
            "No doc links here with [[title]] yet.".into()
        } else {
            table(
                &docs
                    .iter()
                    .map(|d| vec![d.title.clone(), d.id.clone()])
                    .collect::<Vec<_>>(),
            )
        }
    });
    Ok(())
}

// ── reading and editing ─────────────────────────────────────────────────────────────────────

pub async fn cat(ctx: &Ctx, doc: &str, critic: bool, comments: bool) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let options = MarkdownOptions {
        suggestions: if critic {
            SuggestionsView::Critic
        } else {
            SuggestionsView::Current
        },
        inline_comments: comments,
    };
    let md = ctx.client.markdown(&id, options).await?;
    ctx.emit(&md, || md.markdown.clone());
    Ok(())
}

fn edit_summary(id: &str, seq: i64, suggest: bool, count: usize) -> String {
    let what = if count == 1 {
        "1 change"
    } else {
        &format!("{count} changes")
    };
    if suggest {
        format!("Suggested {what} in {id} (seq {seq}). The owner or an editor can accept it.")
    } else {
        format!("Applied {what} to {id} (seq {seq}).")
    }
}

pub struct EditOptions {
    pub all: bool,
    pub suggest: bool,
    pub expect_seq: Option<i64>,
}

pub async fn edit(
    ctx: &Ctx,
    doc: &str,
    old: Option<String>,
    new: Option<String>,
    options: EditOptions,
    edits_file: Option<String>,
) -> CliResult<()> {
    let EditOptions {
        all,
        suggest,
        expect_seq,
    } = options;
    let edits: Vec<Edit> = match (edits_file, old, new) {
        (Some(file), None, None) => {
            let text = read_input(&file, "the edits")?;
            let value: Value = serde_json::from_str(&text).map_err(|e| {
                CliError::invalid(
                    format!("The edits are not valid JSON ({e})."),
                    r#"Write an array like [{"old":"exact text","new":"replacement","all":false}]."#,
                )
            })?;
            let list = value.get("edits").cloned().unwrap_or(value);
            serde_json::from_value(list).map_err(|e| {
                CliError::invalid(
                    format!("The edits don't have the expected shape ({e})."),
                    r#"Each edit is {"old":"exact text","new":"replacement","all":false}."#,
                )
            })?
        }
        (None, Some(old), Some(new)) => vec![Edit { old, new, all }],
        (Some(_), _, _) => {
            return Err(CliError::invalid(
                "Pass either --edits FILE or --old/--new, not both.",
                "See `write edit --help`.",
            ));
        }
        _ => {
            return Err(CliError::invalid(
                "Both --old and --new are needed.",
                "Pass --old TEXT --new TEXT (use --new '' to delete).",
            ));
        }
    };
    if edits.iter().any(|e| e.old.is_empty()) {
        return Err(CliError::invalid(
            "An edit's old text is empty.",
            "`old` must be exact text from the doc (read it with `write cat`). To add text, replace a nearby passage with itself plus the addition.",
        ));
    }
    let id = resolve::doc_id(ctx, doc, false).await?;
    let result = ctx.client.edit_expecting(&id, &edits, suggest, expect_seq).await.map_err(|e| {
        let mut err = CliError::from(e);
        if err.code == "no_match" && err.hint.is_none() {
            err.hint = Some(format!("`old` must be exact text from the current Markdown; read it with `write cat {id}`."));
        }
        if err.code == "not_unique" && err.hint.is_none() {
            err.hint = Some("Include more surrounding text so `old` appears once, or pass --all to change every occurrence.".into());
        }
        err
    })?;
    // A commenter's changes become suggestions even without --suggest.
    let suggest = suggest || result.suggested;
    let value =
        json!({ "doc": id, "seq": result.seq, "markdown": result.markdown, "suggest": suggest });
    ctx.emit(&value, || {
        edit_summary(&id, result.seq, suggest, edits.len())
    });
    Ok(())
}

pub async fn put(
    ctx: &Ctx,
    doc: &str,
    file: &str,
    base_seq: Option<i64>,
    suggest: bool,
) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let markdown = read_input(file, "the Markdown")?;
    let result = ctx
        .client
        .put_markdown(&id, &markdown, base_seq, suggest)
        .await?;
    // A commenter's changes become suggestions even without --suggest.
    let suggest = suggest || result.suggested;
    let merged = result.markdown != markdown;
    let value = json!({ "doc": id, "seq": result.seq, "markdown": result.markdown, "merged": merged, "suggest": suggest, "conflicts": result.conflicts });
    ctx.emit(&value, || {
        if !result.conflicts.is_empty() {
            let mut out = format!(
                "Wrote {id} (seq {}). {} changed since you read it, differently from you: the doc keeps its text there, and yours is a suggestion on it.",
                result.seq,
                match result.conflicts.len() {
                    1 => "1 passage".to_owned(),
                    n => format!("{n} passages"),
                }
            );
            for c in &result.conflicts {
                out.push_str(&format!("\n\nNow:   {}\nYours: {}", c.now.trim_end(), c.yours.trim_end()));
                if let Some(s) = &c.suggestion {
                    out.push_str(&format!("\n`write accept {id} {s}` uses yours; `write reject {id} {s}` keeps it as it is."));
                }
            }
            out
        } else if suggest {
            format!("Suggested your changes to {id} (seq {}). They show once accepted; `write cat {id} --critic` shows them now.", result.seq)
        } else if merged && base_seq.is_some() {
            format!("Wrote {id} (seq {}). Changes made since then were merged in; read the result with `write cat`.", result.seq)
        } else {
            format!("Wrote {id} (seq {}).", result.seq)
        }
    });
    Ok(())
}

pub async fn image(ctx: &Ctx, doc: &str, file: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let upload = Upload::from_path(file).await?;
    let asset = ctx.client.upload_asset(&id, &upload).await?;
    let alt = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let snippet = format!("![{alt}]({})", asset.url);
    let value = json!({ "id": asset.id, "url": asset.url, "markdown": snippet });
    ctx.emit(&value, || {
        format!(
            "Uploaded {} ({}). Put it in the doc with:\n{snippet}",
            asset.id, asset.url
        )
    });
    Ok(())
}

pub async fn asset(ctx: &Ctx, id: &str, output: Option<PathBuf>) -> CliResult<()> {
    let download = ctx.client.asset(id).await?;
    let saved = save_download(ctx, download, output, id.to_owned()).await?;
    if let Some(path) = saved.get("path").and_then(Value::as_str) {
        let path = path.to_owned();
        ctx.emit(&saved, || {
            format!("Saved {path} ({} bytes).", saved["bytes"])
        });
    }
    Ok(())
}

// ── sharing ─────────────────────────────────────────────────────────────────────────────────

fn parse_role(role: &str) -> CliResult<Role> {
    role.parse()
        .map_err(|e: String| CliError::invalid(e, "Roles are editor, commenter and viewer."))
}

fn same_person(m: &Member, who: &str) -> bool {
    let who = who.trim();
    m.id == who
        || m.email
            .as_deref()
            .is_some_and(|e| e.eq_ignore_ascii_case(who))
        || m.account
            .as_ref()
            .is_some_and(|a| a.id == who || a.uuid == who)
}

pub async fn share(ctx: &Ctx, item: &str, to: &str, role: &str) -> CliResult<()> {
    let role = parse_role(role)?;
    let item = resolve::item_id(ctx, item, false).await?;
    let sharing = ctx.client.sharing(item.as_item()).await?;
    let existing = sharing
        .members
        .iter()
        .find(|m| same_person(m, to) && m.via_folder().is_none());
    let (member, changed) = match existing {
        Some(m) if m.role == role.as_str() => (m.clone(), false),
        Some(m) => (
            ctx.client
                .update_member(item.as_item(), &m.id, role)
                .await?,
            true,
        ),
        None => (ctx.client.share(item.as_item(), to, role).await?, true),
    };
    ctx.emit(&member, || {
        if !changed {
            format!(
                "{} already has {} access to {}.",
                member.label(),
                member.role,
                item.id()
            )
        } else if member.pending {
            format!(
                "Invited {} as {} to {}; they get access once they join Silicon Accounts.",
                member.label(),
                member.role,
                item.id()
            )
        } else {
            format!(
                "Shared {} with {} as {}.",
                item.id(),
                member.label(),
                member.role
            )
        }
    });
    Ok(())
}

pub async fn unshare(ctx: &Ctx, item: &str, who: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    let sharing = ctx.client.sharing(item.as_item()).await?;
    let matches: Vec<&Member> = sharing
        .members
        .iter()
        .filter(|m| same_person(m, who))
        .collect();
    let direct: Vec<&&Member> = matches
        .iter()
        .filter(|m| m.via_folder().is_none())
        .collect();
    let Some(member) = direct.first() else {
        if let Some(through) = matches.iter().find_map(|m| m.via_folder()) {
            return Err(CliError::new(
                "conflict",
                format!(
                    "{who} has access through the folder “{}” ({}), not directly.",
                    through.name, through.id
                ),
                format!(
                    "Remove them from the folder: `write unshare {} {who}`.",
                    through.id
                ),
            ));
        }
        return Err(CliError::not_found(
            format!(
                "{who} is not among the people {} is shared with.",
                item.id()
            ),
            format!("See who has access with `write members {}`.", item.id()),
        ));
    };
    ctx.client.remove_member(item.as_item(), &member.id).await?;
    let value = json!({ "removed": member.id, "who": member.label() });
    ctx.emit(&value, || {
        format!("{} no longer has access to {}.", member.label(), item.id())
    });
    Ok(())
}

pub async fn members(ctx: &Ctx, item: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    let sharing = ctx.client.sharing(item.as_item()).await?;
    ctx.emit(&sharing, || {
        let mut rows = vec![vec![
            sharing.owner.label().to_owned(),
            "owner".into(),
            String::new(),
        ]];
        for m in &sharing.members {
            let mut note = match m.via_folder() {
                Some(f) => format!("through folder {}", f.name),
                None => String::new(),
            };
            if m.pending {
                note = format!("{note} invited, not joined yet").trim().to_owned();
            }
            rows.push(vec![m.label(), m.role.clone(), note]);
        }
        let mut out = table(&rows);
        if let Some(access) = sharing.public_access.as_deref().filter(|a| *a != "none") {
            out.push_str(&format!("\nAnyone with the link can {access}."));
        }
        out
    });
    Ok(())
}

pub async fn public(ctx: &Ctx, doc: &str, access: &str) -> CliResult<()> {
    let access: PublicAccess = access
        .parse()
        .map_err(|e: String| CliError::invalid(e, "Use none, view, comment or edit."))?;
    let id = resolve::doc_id(ctx, doc, false).await?;
    let d = ctx.client.set_public(&id, access).await?;
    ctx.emit(&d, || match access {
        PublicAccess::None => format!(
            "{} is private again; its link no longer opens it for others.",
            doc_summary(&d)
        ),
        PublicAccess::View => format!(
            "Anyone with the link can view {}:\n{}",
            doc_summary(&d),
            d.url
        ),
        other => format!(
            "Anyone with the link can view {}, and anyone signed in can {} it:\n{}",
            doc_summary(&d),
            other.as_str(),
            d.url
        ),
    });
    Ok(())
}

pub async fn transfer(ctx: &Ctx, item: &str, to: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    let t = ctx.client.transfer(item.as_item(), to).await?;
    ctx.emit(&t, || {
        format!("Asked {} to take {} “{}” ({}). It moves once they accept; cancel with `write transfers cancel {}`.", t.to.label(), t.item.kind, t.item.title, t.item.id, t.id)
    });
    Ok(())
}

pub async fn transfers(ctx: &Ctx, action: Option<(TransferAction, String)>) -> CliResult<()> {
    ctx.require_session()?;
    if let Some((action, id)) = action {
        let t = ctx.client.transfer_action(&id, action).await?;
        ctx.emit(&t, || {
            let verb = match action {
                TransferAction::Accept => "Accepted",
                TransferAction::Decline => "Declined",
                TransferAction::Cancel => "Cancelled",
            };
            format!(
                "{verb} the transfer of {} “{}” ({}).",
                t.item.kind, t.item.title, t.item.id
            )
        });
        return Ok(());
    }
    let list = ctx.client.transfers().await?;
    ctx.emit(&list, || {
        let line = |t: &Transfer, other: &Account, dir: &str| {
            vec![
                t.id.clone(),
                format!("{} “{}”", t.item.kind, t.item.title),
                format!("{dir} {}", other.label()),
                t.status.clone(),
            ]
        };
        let mut rows: Vec<Vec<String>> = list
            .incoming
            .iter()
            .map(|t| line(t, &t.from, "from"))
            .collect();
        rows.extend(list.outgoing.iter().map(|t| line(t, &t.to, "to")));
        if rows.is_empty() {
            "No transfers.".into()
        } else {
            format!("{}\nAccept with `write transfers accept ID`.", table(&rows))
        }
    });
    Ok(())
}

// ── comments ────────────────────────────────────────────────────────────────────────────────

fn reactions(c: &Comment) -> String {
    if c.reactions.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = c
        .reactions
        .iter()
        .map(|r| format!("{} {}", r.emoji, r.accounts.len()))
        .collect();
    format!("  [{}]", parts.join(", "))
}

fn render_thread(t: &Thread) -> String {
    let quote = t.current_quote.as_deref().unwrap_or(&t.quote);
    let mut status = t.status.clone();
    if t.orphaned {
        status.push_str(" · its text was deleted");
    }
    let mut out = format!("{}  {status} · on “{}”\n", t.id, quote.replace('\n', " "));
    for (i, c) in t.comments.iter().enumerate() {
        let lead = if i == 0 { "  " } else { "  ↳ " };
        let body = if c.deleted {
            "(deleted)".to_owned()
        } else {
            c.body.replace('\n', "\n    ")
        };
        let edited = if c.edited_at.is_some() {
            " (edited)"
        } else {
            ""
        };
        out.push_str(&format!(
            "{lead}{} · {}{edited}  {}\n    {body}{}\n",
            c.author.label(),
            when(&c.created_at),
            c.id,
            reactions(c)
        ));
    }
    out
}

pub async fn comments(ctx: &Ctx, doc: &str, all: bool, resolved: bool) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let status = if all {
        ThreadStatus::All
    } else if resolved {
        ThreadStatus::Resolved
    } else {
        ThreadStatus::Open
    };
    let threads = ctx.client.threads(&id, status).await?;
    let value = json!({ "threads": threads });
    ctx.emit(&value, || {
        if threads.is_empty() {
            format!(
                "No {} comments on {id}.",
                if all { "" } else { status.as_str() }
            )
            .replace("  ", " ")
        } else {
            threads
                .iter()
                .map(render_thread)
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(())
}

/// `X,Y,W,H` fractions of a page.
pub fn parse_rect(s: &str, page: u32) -> CliResult<Rect> {
    let bad = || {
        CliError::invalid(
            format!("`{s}` is not an area."),
            "Write it as X,Y,W,H in fractions of the page, e.g. --rect 0.1,0.2,0.5,0.1.",
        )
    };
    let n: Vec<f64> = s
        .split(',')
        .map(|p| p.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .map_err(|_| bad())?;
    let [x, y, w, h] = n[..] else {
        return Err(bad());
    };
    let fraction = |v: f64| (0.0..=1.0).contains(&v);
    if !(fraction(x) && fraction(y) && fraction(w) && fraction(h)) || w == 0.0 || h == 0.0 {
        return Err(bad());
    }
    Ok(Rect {
        x,
        y,
        w,
        h,
        page: Some(page),
    })
}

pub async fn comment(
    ctx: &Ctx,
    doc: &str,
    quote: Option<String>,
    page: Option<u32>,
    rect: Option<String>,
    body: &str,
) -> CliResult<()> {
    let body = body_text(body)?;
    let anchor = match (quote, page) {
        (_, Some(0)) => {
            return Err(CliError::invalid(
                "Pages count from 1.",
                "Pass --page 1 for the first page.",
            ));
        }
        (_, Some(page)) => Anchor::pdf_area(match rect.as_deref() {
            Some(r) => parse_rect(r, page)?,
            None => Rect::page(page),
        }),
        (Some(quote), None) if !quote.is_empty() => Anchor::quote(quote),
        _ => {
            return Err(CliError::invalid(
                "--quote is empty.",
                "Quote the exact text the comment is about (it must appear once in the doc), or pass --page for a PDF.",
            ));
        }
    };
    let id = resolve::doc_id(ctx, doc, false).await?;
    let t = ctx.client.create_thread(&id, &anchor, &body).await.map_err(|e| {
        let mut err = CliError::from(e);
        if matches!(err.code.as_str(), "no_match" | "not_unique") && err.hint.is_none() {
            err.hint = Some(format!(
                "Quote exact text that appears once in the doc's text; read it with `write cat {id}`."
            ));
        }
        err
    })?;
    ctx.emit(&t, || format!("Commented on “{}” ({}).", t.quote, t.id));
    Ok(())
}

pub async fn reply(ctx: &Ctx, thread: &str, body: &str) -> CliResult<()> {
    let body = body_text(body)?;
    let c = ctx.client.reply(thread, &body).await?;
    ctx.emit(&c, || format!("Replied in {thread} ({}).", c.id));
    Ok(())
}

pub async fn resolve_thread(ctx: &Ctx, thread: &str, reopen: bool) -> CliResult<()> {
    let t = if reopen {
        ctx.client.reopen(thread).await?
    } else {
        ctx.client.resolve(thread).await?
    };
    ctx.emit(&t, || {
        if reopen {
            format!("Reopened {}.", t.id)
        } else {
            format!("Resolved {}.", t.id)
        }
    });
    Ok(())
}

pub async fn react(ctx: &Ctx, comment: &str, emoji: &str) -> CliResult<()> {
    let me = ctx.client.me().await?;
    let c = ctx.client.react(comment, emoji).await?;
    let on = c
        .reactions
        .iter()
        .any(|r| r.emoji == emoji && r.accounts.iter().any(|a| a.uuid == me.uuid));
    ctx.emit(&c, || {
        if on {
            format!("Reacted {emoji} to {comment}.")
        } else {
            format!("Removed your {emoji} from {comment}.")
        }
    });
    Ok(())
}

pub async fn comment_edit(ctx: &Ctx, comment: &str, body: &str) -> CliResult<()> {
    let body = body_text(body)?;
    let c = ctx.client.edit_comment(comment, &body).await?;
    ctx.emit(&c, || format!("Edited {}.", c.id));
    Ok(())
}

pub async fn comment_rm(ctx: &Ctx, comment: &str) -> CliResult<()> {
    ctx.client.delete_comment(comment).await?;
    let value = json!({ "deleted": comment });
    ctx.emit(&value, || {
        format!("Deleted {comment} (it stays in the doc's history).")
    });
    Ok(())
}

// ── suggestions ─────────────────────────────────────────────────────────────────────────────

pub async fn suggestions(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let list = ctx.client.suggestions(&id).await?;
    let value = json!({ "suggestions": list });
    ctx.emit(&value, || {
        if list.is_empty() {
            return format!("No pending suggestions on {id}.");
        }
        let mut out = String::new();
        for s in &list {
            out.push_str(&format!("{}  by {}\n", s.id, s.author.label()));
            if !s.deleted.is_empty() {
                out.push_str(&format!("  - {}\n", s.deleted.replace('\n', "\n    ")));
            }
            if !s.inserted.is_empty() {
                out.push_str(&format!("  + {}\n", s.inserted.replace('\n', "\n    ")));
            }
        }
        out.push_str(&format!(
            "Accept with `write accept {id} ID` (or --all); reject with `write reject`."
        ));
        out
    });
    Ok(())
}

pub async fn decide(
    ctx: &Ctx,
    doc: &str,
    sid: Option<String>,
    all: bool,
    accept: bool,
) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let result = match (sid, all) {
        (Some(sid), false) => {
            if accept {
                ctx.client.accept_suggestion(&id, &sid).await?
            } else {
                ctx.client.reject_suggestion(&id, &sid).await?
            }
        }
        (None, true) => {
            if accept {
                ctx.client.accept_all_suggestions(&id).await?
            } else {
                ctx.client.reject_all_suggestions(&id).await?
            }
        }
        _ => {
            return Err(CliError::invalid(
                "Pass one suggestion id, or --all.",
                format!("List them with `write suggestions {id}`."),
            ));
        }
    };
    let value = json!({ "doc": id, "seq": result.seq });
    ctx.emit(&value, || {
        format!(
            "{} (seq {}).",
            if accept { "Accepted" } else { "Rejected" },
            result.seq
        )
    });
    Ok(())
}

// ── versions ────────────────────────────────────────────────────────────────────────────────

pub async fn versions(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let list = ctx.client.versions(&id).await?;
    let value = json!({ "versions": list });
    ctx.emit(&value, || {
        if list.is_empty() {
            return "No versions yet.".into();
        }
        let rows: Vec<Vec<String>> = list
            .iter()
            .map(|v| {
                let mut summary = v.summary.clone();
                if let Some(name) = &v.name {
                    summary = format!("{summary}  [{name}]");
                }
                vec![format!("seq {}", v.seq), when(&v.created_at), summary]
            })
            .collect();
        table(&rows)
    });
    Ok(())
}

pub async fn version(ctx: &Ctx, doc: &str, seq: i64) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let md = ctx.client.version_markdown(&id, seq).await?;
    ctx.emit(&md, || md.markdown.clone());
    Ok(())
}

pub async fn name_version(
    ctx: &Ctx,
    doc: &str,
    seq: i64,
    name: Option<String>,
    remove: bool,
) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    match (name, remove) {
        (Some(name), false) => {
            let named = ctx.client.name_version(&id, seq, &name).await?;
            ctx.emit(&named, || {
                format!("Named version {} of {id} “{}”.", named.seq, named.name)
            });
        }
        (None, true) => {
            ctx.client.unname_version(&id, seq).await?;
            ctx.emit(&json!({ "doc": id, "seq": seq, "name": null }), || {
                format!("Removed the name of version {seq}.")
            });
        }
        _ => {
            return Err(CliError::invalid(
                "Pass a NAME, or --remove.",
                "Example: `write name DOC 42 \"Sent to the client\"`.",
            ));
        }
    }
    Ok(())
}

/// A comparison as text: `+`/`-` for added and removed blocks, `~` for a changed block with
/// its words marked `[-removed-]{+added+}`, and who made each change.
fn render_comparison(cmp: &Comparison) -> String {
    let prefixed = |text: &str, mark: &str| {
        text.trim_end()
            .lines()
            .map(|l| format!("{mark} {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let with_by = |text: String, by: &[Account]| {
        let names: std::collections::BTreeSet<&str> = by
            .iter()
            .map(|a| a.label())
            .filter(|l| !l.is_empty())
            .collect();
        if names.is_empty() {
            text
        } else {
            format!(
                "{text}\n  by {}",
                names.into_iter().collect::<Vec<_>>().join(", ")
            )
        }
    };
    let mut out = Vec::new();
    for b in &cmp.blocks {
        match b.change.as_str() {
            "same" => {}
            "added" => out.push(with_by(
                prefixed(b.after.as_deref().unwrap_or(""), "+"),
                &b.by,
            )),
            "removed" => out.push(with_by(
                prefixed(b.before.as_deref().unwrap_or(""), "-"),
                &b.by,
            )),
            _ => {
                let parts = b.parts.as_deref().unwrap_or_default();
                // Words marked inline when the block keeps some of its text; a rewritten block
                // reads better as its lines before and after.
                let shares_text = parts
                    .iter()
                    .any(|p| p.op == "same" && !p.text.trim().is_empty());
                let block = if shares_text && parts.iter().any(|p| p.op != "same") {
                    let inline: String = parts
                        .iter()
                        .map(|p| match p.op.as_str() {
                            "added" => format!("{{+{}+}}", p.text),
                            "removed" => format!("[-{}-]", p.text),
                            _ => p.text.clone(),
                        })
                        .collect();
                    prefixed(&inline, "~")
                } else {
                    format!(
                        "{}\n{}",
                        prefixed(b.before.as_deref().unwrap_or(""), "-"),
                        prefixed(b.after.as_deref().unwrap_or(""), "+")
                    )
                };
                let mut by: Vec<Account> = parts
                    .iter()
                    .filter(|p| p.op != "same")
                    .filter_map(|p| p.by.clone())
                    .collect();
                by.extend(b.by.iter().cloned());
                out.push(with_by(block, &by));
            }
        }
    }
    out.join("\n\n")
}

pub async fn compare(ctx: &Ctx, doc: &str, from: i64, to: i64) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let cmp = ctx.client.compare(&id, from, to).await?;
    ctx.emit(&cmp, || {
        let text = render_comparison(&cmp);
        if text.is_empty() {
            format!("No differences between versions {from} and {to}.")
        } else {
            text
        }
    });
    Ok(())
}

/// `FROM..TO` (inclusive top-level block indexes).
pub fn parse_blocks(s: &str) -> CliResult<(i64, i64)> {
    let bad = || {
        CliError::invalid(
            format!("`{s}` is not a block range."),
            "Write it as FROM..TO, e.g. --blocks 2..4 (top-level blocks, from 0).",
        )
    };
    let (a, b) = s.split_once("..").ok_or_else(bad)?;
    let a: i64 = a.trim().parse().map_err(|_| bad())?;
    let b: i64 = b.trim().parse().map_err(|_| bad())?;
    if a < 0 || b < a {
        return Err(bad());
    }
    Ok((a, b))
}

pub async fn revert(ctx: &Ctx, doc: &str, seq: i64, blocks: Option<String>) -> CliResult<()> {
    let blocks = blocks.as_deref().map(parse_blocks).transpose()?;
    let id = resolve::doc_id(ctx, doc, false).await?;
    let result = ctx.client.restore_version(&id, seq, blocks).await?;
    let value = json!({ "doc": id, "seq": result.seq, "from_version": seq, "blocks": blocks.map(|(a, b)| json!([a, b])) });
    ctx.emit(&value, || match blocks {
        Some((a, b)) => format!(
            "Brought back blocks {a}..{b} from version {seq}; that is the new version {}.",
            result.seq
        ),
        None => format!(
            "Restored version {seq}; that is the new version {} (nothing after it is lost).",
            result.seq
        ),
    });
    Ok(())
}

pub async fn undo(
    ctx: &Ctx,
    doc: Option<String>,
    account: Option<String>,
    since: Option<i64>,
    event: Option<String>,
) -> CliResult<()> {
    if let Some(event) = event {
        ctx.require_session()?;
        let result = ctx.client.undo_activity(&event).await?;
        let value = if result.is_null() {
            json!({ "undone": event })
        } else {
            result
        };
        ctx.emit(&value, || format!("Undid {event}."));
        return Ok(());
    }
    let (Some(doc), Some(account), Some(since)) = (doc, account, since) else {
        return Err(CliError::invalid(
            "Pass DOC --account ID --since SEQ, or --event ID.",
            "Example: `write undo \"Launch plan\" --account si:writer --since 40`; event ids come from `write activity`.",
        ));
    };
    let id = resolve::doc_id(ctx, &doc, false).await?;
    let result = ctx.client.undo(&id, &account, since).await?;
    let value = json!({ "doc": id, "seq": result.seq });
    ctx.emit(&value, || {
        format!(
            "Undid what {account} changed after version {since}; that is the new version {}.",
            result.seq
        )
    });
    Ok(())
}

/// `doc.renamed “New title”` style description of an event.
fn describe_event(e: &ActivityEvent) -> String {
    let name = ["title", "name", "to", "account", "doc", "folder"]
        .iter()
        .find_map(|k| e.data.get(*k).and_then(Value::as_str))
        .map(|n| format!(" “{n}”"))
        .unwrap_or_default();
    format!("{}{name}", e.kind)
}

pub async fn activity(ctx: &Ctx, item: &str) -> CliResult<()> {
    let item = resolve::item_id(ctx, item, false).await?;
    let events = ctx.client.activity(item.as_item()).await?;
    let value = json!({ "events": events });
    ctx.emit(&value, || {
        if events.is_empty() {
            return "No activity yet.".into();
        }
        let rows: Vec<Vec<String>> = events
            .iter()
            .map(|e| {
                vec![
                    e.id.clone(),
                    when(&e.created_at),
                    e.actor.label().to_owned(),
                    describe_event(e),
                    if e.undoable {
                        "undoable".into()
                    } else {
                        String::new()
                    },
                ]
            })
            .collect();
        let mut out = table(&rows);
        if events.iter().any(|e| e.undoable) {
            out.push_str("\nUndo an event with `write undo --event ID`.");
        }
        out
    });
    Ok(())
}

pub async fn authors(ctx: &Ctx, doc: &str) -> CliResult<()> {
    let id = resolve::doc_id(ctx, doc, false).await?;
    let authorship = ctx.client.authorship(&id).await?;
    ctx.emit(&authorship, || {
        if authorship.blocks.is_empty() {
            return "The doc is empty.".into();
        }
        let rows: Vec<Vec<String>> = authorship
            .blocks
            .iter()
            .map(|b| {
                vec![
                    format!("block {}", b.index),
                    b.authors
                        .iter()
                        .map(|a| a.label().to_owned())
                        .collect::<Vec<_>>()
                        .join(", "),
                ]
            })
            .collect();
        table(&rows)
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_areas() {
        let r = parse_rect("0.1, 0.2,0.5,0.25", 3).unwrap();
        assert_eq!((r.x, r.y, r.w, r.h, r.page), (0.1, 0.2, 0.5, 0.25, Some(3)));
        assert!(parse_rect("0.1,0.2,0.5", 1).is_err());
        assert!(parse_rect("0.1,0.2,1.5,0.1", 1).is_err());
        assert!(parse_rect("a,b,c,d", 1).is_err());
        let anchor = serde_json::to_value(Anchor::pdf_area(Rect::page(2))).unwrap();
        assert_eq!(
            anchor,
            json!({ "kind": "pdf", "quote": "Page 2", "rect": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "page": 2 } })
        );
    }

    #[test]
    fn block_ranges() {
        assert_eq!(parse_blocks("2..4").unwrap(), (2, 4));
        assert_eq!(parse_blocks("0..0").unwrap(), (0, 0));
        assert!(parse_blocks("4..2").is_err());
        assert!(parse_blocks("2-4").is_err());
    }

    #[test]
    fn tables_align() {
        let t = table(&[
            vec!["a".into(), "bb".into()],
            vec!["ccc".into(), "d".into()],
        ]);
        assert_eq!(t, "a    bb\nccc  d");
    }

    #[test]
    fn comparisons_read_as_word_diffs() {
        let cmp: Comparison = serde_json::from_value(json!({ "blocks": [
            { "change": "same", "after": "# Plan" },
            { "change": "changed", "before": "Ship Monday.", "after": "Ship Tuesday.", "parts": [
                { "op": "same", "text": "Ship " },
                { "op": "removed", "text": "Mon", "by": { "id": "si:writer" } },
                { "op": "added", "text": "Tues", "by": { "id": "si:writer" } },
                { "op": "same", "text": "day." } ] },
            { "change": "added", "after": "New line.", "by": { "id": "c:saket" }, "after_index": 2 },
            { "change": "removed", "before": "Old line." },
            { "change": "changed", "before": "Gone.", "after": "Fresh.", "parts": [ { "op": "added", "text": "Fresh." } ] }
        ] }))
        .unwrap();
        assert_eq!(
            render_comparison(&cmp),
            "~ Ship [-Mon-]{+Tues+}day.\n  by si:writer\n\n+ New line.\n  by c:saket\n\n- Old line.\n\n- Gone.\n+ Fresh."
        );
    }

    #[test]
    fn timestamps() {
        assert_eq!(when("2026-10-17T09:12:33.123Z"), "2026-10-17 09:12");
        assert_eq!(when(""), "");
    }
}
