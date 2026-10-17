#!/usr/bin/python3
"""Run a document converter with only its working files and no network or app secrets."""
import os
import fcntl
from pathlib import Path
import resource
import subprocess
import sys

PROGRAMS = {
    "pandoc": "/usr/bin/pandoc",
    "soffice": "/usr/bin/soffice",
    "pdftotext": "/usr/bin/pdftotext",
    "pdfinfo": "/usr/bin/pdfinfo",
}


def command(name, args, cwd):
    if name not in PROGRAMS:
        raise ValueError("Unknown document converter")
    cwd = str(Path(cwd).resolve())
    if not cwd.startswith("/tmp/"):
        raise ValueError("Converters require a temporary working directory")
    result = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-all", "--clearenv"]
    # LibreOffice's registry links into /etc, and its user-profile initialization
    # needs the host's public identity databases even with HOME inside the sandbox.
    for path in ["/usr", "/bin", "/lib", "/lib64", "/etc/fonts", "/etc/alternatives",
                 "/etc/ld.so.cache", "/etc/libreoffice", "/etc/passwd", "/etc/group",
                 "/etc/nsswitch.conf"]:
        if Path(path).exists():
            result += ["--ro-bind", path, path]
    result += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
               "--bind", cwd, cwd, "--chdir", cwd,
               "--setenv", "HOME", cwd, "--setenv", "TMPDIR", cwd,
               "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
               "--", PROGRAMS[name], *args]
    return result


if __name__ == "__main__":
    argv = command(Path(sys.argv[0]).name, sys.argv[1:], os.getcwd())
    # One converter per API instance keeps parallel LibreOffice requests within the
    # dedicated host's memory budget. API cancellation kills this parent, and bwrap's
    # die-with-parent then tears down the converter's entire PID namespace.
    with open("/tmp/silicon-write-converter.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024**2, 512 * 1024**2))
        result = subprocess.run(argv, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        sys.exit(result.returncode)
