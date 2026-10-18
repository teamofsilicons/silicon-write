//! `write`: the Silicon Write command line, for Carbons and Silicons.

mod auth;
mod commands;
mod ctx;
mod error;
mod live;
mod resolve;
mod session;
mod sync;

#[cfg(test)]
mod live_command_tests {
    use super::*;
    #[test]
    fn accepts_resumable_join_and_guarded_batch_edits() {
        let cli = Cli::try_parse_from([
            "write",
            "join",
            "https://write.teamofsilicons.com/d/d_1",
            "--json",
            "--after",
            "epoch:42",
            "--duration",
            "1200",
        ])
        .unwrap();
        assert!(cli.global.json);
        assert!(matches!(
            cli.command,
            Some(Command::Join(LiveArgs {
                duration: Some(1200),
                ..
            }))
        ));
        let cli =
            Cli::try_parse_from(["write", "edit", "d_1", "--edits", "-", "--expect-seq", "42"])
                .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Edit {
                expect_seq: Some(42),
                ..
            })
        ));
        assert!(Cli::try_parse_from(["write", "join", "d_1", "--duration", "0"]).is_err());
        assert!(
            Cli::try_parse_from([
                "write",
                "edit",
                "d_1",
                "--old",
                "a",
                "--new",
                "b",
                "--expect-seq",
                "-1"
            ])
            .is_err()
        );
    }
}

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, CommandFactory, Parser, Subcommand};
use silicon_write_client::TransferAction;

use crate::ctx::{Ctx, Options};
use crate::error::{CliError, CliResult};

const GUIDE: &str = include_str!("guide.md");

const ABOUT: &str =
    "Silicon Write: docs that Carbons and Silicons write, read and comment on together.";

const LONG_ABOUT: &str = "\
Silicon Write: docs that Carbons and Silicons write, read and comment on together.

Every doc is Markdown underneath. Read it with `write cat`, change an exact passage with
`write edit` (your change merges with whatever anyone else is doing), or pull everything down
as .md files with `write pull`, work on them with any tool, and `write push` the changes back.

DOC is a doc id (d_…), a doc link, or an exact title. FOLDER is a folder id (f_…), a folder
path like `Plans/Q3`, or `/` for the top level.";

const AFTER_HELP: &str = "\
QUICK START
  write login                                   Carbon: approve a code in the browser
  silicon-accounts login --app write | write login --token-stdin
                                                Silicon: sign in with a short-lived token
  write ls                                      your docs and folders
  write context DOC --json                      content, comments, authors and presence
  write join DOC --json                         stay present and receive live changes
  write new --title \"Launch plan\" --file plan.md
  write cat \"Launch plan\" --comments            Markdown with open comments inline
  write edit \"Launch plan\" --old \"Monday\" --new \"Tuesday\"
  write comment \"Launch plan\" --quote \"Ship it\" --body \"@c:saket ok?\"
  write pull ~/docs && write push ~/docs        work on every doc as .md files

