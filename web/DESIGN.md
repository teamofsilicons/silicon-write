# Silicon Write design

Write follows the layout and visual language of [Silicon Writings](https://writings.teamofsilicons.com/p/mv2o9xtfokwzjv6f),
reviewed on 17 October 2026: neutral Silicon UI surfaces, a restrained header, a generous reading column, and notes in the margin.
It keeps Write's document model and operations: private docs, folders, sharing, suggestions, version history, imports,
exports, and collaboration between Carbons and Silicons. The reference's publishing and timeline concepts do not
become Write features.

This guide describes the current design. The source of truth for shared colours and fonts is `styles/tokens.css`;
page composition lives in `components/doc/`, `components/editor/`, `components/library/`, and
`components/foundation/shell/`. The site is light only, with no theme switch and no telemetry.

## Principles

1. **The writing comes first.** Keep the document centered and its title with its text. Navigation and tools should
   leave room for reading rather than surround it with persistent controls.
2. **One quiet header.** Use compact navigation and actions on the paper background. Make the available writing mode
   clear; show formatting by default when writing, with a toggle to tuck it away.
3. **Few boxes.** Lists and conversations use whitespace and hairlines. Menus, dialogs, fields, and floating panels
   have edges; ordinary document content does not look like a card.
4. **A restrained palette.** Ink carries the document and primary actions. Blue carries library titles, links, and
   selection feedback. Status colours convey meaning and always have a text equivalent.
5. **Keep the behavior.** A visual change must preserve roles, keyboard commands, comment anchors, pending
   suggestions, live edits, version history, and file fidelity.
6. **Accessible at every size.** Text contrast, visible focus, readable wrapping, target sizes, and reduced motion
   are requirements, including inside menus and comment composers.

## Document composition

The document has its own frame rather than the library navigation. Its centered reading column is **700 px** wide,
with responsive side gutters. The title and editor share the same left edge. Opening comments must not move the
writing to a different column on a wide screen.

- **Header:** 56 px, sticky, with a back link and quiet connection state on the left. Presence, Format, the mode menu,
  history, Comments, Share, and More sit on the right. Share is an ink-filled primary action. On narrow screens,
  secondary labels and presence collapse; the controls retain accessible names. History remains available in More.
- **Title:** belongs above the body, not inside the header. A small uppercase line identifies the file and its
  visibility or trash state. The title is Hedvig Letters Serif, weight 400, up to **56 px**, with 1.12 line height.
  It scales down on phones and wraps long names. Editors can rename a live doc in place; Enter saves and Escape
  cancels. Read-only docs and PDFs show a static title.
- **Body:** BDO Grotesk at 19 px with 1.7 line height. Paragraphs have room between them. Content headings use BDO
  Grotesk at medium weight; blockquotes use an italic serif and a simple vertical rule. Code retains its monospace
  face and horizontal scrolling where necessary. Tables, images, equations, and imported formatting keep their
  document meaning.
- **Formatting:** visible initially in writing modes. Format toggles the toolbar beneath the header; it can be hidden
  again without changing the document. Keyboard formatting remains available. The link shortcut reveals its
  toolbar anchor before opening the link popover. Formatting is available in Editing and Suggesting when the
  document role allows it, and absent in Reading or Commenting.
- **Modes:** a compact menu replaces the segmented mode selector. Editors have Editing, Suggesting, and Reading;
  commenters have Commenting and Suggesting. Reading and Commenting share the read-only document behavior while
  retaining the appropriate comment permissions. The internal `viewing` value is unchanged.
- **Status:** connection/sync state is in the header. The small footer beneath the document contains word and
  character counts. A connection indicator must reflect the live provider, including connecting, offline, and
  error states; it is not a substitute for persistence checks.

The formatting toolbar remains mounted while collapsed so its keyboard behavior is available. Its height joins
the header height when positioning Find and side panels. Sticky controls must not cover focused content or jump
targets. The page provides a keyboard-visible skip link to its main landmark.

## Comments, suggestions, and side panels

Comments are closed on an ordinary document visit. The header's Comments action opens the full conversation list.
Activating a photo or highlighted passage opens only that thread in a small popover beside its anchor, without
moving the writing. The popover offers **All comments** and Close. A `?thread=` deep link or a newly posted comment
opens the same focused conversation; missing or deleted anchors retain the conversation and its original quote.

At wide desktop sizes, comments occupy the right margin beside the centered document. Below 1440 px, the panel
becomes a floating surface; at phone widths it becomes a bottom panel. Each layout keeps its close control visible,
scrolls long conversations within the panel, and leaves the document available. Version history and backlinks use
the same panel placement, with wider space for version detail where needed.

A thread is a flat conversation: a quoted passage with a blue rule, small author photo and name, readable comment
text, and compact reply, resolve, edit, and reaction controls. Hairlines separate threads. The shared
`CommentThread` component opts into `presentation="margin"`; other consumers retain its default card treatment.
Open and Resolved use quiet underlined selectors while retaining their keyboard behavior.

Open comments have a small profile photo beside their anchor in the document. The photo belongs to the first
remaining comment's author (or the thread creator if all comments were deleted), and opens the conversation.
Its **2 px border** uses `--accent` for unread activity and `--border-strong` once read. Read state is saved per
account by the service; fetching a document never marks its conversations read. A visible conversation
acknowledges only the activity version it displayed after every comment has been visible. A later reply or edit
from another account makes the border accent again. Own activity does not clear earlier unread activity.
The former yellow section marks are absent; selected text receives a quiet accent tint while its thread is open.
Phones reserve a narrow photo gutter so the controls remain visible without overlapping the writing.

- Quotes are actual buttons that reveal their anchors in the document. Orphaned anchors explain that the original
  text was deleted; a visual update never silently attaches them to another copy of the same words.
- Previous/next controls and J/K navigate threads. Empty lists disable previous/next. Navigation does not consume
  typing in an editor or comment field.
- Selecting text in Reading or Commenting opens the composer; Editing offers a Comment button and the comment
  keyboard shortcut. The composer preserves mentions, Enter to post, Shift+Enter for a new line, and Escape to
  cancel. Its height and width stay within the viewport, including when the keyboard or a long quote reduces room.
- Suggestions remain reviewable in the Comments panel. Their previews reveal the proposed changes. Authorized
  editors can accept or reject one proposal or all proposals; commenters cannot approve their own changes.
- Scrolling to a thread or suggestion respects reduced motion. PDF deep links wait until the target page is ready
  and must not pull the reader back after they scroll elsewhere.

## Library and navigation

The desktop library uses a **56 px horizontal header**, with the wordmark and My docs, Shared with me, Recent,
Search, and Trash on the left, and search/account actions on the right. Docs remains a direct resource link; the
command palette also reaches the Apps store. Below 900 px, navigation moves into the existing menu drawer. The
account menu, sign-out behavior, and ⌘K / Ctrl+K palette retain their existing operations.

The library and search use a scoped **720 px content column**, centered on the page with roughly 32 px of space
below the header. This does not change the shared `Page` primitive's widths for unrelated pages.

- A small uppercase eyebrow precedes a blue Hedvig title at 48 px, then an 18 px description. Phones use smaller
  type and side gutters.
- New doc is the ink primary action. New folder, Open files, Open folder, and applicable sharing actions remain compact and
  accessible near the heading. Folder breadcrumbs wrap long names without pushing actions off screen.
- Documents are an airy list, with 24 px serif titles and smaller metadata below. Rows have hairlines rather than
  card frames. Long titles and account ids wrap. Document icons do not repeat on every row; PDFs have a type label
  and folders retain a distinct folder glyph.
- Existing permissions and actions remain intact: rename, move, copy, share, ownership transfer, import, trash,
  restore, and permanent deletion. Trash actions wrap on phones and keep the hold-to-confirm safeguard.
- Search uses the same heading and reading width. Snippets wrap, mark matching text, and open the result without
  a delayed query update cancelling navigation.

The homepage combines your root docs and folders with items shared with you, deduplicated and ordered by name for
folders and last edit for docs. Shared items identify their owner; their existing permissions still determine actions.
Opening a folder shows its contents, without mixing in unrelated shared docs.

Document selection controls appear on row hover or keyboard focus, and stay visible while a selection is active.
The select-all and **Open selected** toolbar appears only after selecting a doc. Cmd/Ctrl-click toggles individual
docs; Shift-click selects a range. A row's menu also offers selection for touch, and an ordinary title click opens
the doc. The selection applies to the current library view and never includes trashed documents. Opening several docs adds them to one horizontal tab
strip. Each tab names its document, shows which one is active, and has a separate close control. Long names truncate
within the strip; the strip scrolls horizontally rather than widening the page. Keyboard navigation must leave
normal document editing shortcuts intact.

Open tab metadata is kept for the current account and browser tab, including across visits to the library. Document
contents are not stored with tab titles. Each tab is one rounded surface, including its close control; the active tab joins the document. A + beside the strip opens a searchable document picker without leaving the editor. Tab arrows are omitted; tab and picker shortcuts remain visible on hover. Alt+PageUp/PageDown switches while writing (Option+Fn+Up/Down on Mac keyboards). Alt/Option+Shift+1–8 selects a document tab, 9 selects the last, and O opens the picker. Alt/Option+Shift+Left/Right switches outside editable fields; unmodified arrows activate tabs when the strip has focus. Editors load when visited; switching between open tabs keeps their live
document state, including edits waiting for the connection to return. Closing a tab never deletes its document.

**Open files** accepts multiple supported files. **Open folder** imports the selected folder and its nested structure
into the current library location. Hidden/system files and unsupported formats are skipped with a visible reason.
An import shows progress, preserves completed documents when another file fails, and offers opening the imported
docs together in tabs. Stopping finishes the current file; continuing retains completed documents and folder IDs.
An unconfirmed server response must never be silently retried in a way that could create duplicates.

## Colour and type

Use semantic tokens rather than reproducing palette values in each component. Scoped comment surfaces may tune
these tokens to match the reference, but every foreground/background pair must still meet its contrast target.

| Token | Light value | Use |
| --- | --- | --- |
| `--background` | `var(--neutral-0)` | Neutral white page |
| `--surface` | `#FFFFFF` | Fields and raised conversation surfaces |
| `--surface-muted` | `var(--neutral-2)` | Quiet fills and hover feedback |
| `--surface-pressed` | `var(--neutral-3)` | Selected and pressed fills |
| `--foreground` | `var(--neutral-11)` | Body text, important icons, ink actions |
| `--text-secondary` | `var(--neutral-8)` | Descriptions and secondary content |
| `--text-muted` | `var(--neutral-8)` | Hints, timestamps, and placeholders; AA contrast for small labels |
| `--border` / `--border-subtle` / `--border-strong` | `oklch(93.5% 0 0)` / `oklch(96.5% 0 0)` / `oklch(82% 0 0)` | Edges and hairlines |
| `--accent` / `--accent-ink` | `#1F5CB1` | Links, library titles, selected content |
| `--success` / `--warning` / `--danger` | `#2B7148` / `#8F560D` / `#B42318` | Status and review meaning |

**Hedvig Letters Serif** is the title and quotation face, always weight 400. **BDO Grotesk** is the interface and
reading face. **Geist Pixel Square** is used for the wordmark and small library labels. Fonts are self-hosted with
their licenses under `public/fonts/`; code uses the monospace stack.

The document title is ink; the library title is blue. Keep document headings semantically faithful to the content,
with one separate page title. Use tabular numerals where counts or dates need alignment. Interface emphasis is
usually weight 500; do not simulate a bold weight for Hedvig.

## Shape, spacing, and controls

Use the shared 4 px spacing scale for composition. The document and comment controls use smaller, restrained
corners, generally 6 px, while dialogs and larger panels retain the shared geometry. Current shared panel and
surface radius tokens are 14 and 18 px. Do not restore the former oversized rounded cards or sidebar layout.

Rounded surfaces use the Silicon squircle system (`data-sq` and `--sq-*`) or the component's native corner-shape
support. Photos use the shared avatar treatment. Resting lists need no shadow; floating menus, dialogs, composers,
and panels may use the floating shadow. Focus changes the painted fill or edge, not a decorative outer ring.

Use compact buttons in headers, toolbars, and rows; larger controls belong in forms. Every icon-only action needs
an accessible name. Targets are at least 24 × 24 px and should be larger on touch screens. New doc, Share, and
comment submission use ink primaries in their respective contexts; secondary actions use an outline or quiet text.
Destructive operations keep their existing confirmation behavior and never become the primary action.

## Motion and accessibility

Motion clarifies a change rather than decorating the page: a menu appears from its trigger, an inline title becomes
an editor in place, and the selected drawer item can move between destinations. All transitions and scroll effects
respect reduced motion. There is no theme animation because there is no theme choice.

- Normal text, including placeholders and tiny timestamps, needs at least 4.5:1 contrast. Check scoped tokens against
  actual field fills as well as the page. Do not rely on a colour's contrast against white alone.
- Keyboard focus is always visible through a fill, edge, or underline. Each page has a main landmark, a skip link,
  and labelled navigation or complementary panels where appropriate.
- Visible control labels appear in their accessible names. Menus preserve their standard keyboard behavior; hidden
  toolbars and responsive labels must not leave unreachable or unnamed controls.
- Fields expose their names, errors, and hints. Errors explain what happened and how to recover. Connection state
  uses a quiet status announcement rather than repeated alerts.
- Test 1440 px and 390 px layouts, long titles and ids, empty states, loaded documents, dialogs, and reduced motion.
  A dark device preference must still receive the light site. Only deliberately scrollable document content, such
  as code or a wide table, may overflow its reading area.

## Copy and accounts

Use Carbons and Silicons, and their public `c:` / `si:` ids. Never expose a UUID as the account's name. Show a known
display name and profile photo, with Carbon or Silicon where the kind matters. Sharing targets exact accounts or
email invitations and follows the service's permission rules.

Use sentence case and concrete action labels: New doc, Open files, Move to the trash. Do not borrow publishing
terms from Writings for Write operations. Errors state what failed, why, and the next action. Relative dates work
in library rows; detailed timestamps belong in version history and other detailed views.

## Validation when changing the design

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`, then verify the affected journeys in the real browser against the
local stack. Check writing, formatting, keyboard links, mode changes, selection comments, image/PDF comments,
suggestion decisions, title editing, folder navigation, sharing, and responsive overflow as appropriate to the diff.
Backend persistence and raw document round trips remain separate evidence from visual success.

Tests should follow the intended controls: open Format before clicking a toolbar tool; choose a mode through its
menu; open Comments when reviewing an existing thread or proposal; read sync state from the header's status element.
Keep assertions that readonly roles cannot edit or approve proposals. Do not change a test merely to accommodate a
lost operation or a regression.

## Sharing

The Share dialog has a compact **Share** heading and the document or folder title as its subtitle. Its desktop
width is 560 px; phones keep side gutters and place the invitation field on a full row above the role and Share
controls. Share remains an ink primary action. Member rows use small profile photos, readable names and ids,
hairlines, and quiet role controls. Redundant role labels stay available to assistive technology without taking
visible space.

Link access is a separate section with concise permission copy and Copy link. Only owners can change public
access or other members’ roles; inherited access stays read-only. Ownership transfer is tucked into a collapsed,
owner-only **Transfer ownership** disclosure and still requires the recipient to accept. Link-only visitors never
see membership. Long titles and identities wrap without pushing controls outside the dialog.


### Selection and suggestion review

Double-clicking text or right-clicking in the document opens a Silicon UI text menu. It retains the editor selection
for copying, formatting, and comments; permission checks hide writing actions from readers. Escape returns focus to
the editor, while an outside click keeps focus at its destination. The insert menu tracks the typed slash as the page
scrolls, flips above the caret near the lower edge, and scrolls its own options without scrolling the page.

Invitations label the existing `commenter` permission **Suggester**: it permits comments and proposed edits, never direct
edits or review decisions. Suggesters start in Suggesting mode. Clicking suggested text opens an anchored review card;
editors accept or reject there or through the visible Suggestions action. Decisions await acknowledgement of local
edits and disable duplicate submissions. The accepted text becomes ordinary content through the existing service API.
