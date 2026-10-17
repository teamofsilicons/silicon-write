//! The shapes of the Silicon Write API (see `docs/api.md`). Response types are lenient: a field
//! the service leaves out takes its default, and fields this client doesn't know yet are kept in
//! `extra` where it matters, so a newer service never breaks an older client.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// Reads `null` as the type's default.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de> + Default>(d: D) -> Result<T, D::Error> {
    Option::<T>::deserialize(d).map(Option::unwrap_or_default)
}

/// Reads `null`, one account, or a list of accounts as a list.
fn one_or_many<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Account>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<Account>),
        One(Account),
    }
    Ok(match Option::<OneOrMany>::deserialize(d)? {
        None => Vec::new(),
        Some(OneOrMany::Many(list)) => list,
        Some(OneOrMany::One(account)) => vec![account],
    })
}

/// Reads an id that may be a JSON string or number as a string.
fn string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

/// A Carbon or a Silicon, as Silicon Write shows them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Account {
    /// The permanent Silicon Accounts uuid.
    pub uuid: String,
    /// `c:…` or `si:…` (can change; never key on it).
    pub id: String,
    /// `carbon` or `silicon`.
    pub kind: String,
    /// Display name.
    pub display_name: String,
    /// Profile photo URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp_url: Option<String>,
}

impl Account {
    /// The id, or the uuid when the id is unknown.
    pub fn label(&self) -> &str {
        if self.id.is_empty() {
            &self.uuid
        } else {
            &self.id
        }
    }
}

/// `GET /v1/me`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Me {
    /// The signed-in account.
    pub account: Account,
}

/// One folder on the way to a doc or folder, from the top down.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PathEntry {
    /// `f_…`.
    pub id: String,
    /// The folder's name.
    pub name: String,
}

/// A doc.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Doc {
    /// `d_…`.
    pub id: String,
    /// Title.
    pub title: String,
    /// `doc`, or `pdf` for a PDF shown as it is.
    pub kind: String,
    /// The Carbon or Silicon it belongs to.
    pub owner: Account,
    /// Who made it (differs from the owner in someone else's shared folder).
    pub created_by: Account,
    /// The folder it is in (`None` at the top level).
    pub folder_id: Option<String>,
    /// Folders from the top down.
    pub path: Vec<PathEntry>,
    /// The caller's role: `owner`, `editor`, `commenter` or `viewer`.
    pub role: String,
    /// `none`, `view`, `comment` or `edit`.
    pub public_access: String,
    /// Latest change number.
    pub seq: i64,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    /// RFC 3339 when it is in the trash.
    pub deleted_at: Option<String>,
    /// Link to the doc in the web editor.
    pub url: String,
}

impl Doc {
    /// `Plans / Q3` style path of the folders it is in.
    pub fn folder_path(&self) -> String {
        self.path
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    }
}

/// A folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Folder {
    /// `f_…`.
    pub id: String,
    /// Name.
    pub name: String,
    /// The Carbon or Silicon it belongs to.
    pub owner: Account,
    /// The folder it is in (`None` at the top level).
    pub parent_id: Option<String>,
    /// Folders from the top down (not including this one).
    pub path: Vec<PathEntry>,
    /// The caller's role.
    pub role: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339 when it is in the trash.
    pub deleted_at: Option<String>,
}

/// `GET /v1/library`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Library {
    /// The folder listed, or `None` for a top level.
    pub folder: Option<Folder>,
    /// Folders in it.
    pub folders: Vec<Folder>,
    /// Docs in it.
    pub docs: Vec<Doc>,
}

/// Which part of the library to list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LibraryView {
    /// The caller's own docs and folders.
    #[default]
    Mine,
    /// Everything shared with the caller directly.
    Shared,
    /// The 30 docs the caller can open that changed most recently (no folders).
    Recent,
    /// The caller's deleted docs and folders.
    Trash,
}

impl LibraryView {
    /// The query value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            Self::Shared => "shared",
            Self::Recent => "recent",
            Self::Trash => "trash",
        }
    }
}