Every command has --help with examples, and --json for machine output (errors too:
{\"error\":{\"code\",\"message\",\"hint\"}} on stdout). `write docs` is the full guide.

State lives in <home>/.write/ (session.json, mode 0600). URLs: a flag or environment variable
wins, then the URLs you signed in with, then production.

Exit codes: 0 ok, 1 failure, 2 invalid input, 3 not signed in or not allowed, 4 not found,
5 conflict.

No telemetry: Silicon Write's CLI records and sends nothing about how you use it.";

#[derive(Parser)]
#[command(name = "write", version, about = ABOUT, long_about = LONG_ABOUT, after_help = AFTER_HELP)]
#[command(propagate_version = true, max_term_width = 100)]
struct Cli {
    #[command(flatten)]
    global: Global,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Args)]
#[command(next_help_heading = "Global options")]
struct Global {
    /// Print machine-readable JSON on stdout (errors too: {"error":{"code","message","hint"}})
    #[arg(long, global = true)]
    json: bool,
    /// Silicon Write API URL [default: the one you signed in with, then https://api.write.teamofsilicons.com]
    #[arg(long, global = true, env = "WRITE_API_URL", value_name = "URL")]
    api_url: Option<String>,
    /// Silicon Accounts URL [default: the one you signed in with, then https://accounts.teamofsilicons.com]
    #[arg(long, global = true, env = "ACCOUNTS_URL", value_name = "URL")]
    accounts_url: Option<String>,
    /// Directory that holds .write/ [default: ~]
    #[arg(long, global = true, env = "SILICON_HOME", value_name = "DIR")]
    home: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    // ── account ──
    /// Sign in: Carbons approve a code in the browser, Silicons pass a short-lived token
    #[command(after_help = "\
Examples:
  write login                                   Carbon: device sign-in (prints a code and link)
  write login --slt slt_…                       Silicon: exchange a short-lived token
  silicon-accounts login --app write | write login --token-stdin
  write login status --json                     {\"authenticated\":true,\"id\":\"si:…\",…}")]
    Login(LoginArgs),
    /// Sign out: end the sign-in at Silicon Accounts and delete the stored session
    #[command(after_help = "Example:\n  write logout")]
    Logout,
    /// Show who you are signed in as
    #[command(after_help = "Example:\n  write whoami --json")]
    Whoami,
    /// Show this app's Silicon Accounts identity (app id, URLs, version)
    #[command(after_help = "Example:\n  write accounts --json")]
    Accounts,
    /// Print the guide to using Silicon Write from the command line
    #[command(after_help = "Example:\n  write docs | less")]
    Docs,

    // ── library ──
    /// List your docs and folders, a folder's content, what is shared with you, or your trash
    #[command(after_help = "\
Examples:
  write ls                    your top level
  write ls Plans/Q3           a folder (path or f_… id)
  write ls --shared           docs and folders shared with you
  write ls --recent           the 30 docs you can open that changed last
  write ls --trash            your trash")]
    Ls {
        /// Folder to list
        folder: Option<String>,
        /// What is shared with you directly
        #[arg(long, conflicts_with_all = ["trash", "recent"])]
        shared: bool,
        /// The docs that changed most recently
        #[arg(long, conflicts_with_all = ["trash", "folder"])]
        recent: bool,
        /// Your trash
        #[arg(long)]
        trash: bool,
    },
    /// Show every doc and folder you can open as a tree
    #[command(after_help = "Example:\n  write tree")]
    Tree,
    /// Show a doc's details: owner, folder, your role, link access, seq
    #[command(after_help = "Example:\n  write info \"Launch plan\"")]
    Info {
        /// Doc id, link or exact title
        doc: String,
    },
    /// Create a doc, empty or from Markdown (other formats are imported)
    #[command(after_help = "\
Examples:
  write new --title \"Launch plan\"
  write new --file plan.md --folder Plans           title from the file name
  echo \"# Notes\" | write new --title Notes --file -
  write new --file report.docx                      same as `write import`")]
    New {
        /// Title
        #[arg(long)]
        title: Option<String>,
        /// Folder to create it in
        #[arg(long)]
        folder: Option<String>,
        /// Markdown file to start from (- reads stdin)
        #[arg(long, value_name = "PATH|-")]
        file: Option<String>,
    },
    /// Open a file as a new doc (.md .txt .docx .doc .odt .rtf .html .pdf), or on top of a doc
    #[command(after_help = "\
Examples:
  write import report.docx
  write import notes.md --folder Plans --title \"Meeting notes\"
  write import v2.docx --into \"Launch plan\"        becomes the doc's next version")]
    Import {
        /// File to open
        file: String,
        /// Folder for the new doc
        #[arg(long)]
        folder: Option<String>,
        /// Title for the new doc
        #[arg(long)]
        title: Option<String>,
        /// Open the file on top of this doc instead; it becomes the doc's next version
        #[arg(long, value_name = "DOC", conflicts_with_all = ["folder", "title"])]
        into: Option<String>,
    },
    /// Download a doc as md, txt, docx, doc, odt, rtf, html or pdf (any version)
    #[command(after_help = "\
Examples:
  write export \"Launch plan\" --format docx
  write export d_x7Kq --format pdf --seq 40 -o plan-v40.pdf
  write export d_x7Kq --format md -o -              to stdout")]
    Export {
        /// Doc id, link or exact title
        doc: String,
        /// md, txt, docx, doc, odt, rtf, html or pdf
        #[arg(long, short = 'f')]
        format: String,
        /// Export this version instead of the latest
        #[arg(long)]
        seq: Option<i64>,
        /// Where to save (a file, a directory, or - for stdout) [default: the file's name here]
        #[arg(short = 'o', long = "output", value_name = "PATH")]
        output: Option<PathBuf>,
    },
    /// Download the original file of a PDF doc
    #[command(after_help = "Example:\n  write original \"Signed contract\" -o contract.pdf")]
    Original {
        /// Doc id, link or exact title
        doc: String,
        /// Where to save (- for stdout)
        #[arg(short = 'o', long = "output", value_name = "PATH")]
        output: Option<PathBuf>,
    },
    /// Turn a PDF doc into a normal doc you can edit (the PDF stays as its original)
    #[command(after_help = "Example:\n  write convert \"Signed contract\"")]
    Convert {
        /// Doc id, link or exact title
        doc: String,
    },
    /// Move a doc or folder into a folder (/ for the top level)
    #[command(after_help = "\
Examples:
  write mv \"Launch plan\" --to Plans/Q3
  write mv f_abc --to /")]
    Mv {
        /// Doc or folder (id, link, title or path)
        item: String,
        /// Target folder (path, f_… id, or / for the top level)
        #[arg(long)]
        to: String,
    },
    /// Rename a doc or folder
    #[command(after_help = "Example:\n  write rename \"Launch plan\" \"Launch plan (final)\"")]
    Rename {
        /// Doc or folder
        item: String,
        /// New title or name
        name: String,
    },
    /// Move a doc or folder to the trash (restore it any time)
    #[command(after_help = "Example:\n  write rm \"Old draft\"")]
    Rm {
        /// Doc or folder
        item: String,
    },
    /// Bring a doc or folder back from the trash
    #[command(after_help = "Example:\n  write restore \"Old draft\"")]
    Restore {
        /// Doc or folder in the trash
        item: String,
    },
    /// Delete a doc or folder from the trash for good (needs --confirm; it can't be undone)
    #[command(after_help = "Example:\n  write purge d_x7Kq --confirm")]
    Purge {
        /// Doc or folder in the trash
        item: String,
        /// Yes, delete it permanently
        #[arg(long)]
        confirm: bool,
    },
    /// Make a new doc from a doc (or from one of its versions)
    #[command(after_help = "\
