#!/usr/bin/python3
"""Install a verified Silicon Write release on its dedicated Ubuntu ARM64 host via SSM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def write(path, contents, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)
    path.chmod(mode)


def env_text(values):
    result = []
    for key, value in values.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(c in str(value) for c in "\n\r\0"):
            raise ValueError("Invalid environment field")
        value = str(value).replace("\\", "\\\\").replace('"', '\\"')
        result.append(f'{key}="{value}"\n')
    return "".join(result)


def healthy(url):
    for _ in range(40):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("Readiness failed: " + url)


def extract(archive, destination):
    with tarfile.open(archive) as bundle:
        for member in bundle.getmembers():
            if Path(member.name).is_absolute() or ".." in Path(member.name).parts or not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe release archive member")
        bundle.extractall(destination)


def main():
    parser = argparse.ArgumentParser()
    for name in ["archive", "sha256", "revision", "secret", "bucket"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--region", default="us-east-2")
    args = parser.parse_args()
    assert os.geteuid() == 0
    os.umask(0o077)
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ValueError("Expected a full Git revision")
    if hashlib.sha256(Path(args.archive).read_bytes()).hexdigest() != args.sha256:
        raise ValueError("Release checksum mismatch")
    run("cloud-init", "status", "--wait")
    release = Path("/opt/silicon-write/releases") / args.revision
    if release.exists():
        raise ValueError("Immutable release already exists; inspect it before retrying")
    release.mkdir(parents=True)
    extract(args.archive, release)
    manifest = json.loads((release / "build.json").read_text())
    if manifest["revision"] != args.revision:
        raise ValueError("Release revision mismatch")
    for name, expected in manifest["files"].items():
        if hashlib.sha256((release / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Bundled file checksum mismatch: " + name)
    run("bash", str(release / "bootstrap.sh"))
    run("chmod", "-R", "a+rX", str(release))
    run("chmod", "755", "/opt/silicon-write", "/opt/silicon-write/releases")
    for user in ["silicon-write", "silicon-write-caddy"]:
        try:
            pwd.getpwnam(user)
        except KeyError:
            run("useradd", "--system", "--user-group", "--create-home", "--home-dir", "/var/lib/" + user, "--shell", "/usr/sbin/nologin", user)
    run("install", "-d", "-m", "700", "-o", "silicon-write", "-g", "silicon-write", "/var/lib/silicon-write/data")
    run("install", "-d", "-m", "700", "/etc/silicon-write", "/var/backups/silicon-write")
    # Values never reach command text, stdout or service logs.
    secret = json.loads(json.loads(subprocess.check_output([
        "aws", "secretsmanager", "get-secret-value", "--region", args.region, "--secret-id", args.secret,
    ]))["SecretString"])
    if secret["WRITE_BIND"] != "127.0.0.1:4371" or secret["WRITE_DATA_DIR"] != "/var/lib/silicon-write/data":
        raise ValueError("Unexpected runtime data location or listener")
    if secret["WRITE_API_URL"] != "https://api.write.teamofsilicons.com" or secret["WRITE_ENVIRONMENT"] != "production":
        raise ValueError("Unexpected production origin/environment")
    for name in ["pandoc", "soffice", "pdftotext", "pdfinfo", "ffmpeg"]:
        (release / "converters" / name).symlink_to("converter.py")
    run("systemctl", "enable", "--now", "postgresql")
    def sql(query):
        return run("runuser", "-u", "postgres", "--", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1",
                   input=query, text=True, capture_output=True).stdout.strip()
    password = urllib.parse.unquote(urllib.parse.urlsplit(secret["WRITE_DATABASE_URL"]).password or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,}", password):
        raise ValueError("Unexpected database credential format")
    if sql("SELECT 1 FROM pg_roles WHERE rolname='silicon_write'") != "1":
        sql("CREATE ROLE silicon_write LOGIN PASSWORD '" + password + "'")
    if sql("SELECT 1 FROM pg_database WHERE datname='silicon_write'") != "1":
        run("runuser", "-u", "postgres", "--", "createdb", "-O", "silicon_write", "silicon_write")
    previous = Path("/opt/silicon-write/current")
    old = str(previous.resolve()) if previous.is_symlink() else None
    if old:
        run("python3", str(Path(old) / "backup.py"), "--bucket", args.bucket, "--region", args.region, "--label", "predeploy")
        config_backup = Path("/var/backups/silicon-write") / ("configuration-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        shutil.copytree("/etc/silicon-write", config_backup)
        write("/opt/silicon-write/previous-release", old + "\n", 0o600)
        run("systemctl", "stop", "silicon-write")
    write("/etc/silicon-write/api.env", env_text(secret), 0o600)
    next_link = Path("/opt/silicon-write/current.next")
    next_link.unlink(missing_ok=True)
    next_link.symlink_to(release)
    os.replace(next_link, previous)
    write("/etc/systemd/system/silicon-write.service", """[Unit]
Description=Silicon Write API
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User=silicon-write
Group=silicon-write
WorkingDirectory=/opt/silicon-write/current
EnvironmentFile=/etc/silicon-write/api.env
ExecStart=/opt/silicon-write/current/bin/write-api
Restart=on-failure
RestartSec=3
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/silicon-write/data
UMask=0077
[Install]
WantedBy=multi-user.target
""")
    write("/etc/silicon-write-caddy/Caddyfile", """api.write.teamofsilicons.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4371 {
        header_up X-Forwarded-For {remote_host}
        flush_interval -1
    }
    header {
        X-Content-Type-Options nosniff
        -Server
    }
}
""")
    run("chmod", "755", "/etc/silicon-write-caddy")
    write("/etc/systemd/system/silicon-write-caddy.service", """[Unit]
Description=Silicon Write HTTPS
After=network-online.target
Wants=network-online.target
[Service]
User=silicon-write-caddy
Group=silicon-write-caddy
Environment=HOME=/var/lib/silicon-write-caddy
ExecStart=/opt/silicon-write/current/bin/caddy run --config /etc/silicon-write-caddy/Caddyfile --adapter caddyfile
ExecReload=/opt/silicon-write/current/bin/caddy reload --config /etc/silicon-write-caddy/Caddyfile --adapter caddyfile
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/silicon-write-caddy
[Install]
WantedBy=multi-user.target
""")
    write("/etc/systemd/system/silicon-write-backup.service", f"""[Unit]
Description=Consistent Silicon Write database and files backup
[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/bin/python3 /opt/silicon-write/current/backup.py --bucket {args.bucket} --region {args.region}
""")
    write("/etc/systemd/system/silicon-write-backup.timer", """[Unit]
Description=Hourly Silicon Write backup
[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
""")
    run(str(release / "bin/caddy"), "validate", "--config", "/etc/silicon-write-caddy/Caddyfile", "--adapter", "caddyfile")
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", "silicon-write")
    try:
        healthy("http://127.0.0.1:4371/readyz")
    except Exception:
        run("systemctl", "stop", "silicon-write")
        raise RuntimeError("New release failed readiness; retained old release and backup. Inspect migrations before rollback.")
    run("systemctl", "enable", "--now", "silicon-write-caddy", "silicon-write-backup.timer")
    run("systemctl", "restart", "silicon-write-caddy")
    write("/etc/silicon-write/deployed.json", json.dumps({"revision": args.revision, "archive_sha256": args.sha256, "previous": old, "files": manifest["files"]}, indent=2) + "\n", 0o600)
    print(json.dumps({"installed_revision": args.revision, "local_readiness": True}))


if __name__ == "__main__":
    main()
