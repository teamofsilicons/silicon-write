# This file is only meant to be changed by carbons (humans), if you are an agent DONT EDIT THIS FILE.


# UNDERSTANDING.md - Write

This understanding contains the understanding for the entire Silicon Write, the service, the web editor at `write.teamofsilicons.com` and the `write` CLI.

Silicon Write is where Carbons and Silicons write, read and comment on docs together. It is just a normal docs editor, with everything people expect from Google Docs, Microsoft Word or Obsidian. The difference is that Silicons are native users: they open, edit and comment on the same docs as Carbons, through the CLI, as easily as Carbons do in the web editor.

Carbons will mostly read and comment, and Silicons will mostly write and edit. So commenting has to be effortless, and every doc has to be a comfortable place for a Silicon to work.


# Glossary

`Carbon` - The human in the system. Every human account is called a carbon.
`Silicon` - Our AI Agent account is referred to as a Silicon.
`Doc` - A single document in Silicon Write.
`Folder` - A place to keep docs and other folders together.
`Owner` - The Carbon or Silicon a doc or folder belongs to. Every doc and folder has exactly one owner.
`Comment` - A note attached to a part of a doc. A comment and its replies are a `thread`.
`Suggestion` - A proposed change to a doc that can be accepted or rejected.


# Sign in

Signing in and signing up are handled entirely by Silicon Accounts. Use the official and latest Silicon Accounts client everywhere. Carbons and Silicons are always stored by their Silicon Accounts uuid, and shown by their c:id or si:id.

Reading a public doc never needs signing in.


# Docs and folders

Docs are personal. Every doc belongs to the Carbon or Silicon who created it. There are no Teams or workspaces. Everyone has two places: their own docs, and the docs and folders shared with them.

An owner can sort their docs into folders, and folders into other folders.

A doc created inside someone else's shared folder belongs to that folder's owner, so a folder never holds docs its owner doesn't control. The doc still shows who created it.

The owner can transfer a doc or folder to another Carbon or Silicon, who has to accept before it moves. The owner can delete a doc or folder. Anything deleted goes to the trash with its full history, and can be restored from there at any time. It stays in the trash until the owner permanently deletes it, which asks them to confirm first. That is the only way anything in Silicon Write is ever truly gone.


# Formats

Markdown is the native format of every doc. Every doc can always be read and written as Markdown, and that is how Silicons usually work with them.

Silicon Write handles every common document format. Any of these can be opened, which creates a new doc from the file, and any doc can be downloaded as any of them:

| Format          | Extension        |
| --------------- | ---------------- |
| Markdown        | `.md`            |
| Plain text      | `.txt`           |
| Word            | `.docx`, `.doc`  |
| OpenDocument    | `.odt`           |
| Rich text       | `.rtf`           |
| Web page        | `.html`          |
| PDF             | `.pdf`           |

Formatting that Markdown has no way of writing, like underline or text colour, is never dropped. It stays in the doc and comes back out in every format that supports it.

The website also offers **Beautiful PDF** under **More → Download as** for text docs. It uses Write's own fonts, typography, colors and generous spacing on paginated A4 pages, with selectable text. Choose Light or Dark for the export; the initial choice matches the appearance currently on screen, including when following System. This choice does not change the website's appearance. Pending edits save before export; comments and unaccepted suggestions are omitted, as with the other downloads.

A PDF opens as it is, to read and comment on. It can be turned into a normal doc to edit it.


# Sharing

Docs and folders are shared the same way. The owner, and anyone who can edit, can invite Carbons and Silicons by their c:id, si:id or email. Inviting an email that isn't on Silicon Accounts yet sends them an invite to join.

Everyone invited gets one of three roles:
- `Editor` - can edit, comment and invite others.
- `Commenter` - can read, comment and make suggestions.
- `Viewer` - can only read.

Carbons and Silicons get exactly the same roles and the same rights. A Silicon invited as an editor edits directly, like any other editor.

## Shared folders

Sharing a folder shares everything in it, including the folders inside it and anything added to it later. Editors of a folder can also create new docs and folders in it, and move docs and folders around inside it.

If someone has access to a doc both directly and through its folder, they get whichever role gives them more.

## Public docs

Any doc can be made public at any time with one switch. Anyone with the link can then view it, or, if the owner chooses, comment on it or edit it. There is no publishing and nothing is listed anywhere: the doc is just reachable by its link. The owner can make it private again at any time, and the link stops working.

Viewing a public doc never needs signing in. Commenting or editing through the link does, so every change and every comment always has a Carbon or Silicon behind it.


# Editing

Opening a doc shows “Loading content…” until its current content and editor controls are ready together. Saved text must not appear to be a working editor while the live document is still loading.

Everyone edits the same doc at the same time and sees every change as it happens. Each Carbon and Silicon in the doc shows up with their name, pfp and cursor. Silicons show up exactly like Carbons do. When a Silicon makes a change, the whole change appears at once, briefly highlighted with its name, never typed out letter by letter.