Examples:
  write copy \"Launch plan\" --title \"Launch plan (copy)\"
  write copy d_x7Kq --seq 40 --title \"Plan as sent\"")]
    Copy {
        /// Doc id, link or exact title
        doc: String,
        /// Title of the copy
        #[arg(long)]
        title: Option<String>,
        /// Folder for the copy
        #[arg(long)]
        folder: Option<String>,
        /// Copy this version
        #[arg(long)]
        seq: Option<i64>,
    },
    /// Folders: create, show, rename, move, delete, restore, purge
    #[command(subcommand)]
    Folder(FolderCmd),
    /// Search the text of every doc you can open
    #[command(after_help = "Example:\n  write search \"launch date\"")]
    Search {
        /// Words to find
        query: String,
    },
    /// Show which doc a [[title]] link opens
    #[command(after_help = "Example:\n  write link \"Launch plan\"")]
    Link {
        /// The title inside [[…]]
        title: String,
    },
    /// List docs that link to a doc with [[title]]
    #[command(after_help = "Example:\n  write backlinks \"Launch plan\"")]
    Backlinks {
        /// Doc id, link or exact title
        doc: String,
    },

    // ── reading and editing ──
    /// Read content, comments, authors, revisions, and live collaborators together
    #[command(
        after_help = "Example:\n  write context DOC --json\n\nThe response includes a resumable cursor for `write watch` or `write join`."
    )]
    Context {
        /// Doc id, link or exact title
        doc: String,
        /// Recent revisions to include (0 omits history; the API retains up to 100)
        #[arg(long, default_value = "10", value_parser = clap::value_parser!(u16).range(0..=100))]
        revisions: u16,
    },
    /// Stream document and comment activity without appearing as a collaborator
    #[command(
        after_help = "Example:\n  write watch DOC --json --after CURSOR\n\nJSON output is one event per line. Save the cursor after processing each event.\nAn expired cursor produces a reset with fresh context. Ctrl+C stops watching."
    )]
    Watch(LiveArgs),
    /// Stay in a doc as your signed-in identity and stream collaboration activity
    #[command(
        after_help = "Example:\n  write join DOC --json --duration 1200\n\nYou appear in the document while connected. JSON output is one event per line.\nUse separate edit or comment commands to contribute. Ctrl+C leaves the session."
    )]
    Join(LiveArgs),
    /// Print a doc as Markdown, optionally with suggestions or open comments shown inline
    #[command(after_help = "\
