# Releasing the Write CLI

The CLI package version is the workspace version in `Cargo.toml`. Keep
`crates/write-cli/package/apps.yaml` in sync. Publishing a new CLI release is separate
from deploying the API or web editor. The CLI crate has `publish = false`; this flow
distributes executable packages through Silicon Apps, not crates.io.

## Current publication boundary

Write CLI **0.2.0** is public on six targets: Linux x86_64, aarch64, i686 and
armv7hf; Apple Silicon macOS; and Windows x86_64. Production release
`0bad7e9f-96ab-4d03-beaa-2bf409a2abf0` was promoted from development release
`a1804e00-928f-4972-96e4-ed7a60b8176e` on 2026-10-18 UTC. All six packages passed
the normal authenticated store upload and isolated discovery commands. The
release receipts and original archives are retained in
`~/.silicon-release/accounts-apps/write/cli-0.2.0/`. The checked package hashes,
public signatures, fresh Mac and Windows installs, and Linux 0.1.0 upgrade are
recorded in [the 0.2.0 verification receipt](verification-cli-0.2.0-2026-10-18.json).

The live Apps service requires `linux-x86_64`, `windows-x86_64` and
`macos-aarch64` for every new release and promotion. Preserve the other three
Linux packages too. Missing required targets are rejected; validated immutable
package IDs are required even when builds succeed locally.

Validation for all four Linux targets and the dedicated Windows Hyper-V worker
remain available.
Mac upload validation is **on demand**: this release used the owner's existing
Apple Silicon Mac, with a temporary loopback listener and authenticated SSH/SSM
transport to the Linux gateway. The listener accepted only the exact approved
Write archive before extraction or execution. The local process, tunnel,
temporary routes and credentials were removed after acceptance; no cloud Mac was
allocated. Prepare a fresh approved release session for the next Mac upload; see
`silicon-apps/runner/RELEASE-SESSION.md` in the sibling repository. General public
Mac uploads are not enabled while that session is absent.

Recheck live `capabilities` for the target being uploaded. A target without a
running validation environment returns HTTP 503 `dependency_unavailable`; local
`validate` cannot create an accepted package ID. The first-party operator import
helper is not a Write publication path. Existing accepted packages remain valid
for release creation and installation after a temporary validator disconnects.

Write 0.1.0 and its original four Linux packages remain retained. Its production
release is `4138ff02-2fd0-4834-88b2-f9c527549d68`; the 0.1.0 artifacts and receipts
remain in their separate directory.

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
| windows-x86_64 | x86_64-pc-windows-msvc | `RUSTFLAGS="-C target-feature=+crt-static" cargo xwin build` | write.exe |

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
RUSTFLAGS="-C target-feature=+crt-static" cargo xwin build --locked --release -p write-cli --bin write --target x86_64-pc-windows-msvc
```

The Windows package must statically link the Microsoft C runtime. A dynamically
linked build failed all three discovery commands in a clean Hyper-V Server Core
container with `0xC0000135` (missing DLL). Keep `+crt-static` in the release command,
inspect the resulting PE imports for unexpected runtime DLL dependencies, and
validate the exact archive on the native worker. Do not add runtime libraries to
the validator image to hide a package dependency.

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
`silicon-apps capabilities --json` reports the target being uploaded live. Keep
the approved local Mac session active for its upload, then disconnect it after
acceptance. Package
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
