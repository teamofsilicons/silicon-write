#!/usr/bin/python3
"""Keep a consistent PostgreSQL/files snapshot, then upload it to the private backup bucket."""
import argparse
import hashlib
import json
from pathlib import Path
import select
import shutil
import subprocess
import tarfile
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def backup(bucket, region, label="hourly"):
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    directory = Path("/var/backups/silicon-write") / (label + "-" + stamp)
    directory.mkdir(parents=True, mode=0o700)
    # Purging a document deletes rows before unlinking files. Hold these locks through
    # the exported snapshot and file copy so a referenced file cannot disappear halfway.
    # Readers and live connections stay connected; writes wait for this short checkpoint.
    with (directory / "lock.log").open("w") as errors:
        holder = subprocess.Popen(
            ["runuser", "-u", "postgres", "--", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "silicon_write"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True,
        )
        try:
            holder.stdin.write("BEGIN; SET lock_timeout = '20s'; LOCK TABLE docs, assets IN SHARE MODE; SELECT pg_export_snapshot();\n")
            holder.stdin.flush()
            if not select.select([holder.stdout], [], [], 25)[0]:
                raise RuntimeError("Backup lock timed out")
            snapshot = holder.stdout.readline().strip()
            if not snapshot or any(c not in "0123456789ABCDEFabcdef-" for c in snapshot):
                raise RuntimeError("Could not export backup snapshot")
            with (directory / "database.dump").open("wb") as output:
                run("runuser", "-u", "postgres", "--", "pg_dump", "-Fc", "--snapshot=" + snapshot,
                    "silicon_write", stdout=output, timeout=300)
            with tarfile.open(directory / "files.tar.gz", "w:gz") as archive:
                archive.add("/var/lib/silicon-write/data", arcname="data")
            holder.stdin.write("COMMIT;\n\\q\n")
            holder.stdin.flush()
            holder.wait(timeout=10)
            if holder.returncode:
                raise RuntimeError("Backup lock transaction failed")
        finally:
            if holder.poll() is None:
                holder.terminate()
                holder.wait(timeout=10)
    receipt = {"created_at": stamp, "release": str(Path("/opt/silicon-write/current").resolve()), "files": {}}
    for name in ["database.dump", "files.tar.gz"]:
        path = directory / name
        receipt["files"][name] = digest(path)
        run("aws", "s3", "cp", str(path), f"s3://{bucket}/backups/{directory.name}/{name}", "--region", region, "--only-show-errors")
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    run("aws", "s3", "cp", str(directory / "receipt.json"), f"s3://{bucket}/backups/{directory.name}/receipt.json", "--region", region, "--only-show-errors")
    print(json.dumps({"backup": directory.name, "files": receipt["files"]}))
    for previous in directory.parent.iterdir():
        if previous.is_dir() and (previous / "receipt.json").is_file() and previous.stat().st_mtime < time.time() - 3 * 86400:
            shutil.rmtree(previous)
    return directory


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--label", default="hourly")
    args = parser.parse_args()
    backup(args.bucket, args.region, args.label)
