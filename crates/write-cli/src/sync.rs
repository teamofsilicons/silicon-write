//! `write pull`, `write push` and `write status`: a folder of `.md` files mirroring every doc
//! you can open, with `.write/state.json` remembering which file is which doc and the `seq` and
//! Markdown it was pulled at, so a push sends only what changed and the service merges it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use futures::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use silicon_write_client::{Doc, DocMarkdown, DocPatch, Folder, MarkdownOptions, NewDoc};

use crate::ctx::Ctx;
use crate::error::{CliError, CliResult};

/// Where docs shared with you go.
pub const SHARED_DIR: &str = "Shared with me";
const STATE_DIR: &str = ".write";
const STATE_FILE: &str = "state.json";
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StateAccount {
    pub uuid: String,
    pub id: String,
}

/// One pulled file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FileEntry {
    pub doc: String,
    pub title: String,
    pub seq: i64,
    pub folder: Option<String>,
    /// The Markdown as it was pulled (or pushed); a file that differs is modified.
    pub markdown: String,
}

/// `.write/state.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub version: u32,
    pub api_url: String,
    pub account: StateAccount,
    pub pulled_at: String,
    /// File path (relative, `/`-separated) → doc.
    pub files: BTreeMap<String, FileEntry>,
    /// Directory (relative, `/`-separated) → folder id.
    pub folders: BTreeMap<String, String>,
}

fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STATE_FILE)
}

pub fn load_state(root: &Path) -> CliResult<Option<State>> {
    let path = state_path(root);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            CliError::new(
                "invalid",
                format!("{} could not be read ({e}).", path.display()),
                "Move the folder aside and pull again into an empty one.",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CliError::io(
            format!("Could not read {}: {e}.", path.display()),
            e,
        )),
    }
}

fn save_state(root: &Path, state: &State) -> CliResult<()> {
    let dir = root.join(STATE_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| CliError::io(format!("Could not create {}: {e}.", dir.display()), e))?;
    let tmp = dir.join(format!(".state.json.{}.tmp", std::process::id()));
    let json = serde_json::to_vec_pretty(state).expect("state serializes");
    fs::write(&tmp, json)
        .and_then(|()| fs::rename(&tmp, state_path(root)))
        .map_err(|e| {
            CliError::io(
                format!("Could not save {}: {e}.", state_path(root).display()),
                e,
            )
        })
}

/// A title or folder name made safe as a file name on every common filesystem.
pub fn safe_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_space = false;
    for c in name.chars() {
        let c = match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    let trimmed = out
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim();
    let mut result: String = trimmed.chars().take(MAX_NAME_CHARS).collect();
    result = result.trim_end_matches(['.', ' ']).to_owned();
    if result.is_empty() {
        "Untitled".to_owned()
    } else {
        result
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn file_name_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(_, n)| n).unwrap_or(rel)
}

pub fn to_path(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// The title a file stands for: its name without `.md`.
fn title_of(rel: &str) -> String {
    let name = file_name_of(rel);
    name.strip_suffix(".md").unwrap_or(name).to_owned()
}

/// Whether `name` is `base` + optional ` (n)` + `ext`.
fn is_variant(name: &str, base: &str, ext: &str) -> bool {
    let Some(stem) = name.strip_suffix(ext) else {
        return false;
    };
    if stem.eq_ignore_ascii_case(base) {
        return true;
    }
    stem.len() > base.len()
        && stem[..base.len()].eq_ignore_ascii_case(base)
        && stem[base.len()..].starts_with(" (")
        && stem.ends_with(')')
        && stem[base.len() + 2..stem.len() - 1]
            .chars()
            .all(|c| c.is_ascii_digit())
}

struct Entry<'a> {
    id: &'a str,
    base: String,
    ext: &'static str,
    created_at: &'a str,
}

/// Names a directory's entries: an entry keeps the name it had before when it still fits,
/// the others take `base`, `base (2)`, … in creation order. Names compare case-insensitively.
fn assign_names(
    dir: &str,
    entries: Vec<Entry<'_>>,
    previous: &HashMap<String, String>,
    reserved: &[&str],
) -> Vec<(String, String)> {
    let mut taken: HashSet<String> = reserved.iter().map(|r| r.to_lowercase()).collect();
    let mut named = Vec::new();
    let mut rest = Vec::new();
    for entry in entries {
        let keep = previous
            .get(entry.id)
            .filter(|p| parent_of(p) == dir && is_variant(file_name_of(p), &entry.base, entry.ext))
            .map(|p| file_name_of(p).to_owned())
            .filter(|n| !taken.contains(&n.to_lowercase()));
        match keep {
            Some(name) => {
                taken.insert(name.to_lowercase());
                named.push((entry.id.to_owned(), join(dir, &name)));
            }
            None => rest.push(entry),
        }
    }
    rest.sort_by(|a, b| (a.created_at, a.id).cmp(&(b.created_at, b.id)));
    for entry in rest {
        let mut n = 1;
        let name = loop {
            let candidate = if n == 1 {
                format!("{}{}", entry.base, entry.ext)
            } else {
                format!("{} ({n}){}", entry.base, entry.ext)
            };
            if !taken.contains(&candidate.to_lowercase()) {
                break candidate;
            }
            n += 1;
        };
        taken.insert(name.to_lowercase());
        named.push((entry.id.to_owned(), join(dir, &name)));
    }
    named
}

/// Where every folder and doc goes.
#[derive(Debug, Default)]
pub struct Layout {
    /// Folder id → directory.
    pub folders: HashMap<String, String>,
    /// Doc id → file.
    pub docs: HashMap<String, String>,
}