Examples:
  write cat \"Launch plan\"
  write cat d_x7Kq --comments      open threads after the block they're on:
                                   > [!comment t_… by c:saket on \"quoted text\"] body
  write cat d_x7Kq --critic        pending suggestions as {++added++} / {--removed--}")]
    Cat {
        /// Doc id, link or exact title
        doc: String,
        /// Show pending suggestions as CriticMarkup
        #[arg(long)]
        critic: bool,
        /// Show open comments inline
        #[arg(long)]
        comments: bool,
    },
    /// Replace exact passages; the change merges with what others are doing
    #[command(after_help = "\
Examples:
  write edit \"Launch plan\" --old \"ship on Monday\" --new \"ship on Tuesday\"
  write edit d_x7Kq --old \"TODO\" --new \"done\" --all
  write edit d_x7Kq --old \"draft\" --new \"final\" --suggest     as a suggestion
  write edit d_x7Kq --edits edits.json
      edits.json: [{\"old\":\"exact text\",\"new\":\"replacement\",\"all\":false}, …]

`old` must be exact text from `write cat` and appear once (or pass --all). Errors:
no_match (the text isn't there) and not_unique (it appears several times).")]
    Edit {
        /// Doc id, link or exact title
        doc: String,
        /// Exact text to replace
        #[arg(long, allow_hyphen_values = true)]
        old: Option<String>,
        /// Replacement ('' deletes)
        #[arg(long, allow_hyphen_values = true)]
        new: Option<String>,
        /// Replace every occurrence
        #[arg(long)]
        all: bool,
        /// Make it a suggestion instead of an edit
        #[arg(long)]
        suggest: bool,
        /// JSON file with several edits applied together (- reads stdin)
        #[arg(long, value_name = "FILE|-", conflicts_with_all = ["old", "new", "all"])]
        edits: Option<String>,
        /// Apply only if the document still has this content version; conflict exits 5
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        expect_seq: Option<i64>,
    },
    /// Write a whole doc from Markdown (with --base-seq, only your changes since then)
    #[command(after_help = "\
Examples:
  write put \"Launch plan\" plan.md --base-seq 42    merges with changes made after seq 42
  write cat d_x7Kq --json | jq -r .markdown > plan.md   (the JSON has the seq)
  cat plan.md | write put d_x7Kq - --suggest")]
    Put {
        /// Doc id, link or exact title
        doc: String,
        /// Markdown file (- reads stdin)
        file: String,
        /// The seq the Markdown was read at; changes made after it are kept and merged
        #[arg(long)]
        base_seq: Option<i64>,
        /// Make it a suggestion
        #[arg(long)]
        suggest: bool,
    },
    /// Upload an image for a doc and print the Markdown to place it
    #[command(after_help = "Example:\n  write image \"Launch plan\" chart.png")]
    Image {
        /// Doc id, link or exact title
        doc: String,
        /// Image file
        file: String,
    },
    /// Download an image uploaded to a doc (a_… id)
    #[command(after_help = "Example:\n  write asset a_k2Lm -o chart.png")]
    Asset {
        /// Asset id
        id: String,
        /// Where to save (- for stdout)
        #[arg(short = 'o', long = "output", value_name = "PATH")]
        output: Option<PathBuf>,
    },
    /// Bring every doc you can open down as .md files (shared docs under `Shared with me/`)
    #[command(after_help = "\
Examples:
  write pull ~/docs
  write pull                       into this folder
  write pull --force               take Silicon Write's version over local changes

Your docs land by their folders; docs shared with you under `Shared with me/`. Duplicate titles
get ` (2)`. `.write/state.json` remembers each file's doc and the seq it was pulled at. A pull
never overwrites a file you changed: it reports a conflict (exit 5) unless --force.")]
    Pull {
        /// Directory [default: .]
        dir: Option<PathBuf>,
        /// Overwrite local changes with Silicon Write's version
        #[arg(long)]
        force: bool,
    },
    /// Send changed and new .md files back; Silicon Write merges them with everyone's changes
    #[command(after_help = "\
Examples:
  write push ~/docs
  write push --suggest              send every change as suggestions

Changed files are merged from the seq they were pulled at, and refreshed with the result. New
files become new docs in the matching folder (missing folders are created). A renamed or moved
file renames or moves its doc. Deleted files are only reported, never deleted on Silicon Write.")]
    Push {
        /// Directory [default: .]
        dir: Option<PathBuf>,
        /// Make the changes suggestions
        #[arg(long)]
        suggest: bool,
    },
    /// Show modified, new and deleted files since the last pull or push (no network)
    #[command(after_help = "Example:\n  write status ~/docs")]
    Status {
        /// Directory [default: .]
        dir: Option<PathBuf>,
    },

    // ── sharing ──
    /// Share a doc or folder with a c:id, si:id or email (again to change the role)
    #[command(after_help = "\
Examples:
  write share \"Launch plan\" si:writer --role editor
  write share Plans c:saket --role commenter
  write share d_x7Kq friend@example.com --role viewer     invites them to join")]
    Share {
        /// Doc or folder
        item: String,
        /// c:id, si:id or email
        to: String,
        /// editor, commenter or viewer
        #[arg(long, default_value = "editor")]
        role: String,
    },
    /// Stop sharing a doc or folder with someone
    #[command(after_help = "Example:\n  write unshare \"Launch plan\" si:writer")]
    Unshare {
        /// Doc or folder
        item: String,
        /// c:id, si:id, email or member id (m_…)
        who: String,
    },
    /// List who a doc or folder is shared with
    #[command(after_help = "Example:\n  write members \"Launch plan\"")]
    Members {
        /// Doc or folder
        item: String,
    },
    /// Set who can use a doc's link: none, view, comment or edit
    #[command(after_help = "\
Examples:
  write public \"Launch plan\" --access view
  write public d_x7Kq --access none        private again")]
    Public {
        /// Doc id, link or exact title
        doc: String,
        /// none, view, comment or edit
        #[arg(long)]
        access: String,
    },
    /// Offer a doc or folder to another Carbon or Silicon (it moves when they accept)
    #[command(after_help = "Example:\n  write transfer \"Launch plan\" c:saket")]
    Transfer {
        /// Doc or folder
        item: String,
        /// c:id or si:id
        to: String,
    },
    /// List transfers to and from you, or accept, decline or cancel one
    #[command(after_help = "\
Examples:
  write transfers
  write transfers accept x_9Qe
  write transfers cancel x_9Qe")]
    Transfers {
        #[command(subcommand)]
        action: Option<TransfersCmd>,
    },

    // ── comments ──
    /// List a doc's comment threads (open by default)
    #[command(after_help = "\
Examples:
  write comments \"Launch plan\"
  write comments d_x7Kq --all --json")]
    Comments {
        /// Doc id, link or exact title
        doc: String,
        /// Open and resolved threads
        #[arg(long, conflicts_with = "resolved")]
        all: bool,
        /// Only resolved threads
        #[arg(long)]
        resolved: bool,
    },
    /// Comment on exact text in a doc, or on an area of a PDF page (mention with @c:id / @si:id)
    #[command(after_help = "\
Examples:
  write comment \"Launch plan\" --quote \"ship on Monday\" --body \"@si:writer make this Tuesday\"
  write comment d_x7Kq --quote \"Budget\" --body - < note.md
  write comment \"Signed contract\" --page 2 --body \"Check this page\"
  write comment \"Signed contract\" --page 2 --rect 0.1,0.6,0.8,0.1 --body \"This clause?\"")]
    Comment {
        /// Doc id, link or exact title
        doc: String,
        /// Exact text the comment is on (must appear once)
        #[arg(
            long,
            allow_hyphen_values = true,
            required_unless_present = "page",
            conflicts_with = "page"
        )]
        quote: Option<String>,
        /// PDF docs: the page the comment is on (from 1)
        #[arg(long)]
        page: Option<u32>,
        /// PDF docs: the area on the page as fractions X,Y,W,H [default: the whole page]
        #[arg(long, requires = "page", value_name = "X,Y,W,H")]
        rect: Option<String>,
        /// The comment, Markdown (- reads stdin)
        #[arg(long, allow_hyphen_values = true)]
        body: String,
    },
    /// Reply in a thread
    #[command(after_help = "Example:\n  write reply t_4Hs --body \"Done.\"")]
    Reply {
        /// Thread id (t_…)
        thread: String,
        /// The reply (- reads stdin)
        #[arg(long, allow_hyphen_values = true)]
        body: String,
    },
    /// Resolve a thread
    #[command(after_help = "Example:\n  write resolve t_4Hs")]
    Resolve {
        /// Thread id (t_…)
        thread: String,
    },
    /// Reopen a resolved thread
    #[command(after_help = "Example:\n  write reopen t_4Hs")]
    Reopen {
        /// Thread id (t_…)
        thread: String,
    },
    /// Add or remove your reaction on a comment
    #[command(after_help = "Example:\n  write react c_8Fd 👍")]
    React {
        /// Comment id (c_…)
        comment: String,
        /// Emoji
        emoji: String,
    },
    /// Edit your comment
    #[command(
        name = "comment-edit",
        after_help = "Example:\n  write comment-edit c_8Fd --body \"Better wording\""
    )]
    CommentEdit {
        /// Comment id (c_…)
        comment: String,
        /// New text (- reads stdin)
        #[arg(long, allow_hyphen_values = true)]
        body: String,
    },
    /// Delete your comment (it stays in the doc's history)
    #[command(name = "comment-rm", after_help = "Example:\n  write comment-rm c_8Fd")]
    CommentRm {
        /// Comment id (c_…)
        comment: String,
    },

    // ── suggestions ──
    /// List a doc's pending suggestions
    #[command(after_help = "Example:\n  write suggestions \"Launch plan\"")]
    Suggestions {
        /// Doc id, link or exact title
        doc: String,
    },
    /// Suggest replacing exact text (like `write edit --suggest`)
    #[command(
        after_help = "Example:\n  write suggest \"Launch plan\" --old \"Monday\" --new \"Tuesday\""
    )]
    Suggest {
        /// Doc id, link or exact title
        doc: String,
        /// Exact text to replace
        #[arg(long, allow_hyphen_values = true)]
        old: String,
        /// Replacement
        #[arg(long, allow_hyphen_values = true)]
        new: String,
        /// Every occurrence
        #[arg(long)]
        all: bool,
    },
    /// Accept one suggestion, or all of them
    #[command(after_help = "\
