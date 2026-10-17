//! Turning DOC and FOLDER arguments (ids, links, titles, paths) into ids.

use serde_json::json;
use silicon_write_client::{Doc, Folder, LibraryView};

use crate::ctx::Ctx;
use crate::error::{CliError, CliResult};

/// What a DOC argument names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocRef {
    Id(String),
    Title(String),
}

/// `d_…`, a doc link (`…/d/d_…`), or a title.
pub fn parse_doc_ref(arg: &str) -> DocRef {
    let arg = arg.trim();
    if is_id(arg, "d_") {
        return DocRef::Id(arg.to_owned());
    }
    if (arg.starts_with("http://") || arg.starts_with("https://"))
        && let Ok(url) = url::Url::parse(arg)
        && let Some(segments) = url.path_segments()
    {
        let segments: Vec<&str> = segments.collect();
        if let Some(id) = segments.iter().find(|s| is_id(s, "d_")) {
            return DocRef::Id((*id).to_owned());
        }
    }
    DocRef::Title(arg.to_owned())
}

pub fn is_id(s: &str, prefix: &str) -> bool {
    s.len() > prefix.len()
        && s.starts_with(prefix)
        && s[prefix.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn doc_line(d: &Doc) -> String {
    let place = if d.path.is_empty() {
        "top level".to_owned()
    } else {
        d.folder_path()
    };
    format!(
        "{}  {} ({}, owner {})",
        d.id,
        d.title,
        place,
        d.owner.label()
    )
}

fn folder_full_path(f: &Folder) -> String {
    let mut parts: Vec<&str> = f.path.iter().map(|p| p.name.as_str()).collect();
    parts.push(&f.name);
    parts.join("/")
}

fn ambiguous(kind: &str, arg: &str, lines: Vec<String>, ids: Vec<String>) -> CliError {
    CliError::new(
        "ambiguous",
        format!(
            "“{arg}” matches {} {kind}s:\n  {}",
            lines.len(),
            lines.join("\n  ")
        ),
        format!("Pass the {kind} id instead (the first column)."),
    )
    .with_details(json!({ "matches": ids }))
}

/// Docs whose title is exactly `title`.
fn match_title<'a>(docs: &'a [Doc], title: &str) -> Vec<&'a Doc> {
    docs.iter().filter(|d| d.title == title).collect()
}

/// Resolves a DOC argument to a doc id. Titles are looked up among every doc you can open
/// (and, with `include_trash`, your trash).
pub async fn doc_id(ctx: &Ctx, arg: &str, include_trash: bool) -> CliResult<String> {
    let title = match parse_doc_ref(arg) {
        DocRef::Id(id) => return Ok(id),
        DocRef::Title(t) => t,
    };
    if title.is_empty() {
        return Err(CliError::invalid(
            "The doc is empty.",
            "Pass a doc id (d_…), a doc link or an exact title.",
        ));
    }
    ctx.require_session()?;
    let mut docs = ctx.client.docs().await?;
    if include_trash {
        docs.extend(ctx.client.library(LibraryView::Trash, None).await?.docs);
    }
    let matches = match_title(&docs, &title);
    match matches.len() {
        1 => Ok(matches[0].id.clone()),
        0 => {
            let lower = title.to_lowercase();
            let close: Vec<String> = docs
                .iter()
                .filter(|d| d.title.to_lowercase().contains(&lower))
                .take(5)
                .map(|d| format!("“{}” ({})", d.title, d.id))
                .collect();
            let hint = if close.is_empty() {
                "Titles must match exactly. List your docs with `write ls` or search with `write search TEXT`.".to_owned()
            } else {
                format!(
                    "Titles must match exactly. Did you mean {}?",
                    close.join(", ")
                )
            };
            Err(CliError::not_found(
                format!("No doc you can open is titled “{title}”."),
                hint,
            ))
        }
        _ => Err(ambiguous(
            "doc",
            &title,
            matches.iter().map(|d| doc_line(d)).collect(),
            matches.iter().map(|d| d.id.clone()).collect(),
        )),
    }
}