/// Plans the folder tree: your own docs by their folders at the top, docs shared with you
/// under `Shared with me/` (from the top-most folder you can open).
pub fn plan_layout(me: &str, folders: &[Folder], docs: &[&Doc], state: &State) -> Layout {
    let open: HashMap<&str, &Folder> = folders
        .iter()
        .filter(|f| f.deleted_at.is_none())
        .map(|f| (f.id.as_str(), f))
        .collect();
    let mut prev_folder: HashMap<String, String> = HashMap::new();
    for (dir, id) in &state.folders {
        prev_folder.insert(id.clone(), dir.clone());
    }
    let mut prev_doc: HashMap<String, String> = HashMap::new();
    for (path, entry) in &state.files {
        prev_doc.insert(entry.doc.clone(), path.clone());
    }

    // Directory key: None = own top level, Some("") = shared top level, Some(id) = a folder.
    let group = |parent: Option<&String>, owner: &str| -> String {
        match parent.filter(|p| open.contains_key(p.as_str())) {
            Some(p) => p.clone(),
            None if owner == me => "@top".into(),
            None => "@shared".into(),
        }
    };
    let mut child_folders: HashMap<String, Vec<&Folder>> = HashMap::new();
    for f in open.values() {
        child_folders
            .entry(group(f.parent_id.as_ref(), &f.owner.uuid))
            .or_default()
            .push(f);
    }
    let mut child_docs: HashMap<String, Vec<&Doc>> = HashMap::new();
    for d in docs {
        child_docs
            .entry(group(d.folder_id.as_ref(), &d.owner.uuid))
            .or_default()
            .push(d);
    }

    let mut layout = Layout::default();
    let mut queue: Vec<(String, String)> = vec![
        ("@top".into(), String::new()),
        ("@shared".into(), SHARED_DIR.into()),
    ];
    let mut seen = HashSet::new();
    while let Some((key, dir)) = queue.pop() {
        if !seen.insert(key.clone()) {
            continue;
        }
        let mut entries = Vec::new();
        for f in child_folders
            .get(&key)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            entries.push(Entry {
                id: &f.id,
                base: safe_name(&f.name),
                ext: "",
                created_at: &f.created_at,
            });
        }
        for d in child_docs.get(&key).map(Vec::as_slice).unwrap_or_default() {
            entries.push(Entry {
                id: &d.id,
                base: safe_name(&d.title),
                ext: ".md",
                created_at: &d.created_at,
            });
        }
        let mut previous = prev_folder.clone();
        previous.extend(prev_doc.iter().map(|(k, v)| (k.clone(), v.clone())));
        let reserved: &[&str] = if key == "@top" {
            &[SHARED_DIR, STATE_DIR]
        } else {
            &[STATE_DIR]
        };
        for (id, path) in assign_names(&dir, entries, &previous, reserved) {
            if open.contains_key(id.as_str()) {
                queue.push((id.clone(), path.clone()));
                layout.folders.insert(id, path);
            } else {
                layout.docs.insert(id, path);
            }
        }
    }
    layout
}

/// Every `.md` file under `root` (relative, `/`-separated), skipping hidden entries.
pub fn scan(root: &Path) -> CliResult<Vec<String>> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) -> CliResult<()> {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(CliError::io(
                    format!("Could not list {}: {e}.", dir.display()),
                    e,
                ));
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let child = join(rel, &name);
            let kind = entry.file_type().map_err(|e| {
                CliError::io(
                    format!("Could not read {}: {e}.", entry.path().display()),
                    e,
                )
            })?;
            if kind.is_dir() {
                walk(&entry.path(), &child, out)?;
            } else if name.ends_with(".md") {
                out.push(child);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, "", &mut out)?;
    out.sort();
    Ok(out)
}

fn read_local(root: &Path, rel: &str) -> CliResult<Option<String>> {
    let path = to_path(root, rel);
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CliError::io(
            format!("Could not read {}: {e}.", path.display()),
            e,
        )),
    }
}

fn write_local(root: &Path, rel: &str, text: &str) -> CliResult<()> {
    let path = to_path(root, rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CliError::io(format!("Could not create {}: {e}.", parent.display()), e))?;
    }
    let tmp = path.with_file_name(format!(".{}.write-tmp", file_name_of(rel)));
    fs::write(&tmp, text)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|e| CliError::io(format!("Could not write {}: {e}.", path.display()), e))
}

fn remove_local(root: &Path, rel: &str) {
    let path = to_path(root, rel);
    let _ = fs::remove_file(&path);
    // Tidy up directories left empty, but never the root.
    let mut dir = path.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == root || fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

/// Local changes against the state, without any network call.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Changes {
    pub modified: Vec<String>,
    pub new: Vec<String>,
    pub deleted: Vec<String>,
}

pub fn local_changes(root: &Path, state: &State) -> CliResult<Changes> {
    let files = scan(root)?;
    let present: HashSet<&String> = files.iter().collect();
    let mut changes = Changes::default();
    for (path, entry) in &state.files {
        if !present.contains(path) {
            changes.deleted.push(path.clone());
        } else if read_local(root, path)?.as_deref() != Some(entry.markdown.as_str()) {
            changes.modified.push(path.clone());
        }
    }
    changes.new = files
        .into_iter()
        .filter(|f| !state.files.contains_key(f))
        .collect();
    Ok(changes)
}

fn root_dir(dir: Option<PathBuf>) -> PathBuf {
    dir.unwrap_or_else(|| PathBuf::from("."))
}

fn display_root(root: &Path) -> String {
    let shown = root.display().to_string();
    if shown == "." {
        "this folder".into()
    } else {
        shown
    }
}

fn check_owner(
    state: &State,
    me: &silicon_write_client::Account,
    api_url: &str,
    root: &Path,
) -> CliResult<()> {
    if !state.account.uuid.is_empty() && state.account.uuid != me.uuid {
        return Err(CliError::new(
            "conflict",
            format!(
                "{} was pulled by {}, but you are signed in as {}.",
                display_root(root),
                state.account.id,
                me.label()
            ),
            "Pull into another folder, or sign in as the account that pulled it.",
        ));
    }
    if !state.api_url.is_empty() && state.api_url != api_url {
        return Err(CliError::new(
            "conflict",
            format!(
                "{} was pulled from {}, not {api_url}.",
                display_root(root),
                state.api_url
            ),
            "Pass the same --api-url, or pull into another folder.",
        ));
    }
    Ok(())
}

// ── status ──────────────────────────────────────────────────────────────────────────────────

