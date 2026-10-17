#!/usr/bin/env python3
"""Package committed deployment sources, the Linux API and verified upstream converters/proxy."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    production = ROOT / ".dev/production"
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, text=True).strip():
        raise SystemExit("Commit tracked source changes before packaging")
    pandoc = production / "pandoc-3.12.1-1-arm64.deb"
    if digest(pandoc) != "38f44718c0cb15cb81fc31026bd68c33e8628ca5f7ab15ca86494a7f24f7b8e4":
        raise SystemExit("Pandoc release checksum mismatch")
    caddy = production / "caddy_2.11.7_linux_arm64.tar.gz"
    sums = dict((parts[1].lstrip("*"), parts[0]) for line in (production / "caddy_2.11.7_checksums.txt").read_text().splitlines() if len(parts := line.split()) == 2)
    if digest(caddy) != sums[caddy.name]:
        raise SystemExit("Caddy upstream checksum mismatch")
    with tempfile.TemporaryDirectory(dir=production, prefix="bundle-") as temp:
        bundle = Path(temp)
        for directory in ["bin", "packages", "converters"]:
            (bundle / directory).mkdir()
        shutil.copy2(ROOT / "target/aarch64-unknown-linux-gnu/release/write-api", bundle / "bin/write-api")
        with tarfile.open(caddy) as archive:
            with archive.extractfile("caddy") as source, (bundle / "bin/caddy").open("wb") as target:
                shutil.copyfileobj(source, target)
        (bundle / "bin/caddy").chmod(0o755)
        shutil.copy2(pandoc, bundle / "packages" / pandoc.name)
        for name in ["install.py", "backup.py", "bootstrap.sh"]:
            shutil.copy2(ROOT / "deploy" / name, bundle / name)
        shutil.copy2(ROOT / "deploy/converter.py", bundle / "converters/converter.py")
        (bundle / "converters/converter.py").chmod(0o755)
        files = {str(path.relative_to(bundle)): digest(path) for path in sorted(bundle.rglob("*")) if path.is_file()}
        (bundle / "build.json").write_text(json.dumps({"revision": revision, "architecture": "aarch64", "files": files}, indent=2) + "\n")
        output = production / (revision + ".tar.gz")
        with tarfile.open(output, "w:gz") as archive:
            for path in sorted(bundle.iterdir()):
                archive.add(path, arcname=path.name)
    receipt = {"revision": revision, "archive": str(output), "sha256": digest(output), "files": files}
    (production / "release.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in ["revision", "archive", "sha256"]}))


if __name__ == "__main__":
    main()