/// `POST /v1/docs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewDoc {
    /// Title (the service picks one when absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Folder to create it in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    /// Initial Markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

/// `PATCH /v1/docs/{id}`. `folder_id: Some(None)` moves the doc to the top level.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocPatch {
    /// New title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// New folder (`Some(None)` = the top level).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<Option<String>>,
}

/// `PATCH /v1/folders/{id}`. `parent_id: Some(None)` moves the folder to the top level.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FolderPatch {
    /// New name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New parent (`Some(None)` = the top level).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<String>>,
}

/// `POST /v1/docs/{id}/copy`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CopyDoc {
    /// Copy this version instead of the latest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    /// Title of the copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Folder for the copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

/// How pending suggestions show in Markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SuggestionsView {
    /// The doc as it reads now (default).
    #[default]
    Current,
    /// Pending suggestions as CriticMarkup `{++inserted++}` / `{--deleted--}`.
    Critic,
}

/// Options for `GET /v1/docs/{id}/markdown`.
#[derive(Debug, Clone, Copy, Default)]
pub struct MarkdownOptions {
    /// How pending suggestions show.
    pub suggestions: SuggestionsView,
    /// Add every open thread after the block it is on.
    pub inline_comments: bool,
}

/// `GET /v1/docs/{id}/markdown` and `GET /v1/docs/{id}/versions/{seq}/markdown`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DocMarkdown {
    /// The change number the Markdown was read at.
    pub seq: i64,
    /// The doc as Markdown.
    pub markdown: String,
    /// Title (absent for versions).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One exact-text replacement.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Edit {
    /// Exact text from the current Markdown.
    pub old: String,
    /// Replacement.
    pub new: String,
    /// Replace every occurrence (otherwise `old` must appear once).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

impl Edit {
    /// A single replacement of text that appears once.
    pub fn new(old: impl Into<String>, new: impl Into<String>) -> Self {
        Self {
            old: old.into(),
            new: new.into(),
            all: false,
        }
    }
}

/// `{ "seq", "markdown", "conflicts" }` after an edit or a whole-doc write.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EditResult {
    /// The new change number.
    pub seq: i64,
    /// The doc as Markdown after the change.
    pub markdown: String,
    /// The change was made as a suggestion (asked for, or because the caller is a commenter).
    pub suggested: bool,
    /// A whole-doc write from an older version (`base_seq`): where it met changes made since and
    /// both changed the same text.
    pub conflicts: Vec<MergeConflict>,
}

/// A passage both a whole-doc write and the changes made since it was read changed differently.
/// The doc keeps its text, and the written text became a suggestion on it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MergeConflict {
    /// The passage as it was at the version the write started from (Markdown).
    pub was: String,
    /// The passage as the doc has it, which it keeps.
    pub now: String,
    /// The passage as the write had it.
    pub yours: String,
    /// The suggestion it became (accepting it uses `yours`); none when the doc already read so.
    pub suggestion: Option<String>,
}

/// `{ "seq" }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SeqResult {
    /// The new change number.
    pub seq: i64,
}

/// Every download format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// Markdown.
    Md,
    /// Plain text.
    Txt,
    /// Word.
    Docx,
    /// Word 97-2003.
    Doc,
    /// OpenDocument.
    Odt,
    /// Rich text.
    Rtf,
    /// Web page.
    Html,
    /// PDF.
    Pdf,
}

impl ExportFormat {
    /// Every format.
    pub const ALL: [ExportFormat; 8] = [
        Self::Md,
        Self::Txt,
        Self::Docx,
        Self::Doc,
        Self::Odt,
        Self::Rtf,
        Self::Html,
        Self::Pdf,
    ];

    /// The query value and file extension.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Md => "md",
            Self::Txt => "txt",
            Self::Docx => "docx",
            Self::Doc => "doc",
            Self::Odt => "odt",
            Self::Rtf => "rtf",
            Self::Html => "html",
            Self::Pdf => "pdf",
        }
    }
}