pub fn status(ctx: &Ctx, dir: Option<PathBuf>) -> CliResult<()> {
    let root = root_dir(dir);
    let state = load_state(&root)?.ok_or_else(|| not_pulled(&root))?;
    let changes = local_changes(&root, &state)?;
    let clean = changes.modified.is_empty() && changes.new.is_empty() && changes.deleted.is_empty();
    let value = json!({
        "dir": root.display().to_string(),
        "account": state.account.id,
        "pulled_at": state.pulled_at,
        "tracked": state.files.len(),
        "modified": changes.modified,
        "new": changes.new,
        "deleted": changes.deleted,
        "clean": clean,
    });
    ctx.emit(&value, || {
        if clean {
            return format!(
                "Nothing changed in {} since the last pull or push ({} docs).",
                display_root(&root),
                state.files.len()
            );
        }
        let mut out = String::new();
        for p in &changes.modified {
            out.push_str(&format!("modified  {p}\n"));
        }
        for p in &changes.new {
            out.push_str(&format!("new       {p}\n"));
        }
        for p in &changes.deleted {
            out.push_str(&format!("deleted   {p}  (stays on Silicon Write)\n"));
        }
        out.push_str("Send the changes with `write push`.");
        out
    });
    Ok(())
}

fn not_pulled(root: &Path) -> CliError {
    CliError::new(
        "not_found",
        format!(
            "{} has not been pulled yet (no {STATE_DIR}/{STATE_FILE}).",
            display_root(root)
        ),
        format!("Run `write pull {}` first.", root.display()),
    )
}

// ── pull ────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize)]
struct PullReport {
    dir: String,
    account: String,
    new: Vec<String>,
    updated: Vec<String>,
    moved: Vec<Value>,
    unchanged: usize,
    kept: Vec<Value>,
    removed: Vec<String>,
    conflicts: Vec<Value>,
    skipped: Vec<Value>,
}