Examples:
  write accept \"Launch plan\" s_1
  write accept d_x7Kq --all")]
    Accept {
        /// Doc id, link or exact title
        doc: String,
        /// Suggestion id
        #[arg(required_unless_present = "all")]
        suggestion: Option<String>,
        /// Every pending suggestion
        #[arg(long, conflicts_with = "suggestion")]
        all: bool,
    },
    /// Reject one suggestion, or all of them
    #[command(after_help = "\
Examples:
  write reject \"Launch plan\" s_1
  write reject d_x7Kq --all")]
    Reject {
        /// Doc id, link or exact title
        doc: String,
        /// Suggestion id
        #[arg(required_unless_present = "all")]
        suggestion: Option<String>,
        /// Every pending suggestion
        #[arg(long, conflicts_with = "suggestion")]
        all: bool,
    },

    // ── versions ──
    /// List a doc's versions, newest first
    #[command(after_help = "Example:\n  write versions \"Launch plan\"")]
    Versions {
        /// Doc id, link or exact title
        doc: String,
    },
    /// Print a version of a doc as Markdown
    #[command(after_help = "Example:\n  write version \"Launch plan\" 40")]
    Version {
        /// Doc id, link or exact title
        doc: String,
        /// Version (seq)
        seq: i64,
    },
    /// Name a version so it's easy to find again (or --remove the name)
    #[command(after_help = "\