impl fmt::Display for ExportFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ExportFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim().trim_start_matches('.').to_ascii_lowercase();
        Self::ALL
            .into_iter()
            .find(|f| {
                f.as_str() == s
                    || (s == "markdown" && *f == Self::Md)
                    || (s == "htm" && *f == Self::Html)
            })
            .ok_or_else(|| {
                format!("`{s}` is not a download format; use md, txt, docx, doc, odt, rtf, html or pdf")
            })
    }
}

/// `POST /v1/docs/{id}/assets`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Asset {
    /// `a_…`.
    pub id: String,
    /// Where it is served.
    pub url: String,
}

/// `GET /v1/docs/{id}/backlinks` and similar `{ "docs": [...] }` answers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DocList {
    /// The docs.
    pub docs: Vec<Doc>,
}

/// `GET /v1/folders`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FolderList {
    /// The folders.
    pub folders: Vec<Folder>,
}

/// Who wrote one top-level block.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BlockAuthors {
    /// Index of the top-level block.
    pub index: i64,
    /// Authors, most text first.
    pub authors: Vec<Account>,
}

/// `GET /v1/docs/{id}/authorship`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Authorship {
    /// One entry per top-level block.
    pub blocks: Vec<BlockAuthors>,
}

/// One search hit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchResult {
    /// The doc.
    pub doc: Doc,
    /// The matching text.
    pub snippet: String,
}

/// `GET /v1/search`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchResults {
    /// Hits.
    pub results: Vec<SearchResult>,
}

/// `POST /v1/docs/{id}/live`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LiveTicket {
    /// WebSocket URL.
    pub url: String,
    /// Ticket to pass as `?ticket=`.
    pub ticket: String,
    /// RFC 3339.
    pub expires_at: String,
    /// The caller's role in the doc.
    pub role: String,
    /// The caller, when signed in.
    pub account: Option<Account>,
}

/// Roles someone can be invited with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Can edit, comment and invite others.
    Editor,
    /// Can read, comment and make suggestions.
    Commenter,
    /// Can only read.
    Viewer,
}

impl Role {
    /// The API value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Commenter => "commenter",
            Self::Viewer => "viewer",
        }
    }
}

impl FromStr for Role {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "editor" | "edit" => Ok(Self::Editor),
            "commenter" | "comment" => Ok(Self::Commenter),
            "viewer" | "view" => Ok(Self::Viewer),
            other => Err(format!(
                "`{other}` is not a role; use editor, commenter or viewer"
            )),
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Who can reach a doc by its link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicAccess {
    /// Private.
    None,
    /// Anyone with the link can view.
    View,
    /// Anyone signed in with the link can comment.
    Comment,
    /// Anyone signed in with the link can edit.
    Edit,
}

impl PublicAccess {
    /// The API value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::View => "view",
            Self::Comment => "comment",
            Self::Edit => "edit",
        }
    }
}

impl FromStr for PublicAccess {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" | "private" | "off" => Ok(Self::None),
            "view" => Ok(Self::View),
            "comment" => Ok(Self::Comment),
            "edit" => Ok(Self::Edit),
            other => Err(format!(
                "`{other}` is not a public access; use none, view, comment or edit"
            )),
        }
    }
}

/// How a member got their access: directly on the item, or through a folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MemberVia {
    /// Through a shared folder.
    Folder {
        /// The folder.
        folder: Box<Folder>,
    },
    /// `"doc"` (or `"folder"` for a folder's own members).
    Direct(String),
}

impl Default for MemberVia {
    fn default() -> Self {
        Self::Direct("doc".into())
    }
}

/// Someone a doc or folder is shared with.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Member {
    /// `m_…`.
    pub id: String,
    /// The account (`None` for an email invite that hasn't joined yet).
    pub account: Option<Account>,
    /// The invited email, for pending invites.
    pub email: Option<String>,
    /// `editor`, `commenter` or `viewer`.
    pub role: String,
    /// Directly, or through a folder.
    pub via: MemberVia,
    /// Invited by email and not joined yet.
    pub pending: bool,
    /// Who invited them.
    pub invited_by: Option<Account>,
    /// RFC 3339.
    pub created_at: String,
}