pub async fn pull(ctx: &Ctx, dir: Option<PathBuf>, force: bool) -> CliResult<()> {
    ctx.require_session()?;
    let root = root_dir(dir);
    let client = &ctx.client;
    let (me, docs, folders) = tokio::try_join!(client.me(), client.docs(), client.folders())?;
    let mut state = load_state(&root)?.unwrap_or_default();
    check_owner(&state, &me, &ctx.api_url, &root)?;
    fs::create_dir_all(&root)
        .map_err(|e| CliError::io(format!("Could not create {}: {e}.", root.display()), e))?;

    let mut report = PullReport {
        dir: root.display().to_string(),
        account: me.label().to_owned(),
        ..Default::default()
    };
    let live: Vec<&Doc> = docs.iter().filter(|d| d.deleted_at.is_none()).collect();
    let (editable, pdfs): (Vec<&Doc>, Vec<&Doc>) = live.iter().partition(|d| d.kind != "pdf");
    for d in &pdfs {
        report.skipped.push(json!({ "doc": d.id, "title": d.title, "reason": "a PDF shown as it is; `write convert` turns it into a doc" }));
    }
    let layout = plan_layout(&me.uuid, &folders, &editable, &state);

    let by_doc: HashMap<String, (String, FileEntry)> = state
        .files
        .iter()
        .map(|(p, e)| (e.doc.clone(), (p.clone(), e.clone())))
        .collect();
    let targets: HashSet<&String> = layout.docs.values().collect();

    // Decide what to fetch.
    struct Plan<'a> {
        doc: &'a Doc,
        target: String,
        prev: Option<(String, FileEntry)>,
        local: Option<String>,
    }
    let mut plans = Vec::new();
    for doc in &editable {
        let target = layout.docs[&doc.id].clone();
        let prev = by_doc.get(&doc.id).cloned();
        let local = match &prev {
            Some((path, _)) => read_local(&root, path)?,
            None => read_local(&root, &target)?,
        };
        plans.push(Plan {
            doc,
            target,
            prev,
            local,
        });
    }
    let modified_tracked: HashSet<String> = state
        .files
        .iter()
        .filter(|(p, e)| {
            read_local(&root, p)
                .ok()
                .flatten()
                .is_some_and(|l| l != e.markdown)
        })
        .map(|(p, _)| p.clone())
        .collect();

    let mut fetch = Vec::new();
    let mut new_files: BTreeMap<String, FileEntry> = BTreeMap::new();
    let mut writes: Vec<(usize, &'static str)> = Vec::new();
    for (i, plan) in plans.iter().enumerate() {
        let doc = plan.doc;
        match (&plan.prev, &plan.local) {
            (Some((path, entry)), Some(local)) if *local != entry.markdown => {
                let remote_changed = entry.seq != doc.seq;
                if !remote_changed && *path == plan.target {
                    report.kept.push(
                        json!({ "path": path, "reason": "changed here; `write push` sends it" }),
                    );
                    new_files.insert(path.clone(), entry.clone());
                } else if force {
                    fetch.push(i);
                    writes.push((i, "updated"));
                } else {
                    let reason = if remote_changed {
                        "changed here and on Silicon Write; `write push` merges yours first, or `write pull --force` takes theirs"
                    } else {
                        "changed here, and renamed or moved on Silicon Write; `write push` first"
                    };
                    report
                        .conflicts
                        .push(json!({ "path": path, "doc": doc.id, "reason": reason }));
                    new_files.insert(path.clone(), entry.clone());
                }
            }
            (Some((path, entry)), Some(_)) => {
                if entry.seq == doc.seq && *path == plan.target && entry.title == doc.title {
                    report.unchanged += 1;
                    new_files.insert(
                        path.clone(),
                        FileEntry {
                            folder: doc.folder_id.clone(),
                            ..entry.clone()
                        },
                    );
                } else {
                    fetch.push(i);
                    writes.push((
                        i,
                        if *path == plan.target {
                            "updated"
                        } else {
                            "moved"
                        },
                    ));
                }
            }
            (Some(_), None) => {
                // Deleted here: a pull brings it back (deleting files never deletes docs).
                fetch.push(i);
                writes.push((i, "new"));
            }
            (None, Some(_)) if !force => {
                report.conflicts.push(json!({
                    "path": plan.target, "doc": doc.id,
                    "reason": "a file that didn't come from Silicon Write is already there; move it, or `write pull --force` replaces it"
                }));
            }
            (None, _) => {
                fetch.push(i);
                writes.push((i, "new"));
            }
        }
    }

    // Fetch Markdown, eight at a time.
    let fetched: HashMap<String, DocMarkdown> = futures::stream::iter(fetch.iter().map(|&i| {
        let id = plans[i].doc.id.clone();
        async move {
            client
                .markdown(&id, MarkdownOptions::default())
                .await
                .map(|md| (id, md))
        }
    }))
    .buffer_unordered(8)
    .try_collect()
    .await?;

    for (i, what) in writes {
        let plan = &plans[i];
        let doc = plan.doc;
        let md = &fetched[&doc.id];
        // Never write over someone else's local changes.
        if modified_tracked.contains(&plan.target)
            && plan.prev.as_ref().map(|(p, _)| p) != Some(&plan.target)
            && !force
        {
            report.conflicts.push(json!({
                "path": plan.target, "doc": doc.id,
                "reason": "another changed file is in the way; push or move it, then pull again"
            }));
            continue;
        }
        write_local(&root, &plan.target, &md.markdown)?;
        if let Some((old, _)) = &plan.prev
            && *old != plan.target
            && !targets.contains(old)
        {
            remove_local(&root, old);
        }
        new_files.insert(
            plan.target.clone(),
            FileEntry {
                doc: doc.id.clone(),
                title: md.title.clone().unwrap_or_else(|| doc.title.clone()),
                seq: md.seq,
                folder: doc.folder_id.clone(),
                markdown: md.markdown.clone(),
            },
        );
        match what {
            "moved" => report
                .moved
                .push(json!({ "from": plan.prev.as_ref().map(|(p, _)| p), "to": plan.target })),
            "updated" => report.updated.push(plan.target.clone()),
            _ => report.new.push(plan.target.clone()),
        }
    }

    // Docs you can no longer open.
    let open_ids: HashSet<&str> = live.iter().map(|d| d.id.as_str()).collect();
    for (path, entry) in &state.files {
        if open_ids.contains(entry.doc.as_str()) {
            continue;
        }
        match read_local(&root, path)? {
            Some(local) if local != entry.markdown => {
                report.kept.push(json!({ "path": path, "reason": "no longer on Silicon Write for you (deleted or unshared); your copy is kept" }));
                new_files.insert(path.clone(), entry.clone());
            }
            Some(_) => {
                remove_local(&root, path);
                report.removed.push(path.clone());
            }
            None => {}
        }
    }

    // Folders, even empty ones.
    for dir in layout.folders.values() {
        let path = to_path(&root, dir);
        fs::create_dir_all(&path)
            .map_err(|e| CliError::io(format!("Could not create {}: {e}.", path.display()), e))?;
    }

    state.version = 1;
    state.api_url = ctx.api_url.clone();
    state.account = StateAccount {
        uuid: me.uuid.clone(),
        id: me.label().to_owned(),
    };
    state.pulled_at = crate::session::rfc3339(crate::session::now());
    state.files = new_files;
    state.folders = layout
        .folders
        .iter()
        .map(|(id, dir)| (dir.clone(), id.clone()))
        .collect();
    save_state(&root, &state)?;

    let summary = format!(
        "Pulled {} docs into {}: {} new, {} updated, {} moved, {} unchanged{}{}.",
        state.files.len(),
        display_root(&root),
        report.new.len(),
        report.updated.len(),
        report.moved.len(),
        report.unchanged,
        if report.removed.is_empty() {
            String::new()
        } else {
            format!(", {} removed", report.removed.len())
        },
        if report.skipped.is_empty() {
            String::new()
        } else {
            format!(", {} PDFs skipped", report.skipped.len())
        },
    );
    let readable = |report: &PullReport| {
        let mut out = summary.clone();
        for k in &report.kept {
            out.push_str(&format!(
                "\nkept      {}  ({})",
                k["path"].as_str().unwrap_or(""),
                k["reason"].as_str().unwrap_or("")
            ));
        }
        for c in &report.conflicts {
            out.push_str(&format!(
                "\nconflict  {}  ({})",
                c["path"].as_str().unwrap_or(""),
                c["reason"].as_str().unwrap_or("")
            ));
        }
        out
    };
    if report.conflicts.is_empty() {
        ctx.emit(&report, || readable(&report));
        Ok(())
    } else {
        if !ctx.json {
            println!("{}", readable(&report));
        }
        Err(CliError::new(
            "pull_conflict",
            format!("{} file(s) were not pulled because they would overwrite local changes.", report.conflicts.len()),
            "Push your changes first (`write push`), or take Silicon Write's version with `write pull --force`.",
        )
        .with_details(serde_json::to_value(&report).unwrap_or_default()))
    }
}

// ── push ────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize)]
struct PushReport {
    dir: String,
    pushed: Vec<Value>,
    created: Vec<Value>,
    renamed: Vec<Value>,
    deleted_locally: Vec<String>,
    failed: Vec<Value>,
    unchanged: usize,
}

/// The folder a directory stands for, creating missing folders when `create`.
async fn folder_for_dir(ctx: &Ctx, state: &mut State, dir: &str) -> CliResult<Option<String>> {
    if dir.is_empty() {
        return Ok(None);
    }
    if let Some(id) = state.folders.get(dir) {
        return Ok(Some(id.clone()));
    }
    if dir == SHARED_DIR {
        return Err(CliError::invalid(
            format!(
                "Docs can't be created at the top of “{SHARED_DIR}”: it only holds what others shared with you."
            ),
            "Put the file in one of your folders, or inside a folder shared with you.",
        ));
    }
    // Walk down from the deepest known folder, creating the rest.
    let parts: Vec<&str> = dir.split('/').collect();
    let mut parent: Option<String> = None;
    let mut known_depth = 0;
    for depth in (1..=parts.len()).rev() {
        let prefix = parts[..depth].join("/");
        if let Some(id) = state.folders.get(&prefix) {
            parent = Some(id.clone());
            known_depth = depth;
            break;
        }
    }
    if known_depth == 0 && parts[0] == SHARED_DIR {
        return Err(CliError::invalid(
            format!("Folders can't be created at the top of “{SHARED_DIR}”."),
            "Put new folders inside a folder shared with you, or in your own folders.",
        ));
    }
    for depth in known_depth + 1..=parts.len() {
        let folder = ctx
            .client
            .create_folder(parts[depth - 1], parent.as_deref())
            .await?;
        state
            .folders
            .insert(parts[..depth].join("/"), folder.id.clone());
        parent = Some(folder.id);
    }
    Ok(parent)
}