Examples:
  write name \"Launch plan\" 42 \"Sent to the client\"
  write name d_x7Kq 42 --remove")]
    Name {
        /// Doc id, link or exact title
        doc: String,
        /// Version (seq)
        seq: i64,
        /// The name
        #[arg(required_unless_present = "remove")]
        name: Option<String>,
        /// Remove the version's name
        #[arg(long, conflicts_with = "name")]
        remove: bool,
    },
    /// Compare two versions: what was added and removed, and by whom
    #[command(after_help = "Example:\n  write compare \"Launch plan\" 40 42")]
    Compare {
        /// Doc id, link or exact title
        doc: String,
        /// Older version (seq)
        from: i64,
        /// Newer version (seq)
        to: i64,
    },
    /// Restore an older version, or only some of its blocks (a new version; nothing is lost)
    #[command(after_help = "\
Examples:
  write revert \"Launch plan\" 40
  write revert d_x7Kq 40 --blocks 2..4      top-level blocks 2 to 4 (from 0) of version 40")]
    Revert {
        /// Doc id, link or exact title
        doc: String,
        /// Version (seq) to go back to
        seq: i64,
        /// Only these top-level blocks of that version: FROM..TO
        #[arg(long, value_name = "FROM..TO")]
        blocks: Option<String>,
    },
    /// Undo everything one Carbon or Silicon changed since a version, or undo one activity event
    #[command(after_help = "\
Examples:
  write undo \"Launch plan\" --account si:writer --since 40
  write undo --event ev_123                 a rename, move, delete or create from `write activity`")]
    Undo {
        /// Doc id, link or exact title
        #[arg(required_unless_present = "event")]
        doc: Option<String>,
        /// c:id or si:id whose changes to undo
        #[arg(long, requires = "since", conflicts_with = "event")]
        account: Option<String>,
        /// Undo their changes after this version (seq)
        #[arg(long, requires = "account", conflicts_with = "event")]
        since: Option<i64>,
        /// Activity event id to undo
        #[arg(long, conflicts_with = "doc")]
        event: Option<String>,
    },
    /// Show a doc's or folder's history: renames, moves, sharing, comments, deletions
    #[command(after_help = "Example:\n  write activity Plans")]
    Activity {
        /// Doc or folder
        item: String,
    },
    /// Show who wrote each top-level block of a doc
    #[command(after_help = "Example:\n  write authors \"Launch plan\"")]
    Authors {
        /// Doc id, link or exact title
        doc: String,
    },
}

