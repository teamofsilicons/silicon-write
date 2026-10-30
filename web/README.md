# Silicon Write web editor

The web editor of Silicon Write (write.teamofsilicons.com): Next.js 16, React 19, TypeScript, Silicon UI, and Tiptap 3
with Yjs for live editing. Light, Dark, and System appearance choices. The product contract is `../understanding/UNDERSTANDING.md`; the service's API is
`../docs/api.md`.

The site is a BFF: Silicon Accounts tokens stay in a sealed, HttpOnly cookie and the browser never holds one. Pages call
the service through `/api/*` (`app/api/[...path]/route.ts` adds the bearer token; a public doc's read routes go through
without a session). The live editor gets a short-lived ticket from the service and opens its WebSocket directly
(`lib/write/live.ts`); the CSP's `connect-src` allows the service's origin (`LIVE_ORIGIN`, default `APP_API_URL`).

## Run locally

Beautiful PDF exports use the existing HTML export and a network-isolated Chromium renderer with Write's shared CSS and embedded fonts. `GET /api/v1/docs/{id}/beautiful-pdf?theme=light|dark` applies the same document permissions and email-view grants as other downloads. Linux deployments bundle `@sparticuz/chromium`; macOS development uses installed Google Chrome. Set `WRITE_PDF_CHROME_PATH` to use another local Chrome/Chromium executable. The PDF response streams directly, and the renderer closes when the download completes or is cancelled. Export appearance does not change the saved site theme.

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

## Durable browser sessions

`lib/server/refresh-store.ts` and `refresh-state.ts` hold the current session and a random refresh operation key before
calling Accounts. A compare-and-set update prevents late responses from overwriting newer tokens or a saved sign-out.
Existing sealed cookies are adopted atomically. Cookies remain HttpOnly and encrypted; server state is encrypted with
`SESSION_SECRET`, with a separate purpose for each record. Keep that secret stable across deployments.

Production requires either `REFRESH_STATE_TABLE` plus `REFRESH_STATE_REGION` (DynamoDB, consistent reads and conditional
writes), or `REFRESH_STATE_PATH` on a durable, private local volume shared by all web processes on one host. Vercel
requires DynamoDB; `REFRESH_STATE_ROLE_ARN` selects an app-specific Vercel OIDC role with GetItem/PutItem permissions.
EC2 can use its instance role. Never share a development store with production. Development defaults to
`.dev/refresh-state.sqlite`; its parent directory and database are private. Configure DynamoDB TTL on `expires`.

Storage failures, transport failures, 5xx and recovery conflicts preserve the session and return a retryable error.
Recovered absolute access-token expiry is respected, including zero remaining lifetime: the successor is saved before
rotating again. Only a definitive `invalid_grant` ends the sign-in. Sign-out is saved before the cookie is cleared.
Tests in `tests/refresh-recovery.test.ts` cover competing refreshes, process restart, lost replies, expired recovery,
stale cookies, storage failure and sign-out racing a refresh. All replicas must use this protocol before traffic is
switched; do not roll back to the old token-refresh code once these sessions are in use.