pub async fn push(ctx: &Ctx, dir: Option<PathBuf>, suggest: bool) -> CliResult<()> {
    ctx.require_session()?;
    let root = root_dir(dir);
    let mut state = load_state(&root)?.ok_or_else(|| not_pulled(&root))?;
    let me = ctx.client.me().await?;
    check_owner(&state, &me, &ctx.api_url, &root)?;
    let changes = local_changes(&root, &state)?;
    let mut report = PushReport {
        dir: root.display().to_string(),
        ..Default::default()
    };
    report.unchanged = state.files.len() - changes.modified.len() - changes.deleted.len();

    // Changed files: send the whole Markdown with the seq it was pulled at; the service merges.
    for path in &changes.modified {
        let entry = state.files[path].clone();
        let local = read_local(&root, path)?.unwrap_or_default();
        match ctx.client.put_markdown(&entry.doc, &local, Some(entry.seq), suggest).await {
            Ok(result) => {
                let merged = result.markdown != local;
                if merged {
                    write_local(&root, path, &result.markdown)?;
                }
                let suggested = suggest || result.suggested;
                report.pushed.push(json!({ "path": path, "doc": entry.doc, "seq": result.seq, "merged": merged && !suggested, "suggested": suggested, "conflicts": result.conflicts }));
                state.files.insert(path.clone(), FileEntry { seq: result.seq, markdown: result.markdown, ..entry });
            }
            Err(e) => report.failed.push(json!({ "path": path, "doc": entry.doc, "error": CliError::from(e).to_json()["error"] })),
        }
    }

    // A new file with exactly the content of a deleted one is that doc renamed or moved.
    let mut new_files = changes.new.clone();
    let mut deleted = changes.deleted.clone();
    let mut renames = Vec::new();
    for old in changes.deleted.iter() {
        let entry = &state.files[old];
        if let Some(pos) = new_files.iter().position(|n| {
            read_local(&root, n).ok().flatten().as_deref() == Some(entry.markdown.as_str())
        }) {
            renames.push((old.clone(), new_files.remove(pos)));
            deleted.retain(|d| d != old);
        }
    }
    for (old, new) in renames {
        let entry = state.files[&old].clone();
        let title = title_of(&new);
        let result = async {
            let folder = folder_for_dir(ctx, &mut state, parent_of(&new)).await?;
            let mut patch = DocPatch::default();
            if title != entry.title {
                patch.title = Some(title.clone());
            }
            if folder != entry.folder {
                patch.folder_id = Some(folder.clone());
            }
            if patch.title.is_some() || patch.folder_id.is_some() {
                ctx.client.update_doc(&entry.doc, &patch).await?;
            }
            Ok::<_, CliError>(folder)
        }
        .await;
        match result {
            Ok(folder) => {
                state.files.remove(&old);
                state.files.insert(
                    new.clone(),
                    FileEntry {
                        title,
                        folder,
                        ..entry.clone()
                    },
                );
                report
                    .renamed
                    .push(json!({ "from": old, "to": new, "doc": entry.doc }));
            }
            Err(e) => report
                .failed
                .push(json!({ "path": new, "doc": entry.doc, "error": e.to_json()["error"] })),
        }
    }

    // New files become new docs in the matching folder.
    for path in &new_files {
        let local = read_local(&root, path)?.unwrap_or_default();
        let title = title_of(path);
        let result = async {
            let folder = folder_for_dir(ctx, &mut state, parent_of(path)).await?;
            let doc = ctx
                .client
                .create_doc(&NewDoc {
                    title: Some(title.clone()),
                    folder_id: folder.clone(),
                    markdown: Some(local.clone()),
                })
                .await?;
            let md = ctx
                .client
                .markdown(&doc.id, MarkdownOptions::default())
                .await?;
            Ok::<_, CliError>((doc, md))
        }
        .await;
        match result {
            Ok((doc, md)) => {
                if md.markdown != local {
                    write_local(&root, path, &md.markdown)?;
                }
                report
                    .created
                    .push(json!({ "path": path, "doc": doc.id, "url": doc.url }));
                state.files.insert(
                    path.clone(),
                    FileEntry {
                        doc: doc.id,
                        title: doc.title,
                        seq: md.seq,
                        folder: doc.folder_id,
                        markdown: md.markdown,
                    },
                );
            }
            Err(e) => report
                .failed
                .push(json!({ "path": path, "error": e.to_json()["error"] })),
        }
    }
    report.deleted_locally = deleted;
    save_state(&root, &state)?;

    let readable = |r: &PushReport| {
        let mut out = format!(
            "Pushed {}: {} changed, {} new, {} renamed or moved, {} unchanged.",
            display_root(&root),
            r.pushed.len(),
            r.created.len(),
            r.renamed.len(),
            r.unchanged
        );
        for p in &r.pushed {
            let conflicts = p["conflicts"].as_array().map(Vec::len).unwrap_or(0);
            let note = if conflicts > 0 {
                "  (changed since you pulled it, differently from you, in places: the doc kept its text there and yours are suggestions; `write suggestions` lists them)"
            } else if p["suggested"].as_bool() == Some(true) {
                "  (sent as a suggestion; the file shows the doc as it reads until it is accepted)"
            } else if p["merged"].as_bool() == Some(true) {
                "  (merged with others' changes; file refreshed)"
            } else {
                ""
            };
            out.push_str(&format!(
                "\nchanged   {}  seq {}{note}",
                p["path"].as_str().unwrap_or(""),
                p["seq"]
            ));
        }
        for c in &r.created {
            out.push_str(&format!(
                "\nnew       {}  {}",
                c["path"].as_str().unwrap_or(""),
                c["doc"].as_str().unwrap_or("")
            ));
        }
        for c in &r.renamed {
            out.push_str(&format!(
                "\nrenamed   {} → {}",
                c["from"].as_str().unwrap_or(""),
                c["to"].as_str().unwrap_or("")
            ));
        }
        for d in &r.deleted_locally {
            out.push_str(&format!("\ndeleted   {d}  (only here: the doc stays on Silicon Write; `write rm` moves it to the trash)"));
        }
        for f in &r.failed {
            out.push_str(&format!(
                "\nfailed    {}  {}",
                f["path"].as_str().unwrap_or(""),
                f["error"]["message"].as_str().unwrap_or("")
            ));
        }
        out
    };
    if report.failed.is_empty() {
        ctx.emit(&report, || readable(&report));
        Ok(())
    } else {
        if !ctx.json {
            println!("{}", readable(&report));
        }
        Err(CliError::new(
            "push_failed",
            format!("{} file(s) could not be pushed.", report.failed.len()),
            "Fix what each failure says (see above or `details.failed`), then run `write push` again; the rest was sent.",
        )
        .with_details(serde_json::to_value(&report).unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silicon_write_client::{Account, PathEntry};

    fn account(uuid: &str) -> Account {
        Account {
            uuid: uuid.into(),
            id: format!("c:{uuid}"),
            kind: "carbon".into(),
            ..Default::default()
        }
    }

    fn folder(id: &str, name: &str, parent: Option<&str>, owner: &str, created: &str) -> Folder {
        Folder {
            id: id.into(),
            name: name.into(),
            owner: account(owner),
            parent_id: parent.map(Into::into),
            created_at: created.into(),
            ..Default::default()
        }
    }

    fn doc(id: &str, title: &str, folder: Option<&str>, owner: &str, created: &str) -> Doc {
        Doc {
            id: id.into(),
            title: title.into(),
            kind: "doc".into(),
            owner: account(owner),
            folder_id: folder.map(Into::into),
            path: folder
                .map(|f| {
                    vec![PathEntry {
                        id: f.into(),
                        name: String::new(),
                    }]
                })
                .unwrap_or_default(),
            created_at: created.into(),
            ..Default::default()
        }
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("Launch plan"), "Launch plan");
        assert_eq!(safe_name("Q3/Q4: plan?"), "Q3-Q4- plan-");
        assert_eq!(safe_name("  ..hidden  "), "hidden");
        assert_eq!(safe_name("trailing dots..."), "trailing dots");
        assert_eq!(safe_name("tab\tand\nnewline"), "tab and newline");
        assert_eq!(safe_name(""), "Untitled");
        assert_eq!(safe_name("..."), "Untitled");
        assert_eq!(safe_name(&"x".repeat(500)).chars().count(), MAX_NAME_CHARS);
        assert!(is_variant("Plan (2).md", "Plan", ".md"));
        assert!(is_variant("plan.md", "Plan", ".md"));
        assert!(!is_variant("Plan (x).md", "Plan", ".md"));
        assert!(!is_variant("Planning.md", "Plan", ".md"));
    }

    #[test]
    fn layout_puts_shared_docs_apart_and_numbers_duplicates() {
        let folders = vec![
            folder("f_plans", "Plans", None, "me", "1"),
            folder("f_q3", "Q3", Some("f_plans"), "me", "2"),
            folder("f_team", "Team notes", Some("f_hidden"), "other", "3"),
            folder("f_sub", "Sub", Some("f_team"), "other", "4"),
            folder("f_shared_name", "Shared with me", None, "me", "5"),
        ];
        let docs = [
            doc("d_a", "Launch plan", None, "me", "1"),
            doc("d_b", "Launch plan", None, "me", "2"),
            doc("d_c", "launch PLAN", None, "me", "3"),
            doc("d_d", "Budget", Some("f_q3"), "me", "4"),
            doc("d_e", "Minutes", Some("f_sub"), "other", "5"),
            doc("d_f", "Direct", None, "other", "6"),
            doc("d_g", "Mine in theirs", Some("f_team"), "other", "7"),
        ];
        let refs: Vec<&Doc> = docs.iter().collect();
        let layout = plan_layout("me", &folders, &refs, &State::default());
        assert_eq!(layout.docs["d_a"], "Launch plan.md");
        assert_eq!(layout.docs["d_b"], "Launch plan (2).md");
        assert_eq!(layout.docs["d_c"], "launch PLAN (3).md");
        assert_eq!(layout.docs["d_d"], "Plans/Q3/Budget.md");
        assert_eq!(
            layout.docs["d_e"],
            "Shared with me/Team notes/Sub/Minutes.md"
        );
        assert_eq!(layout.docs["d_f"], "Shared with me/Direct.md");
        assert_eq!(
            layout.docs["d_g"],
            "Shared with me/Team notes/Mine in theirs.md"
        );
        assert_eq!(layout.folders["f_shared_name"], "Shared with me (2)");
    }

    #[test]
    fn layout_keeps_names_files_already_have() {
        let docs = [
            doc("d_a", "Plan", None, "me", "1"),
            doc("d_b", "Plan", None, "me", "2"),
        ];
        let refs: Vec<&Doc> = docs.iter().collect();
        let mut state = State::default();
        // d_b was pulled first, so it already owns "Plan.md".
        state.files.insert(
            "Plan.md".into(),
            FileEntry {
                doc: "d_b".into(),
                ..Default::default()
            },
        );
        let layout = plan_layout("me", &[], &refs, &state);
        assert_eq!(layout.docs["d_b"], "Plan.md");
        assert_eq!(layout.docs["d_a"], "Plan (2).md");
    }

    #[test]
    fn changes_are_found_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_local(root, "A.md", "same\n").unwrap();
        write_local(root, "Plans/B.md", "edited\n").unwrap();
        write_local(root, "Plans/New.md", "fresh\n").unwrap();
        write_local(root, ".hidden/x.md", "ignored\n").unwrap();
        let mut state = State::default();
        for (path, md) in [
            ("A.md", "same\n"),
            ("Plans/B.md", "original\n"),
            ("Gone.md", "bye\n"),
        ] {
            state.files.insert(
                path.into(),
                FileEntry {
                    doc: format!("d_{path}"),
                    markdown: md.into(),
                    ..Default::default()
                },
            );
        }
        let changes = local_changes(root, &state).unwrap();
        assert_eq!(
            changes,
            Changes {
                modified: vec!["Plans/B.md".into()],
                new: vec!["Plans/New.md".into()],
                deleted: vec!["Gone.md".into()]
            }
        );
        save_state(root, &state).unwrap();
        assert_eq!(load_state(root).unwrap().unwrap().files.len(), 3);
        remove_local(root, "Plans/New.md");
        assert!(to_path(root, "Plans").exists(), "B.md is still there");
    }

    // ── pull and push against an in-process mock of the API ────────────────────────────────

    use std::sync::{Arc, Mutex};

    use axum::Json;
    use axum::extract::{Path as UrlPath, State as Shared};
    use axum::http::StatusCode;
    use axum::routing::{get, patch};

    use crate::ctx::{Ctx, Options};
    use crate::session::{Session, SessionAccount, Store, now};

    #[derive(Clone)]
    struct MockDoc {
        title: String,
        folder: Option<String>,
        seq: i64,
        md: String,
        created: String,
    }

    #[derive(Default)]
    struct Mock {
        docs: BTreeMap<String, MockDoc>,
        folders: BTreeMap<String, (String, Option<String>)>,
        next: u32,
    }

    type Db = Arc<Mutex<Mock>>;

    fn me() -> Value {
        json!({ "uuid": "u_me", "id": "si:me", "kind": "silicon", "display_name": "Me" })
    }

    fn doc_json(id: &str, d: &MockDoc) -> Value {
        json!({ "id": id, "title": d.title, "kind": "doc", "owner": me(), "created_by": me(), "folder_id": d.folder,
                "role": "owner", "public_access": "none", "seq": d.seq, "created_at": d.created, "updated_at": d.created })
    }

    /// The service's merge, simplified: the client's Markdown plus server lines it doesn't have.
    fn merge(server: &str, client: &str) -> String {
        let mut out = client.to_owned();
        for line in server.lines().filter(|l| !l.is_empty()) {
            if !client.lines().any(|c| c == line) {
                out.push_str(&format!("\n{line}\n"));
            }
        }
        out
    }

    fn mock_router(db: Db) -> axum::Router {
        async fn list_docs(Shared(db): Shared<Db>) -> Json<Value> {
            let m = db.lock().unwrap();
            Json(
                json!({ "docs": m.docs.iter().map(|(id, d)| doc_json(id, d)).collect::<Vec<_>>() }),
            )
        }
        async fn create_doc(
            Shared(db): Shared<Db>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            let mut m = db.lock().unwrap();
            m.next += 1;
            let id = format!("d_new{}", m.next);
            let doc = MockDoc {
                title: body["title"].as_str().unwrap_or("Untitled").into(),
                folder: body["folder_id"].as_str().map(Into::into),
                seq: 1,
                md: body["markdown"].as_str().unwrap_or("").into(),
                created: format!("2026-10-17T00:01:{:02}Z", m.next),
            };
            let out = doc_json(&id, &doc);
            m.docs.insert(id, doc);
            (StatusCode::CREATED, Json(out))
        }
        async fn list_folders(Shared(db): Shared<Db>) -> Json<Value> {
            let m = db.lock().unwrap();
            let folders: Vec<Value> = m
                .folders
                .iter()
                .map(|(id, (name, parent))| json!({ "id": id, "name": name, "parent_id": parent, "owner": me(), "role": "owner", "created_at": id }))
                .collect();
            Json(json!({ "folders": folders }))
        }
        async fn create_folder(
            Shared(db): Shared<Db>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            let mut m = db.lock().unwrap();
            m.next += 1;
            let id = format!("f_new{}", m.next);
            let name = body["name"].as_str().unwrap().to_owned();
            let parent = body["parent_id"].as_str().map(str::to_owned);
            m.folders.insert(id.clone(), (name.clone(), parent.clone()));
            (
                StatusCode::CREATED,
                Json(
                    json!({ "id": id, "name": name, "parent_id": parent, "owner": me(), "role": "owner" }),
                ),
            )
        }
        async fn patch_doc(
            Shared(db): Shared<Db>,
            UrlPath(id): UrlPath<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let mut m = db.lock().unwrap();
            let d = m.docs.get_mut(&id).unwrap();
            if let Some(t) = body["title"].as_str() {
                d.title = t.into();
            }
            if let Some(f) = body.get("folder_id") {
                d.folder = f.as_str().map(Into::into);
            }
            Json(doc_json(&id, d))
        }
        async fn get_md(Shared(db): Shared<Db>, UrlPath(id): UrlPath<String>) -> Json<Value> {
            let m = db.lock().unwrap();
            let d = &m.docs[&id];
            Json(json!({ "seq": d.seq, "markdown": d.md, "title": d.title }))
        }
        async fn put_md(
            Shared(db): Shared<Db>,
            UrlPath(id): UrlPath<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let mut m = db.lock().unwrap();
            let d = m.docs.get_mut(&id).unwrap();
            let client = body["markdown"].as_str().unwrap();
            let base = body["base_seq"].as_i64().unwrap();
            d.md = if base < d.seq {
                merge(&d.md, client)
            } else {
                client.to_owned()
            };
            d.seq += 1;
            Json(json!({ "seq": d.seq, "markdown": d.md }))
        }
        axum::Router::new()
            .route("/v1/me", get(|| async { Json(json!({ "account": me() })) }))
            .route("/v1/docs", get(list_docs).post(create_doc))
            .route("/v1/folders", get(list_folders).post(create_folder))
            .route("/v1/docs/{id}", patch(patch_doc))
            .route("/v1/docs/{id}/markdown", get(get_md).put(put_md))
            .with_state(db)
    }

    async fn mock_ctx(db: Db, home: &Path) -> Ctx {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, mock_router(db)).await.unwrap() });
        Store::new(home)
            .save(&Session {
                access_token: "token".into(),
                refresh_token: None,
                expires_at: now() + 3600,
                refresh_expires_at: None,
                account: SessionAccount {
                    uuid: "u_me".into(),
                    id: "si:me".into(),
                    kind: "silicon".into(),
                    ..Default::default()
                },
                accounts_url: "http://127.0.0.1:9".into(),
                api_url: base.clone(),
                method: "slt".into(),
                signed_in_at: now(),
            })
            .unwrap();
        Ctx::new(Options {
            dangerously_use_em_dash: false,
            json: true,
            api_url: Some(base),
            accounts_url: None,
            home: Some(home.to_path_buf()),
        })
        .unwrap()
    }

    fn remote_edit(db: &Db, id: &str, line: &str) {
        let mut m = db.lock().unwrap();
        let d = m.docs.get_mut(id).unwrap();
        d.md.push_str(&format!("\n{line}\n"));
        d.seq += 1;
    }

    #[tokio::test]
    async fn pull_edit_push_rename_and_conflict() {
        let db: Db = Arc::default();
        {
            let mut m = db.lock().unwrap();
            m.folders.insert("f_plans".into(), ("Plans".into(), None));
            let doc = |title: &str, folder: Option<&str>, md: &str, created: &str| MockDoc {
                title: title.into(),
                folder: folder.map(Into::into),
                seq: 3,
                md: md.into(),
                created: created.into(),
            };
            m.docs.insert(
                "d_plan".into(),
                doc(
                    "Plan",
                    None,
                    "# Plan\n\nShip Monday.\n",
                    "2026-10-17T00:00:01Z",
                ),
            );
            m.docs.insert(
                "d_budget".into(),
                doc(
                    "Budget",
                    Some("f_plans"),
                    "Small.\n",
                    "2026-10-17T00:00:02Z",
                ),
            );
        }
        let home = tempfile::tempdir().unwrap();
        let ctx = mock_ctx(db.clone(), home.path()).await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let read = |rel: &str| fs::read_to_string(to_path(&root, rel)).unwrap();

        pull(&ctx, Some(root.clone()), false).await.unwrap();
        assert_eq!(read("Plan.md"), "# Plan\n\nShip Monday.\n");
        assert_eq!(read("Plans/Budget.md"), "Small.\n");
        let state = load_state(&root).unwrap().unwrap();
        assert_eq!(local_changes(&root, &state).unwrap(), Changes::default());
        assert_eq!(state.files["Plan.md"].seq, 3);

        // A local change and someone else's change meet: push merges and refreshes the file.
        fs::write(
            to_path(&root, "Plan.md"),
            "# Plan\n\nShip Monday.\n\nLocal line.\n",
        )
        .unwrap();
        remote_edit(&db, "d_plan", "Remote line.");
        // A new file in a new folder becomes a new doc in a new folder inside Plans.
        write_local(&root, "Plans/Ideas/Idea.md", "Fresh.\n").unwrap();
        push(&ctx, Some(root.clone()), false).await.unwrap();
        let merged = read("Plan.md");
        assert!(
            merged.contains("Local line.") && merged.contains("Remote line."),
            "{merged}"
        );
        {
            let m = db.lock().unwrap();
            assert!(m.docs["d_plan"].md.contains("Local line."));
            let (ideas_id, (_, parent)) =
                m.folders.iter().find(|(_, (n, _))| n == "Ideas").unwrap();
            assert_eq!(parent.as_deref(), Some("f_plans"));
            let idea = m.docs.values().find(|d| d.title == "Idea").unwrap();
            assert_eq!(idea.folder.as_deref(), Some(ideas_id.as_str()));
        }
        let state = load_state(&root).unwrap().unwrap();
        assert_eq!(
            local_changes(&root, &state).unwrap(),
            Changes::default(),
            "clean after push"
        );

        // A renamed and moved file renames and moves its doc; nothing new is created.
        fs::rename(
            to_path(&root, "Plans/Budget.md"),
            to_path(&root, "Budget 2027.md"),
        )
        .unwrap();
        push(&ctx, Some(root.clone()), false).await.unwrap();
        {
            let m = db.lock().unwrap();
            assert_eq!(m.docs["d_budget"].title, "Budget 2027");
            assert_eq!(m.docs["d_budget"].folder, None);
            assert_eq!(m.docs.len(), 3);
        }

        // A deleted file is only reported, and the next pull brings it back.
        fs::remove_file(to_path(&root, "Budget 2027.md")).unwrap();
        push(&ctx, Some(root.clone()), false).await.unwrap();
        assert!(db.lock().unwrap().docs.contains_key("d_budget"));
        pull(&ctx, Some(root.clone()), false).await.unwrap();
        assert_eq!(read("Budget 2027.md"), "Small.\n");

        // Changed here and there: pull refuses to overwrite, --force takes theirs.
        fs::write(to_path(&root, "Plan.md"), "mine\n").unwrap();
        remote_edit(&db, "d_plan", "Another remote line.");
        let err = pull(&ctx, Some(root.clone()), false).await.unwrap_err();
        assert_eq!(err.code, "pull_conflict");
        assert_eq!(err.exit_code(), crate::error::exit::CONFLICT);
        assert_eq!(read("Plan.md"), "mine\n");
        pull(&ctx, Some(root.clone()), true).await.unwrap();
        assert!(read("Plan.md").contains("Another remote line."));

        // A remote rename moves an unchanged file.
        db.lock().unwrap().docs.get_mut("d_plan").unwrap().title = "Plan final".into();
        pull(&ctx, Some(root.clone()), false).await.unwrap();
        assert!(to_path(&root, "Plan final.md").exists());
        assert!(!to_path(&root, "Plan.md").exists());
    }
}