impl Member {
    /// `c:id`, `si:id` or the email.
    pub fn label(&self) -> String {
        match (&self.account, &self.email) {
            (Some(account), _) => account.label().to_owned(),
            (None, Some(email)) => email.clone(),
            _ => self.id.clone(),
        }
    }

    /// The folder the access comes through, if any.
    pub fn via_folder(&self) -> Option<&Folder> {
        match &self.via {
            MemberVia::Folder { folder } => Some(folder),
            MemberVia::Direct(_) => None,
        }
    }
}

/// `GET /v1/docs/{id}/sharing`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sharing {
    /// The owner.
    pub owner: Account,
    /// Doc link access (absent for folders).
    pub public_access: Option<String>,
    /// Everyone it is shared with.
    pub members: Vec<Member>,
}

/// What is being transferred.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TransferItem {
    /// `doc` or `folder`.
    pub kind: String,
    /// `d_…` or `f_…`.
    pub id: String,
    /// Title or name.
    pub title: String,
}

/// A transfer of ownership waiting for (or after) the recipient's answer.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Transfer {
    /// `x_…`.
    pub id: String,
    /// The doc or folder.
    pub item: TransferItem,
    /// Current owner.
    pub from: Account,
    /// Recipient.
    pub to: Account,
    /// `pending`, `accepted`, `declined` or `cancelled`.
    pub status: String,
    /// RFC 3339.
    pub created_at: String,
}

/// `GET /v1/transfers`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Transfers {
    /// Transfers to the caller.
    pub incoming: Vec<Transfer>,
    /// Transfers from the caller.
    pub outgoing: Vec<Transfer>,
}

/// What to do with a transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferAction {
    /// The recipient takes it.
    Accept,
    /// The recipient refuses it.
    Decline,
    /// The owner withdraws it.
    Cancel,
}

impl TransferAction {
    /// The path segment.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

/// An area of an image or of a PDF page, as fractions of its size.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
    /// The PDF page, from 1 (PDF anchors only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
}

impl Rect {
    /// A whole PDF page.
    pub fn page(page: u32) -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            page: Some(page),
        }
    }
}

/// Where a thread is attached.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Anchor {
    /// `text`, `block`, `cell`, `image` or `pdf`.
    pub kind: String,
    /// Base64 Yjs relative position (from the editor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// Base64 Yjs relative position (text anchors from the editor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    /// The exact text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// Area of an image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
}

impl Anchor {
    /// A text anchor by its exact text, which must appear once in the doc's text.
    pub fn quote(text: impl Into<String>) -> Self {
        Self {
            kind: "text".into(),
            quote: Some(text.into()),
            ..Self::default()
        }
    }

    /// An area of a page of a PDF doc (`rect.page` from 1), quoted as `Page N` like the editor.
    pub fn pdf_area(rect: Rect) -> Self {
        let quote = rect.page.map(|p| format!("Page {p}"));
        Self {
            kind: "pdf".into(),
            rect: Some(rect),
            quote,
            ..Self::default()
        }
    }
}

/// One reaction and who reacted.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Reaction {
    /// The emoji.
    pub emoji: String,
    /// Who reacted with it.
    pub accounts: Vec<Account>,
}

/// One comment in a thread.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Comment {
    /// `c_…`.
    pub id: String,
    /// Who wrote it.
    pub author: Account,
    /// Markdown with `@c:id` / `@si:id` mentions.
    pub body: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339 when edited.
    pub edited_at: Option<String>,
    /// Deleted (kept in history).
    pub deleted: bool,
    /// Reactions.
    pub reactions: Vec<Reaction>,
}

