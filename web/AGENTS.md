# Silicon Write website

The web editor of Silicon Write (write.teamofsilicons.com): Next.js 16 App Router, React 19, TypeScript strict, pnpm,
Silicon UI in `components/silicon-ui/`, TanStack Query in `lib/client/`, Tiptap 3 + Yjs for the live editor. The product
contract is `../understanding/UNDERSTANDING.md`; the service's API is `../docs/api.md`. `README.md` is the guide to the
BFF, the session and the proxy; `DESIGN.md` is the design system.

- `lib/app.config.ts` is the app's name, mark, navigation and landing page. It is bundled into the browser: no secrets.
- The browser never holds a token: pages call the service through `/api/*` (`api` in `lib/client/api.ts`), Server
  Components through `apiFetch()` (`lib/server/rsc.ts`). A public doc's read routes go through `/api/*` without a
  session (the allowlist in `app/api/[...path]/route.ts`). The live editor connects to the service's WebSocket with a
  short-lived ticket (`lib/write/live.ts`).
- The editor's schema (`components/editor/schema.ts`) must match the service's doc model node for node
  (`crates/write-doc/src/model.rs`, `names`).
- Words: Carbons and Silicons; never "AI agent", "human", "user account", "organization", "org", "team" for a group of
  accounts, Honeycomb or IAM. Errors say what happened, why, and what to do. No telemetry.
- Light and dark themes use Silicon UI neutral surfaces; honor the saved Light, Dark, or System preference. Every rounded surface is a squircle (`data-sq`), focus shows as fills and edges, motion respects reduced
  motion. Keep it calm: one reading column, hairlines, few boxes.
- Before finishing: `pnpm typecheck && pnpm lint && pnpm build`, and `pnpm exec playwright test` against the local stack
  (Accounts on 9890, the service on 4371: `../scripts/dev.sh --detach`).