If a connection drops, nothing is lost. Changes made meanwhile merge back in once it returns.

Every doc has the basics: headings, bold, italic, underline, strikethrough, text colour, highlight, lists, checklists, tables, images, links, code blocks, quotes, dividers, maths, footnotes, a table of contents, find and replace, word count, Markdown shortcuts, a slash menu and undo. Docs can link to each other with `[[doc name]]`, and every doc shows which docs link to it.

## Suggestions

Anyone who can edit can switch to suggesting, so their changes become suggestions instead of edits. Commenters can only ever suggest. Each suggestion shows who made it, and can be accepted or rejected one at a time or all at once.


# Comments

Selecting text never opens the comment box automatically, in any mode. Anyone who can comment gets a small `Comment` button next to their selection and a keyboard shortcut. They can freely select text, pause, change the selection or move away; the comment box opens only when they explicitly choose to comment.

A comment can be on any part of a doc:
- some text
- a whole section, by clicking next to it in the margin
- a table cell
- an image, or an area drawn on an image

Comments can be replied to, reacted to, edited, and resolved. Resolved threads can be reopened. A comment stays on its text as the doc changes around it. If that text is deleted, the comment stays, showing the text it was on.

All of a doc's threads can be seen in one list, and moved through one by one with the keyboard.


# Mentions and notifications

Anyone can mention a Carbon or Silicon in a comment with their c:id or si:id. All notifications go through Silicon Ting; Silicon Write never sends its own.

| Ting                       | When                                        | Sent to                    |
| -------------------------- | ------------------------------------------- | -------------------------- |
| `write.mention.received`   | Someone mentions you in a comment           | The one mentioned          |
| `write.comment.created`    | Someone comments on your doc                | The owner                  |
| `write.comment.replied`    | Someone replies in a thread you're in       | Everyone in the thread     |
| `write.suggestion.created` | Someone suggests a change to your doc       | The owner                  |
| `write.thread.resolved`    | A thread you started is resolved            | Who started it             |
| `write.doc.shared`         | A doc or folder is shared with you          | The one invited            |

A ting carries enough for a Silicon to act straight away: the doc, the text the comment is on, and the comment itself. Mentioning a Silicon is how a Carbon asks it for something, for example selecting a paragraph and writing "@si:writer make this shorter".


# Versions

Everything in Silicon Write is versioned, and nothing is ever lost. There is no save button: every change is saved the moment it's made.

## History

Every change to a doc is kept for as long as the doc exists, with who made it and when, whether it was a Carbon or a Silicon. Nothing is ever cleaned up or thinned out over time. The history also keeps renames, moves, sharing changes, accepted and rejected suggestions, and deleted or resolved comments.

Changes are grouped into versions automatically, so the history reads as a list of who did what, for example "si:writer rewrote the introduction". Anyone who can edit can also name a version, like `Sent to the client`, to find it again easily.

Any part of a doc shows who wrote it and when.

## Going back

Anyone who can edit can:
- open a doc exactly as it was at any version, and read it or download it in any format.
- compare any two versions, seeing what was added and removed, and by whom.
- restore a whole older version.
- bring back just one part, like a paragraph or section, from an older version.
- undo everything one Carbon or Silicon changed since a given version, leaving everyone else's changes in place.
- make a new doc from any older version.

Going back never deletes anything. Restoring is itself a new version, so everything that came after it is still in the history and can be brought back again.

## Never overwritten

No change ever silently replaces another. When two changes meet, both are kept and merged. If they can't be merged cleanly, nothing is thrown away: the conflict is shown, and both sides stay in the history.

Opening a file on top of an existing doc doesn't replace it; it becomes the doc's next version.

Folders are versioned too. Docs and folders being created, moved, renamed or deleted inside a folder are all kept in its history and can be undone.


# Silicons

The `write` CLI is how Silicons use Silicon Write, and it can do everything the web editor can.

- **Reading** - any doc can be read as Markdown, on its own or with its comments shown next to the text they're on.
- **Editing** - a Silicon changes a doc by replacing an exact passage, not by overwriting the whole doc, so its change merges cleanly with whatever anyone else is doing at the same time. It can also create new docs from Markdown or any supported format.
- **Working in a folder** - `write pull` brings a Silicon's docs and folders down as a folder of `.md` files. It can work on them with any tools it likes, and `write push` merges its changes back.
- **Comments** - a Silicon can read, write, reply to, react to and resolve comments, and make or accept suggestions, exactly like a Carbon.
- **Versions** - a Silicon can list a doc's versions, read any of them as Markdown, compare them, name them and restore them.
- **Search** - a Silicon can search the text of every doc it has access to.


# Look and feel

The web editor is built entirely with Silicon UI (`ui.teamofsilicons.com`).


# What it is not

Silicon Write is just normal docs. It is not a wiki, a chat, a code editor, a spreadsheet or a slides app, and it is not a place to publish or list writing. There are no Teams.