/// A comment and its replies, attached to part of a doc.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Thread {
    /// `t_…`.
    pub id: String,
    /// Where it is attached.
    pub anchor: Anchor,
    /// The text when it was made.
    pub quote: String,
    /// The text now (`None` when it was deleted).
    pub current_quote: Option<String>,
    /// The text it was on is gone.
    pub orphaned: bool,
    /// Top-level block it is on.
    pub block_index: Option<i64>,
    /// `open` or `resolved`.
    pub status: String,
    /// Who started it.
    pub created_by: Account,
    /// RFC 3339.
    pub created_at: String,
    /// Who resolved it.
    pub resolved_by: Option<Account>,
    /// RFC 3339 when it was resolved.
    pub resolved_at: Option<String>,
    /// The comments, first one first.
    pub comments: Vec<Comment>,
}

/// `GET /v1/docs/{id}/threads`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Threads {
    /// The threads.
    pub threads: Vec<Thread>,
}

/// Which threads to list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThreadStatus {
    /// Open threads (default).
    #[default]
    Open,
    /// Resolved threads.
    Resolved,
    /// Every thread.
    All,
}

impl ThreadStatus {
    /// The query value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::All => "all",
        }
    }
}

/// A pending suggestion.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Suggestion {
    /// Suggestion id.
    pub id: String,
    /// Who suggested it.
    #[serde(deserialize_with = "nullable")]
    pub author: Account,
    /// Text it would add.
    pub inserted: String,
    /// Text it would remove.
    pub deleted: String,
}

/// `GET /v1/docs/{id}/suggestions`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Suggestions {
    /// The suggestions.
    pub suggestions: Vec<Suggestion>,
}

/// One version of a doc.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Version {
    /// Change number at the end of the version.
    pub seq: i64,
    /// Change number it starts after.
    pub from_seq: i64,
    /// Who changed it.
    pub authors: Vec<Account>,
    /// What changed, e.g. `si:writer edited “Introduction”`.
    pub summary: String,
    /// A name someone gave it.
    pub name: Option<String>,
    /// RFC 3339.
    pub created_at: String,
}

/// `PUT /v1/docs/{id}/versions/{seq}/name`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VersionName {
    /// The version.
    pub seq: i64,
    /// Its name.
    pub name: String,
}

/// `GET /v1/links?title=`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkTarget {
    /// The doc a `[[title]]` link opens, if any.
    pub doc: Option<Doc>,
}

/// `GET /v1/docs/{id}/versions`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Versions {
    /// Newest first.
    pub versions: Vec<Version>,
}

/// One part of a changed block.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ComparePart {
    /// `same`, `added` or `removed`.
    pub op: String,
    /// The text.
    pub text: String,
    /// Who made the change.
    pub by: Option<Account>,
}

/// One top-level block in a comparison.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CompareBlock {
    /// `same`, `added`, `removed` or `changed`.
    pub change: String,
    /// Markdown before.
    pub before: Option<String>,
    /// Markdown after.
    pub after: Option<String>,
    /// Word-level parts of a changed block.
    pub parts: Option<Vec<ComparePart>>,
    /// Who changed the block (the service sends one account for an added or removed block and a
    /// list for a changed one; both read as a list).
    #[serde(
        deserialize_with = "one_or_many",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub by: Vec<Account>,
    /// Index of the block in the older version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_index: Option<i64>,
    /// Index of the block in the newer version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_index: Option<i64>,
}

/// `GET /v1/docs/{id}/compare`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Comparison {
    /// Every top-level block.
    pub blocks: Vec<CompareBlock>,
}

/// One event in a doc's or folder's activity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ActivityEvent {
    /// Event id (the service sends a number; it is kept as text).
    #[serde(deserialize_with = "string_or_number")]
    pub id: String,
    /// What happened (`renamed`, `moved`, `deleted`, `created`, `shared`, …).
    pub kind: String,
    /// Who did it.
    pub actor: Account,
    /// Details.
    pub data: Value,
    /// RFC 3339.
    pub created_at: String,
    /// Can be undone with `POST /v1/activity/{id}/undo`.
    pub undoable: bool,
}

/// `GET /v1/docs/{id}/activity` and `GET /v1/folders/{id}/activity`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Activity {
    /// Events, newest first.
    pub events: Vec<ActivityEvent>,
}

