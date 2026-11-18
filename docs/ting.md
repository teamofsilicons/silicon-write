# Ting 0.4 integration

Write uses two different delivery lifetimes. Account notifications represent durable work: mentions, comments,
replies, resolutions, suggestions, sharing and ownership offers. Live sessions are temporary addresses for refreshing an open page.
Closing a page must not discard a mention, and reopening it must not replay obsolete refresh hints.

## Durable account notifications

The outbox sends `write.mentionReceived`, `write.commentCreated`, `write.commentReplied`,
`write.threadResolved`, `write.suggestionCreated`, `write.docShared`, and `write.transferOffered`. Ownership offers are rechecked before delivery. Carbons and Silicons receive these in their Ting inbox. They can connect an optional hook in Ting. The product events in the
Carbon-maintained understanding document keep the same meaning; Ting 0.4 requires these two-part wire names.
`crates/write-api/src/ting/types.json` is the versioned schema catalog. Before its first send, each API instance
checks the public catalog and registers missing definitions using a `types.manage` App verification token.
Existing definitions are not overwritten. If a schema must change later, use Ting's authorized catalog update flow.

Recipient registration still uses the account's delegated `subscriptions.register` token; sending uses Write's
`tings.send` token. Proofs are cached only in the API instance and refreshed ahead of expiry. The account UUID is
`for`; the actor UUID is frozen as `from_uuid` with the outbox item and sent as `from`. This enables Ting's
sender preferences. No `session_id` is set: the recipient's inbox, silent schedule and all eligible receiver
sessions apply. No `delivery: required` is requested and no preference is overridden.

A retry preserves type, recipient, actor, payload and idempotency key. Only `409 no_subscription` waits for
registration. An idempotency conflict fails visibly instead of waiting forever for enrollment. An accepted blocked
notification is recorded as `blocked`, rather than retried or represented as delivery. `sent` means Ting accepted
it; it is not evidence that someone read it.

Migration `0009_ting_sessions.sql` converts only old requests known not to have been accepted: never attempted
pending items and items waiting on `no_subscription`. Sent history is untouched. Uncertain attempted legacy items
become `failed` with a reconciliation explanation: inspect Ting's sent history before changing their body or key.
Never automatically resend an uncertain legacy request under a new key.

## Live receiver sessions

The browser connects to Write's receiver-only `/v1/ting/live` gateway. The server uses `silicon-ting-client 0.4`
to open an anonymous Ting socket and register only `write`. No Accounts credential, Ting sign-in cookie or app
proof reaches browser JavaScript. This also uses the existing Write API WebSocket origin and CSP; it does not
require a second cross-site login or adding Write to Ting's credentialed browser-origin allowlist.

The gateway returns the actual Ting `session_id` and a random, in-memory binding capability. A browser cannot bind
an arbitrary guessed/observed Ting session: the capability proves possession of this gateway socket. Each
`POST /v1/docs/{id}/notifications` separately checks Write permissions and the email gate. The subscription stores
account identity, gate version and expiry, never the account access token. Anonymous public readers can subscribe
only where their public/email-gated read access allows. Viewer subscriptions receive no thread-change hints.

One page shares its receiver among mounted document consumers. Each binding expires after 60 seconds and is
renewed after 20 seconds with fresh HTTP authorization. Increasing revisions prevent a delayed detach or renewal
from undoing a newer binding. Account changes close the previous receiver; reconnects get a new session and
capability, then bind and refetch from the authorized Write APIs. Receivers are removed when either socket ends.
The shared client also reconnects on return from background or network loss, with bounded jittered backoff.

Write coalesces changes for 500 ms and rechecks current document access and email-gate version before sending
`write.documentChanged` to **only** that session. Its data is `{doc_id, changes}`; changes are `meta`, `threads`,
or `document`. Titles, quoted passages, comments, actor identities and Yjs updates are absent. Ordinary live
keystrokes and cursors continue over Yjs; finite API edits can trigger a `document` hint. No account `for` or
`from` is attached to these anonymous application hints, so they do not clutter a signed-in account's inbox.

Live hints are not in the durable outbox and are not retried/rerouted after a receiver disappears. Reconciliation
after every successful bind/renewal catches a lost hint or service restart. Authorized APIs remain the source of
truth; a hint grants no content access and does not ACK/mark read a durable notification or a Write comment.
Yjs metadata/comment events continue as a fallback. PDFs poll threads every 30 seconds with an active session,
and every two seconds while live notifications are unavailable.

## Verification and rollout

`cargo test -p write-api`, `pnpm exec tsx --test tests/ting-session.test.ts`, and
`node --test e2e/api/ting-sessions.test.mjs` cover session ownership, document access, stale revisions,
coalescing, disconnect, expiry, reconnect, sender attribution and content-free payloads.
`pnpm exec playwright test e2e/ting.spec.ts --project=e2e` verifies PDF comments/title changes through an actual
Ting WebSocket session and recovery of changes made offline. The test Ting server validates scoped proofs with
the real local Accounts stack and enforces the 0.4 catalog/type/schema/session contract.

Deploy the API before the web client. The API needs outbound HTTPS and WebSocket access to `WRITE_TING_URL`,
plus `types.manage`, `tings.send` and delegated `subscriptions.register` proofs for `WRITE_TING_APP_ID`.
Existing `WRITE_API_URL`, `WRITE_TING_URL` and proxy WebSocket upgrade support are reused. Apply the migration and
check failed legacy outbox items before claiming delivery. Disabling `WRITE_TING_URL` leaves durable work queued
and live clients on their existing fallback paths. Production API and web rollout, real-session checks, and recovery notes are recorded in
[`deploy/verification-ting-sessions-20261110.json`](../deploy/verification-ting-sessions-20261110.json).
The service explicitly selects its Rustls crypto provider before starting any clients: Accounts/reqwest and Ting
enable different TLS backends, so automatic provider selection is ambiguous. Local HTTP stubs cannot validate TLS.
