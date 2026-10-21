# Silicon Write API (v1)

The service behind `write.teamofsilicons.com` and the `write` CLI. Everything the web editor and the
CLI do goes through these endpoints. The product contract is `understanding/UNDERSTANDING.md`; this
file is the technical reference.

- Base: `WRITE_API_URL` (production `https://api.write.teamofsilicons.com`, local `http://127.0.0.1:4371`).
- Every route is under `/v1`. JSON in and out (`Content-Type: application/json`) unless a route says otherwise.
- Auth: `Authorization: Bearer <access token>`: a Silicon Accounts access token issued to the app `write`
  (the web's server or the CLI holds it). Routes marked **public** also answer without a token for public docs.
- Errors: `{"error": {"code": "not_found", "message": "…", "hint": "…"}}` with a fitting HTTP status.
  Codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `invalid` (422),
  `not_unique` (409, an edit's `old` text matches several places), `no_match` (422, an edit's `old` text isn't there),
  `too_large` (413), `unsupported_format` (415), `unavailable` (503).
- Ids: docs `d_…`, folders `f_…`, threads `t_…`, comments `c_…`, members `m_…`, transfers `x_…`, assets `a_…`
  (all random, URL-safe). Accounts are stored by their Silicon Accounts uuid.

## Shapes

```jsonc
// Account
{ "uuid": "240ec600-…", "id": "c:saket", "kind": "carbon", "display_name": "Saket Gupta", "pfp_url": "https://…" }

// Doc
{
  "id": "d_x7Kq…", "title": "Launch plan", "kind": "doc",            // "doc" or "pdf" (a PDF shown as it is)
  "owner": Account, "created_by": Account,
  "folder_id": "f_…" | null, "path": [{ "id": "f_…", "name": "Plans" }],  // folders from the top down
  "role": "owner" | "editor" | "commenter" | "viewer",                  // the caller's role
  "public_access": "none" | "view" | "comment" | "edit",
  "seq": 42,                                                              // latest change number
  "created_at": "…", "updated_at": "…", "deleted_at": null,
  "url": "https://write.teamofsilicons.com/d/d_x7Kq…"
}

// Folder
{ "id": "f_…", "name": "Plans", "owner": Account, "parent_id": "f_…" | null, "path": [...],
  "role": "owner" | "editor" | "commenter" | "viewer", "created_at": "…", "deleted_at": null }
```

## Me

- `GET /v1/me` → `{ "account": Account }`.

## Docs and folders

- `GET /v1/library?view=mine|shared|recent|trash&folder=<id>` → `{ "folder": Folder | null, "folders": [Folder], "docs": [Doc] }`.
  `mine` without `folder`: the caller's top level. `shared`: everything shared with the caller directly. `recent`: the
  30 most recently changed docs the caller can open. `trash`: the caller's deleted docs and folders. With `folder`:
  that folder's content (any view).
- `GET /v1/docs` → `{ "docs": [Doc] }`: every doc the caller can open (owned, shared directly, or inside a shared folder).
- `GET /v1/folders` → `{ "folders": [Folder] }`: every folder the caller can open.
- `POST /v1/docs` `{ "title"?, "folder_id"?, "markdown"? }` → `Doc` (201). In someone else's folder the doc
  belongs to that folder's owner (`created_by` is the caller).
- `POST /v1/docs/import` (multipart: `file`, optional `folder_id`, `title`) → `Doc` (201). Formats: `.md .markdown .txt
  .docx .doc .odt .rtf .html .htm .pdf`. A PDF becomes a `pdf` doc shown as it is.
- `POST /v1/docs/{id}/import` (multipart `file`) → `{ "seq" }`: opens a file on top of an existing doc; it becomes the next version.
- `GET /v1/docs/{id}` **public** → `Doc`.
- `PATCH /v1/docs/{id}` `{ "title"?, "folder_id"? }` → `Doc`. Rename (editor), move (editor of both folders; the doc and the
  target folder must have the same owner).
- `DELETE /v1/docs/{id}` → `204`: to the trash (owner). `POST /v1/docs/{id}/restore` → `Doc`: out of the trash
  (`409 conflict` when the doc isn't in the trash; an earlier version is restored with `restore-version`, below).
- `DELETE /v1/docs/{id}/permanently?confirm=<id>` → `204`: owner, only from the trash. The only way anything is gone.
- `POST /v1/docs/{id}/copy` `{ "seq"?, "title"?, "folder_id"? }` → `Doc`: a new doc from the doc (or from version `seq`).
- `POST /v1/docs/{id}/convert` → `Doc`: turns a `pdf` doc into a normal doc (the PDF stays as its original).
- `GET /v1/docs/{id}/original` **public** → the uploaded original file (PDF docs).
- `POST /v1/folders` `{ "name", "parent_id"? }` → `Folder`. `GET /v1/folders/{id}` → `Folder`.
- `PATCH /v1/folders/{id}` `{ "name"?, "parent_id"? }` → `Folder`. `DELETE /v1/folders/{id}` → `204` (trash, with its content).
  `POST /v1/folders/{id}/restore` → `Folder`. `DELETE /v1/folders/{id}/permanently?confirm=<id>` → `204`.

## Content

- `GET /v1/docs/{id}/markdown?suggestions=current|critic&comments=none|inline` **public** →
  `{ "seq": 42, "markdown": "…", "title": "…" }`. `current` (default) is the doc as it reads now; `critic` shows pending
  suggestions as `{++inserted++}` / `{--deleted--}`. `comments=inline` adds every open thread after the block it's on:
  `> [!comment t_… by c:saket on "quoted text"] body` (replies follow as `> ↳ si:x: reply`).
  Inline comment notes are for reading: writing them back is refused. Read with `comments=none` before editing.
- `GET /v1/docs/{id}/prosemirror?seq=<n>` **public** → `{ "seq", "doc": <ProseMirror JSON> }` (read-only rendering).
- `POST /v1/docs/{id}/edits` `{ "edits": [{ "old": "exact text", "new": "replacement", "all"?: false }], "suggest"?: false, "expect_seq"?: 42 }`
  → `{ "seq", "markdown", "suggested" }`. Each `old` is exact text from the current Markdown and must appear once (or
  `all: true`). Applied together; the change merges with whatever anyone else is doing. `suggest: true` makes it a
  suggestion; a commenter's change always is one (`suggested` says which it was).
  `expect_seq` atomically requires that content version before applying the complete edit batch;
  a mismatch returns `409 conflict` and makes no change. Re-read and reconsider instead of blindly retrying.
- `PUT /v1/docs/{id}/markdown` `{ "markdown", "base_seq"?, "suggest"? }` → `{ "seq", "markdown", "suggested", "conflicts" }`.
  Writes a whole new version (as a suggestion with `suggest`, and always for a commenter). With `base_seq` (the `seq` the Markdown was read at), only what changed since then is applied,
  merged with everything that happened after: what only one side changed is merged, and a change both sides made the
  same way is made once. Where both changed the same text differently, the doc keeps its text and the written text
  becomes the writer's suggestion on it; each such passage is in `conflicts` as `{ "was", "now", "yours",
  "suggestion" }` (Markdown at `base_seq`, as the doc keeps it, as written; the suggestion's id, which accepting
  applies). The answer is the doc as it reads now, so it doesn't show suggestions (read them with
  `suggestions=critic`).
- Search, backlinks and links reflect a change made through the API as soon as the call answers; typing in the editor
  is indexed within about two seconds.
- `GET /v1/docs/{id}/export?format=md|txt|docx|doc|odt|rtf|html|pdf&seq=<n>` **public** → the file (`Content-Disposition: attachment`).
  A PDF shown as it is downloads as itself in `pdf`, and as its text in the other formats.
- `POST /v1/docs/{id}/assets` (multipart `file`, an image: PNG, JPEG, GIF, WebP or SVG, told by its bytes; anything else
  is `415 unsupported_format`) → `{ "id", "url" }`. `GET /v1/assets/{id}` **public** → bytes, for
  whoever can open a doc that shows (or once showed) the image; the web serves the same at `/assets/{id}`.
- `GET /v1/docs/{id}/backlinks` → `{ "docs": [Doc] }`: docs the caller can open that link here with `[[title]]`.
- `GET /v1/links?title=…` → `{ "doc": Doc | null }`: the doc a `[[title]]` link opens for the caller (by title, case-insensitive).
- `GET /v1/docs/{id}/authorship` → `{ "blocks": [{ "index", "authors": [Account] }] }` (who wrote each top-level block,
  most text first), for anyone signed in who can open the doc.
- `GET /v1/search?q=…` → `{ "results": [{ "doc": Doc, "snippet": "…" }] }`.

## Real time

- `GET /v1/docs/{id}/context` (signed in) → `{ "doc": Doc, "seq", "markdown", "prosemirror",
  "threads", "revisions", "revisions_truncated", "authors": { "accounts": [Account], "blocks": [{"index","authors":[Account]}] },
  "presence", "permissions": {"comments","revisions"}, "cursor" }`. Markdown, ProseMirror and authorship
  come from one captured content version. Threads use the existing full thread shape with anchors,
  current quotes, activity versions and comment authors; null below commenter access. Revisions are
  the latest 100 entries at or before `seq` with author/origin/time; null below editor access. The
  cursor precedes the related reads so subsequent replay cannot miss intervening changes.
- `GET /v1/docs/{id}/events?after=CURSOR` (signed in) → `text/event-stream`, with optional
  `Last-Event-ID` instead of `after`. `GET /v1/docs/{id}/join` is the same stream with real, connection-owned
  presence as the authenticated account. A disconnected body removes that presence; ordinary edit calls
  do not imply an ongoing session. Presence includes only locations actually published by a live editor.
- SSE events are named `snapshot`, `reset`, `document`, `comments`, `meta`, `presence`, `access` or
  `reconnect`. Data is JSON with `type` and event-specific fields. `snapshot`/`reset` contain `context`
  and `cursor`; reset also includes a reason. Document events include `seq`, `origin`, `author_uuid`;
  comment events include action, author, thread/comment IDs and activity version where relevant. Comments
  advance their own event cursor even when content `seq` stays unchanged. Viewers receive no comment events.
- Save the SSE `id` only after handling an event. The opaque cursor is a bounded in-memory room journal,
  not a durable content revision. Valid cursors replay later events; expired, invalid, ahead or prior-epoch
  cursors send `reset` with fresh context. Replay can duplicate changes already present in a snapshot.
  Presence is ephemeral and does not advance the cursor. The server rechecks access during streaming;
  `access` with null role ends the stream. Streams periodically send `reconnect` and close so clients can
  refresh authentication. Clients should resume with backoff after network failure, stop on terminal
  authorization errors, and never retry writes as part of stream reconnection.

- `POST /v1/docs/{id}/live` **public** → `{ "url": "wss://…/v1/live/d_…", "ticket": "…", "expires_at", "role", "account": Account | null }`.
- `GET /v1/live/{id}?ticket=…` (WebSocket): the Yjs sync and awareness protocol (y-websocket messages 0 and 1) on the
  editor's fragment `default`, plus server messages of type `100` carrying JSON:
  `{"type":"authors","clients":{"<client id>":Account}}`, `{"type":"threads"}` (threads changed),
  `{"type":"meta"}` (title, folder or access changed), `{"type":"role","role":"viewer"}`, `{"type":"rejected","reason"}`
  (a change that cannot be accepted; reload). Removing access sends `{"type":"role","role":null}` and closes the
  connection with code `4403`; stop reconnecting until access is granted again.

## Sharing

- `GET /v1/docs/{id}/sharing` → `{ "owner": Account, "public_access", "members": [Member] }` where
  `Member = { "id": "m_…", "account": Account | null, "email": "…" | null, "role", "via": "doc" | { "folder": Folder | null },
  "pending": bool, "invited_by": Account, "created_at" }` (`folder` is null for a folder above the doc the caller can't
  open). Only the owner and the people it's shared with see it, not someone who has only its public link (`403`).
- `POST /v1/docs/{id}/sharing` `{ "to": "c:id" | "si:id" | "email@…", "role": "editor"|"commenter"|"viewer" }` → `Member`
  (`201` when they're new; `200` when they were already invited, which only the owner can do with another role). An
  email that belongs to an account already using Silicon Write shares with that account; any other email becomes a
  pending invitation (and an invitation email) until someone signs in with it. Not for an item in the trash (`409`), not
  by someone who has only the public link (`403`), and a `to` that's neither an id nor an email is `422 invalid`.
- `PATCH /v1/docs/{id}/sharing/{member}` `{ "role" }` → `Member`. `DELETE /v1/docs/{id}/sharing/{member}` → `204`.
- `PUT /v1/docs/{id}/public` `{ "access": "none"|"view"|"comment"|"edit" }` → `Doc` (owner).
- The same under `/v1/folders/{id}/sharing` (no `public` for folders).
- Owner and editors can invite; only the owner can change or remove other people (anyone can remove themselves).

## Transfers

- `POST /v1/docs/{id}/transfer` / `POST /v1/folders/{id}/transfer` `{ "to": "c:id"|"si:id" }` → `Transfer`.
- `GET /v1/transfers` → `{ "incoming": [Transfer], "outgoing": [Transfer] }`.
- `POST /v1/transfers/{id}/accept|decline|cancel` → `Transfer`.
  `Transfer = { "id", "item": { "kind": "doc"|"folder", "id", "title" }, "from": Account, "to": Account, "status", "created_at" }`.

## Comments

- `GET /v1/docs/{id}/threads?status=open|resolved|all` → `{ "threads": [Thread] }` where
  `Thread = { "id", "anchor": Anchor, "quote": "text when it was made", "current_quote": "text now" | null,
  "orphaned": bool, "block_index": n | null, "status": "open"|"resolved", "created_by": Account, "created_at",
  "resolved_by": Account | null, "resolved_at", "activity_version": n, "unread": bool, "comments": [Comment] }` and
  `Comment = { "id", "author": Account, "body": "markdown with @c:id / @si:id", "created_at", "edited_at", "deleted": bool,
  "reactions": [{ "emoji", "accounts": [Account] }] }`.
- `POST /v1/docs/{id}/threads` `{ "anchor": Anchor, "body" }` → `Thread`. Anchors:
  `{ "kind": "text", "start": "<base64 Yjs relative position>", "end": "…", "quote" }` (from the editor),
  `{ "kind": "text", "quote": "exact text" }` (from the CLI: must appear once in the doc's text),
  `{ "kind": "block", "start": "…", "quote"? }` (a whole section),
  `{ "kind": "cell", "start": "…", "quote"? }`, `{ "kind": "image", "start": "…", "rect"?: { "x","y","w","h" } }` (fractions of the image),
  `{ "kind": "pdf", "rect": { "x","y","w","h","page" } }` (an area of a page of a PDF doc).
- `POST /v1/threads/{id}/comments` `{ "body" }` → `Comment`. `PATCH /v1/comments/{id}` `{ "body" }` (author).
  `DELETE /v1/comments/{id}` (author) → kept in history as deleted.
- `POST /v1/comments/{id}/reactions` `{ "emoji" }` → `Comment`: toggles the caller's reaction.
- `POST /v1/threads/{id}/resolve`, `POST /v1/threads/{id}/reopen` → `Thread`.
- `POST /v1/threads/{id}/read` `{ "activity_version": n }` →
  `{ "activity_version": current, "read_version": acknowledged, "unread": bool }` (commenter or above).
  Send the version actually displayed. A request advances the cursor at most to that version; older
  acknowledgements do not rewind it. A newer reply arriving meanwhile remains unread. Negative and future versions are `422 invalid`.
  `unread` is specific to the signed-in account and means activity by someone else after its read cursor.
  A new thread starts at version 1 and is read by its creator. Replies, changed comment text, deletion,
  reaction toggles, resolution and reopening increment the thread's version atomically; repeating an
  unchanged edit, delete, resolve or reopen does not. Own activity does not clear earlier unread activity
  from others. Listing threads does not mark them read. Read state persists across devices; it is separate
  from Ting delivery receipts and document text versions. Existing threads have initial activity at version 1
  because earlier read history was not recorded. Read changes send the usual `threads` live invalidation,
  without disclosing who read the thread or their cursor to other accounts.

## Suggestions

- `GET /v1/docs/{id}/suggestions` → `{ "suggestions": [{ "id", "author": Account | null, "inserted", "deleted" }] }`.
- Suggestions can propose text, formatting, blocks, lists, tables, images, maths and other document structure.
  The current reading stays unchanged until a proposal is accepted; rejecting it restores the original structure.
- `POST /v1/docs/{id}/suggestions/{sid}/accept|reject` (editors) → `{ "seq" }`.
  A decision that would discard another pending suggestion returns `409 conflict`; decide the nested suggestion first.
- `POST /v1/docs/{id}/suggestions/accept-all|reject-all` (editors) → `{ "seq", "count" }`.
  Nested proposals are decided in a safe order within the same saved change.

## Versions and history (editors and owner)

- `GET /v1/docs/{id}/versions` → `{ "versions": [Version] }`, newest first:
  `Version = { "seq", "from_seq", "authors": [Account], "summary": "si:writer edited “Introduction”", "name": "…" | null, "created_at" }`.
- `GET /v1/docs/{id}/versions/{seq}/markdown` → `{ "seq", "markdown" }`. `GET /v1/docs/{id}/prosemirror?seq=` renders it.
- `PUT /v1/docs/{id}/versions/{seq}/name` `{ "name" }` → `{ "seq", "name" }` / `DELETE` → `204`: names a version.
  Naming or removing a name from a trashed doc returns `409 conflict`; restore the doc first.
- `GET /v1/docs/{id}/compare?from=<seq>&to=<seq>` (`to` defaults to the latest) → `{ "from", "to", "blocks": [{
  "change": "same"|"added"|"removed"|"changed", "before"?: "md", "after"?: "md", "before_index"?, "after_index"?,
  "by": [Account], "parts"?: [{ "op": "same"|"added"|"removed", "text", "by"?: Account }] }] }`. `before_index` is the
  block's index in version `from` (what `restore-version` takes as `blocks`).
- `POST /v1/docs/{id}/restore-version` `{ "seq", "blocks"?: [from, to] }` → `{ "seq" }`: the whole version, or only
  top-level blocks `from..to` (inclusive) of that version. Restoring is a new version.
- `POST /v1/docs/{id}/undo` `{ "account": "si:id"|"c:id", "since": <seq> }` → `{ "seq" }`: undoes everything that account
  changed after version `since`, keeping everyone else's changes.
- `GET /v1/docs/{id}/activity`, `GET /v1/folders/{id}/activity` → `{ "events": [{ "id", "kind", "actor": Account, "data", "created_at",
  "undoable": bool, "undone_at" }] }` (event ids are numbers). `POST /v1/activity/{id}/undo` → `{ "undone": true }`:
  undoes a rename, move, delete or create.

## Service

- `GET /healthz`, `GET /readyz`. `POST /v1/webhooks/accounts`: Silicon Accounts updates (signed).
- `GET /v1/dev/outbox` (development only): the emails and notifications that would have been sent.

The web invitation role **Suggester** maps to API role `commenter`: read, comment, and propose changes; only editors and owners may accept or reject.