/// Resolves a FOLDER argument: `f_…`, or a folder path like `Plans/Q3` (or just a unique
/// name). `/` means the top level and resolves to `None`.
pub async fn folder_id(ctx: &Ctx, arg: &str, include_trash: bool) -> CliResult<Option<String>> {
    let arg = arg.trim();
    if arg == "/" || arg.is_empty() {
        return Ok(None);
    }
    if is_id(arg, "f_") {
        return Ok(Some(arg.to_owned()));
    }
    ctx.require_session()?;
    let mut folders = ctx.client.folders().await?;
    if include_trash {
        folders.extend(ctx.client.library(LibraryView::Trash, None).await?.folders);
    }
    let wanted = arg.trim_matches('/');
    let by_path: Vec<&Folder> = folders
        .iter()
        .filter(|f| folder_full_path(f) == wanted)
        .collect();
    let matches = if by_path.is_empty() {
        folders.iter().filter(|f| f.name == wanted).collect()
    } else {
        by_path
    };
    match matches.len() {
        1 => Ok(Some(matches[0].id.clone())),
        0 => Err(CliError::not_found(
            format!("No folder you can open is called “{arg}”."),
            "Folder paths look like `Plans/Q3`; list them with `write tree`, or pass the folder id (f_…).",
        )),
        _ => Err(ambiguous(
            "folder",
            arg,
            matches
                .iter()
                .map(|f| {
                    format!(
                        "{}  {} (owner {})",
                        f.id,
                        folder_full_path(f),
                        f.owner.label()
                    )
                })
                .collect(),
            matches.iter().map(|f| f.id.clone()).collect(),
        )),
    }
}

/// A doc or a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemId {
    Doc(String),
    Folder(String),
}

impl ItemId {
    pub fn as_item(&self) -> silicon_write_client::Item<'_> {
        match self {
            Self::Doc(id) => silicon_write_client::Item::Doc(id),
            Self::Folder(id) => silicon_write_client::Item::Folder(id),
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Doc(id) | Self::Folder(id) => id,
        }
    }
}

/// Resolves an argument that may be a doc or a folder.
pub async fn item_id(ctx: &Ctx, arg: &str, include_trash: bool) -> CliResult<ItemId> {
    let trimmed = arg.trim();
    if is_id(trimmed, "f_") {
        return Ok(ItemId::Folder(trimmed.to_owned()));
    }
    if let DocRef::Id(id) = parse_doc_ref(trimmed) {
        return Ok(ItemId::Doc(id));
    }
    let doc = doc_id(ctx, trimmed, include_trash).await;
    let folder = folder_id(ctx, trimmed, include_trash).await;
    match (doc, folder) {
        (Ok(d), Ok(Some(f))) => Err(CliError::new(
            "ambiguous",
            format!("“{trimmed}” is both a doc ({d}) and a folder ({f})."),
            "Pass the id of the one you mean.",
        )),
        (Ok(d), _) => Ok(ItemId::Doc(d)),
        (_, Ok(Some(f))) => Ok(ItemId::Folder(f)),
        (Err(e), _) if e.code == "ambiguous" => Err(e),
        (_, Err(e)) if e.code == "ambiguous" => Err(e),
        (Err(e), _) if e.code != "not_found" => Err(e),
        _ => Err(CliError::not_found(
            format!("No doc or folder you can open is called “{trimmed}”."),
            "Pass an id (d_… or f_…), a doc link, an exact doc title or a folder path; `write tree` lists them.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_refs() {
        assert_eq!(parse_doc_ref("d_x7Kq9"), DocRef::Id("d_x7Kq9".into()));
        assert_eq!(
            parse_doc_ref("https://write.teamofsilicons.com/d/d_x7Kq9"),
            DocRef::Id("d_x7Kq9".into())
        );
        assert_eq!(
            parse_doc_ref("http://localhost:4370/d/d_abc-1?x=1#h"),
            DocRef::Id("d_abc-1".into())
        );
        assert_eq!(
            parse_doc_ref("Launch plan"),
            DocRef::Title("Launch plan".into())
        );
        assert_eq!(
            parse_doc_ref("d_ with space"),
            DocRef::Title("d_ with space".into())
        );
        assert_eq!(parse_doc_ref("d_"), DocRef::Title("d_".into()));
    }
}