#[derive(Args)]
struct LiveArgs {
    /// Doc id, link or exact title
    doc: String,
    /// Resume from the last processed event cursor
    #[arg(long)]
    after: Option<String>,
    /// Leave after this many seconds (otherwise stay until Ctrl+C)
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    duration: Option<u64>,
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct LoginArgs {
    #[command(subcommand)]
    command: Option<LoginCmd>,
    /// Silicon: a short-lived token from `silicon-accounts login --app write`
    #[arg(long, value_name = "TOKEN", conflicts_with = "token_stdin")]
    slt: Option<String>,
    /// Silicon: read the short-lived token from stdin
    #[arg(long, alias = "slt-stdin")]
    token_stdin: bool,
    /// Sign in again even if already signed in
    #[arg(long)]
    force: bool,
    /// Label for this sign-in in your Silicon Accounts session list
    #[arg(long, value_name = "TEXT")]
    label: Option<String>,
}

#[derive(Subcommand)]
enum LoginCmd {
    /// Report whether you are signed in and as whom ({"authenticated":false} exits 0 with --json)
    #[command(after_help = "Example:\n  write login status --json")]
    Status,
}

#[derive(Subcommand)]
enum FolderCmd {
    /// Create a folder
    #[command(after_help = "\
Examples:
  write folder new Plans
  write folder new Q3 --in Plans")]
    New {
        /// Name
        name: String,
        /// Parent folder
        #[arg(long = "in", value_name = "FOLDER")]
        parent: Option<String>,
    },
    /// Show a folder's details
    #[command(after_help = "Example:\n  write folder show Plans/Q3")]
    Show {
        /// Folder path or id
        folder: String,
    },
    /// Rename a folder
    #[command(after_help = "Example:\n  write folder rename Plans \"Plans 2027\"")]
    Rename {
        /// Folder path or id
        folder: String,
        /// New name
        name: String,
    },
    /// Move a folder (/ for the top level)
    #[command(after_help = "Example:\n  write folder mv Plans/Q3 --to Archive")]
    Mv {
        /// Folder path or id
        folder: String,
        /// Target folder
        #[arg(long)]
        to: String,
    },
    /// Move a folder and everything in it to the trash
    #[command(after_help = "Example:\n  write folder rm Archive")]
    Rm {
        /// Folder path or id
        folder: String,
    },
    /// Bring a folder back from the trash
    #[command(after_help = "Example:\n  write folder restore Archive")]
    Restore {
        /// Folder path or id
        folder: String,
    },
    /// Delete a folder from the trash for good
    #[command(after_help = "Example:\n  write folder purge f_abc --confirm")]
    Purge {
        /// Folder path or id
        folder: String,
        /// Yes, delete it permanently
        #[arg(long)]
        confirm: bool,
    },
}

#[derive(Subcommand)]
enum TransfersCmd {
    /// Take a doc or folder offered to you
    Accept {
        /// Transfer id (x_…)
        id: String,
    },
    /// Refuse a doc or folder offered to you
    Decline {
        /// Transfer id (x_…)
        id: String,
    },
    /// Withdraw a transfer you offered
    Cancel {
        /// Transfer id (x_…)
        id: String,
    },
}

/// Folder arguments given as paths must name folders, not docs.
async fn folder_item(ctx: &Ctx, folder: &str, trash: bool) -> CliResult<String> {
    let id = resolve::folder_id(ctx, folder, trash).await?;
    id.ok_or_else(|| {
        CliError::invalid(
            "`/` is the top level, not a folder.",
            "Pass a folder path or id.",
        )
    })
}

async fn run(ctx: &Ctx, command: Command) -> CliResult<()> {
    use commands as c;
    match command {
        Command::Login(args) => match args.command {
            Some(LoginCmd::Status) => auth::status(ctx).await,
            None => {
                auth::login(
                    ctx,
                    auth::LoginOptions {
                        slt: args.slt,
                        token_stdin: args.token_stdin,
                        force: args.force,
                        label: args.label,
                    },
                )
                .await
            }
        },
        Command::Logout => auth::logout(ctx).await,
        Command::Whoami => auth::whoami(ctx).await,
        Command::Accounts => auth::accounts(ctx),
        Command::Docs => {
            ctx.emit(&serde_json::json!({ "markdown": GUIDE }), || {
                GUIDE.to_owned()
            });
            Ok(())
        }
        Command::Ls {
            folder,
            shared,
            trash,
            recent,
        } => c::ls(ctx, folder, shared, trash, recent).await,
        Command::Tree => c::tree(ctx).await,
        Command::Info { doc } => c::info(ctx, &doc).await,
        Command::New {
            title,
            folder,
            file,
        } => c::new_doc(ctx, title, folder, file).await,
        Command::Import {
            file,
            folder,
            title,
            into,
        } => c::import_cmd(ctx, &file, folder, title, into).await,
        Command::Export {
            doc,
            format,
            seq,
            output,
        } => c::export(ctx, &doc, &format, seq, output).await,
        Command::Original { doc, output } => c::original(ctx, &doc, output).await,
        Command::Convert { doc } => c::convert(ctx, &doc).await,
        Command::Mv { item, to } => c::mv(ctx, &item, &to).await,
        Command::Rename { item, name } => c::rename(ctx, &item, &name).await,
        Command::Rm { item } => c::rm(ctx, &item).await,
        Command::Restore { item } => c::restore(ctx, &item).await,
        Command::Purge { item, confirm } => c::purge(ctx, &item, confirm).await,
        Command::Copy {
            doc,
            title,
            folder,
            seq,
        } => c::copy(ctx, &doc, title, folder, seq).await,
        Command::Folder(cmd) => match cmd {
            FolderCmd::New { name, parent } => c::folder_new(ctx, &name, parent).await,
            FolderCmd::Show { folder } => c::folder_show(ctx, &folder).await,
            FolderCmd::Rename { folder, name } => {
                c::rename(ctx, &folder_item(ctx, &folder, false).await?, &name).await
            }
            FolderCmd::Mv { folder, to } => {
                c::mv(ctx, &folder_item(ctx, &folder, false).await?, &to).await
            }
            FolderCmd::Rm { folder } => c::rm(ctx, &folder_item(ctx, &folder, false).await?).await,
            FolderCmd::Restore { folder } => {
                c::restore(ctx, &folder_item(ctx, &folder, true).await?).await
            }
            FolderCmd::Purge { folder, confirm } => {
                c::purge(ctx, &folder_item(ctx, &folder, true).await?, confirm).await
            }
        },
        Command::Link { title } => c::link(ctx, &title).await,
        Command::Search { query } => c::search(ctx, &query).await,
        Command::Backlinks { doc } => c::backlinks(ctx, &doc).await,
        Command::Context { doc, revisions } => live::context(ctx, &doc, revisions).await,
        Command::Watch(args) => live::watch(ctx, &args.doc, false, args.after, args.duration).await,
        Command::Join(args) => live::watch(ctx, &args.doc, true, args.after, args.duration).await,
        Command::Cat {
            doc,
            critic,
            comments,
        } => c::cat(ctx, &doc, critic, comments).await,
        Command::Edit {
            doc,
            old,
            new,
            all,
            suggest,
            edits,
            expect_seq,
        } => {
            c::edit(
                ctx,
                &doc,
                old,
                new,
                c::EditOptions {
                    all,
                    suggest,
                    expect_seq,
                },
                edits,
            )
            .await
        }
        Command::Put {
            doc,
            file,
            base_seq,
            suggest,
        } => c::put(ctx, &doc, &file, base_seq, suggest).await,
        Command::Image { doc, file } => c::image(ctx, &doc, &file).await,
        Command::Asset { id, output } => c::asset(ctx, &id, output).await,
        Command::Pull { dir, force } => sync::pull(ctx, dir, force).await,
        Command::Push { dir, suggest } => sync::push(ctx, dir, suggest).await,
        Command::Status { dir } => sync::status(ctx, dir),
        Command::Share { item, to, role } => c::share(ctx, &item, &to, &role).await,
        Command::Unshare { item, who } => c::unshare(ctx, &item, &who).await,
        Command::Members { item } => c::members(ctx, &item).await,
        Command::Public { doc, access } => c::public(ctx, &doc, &access).await,
        Command::Transfer { item, to } => c::transfer(ctx, &item, &to).await,
        Command::Transfers { action } => {
            let action = action.map(|a| match a {
                TransfersCmd::Accept { id } => (TransferAction::Accept, id),
                TransfersCmd::Decline { id } => (TransferAction::Decline, id),
                TransfersCmd::Cancel { id } => (TransferAction::Cancel, id),
            });
            c::transfers(ctx, action).await
        }
        Command::Comments { doc, all, resolved } => c::comments(ctx, &doc, all, resolved).await,
        Command::Comment {
            doc,
            quote,
            page,
            rect,
            body,
        } => c::comment(ctx, &doc, quote, page, rect, &body).await,
        Command::Reply { thread, body } => c::reply(ctx, &thread, &body).await,
        Command::Resolve { thread } => c::resolve_thread(ctx, &thread, false).await,
        Command::Reopen { thread } => c::resolve_thread(ctx, &thread, true).await,
        Command::React { comment, emoji } => c::react(ctx, &comment, &emoji).await,
        Command::CommentEdit { comment, body } => c::comment_edit(ctx, &comment, &body).await,
        Command::CommentRm { comment } => c::comment_rm(ctx, &comment).await,
        Command::Suggestions { doc } => c::suggestions(ctx, &doc).await,
        Command::Suggest { doc, old, new, all } => {
            c::edit(
                ctx,
                &doc,
                Some(old),
                Some(new),
                c::EditOptions {
                    all,
                    suggest: true,
                    expect_seq: None,
                },
                None,
            )
            .await
        }
        Command::Accept {
            doc,
            suggestion,
            all,
        } => c::decide(ctx, &doc, suggestion, all, true).await,
        Command::Reject {
            doc,
            suggestion,
            all,
        } => c::decide(ctx, &doc, suggestion, all, false).await,
        Command::Versions { doc } => c::versions(ctx, &doc).await,
        Command::Version { doc, seq } => c::version(ctx, &doc, seq).await,
        Command::Name {
            doc,
            seq,
            name,
            remove,
        } => c::name_version(ctx, &doc, seq, name, remove).await,
        Command::Compare { doc, from, to } => c::compare(ctx, &doc, from, to).await,
        Command::Revert { doc, seq, blocks } => c::revert(ctx, &doc, seq, blocks).await,
        Command::Undo {
            doc,
            account,
            since,
            event,
        } => c::undo(ctx, doc, account, since, event).await,
        Command::Activity { item } => c::activity(ctx, &item).await,
        Command::Authors { doc } => c::authors(ctx, &doc).await,
    }
}

fn report(json: bool, err: &CliError) -> ExitCode {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&err.to_json()).unwrap_or_default()
        );
    } else {
        eprintln!("Error: {}", err.message);
        if let Some(hint) = &err.hint {
            eprintln!("Hint: {hint}");
        }
    }
    ExitCode::from(err.exit_code() as u8)
}

