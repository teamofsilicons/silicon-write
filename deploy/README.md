# Deploying Silicon Write

Nothing here has been deployed yet. This is what a production deployment needs.

## Pieces

- **The service** (`write-api`, `deploy/Dockerfile`): one instance (live rooms are in memory), Postgres 16, a persistent
  volume for uploaded files (`WRITE_DATA_DIR`), behind TLS at `https://api.write.teamofsilicons.com`. Its WebSocket
  (`/v1/live/{doc}`) must pass through the load balancer (idle timeout above a minute).
- **The web editor** (`web/`): Vercel (or `NEXT_OUTPUT=standalone`), at `https://write.teamofsilicons.com`, with
  `APP_ID=write`, `APP_SECRET`, `SESSION_SECRET`, `ACCOUNTS_URL=https://accounts.teamofsilicons.com`,
  `APP_API_URL=https://api.write.teamofsilicons.com`, `PUBLIC_URL=https://write.teamofsilicons.com`.
- **The CLI** (`write`), published in Silicon Apps as the app `write` (the four Linux targets validate today).

## Service settings

| Setting | Production value |
| --- | --- |
| `WRITE_DATABASE_URL` | the Postgres URL |
| `WRITE_APP_SECRET` | the `write` app's secret (`~/.silicon-release/accounts-apps/write/app-secret` on the release machine) |
| `WRITE_TICKET_SECRET` | 48+ random bytes (`openssl rand -base64 48`) |
| `WRITE_API_URL` | `https://api.write.teamofsilicons.com` |
| `WRITE_WEB_URL` | `https://write.teamofsilicons.com` |
| `ACCOUNTS_URL` | `https://accounts.teamofsilicons.com` |
| `WRITE_TING_URL` | `https://backend.ting.teamofsilicons.com` |
| `WRITE_POSTMARK_TOKEN`, `WRITE_MAIL_FROM` | for invitation emails (a Postmark sender for write@teamofsilicons.com) |
| `WRITE_ACCOUNTS_WEBHOOK_SECRET` | from `silicon-accounts app webhook` once the webhook is set to `https://api.write.teamofsilicons.com/v1/webhooks/accounts` |

Run the container where it has no network access except Postgres, Silicon Accounts and Silicon Ting: Pandoc and
LibreOffice read files people upload, and those can name outside resources.

## One-time setup

1. Silicon Accounts (done 2026-10-17): the app `write` exists (owner c:saket) with Google, Apple and email sign-in,
   device flow and public client on, redirect `https://write.teamofsilicons.com/auth/callback`.
2. Silicon Ting: register Silicon Write's notification types under the app, as one of its authors:
   `write.mention.received`, `write.comment.created`, `write.comment.replied`, `write.suggestion.created`,
   `write.thread.resolved`, `write.doc.shared` (`ting types --help`), and allow `write` to send (App verification,
   scope `tings.send`) and register recipients (User verification, scope `subscriptions.register`).
3. DNS for `write.teamofsilicons.com` (the web) and `api.write.teamofsilicons.com` (the service).
4. Silicon Apps: upload the Linux packages of `write` (`apps.yaml` in `crates/write-cli/package/`), release, publish.
