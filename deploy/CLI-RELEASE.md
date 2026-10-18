# Releasing the Write CLI

The CLI package version is the workspace version in `Cargo.toml`. Keep
`crates/write-cli/package/apps.yaml` in sync. Publishing a new CLI release is separate
from deploying the API or web editor. The CLI crate has `publish = false`; this flow
distributes executable packages through Silicon Apps, not crates.io.

## Current publication boundary

Read-only checks on 2026-10-18 confirmed that Write 0.1.0 remains public with four
Linux targets. Its production release is `4138ff02-2fd0-4834-88b2-f9c527549d68`,
promoted from `b5ef0577-39a5-4726-9079-900cdcc955a4`. The original package bytes,
source receipts, runner checks and public download checks are retained in
`~/.silicon-release/accounts-apps/write/cli-0.1.0/` and summarized in
`identity-release-20261017.json`.

The live Apps service now requires `linux-x86_64`, `windows-x86_64` and
`macos-aarch64` in every new development release and production promotion. Preserve
the existing four Linux targets too, for a total of six packages. These are two
separate gates:

- Release creation and promotion reject missing required targets with HTTP 400
  `required_targets_missing`. `silicon-apps readiness write --json` currently reports
  both existing channels missing Windows x86_64 and macOS aarch64. This does not
  withdraw the existing public release.
- Public upload validation currently has live runners only for the four Linux
  targets. For a target absent from `runner_targets`, the service rejects upload at
  the runner stage with HTTP 503 `dependency_unavailable`. A successful local build
  or local `validate` cannot produce an accepted package ID for that target.

This was checked against live `capabilities` and `readiness`, the Apps service's
`validate_package` and release policy, and its
`deploy/verification-required-targets-2026-10-18.json` live rejection receipt.
No new Write upload or release was attempted. Recheck the public runner state before
publication; retain prepared packages if the prerequisite remains unmet. The Apps
operator helper `publish-first-party.py` is restricted to Silicon Apps and Silicon
Accounts and is not a Write publication path.

## Build inputs and targets

Finish the implementation and checks, then record a clean source commit before
building release artifacts. Use a fresh output directory; do not replace the 0.1.0
receipts. The previous Linux build used Zig 0.15.2, Rust musl targets, and
`cargo zigbuild --locked --release -p write-cli --bin write`.

| Apps target | Rust target | Build command prefix | Executable |
| --- | --- | --- | --- |
| linux-x86_64 | x86_64-unknown-linux-musl | cargo zigbuild | write |
| linux-aarch64 | aarch64-unknown-linux-musl | cargo zigbuild | write |
| linux-i686 | i686-unknown-linux-musl | cargo zigbuild | write |
| linux-armv7hf | armv7-unknown-linux-musleabihf | cargo zigbuild | write |
| macos-aarch64 | aarch64-apple-darwin | cargo build | write |
| windows-x86_64 | x86_64-pc-windows-msvc | cargo xwin build | write.exe |

On the release Mac all six Rust targets are installed. `cargo-xwin` 0.23.1 and its
cached x86_64 CRT/SDK are present. `clang-cl` is in `/opt/homebrew/opt/llvm/bin` and
`lld-link` in `/opt/homebrew/bin`; add both to PATH for Windows compilation. The
previous Zig 0.15.2 executable is in
`~/.local/share/uv/tools/ziglang/lib/python3.14/site-packages/ziglang/`;
the separate cargo-zigbuild environment contains Zig 0.16.0. Set PATH explicitly and
record `zig version` instead of silently changing the Linux toolchain. These are
toolchain prerequisites, not proof that the new version builds or runs.

From the repository root, after the source is ready:

```bash
export PATH="$HOME/.local/share/uv/tools/ziglang/lib/python3.14/site-packages/ziglang:/opt/homebrew/opt/llvm/bin:/opt/homebrew/bin:$PATH"
zig version
rustc --version
cargo xwin --version
git diff --quiet
git diff --cached --quiet
git rev-parse HEAD

cargo zigbuild --locked --release -p write-cli --bin write --target x86_64-unknown-linux-musl
cargo zigbuild --locked --release -p write-cli --bin write --target aarch64-unknown-linux-musl
cargo zigbuild --locked --release -p write-cli --bin write --target i686-unknown-linux-musl
cargo zigbuild --locked --release -p write-cli --bin write --target armv7-unknown-linux-musleabihf
cargo build --locked --release -p write-cli --bin write --target aarch64-apple-darwin
cargo xwin build --locked --release -p write-cli --bin write --target x86_64-pc-windows-msvc
```

Retain build logs and a `source.json` per target containing the full source commit,
Rust target, actual build command, toolchain versions, Cargo.lock SHA-256, and binary
SHA-256. Confirm that tracked sources and HEAD did not change during compilation.
Use a fresh temporary home for native discovery checks: `--help`, `accounts --json`
and `login status --json`. The last must report `authenticated: false`; Accounts
discovery must report `app_id: write`. Record `--version` as well. Cross compilation
does not establish execution on Windows or Linux.

## Pack, validate and release

Create one staging directory per target under
`~/.silicon-release/accounts-apps/write/cli-0.2.0/`. Each directory contains only
`apps.yaml`, `source.json` and `bin/write` (or `bin/write.exe`). Use this single-target
manifest, substituting the target and executable from the table:

```yaml
schema_version: 1
app_id: write
version: 0.2.0
command: write
targets:
  linux-x86_64:
    binary: bin/write
```

Set `WRITE_RELEASE_DIR` to that release directory. For each of the six target names:

```bash
silicon-apps validate "$WRITE_RELEASE_DIR/$target" --json
silicon-apps pack "$WRITE_RELEASE_DIR/$target" --output "$WRITE_RELEASE_DIR/write-0.2.0-$target.tar.gz" --json
shasum -a 256 "$WRITE_RELEASE_DIR/write-0.2.0-$target.tar.gz"
```

Before uploading, verify `silicon-apps login status --json` identifies an existing
Write author, `silicon-apps show write --json` confirms author access, and
`silicon-apps capabilities --json` reports all required runners live. Package
validation and packing are local operations. The following are catalog mutations;
run them only as the authorized publication step, after prerequisites pass:

```bash
silicon-apps upload write --target "$target" "$WRITE_RELEASE_DIR/write-0.2.0-$target.tar.gz" --idempotency-key "write-0.2.0-upload-$target-$archive_sha256" --json
silicon-apps packages write --json
silicon-apps release write --version 0.2.0 --package "$linux_x86_64_id" --package "$linux_aarch64_id" --package "$linux_i686_id" --package "$linux_armv7hf_id" --package "$macos_aarch64_id" --package "$windows_x86_64_id" --notes "$release_notes" --idempotency-key "write-0.2.0-development-$source_commit" --json
silicon-apps promote write "$development_release_id" --version 0.2.0 --idempotency-key "write-0.2.0-production-$source_commit" --json
silicon-apps readiness write --json
```

Populate package and release IDs from successful responses; never reuse the 0.1.0
IDs for the new binaries. Inspect all three isolated command checks for every
accepted upload and preserve the exact responses. Retry an uncertain mutation with
the same arguments and idempotency key. Write is already published, so a normal
upgrade needs no metadata changes or additional `publish` call.

After promotion, resolve all six targets anonymously at
`https://apps.teamofsilicons.com/v1/apps/write/resolve?target=TARGET`, verify the
release/version/signature metadata, download the returned package URL, and compare
its size and SHA-256 with the retained archive. Record isolated fresh-install and
upgrade execution checks on supported machines. Keep these public receipts separate
from local build evidence and document any unverified platform execution.