fn main() -> ExitCode {
    let wants_json = std::env::args().any(|a| a == "--json");
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            use clap::error::ErrorKind;
            let informational =
                matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion);
            if !informational && wants_json {
                let message = e.render().to_string();
                let first = message
                    .lines()
                    .take_while(|l| {
                        !l.starts_with("Usage:") && !l.starts_with("For more information")
                    })
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim_start_matches("error: ")
                    .to_owned();
                let err = CliError::new(
                    "usage",
                    first,
                    "Run the command with --help to see its arguments and examples.",
                );
                return report(true, &err);
            }
            let _ = e.print();
            return ExitCode::from(if informational {
                0
            } else {
                error::exit::INVALID as u8
            });
        }
    };
    let Some(command) = cli.command else {
        let _ = Cli::command().print_help();
        return ExitCode::SUCCESS;
    };
    let json = cli.global.json;
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            return report(
                json,
                &CliError::new("io", format!("Could not start: {e}."), "Retry the command."),
            );
        }
    };
    let options = Options {
        json,
        api_url: cli.global.api_url,
        accounts_url: cli.global.accounts_url,
        home: cli.global.home,
    };
    let result = runtime.block_on(async {
        let ctx = Ctx::new(options)?;
        let signed_in = ctx.signed_in;
        run(&ctx, command).await.map_err(|e| {
            // Without a session, a 401 means "sign in", not "your token is bad".
            if e.code == "unauthorized" && !signed_in && e.status == Some(401) {
                session::signed_out_error()
            } else {
                e
            }
        })
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => report(json, &e),
    }
}
