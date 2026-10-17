# Silicon Write web editor

The web editor of Silicon Write (write.teamofsilicons.com): Next.js 16, React 19, TypeScript, Silicon UI, and Tiptap 3
with Yjs for live editing. Light only. The product contract is `../understanding/UNDERSTANDING.md`; the service's API is
`../docs/api.md`.

The site is a BFF: Silicon Accounts tokens stay in a sealed, HttpOnly cookie and the browser never holds one. Pages call
the service through `/api/*` (`app/api/[...path]/route.ts` adds the bearer token; a public doc's read routes go through
without a session). The live editor gets a short-lived ticket from the service and opens its WebSocket directly
(`lib/write/live.ts`); the CSP's `connect-src` allows the service's origin (`LIVE_ORIGIN`, default `APP_API_URL`).

## Run locally

Node 24 or later and pnpm 10.33. `.env.local` needs `APP_ID=write`, `APP_SECRET` (the local `write` app's secret),
`ACCOUNTS_URL=http://localhost:9890`, `ACCOUNTS_API_URL=http://127.0.0.1:9889`, `APP_API_URL=http://127.0.0.1:4371`,
`SESSION_SECRET` (32+ random bytes), `PUBLIC_URL=http://localhost:4370`, `EXTRA_IMG_ORIGINS=http://127.0.0.1:9894`.
Start the local Accounts stack and the service first (see `../README.md`).

```sh
pnpm install --frozen-lockfile
pnpm dev                       # http://localhost:4370
```

## Checks

```sh
pnpm typecheck && pnpm lint && pnpm build
pnpm exec playwright test      # Chromium, against the real local stack; its own server on :4380
```

The browser tests sign Carbons in through the real hosted pages of the local Accounts stack (codes from its mock
mailbox), and drive the real service.

## Where things are

- `app/(workspace)/`: the library (My docs and folders, Shared with me, Recent, Search, Trash).
- `app/d/[id]`: a doc; `components/doc/` (the page, top bar, toolbar, comments, versions, sharing, PDFs) and
  `components/editor/` (the Tiptap editor: schema, suggestions, comment anchors, footnotes, doc links, contents, find,
  the `/` and `[[` menus). The schema must match the service's doc model node for node.
- `app/docs`: the command-line guide (`content/cli-guide.md`, synced from `../crates/write-cli/src/guide.md`).
- `components/silicon-ui/`: Silicon UI, vendored (`node scripts/vendor-ui.mjs <name>`; `silicon-ui-registry.json`).
