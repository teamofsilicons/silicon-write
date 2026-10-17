# Deploying Silicon Write

Silicon Write is deployed at <https://write.teamofsilicons.com>. The API is at
<https://api.write.teamofsilicons.com>. See `production.json` for deployed revisions and verification,
and `identity-release-20261017.json` for Accounts, Ting and the published CLI receipts.

## Pieces

- **The service**: one dedicated Ubuntu 22.04 ARM64 EC2 instance in `us-east-2` (live rooms are in memory),
  PostgreSQL 16, and persistent uploaded files on encrypted storage. Caddy terminates TLS and proxies HTTP and
  WebSockets to the loopback API. `stack.json` defines the infrastructure; `install.py` installs immutable,
  checksum-verified releases and systemd services. Administration uses SSM; only ports 80 and 443 are public.
- **The web editor** (`web/`): Vercel project `silicon-write-web`, at `https://write.teamofsilicons.com`, with
  `APP_ID=write`, `APP_SECRET`, `SESSION_SECRET`, `ACCOUNTS_URL=https://accounts.teamofsilicons.com`,
  `APP_API_URL=https://api.write.teamofsilicons.com`, `PUBLIC_URL=https://write.teamofsilicons.com`.
- **The CLI** (`write`): version 0.1.0 published in Silicon Apps for Linux x86_64, aarch64, i686 and armv7hf.

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

The API uses the wrappers installed under `/opt/silicon-write/current/converters`. Each converter runs in a
Bubblewrap network/PID/mount namespace with a cleared environment, read-only runtime files, and only its temporary
working directory writable. LibreOffice requires its public configuration and user/group databases inside that
sandbox. Conversions are serialized and capped at 2 GiB address space and 512 MiB output; the API imposes a timeout.
The application service itself retains network access for Accounts, Ting and Postmark.

## Identity and DNS

1. Silicon Accounts (done 2026-10-17): the app `write` exists (owner c:saket) with Google, Apple and email sign-in,
   device flow and public client on, redirect `https://write.teamofsilicons.com/auth/callback`, and optional email.
   Its active Accounts webhook points to `/v1/webhooks/accounts` on the API origin.
2. Silicon Ting: the following types are registered:
   `write.mention.received`, `write.comment.created`, `write.comment.replied`, `write.suggestion.created`,
   `write.thread.resolved`, `write.doc.shared`. Sending uses App verification with `tings.send`; recipient enrollment
   uses User verification with `subscriptions.register`. Registration and proof issuance are verified; notification
   delivery has not been tested by sending to other people.
3. Namecheap DNS: `write` CNAME points to `7365698a83a53afa.vercel-dns-017.com`; `api.write` A points to `3.146.142.123`.
   `dns.py` defaults to a dry run, snapshots the zone privately, preserves unrelated records and mail mode,
   and checks for changes immediately before applying. DNS changes must use the current verified provider targets.
4. The shared Postmark server token is valid. The configured sender is `Silicon Write <write@teamofsilicons.com>`;
   sender-domain authorization and invitation delivery remain unverified. No test email was sent.

## Releasing the API

1. Verify `aws sts get-caller-identity --profile silicon-production`; the deployment account is `234951665042`.
   Specify `--region us-east-2` for all infrastructure commands.
2. Run the relevant code tests and `python3 -m unittest discover -s deploy -p 'test_*.py'`.
   Build with `cargo zigbuild --locked --release --target aarch64-unknown-linux-gnu.2.34 -p write-api`.
   Ensure Zig is on PATH; the local default target is not the production host architecture.
3. Commit tracked changes. Place verified upstream artifacts in the private `.dev/production` directory, then run
   `python3 deploy/package.py`. It verifies pinned Pandoc and Caddy checksums, records every bundled file hash, and
   produces `<full-revision>.tar.gz` plus `release.json`. It refuses uncommitted tracked changes.
4. Upload the archive to the private production bucket's `releases/` prefix and wait for completion. Through SSM,
   download it, verify the archive SHA-256 **before extracting the installer**, and run `install.py` with the exact
   revision, digest, runtime secret ARN, bucket and region. The installer also verifies every bundled file.
5. Verify public HTTPS readiness, signed-in document operations, live WebSocket persistence, and Word/PDF conversion.
   Local unit tests and a sign-in page alone do not establish production completion.

The production instance is `i-0797508582b5e8d9e`. Runtime configuration is fetched from Secrets Manager
`silicon-write/production/runtime` into a root-readable environment file. Never commit secrets or put them into SSM
command text. The installed revision and previous release are recorded in `/etc/silicon-write/deployed.json`.
Source history is also backed up as a private Git bundle in the production bucket; this checkout has no Git remote.

## Backups and recovery

`silicon-write-backup.timer` runs hourly. `backup.py` takes a PostgreSQL snapshot while briefly holding locks that
keep document/asset references consistent with the file archive, then uploads both checksummed files and a receipt
to `silicon-write-production-backups-qgkxwl8wkwl0/backups/`. The private bucket is encrypted and versioned with
14-day backup retention; completed local backups are retained for three days. The host can write backups but cannot
read them back; recovery uses the deployment role. Backup object access is not public.

An upgrade first creates a predeployment database/files backup and copies the current configuration. It retains the
previous immutable release. If readiness fails, the installer stops the failed service and retains those artifacts;
it does not automatically roll back database migrations. Inspect schema compatibility before switching the `current`
symlink back. Restore a downloaded backup into an isolated database first, verify both SHA-256 values and referenced
asset files, and only perform a production data restore as a separately planned recovery operation.

The release verification restored a backup downloaded from S3 into a temporary database and checked its asset files.
See the production receipt for the exact backup, document/asset counts and scope of verification.
