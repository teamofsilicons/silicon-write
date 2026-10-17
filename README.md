# Silicon Write

Docs for Carbons and Silicons: write, read and comment on docs together, in real time, with every version kept.
The product contract is [`understanding/UNDERSTANDING.md`](understanding/UNDERSTANDING.md) (Carbon-edited only). The
service's HTTP API is [`docs/api.md`](docs/api.md).

| Part | Where | What |
| --- | --- | --- |
| `crates/write-doc` | Rust library | The doc model (node for node the editor's schema), exact Markdown in and out, every other format through Pandoc's tree, the live Yjs form and minimal patching, history and per-account undo. |
| `crates/write-api` | Rust service (`write-api`) | The API behind the web editor and the CLI: docs and folders, sharing, live editing over y-websocket, comments, suggestions, versions, formats, notifications through Silicon Ting. Postgres. |
| `crates/silicon-write-client` | Rust library | A typed client for every route of the API. |
| `crates/write-cli` | Rust CLI (`write`) | Everything the web editor can do, for Silicons (and Carbons): Markdown reads, exact edits, pull/push of a folder of `.md` files, comments, suggestions, versions, sharing. `write docs` prints the guide. |
| `web/` | Next.js 16 | The web editor (write.teamofsilicons.com): the library, the Tiptap + Yjs live editor, comments, suggestions, versions, sharing, PDFs. Built with Silicon UI. Light only. |
| `e2e/` | Node | End-to-end suites against a real local stack (`e2e/api/*.test.mjs`), the identity helpers (`e2e/lib/stack.mjs`) and a local Silicon Ting stand-in (`e2e/ting-stub.mjs`). |

## How it fits together

- **Sign-in** is Silicon Accounts throughout. The web is a BFF: the browser holds a sealed session cookie, never a
  token; the web's server calls the service with the account's access token. The CLI signs Carbons in with the device
  flow and Silicons with a short-lived token (`silicon-accounts login --app write | write login --token-stdin`).
- **A doc's text is a Yjs document** in exactly the layout the editor's Yjs binding uses (y-prosemirror through
  Tiptap). Every open doc is one in-memory room in the service; every change anyone makes is stored, in order, as the
  update its transaction made, with its author (`doc_updates`), and every Yjs client id belongs to one account
  (`doc_clients`). That is what versions, comparisons, "who wrote what" and per-account undo read. Nothing is ever
  thinned out.
- **Silicons edit Markdown.** The service reads a doc as Markdown, applies exact replacements (or a whole new version
  written from an older one, merged with everything since), and turns the result into the smallest set of Yjs edits,
  so concurrent changes merge and comment anchors stay on their text.
- **Comments** are anchored by Yjs relative positions (or found by a quote, from the CLI), so they follow their text.
- **Notifications** go through Silicon Ting only: accounts are registered as recipients with a User verification proof
  (scope `subscriptions.register`), and the service sends with its App verification proof (scope `tings.send`) from a
  durable outbox.
- One service instance serves a doc at a time (rooms live in memory).

## Running it locally

You need Rust, Node 24+, pnpm, Postgres 16 (Homebrew `postgresql@16`), Pandoc, LibreOffice and poppler
(`pdftotext`), and the local Silicon Accounts test stack:

```sh
# 1. Silicon Accounts on its own ports (site :9890, API :9889, its Postgres :5471), from the silicon-accounts checkout:
ACCOUNTS_PORT=9890 ACCOUNTS_API_PORT=9889 MOCK_OIDC_PORT=9891 MOCK_MESSAGING_PORT=9892 FAKE_APPS_PORT=9893 \
MOCK_IRIS_PORT=9894 ACCOUNTS_PGPORT=5471 ACCOUNTS_PGDATA=$HOME/.silicon-write-test/pg \
ACCOUNTS_DB_NAME=silicon_accounts_write CARGO_TARGET_DIR=target/integration scripts/dev.sh --developer=off --detach
#    then register `write` and a stand-in `ting` there (secrets in ~/.silicon-write-test/apps.json):
target/integration/debug/accounts-seed --fake-apps ~/.silicon-write-test/apps.json

# 2. The local Ting stand-in and the service (scripts/dev-env.sh has every setting):
. scripts/dev-env.sh && node e2e/ting-stub.mjs &
scripts/dev.sh --detach            # write-api on http://127.0.0.1:4371, its database silicon_write on :5471

# 3. The web editor (web/.env.local holds APP_SECRET, SESSION_SECRET, the URLs):
cd web && pnpm install && pnpm dev # http://localhost:4370

# 4. The CLI:
cargo build -p write-cli && ./target/debug/write --api-url http://127.0.0.1:4371 --accounts-url http://localhost:9890 login
```

## Tests

```sh
cargo test -p write-doc                      # the doc engine (Markdown, formats, Yjs, history)
node --test e2e/api/                         # the API, live editing, comments, versions and formats, end to end
crates/write-cli/e2e/e2e.sh                  # the CLI, end to end (needs node and jq)
cd web && pnpm exec playwright test          # the web editor in Chromium (its own server on :4380)
```

All of them run against the real local stack: real Carbons signed up through Silicon Accounts' own sign-in, Silicons
created by them, real proofs checked by the Ting stand-in.

## Configuration (the service)

`WRITE_DATABASE_URL`, `WRITE_APP_SECRET`, `WRITE_TICKET_SECRET` (32+ characters) are required. Optional:
`WRITE_BIND` (127.0.0.1:4371), `WRITE_API_URL` (its public URL; live connections use it), `WRITE_WEB_URL` (links in
notifications and emails, image addresses), `ACCOUNTS_URL`, `WRITE_APP_ID` (write), `WRITE_DATA_DIR` (uploaded files),
`WRITE_TING_URL` and `WRITE_TING_APP_ID` (notifications wait in the outbox until Ting is set), `WRITE_POSTMARK_TOKEN`
and `WRITE_MAIL_FROM` (invitation emails), `WRITE_ACCOUNTS_WEBHOOK_SECRET`, `WRITE_PANDOC`, `WRITE_SOFFICE`,
`WRITE_PDFTOTEXT`, `WRITE_ENVIRONMENT=development` (only for local development: the outbox page, plain-HTTP Accounts).

In production, run Pandoc, LibreOffice and pdftotext where they have no network access: files people open can name
outside resources.

No telemetry anywhere.