/// A doc or a folder, for routes that exist for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item<'a> {
    /// A doc id.
    Doc(&'a str),
    /// A folder id.
    Folder(&'a str),
}

impl<'a> Item<'a> {
    /// `docs` or `folders`.
    pub fn collection(self) -> &'static str {
        match self {
            Self::Doc(_) => "docs",
            Self::Folder(_) => "folders",
        }
    }

    /// The id.
    pub fn id(self) -> &'a str {
        match self {
            Self::Doc(id) | Self::Folder(id) => id,
        }
    }

    /// From an id's prefix (`d_` or `f_`).
    pub fn from_id(id: &'a str) -> Option<Self> {
        if id.starts_with("d_") {
            Some(Self::Doc(id))
        } else if id.starts_with("f_") {
            Some(Self::Folder(id))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn doc_patch_distinguishes_absent_and_top_level() {
        let to_top = DocPatch {
            folder_id: Some(None),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&to_top).unwrap(),
            json!({ "folder_id": null })
        );
        let rename = DocPatch {
            title: Some("A".into()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&rename).unwrap(),
            json!({ "title": "A" })
        );
    }

    #[test]
    fn member_via_reads_both_forms() {
        let direct: Member =
            serde_json::from_value(json!({ "id": "m_1", "role": "editor", "via": "doc" })).unwrap();
        assert!(direct.via_folder().is_none());
        let through: Member = serde_json::from_value(json!({
            "id": "m_2", "role": "viewer", "via": { "folder": { "id": "f_1", "name": "Plans" } }
        }))
        .unwrap();
        assert_eq!(through.via_folder().unwrap().name, "Plans");
    }

    #[test]
    fn lenient_doc() {
        let doc: Doc = serde_json::from_value(
            json!({ "id": "d_1", "title": "T", "seq": 3, "brand_new_field": 1 }),
        )
        .unwrap();
        assert_eq!(doc.seq, 3);
        assert!(doc.folder_id.is_none());
    }

    #[test]
    fn tolerant_ids_and_nulls() {
        let event: ActivityEvent =
            serde_json::from_value(json!({ "id": 43, "kind": "doc.renamed", "undoable": true }))
                .unwrap();
        assert_eq!(event.id, "43");
        let s: Suggestion = serde_json::from_value(
            json!({ "id": "s_1", "author": null, "inserted": "a", "deleted": "" }),
        )
        .unwrap();
        assert!(s.author.uuid.is_empty());
    }

    #[test]
    fn compare_by_is_one_or_many() {
        let cmp: Comparison = serde_json::from_value(json!({ "blocks": [
            { "change": "changed", "by": [{ "id": "c:a", "uuid": "1" }, { "id": "si:b", "uuid": "2" }],
              "parts": [{ "op": "same", "text": "x" }] },
            { "change": "added", "after": "y", "by": { "id": "si:b", "uuid": "2" }, "after_index": 1 },
            { "change": "removed", "before": "z", "by": null },
            { "change": "same", "after": "w" }
        ] }))
        .unwrap();
        let ids: Vec<Vec<&str>> = cmp
            .blocks
            .iter()
            .map(|b| b.by.iter().map(|a| a.id.as_str()).collect())
            .collect();
        assert_eq!(ids, vec![vec!["c:a", "si:b"], vec!["si:b"], vec![], vec![]]);
        assert_eq!(cmp.blocks[1].after_index, Some(1));
    }

    #[test]
    fn edits_omit_false_all() {
        assert_eq!(
            serde_json::to_value(Edit::new("a", "b")).unwrap(),
            json!({ "old": "a", "new": "b" })
        );
    }

    #[test]
    fn formats_parse() {
        assert_eq!("DOCX".parse::<ExportFormat>().unwrap(), ExportFormat::Docx);
        assert_eq!(".DOC".parse::<ExportFormat>().unwrap(), ExportFormat::Doc);
        assert_eq!(
            ".markdown".parse::<ExportFormat>().unwrap(),
            ExportFormat::Md
        );
        assert!("xls".parse::<ExportFormat>().is_err());
    }
}
