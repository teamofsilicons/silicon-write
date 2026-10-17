"""Offline deployment safety checks; no credentials, network, or host changes.

Run with: python3 -m unittest discover -s deploy -p test_install.py -v
Actual namespace isolation and Office conversion also need a check on the Linux host.
"""

import importlib.util
import io
import os
from pathlib import Path, PurePosixPath
import tarfile
import tempfile
import unittest
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location("write_deploy_" + name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


install = load("install")
converter = load("converter")


class EnvironmentTests(unittest.TestCase):
    def test_literals_cannot_break_out_of_environment_value(self):
        self.assertEqual(
            install.env_text({"WRITE_SECRET": 'a\\b"c$HOME`command`%n #;=value'}),
            'WRITE_SECRET="a\\\\b\\"c$HOME`command`%n #;=value"\n',
        )

    def test_line_and_nul_injection_rejected(self):
        for value in ["ok\nEXECSTART=bad", "ok\rBAD=value", "ok\0tail"]:
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                install.env_text({"WRITE_SECRET": value})

    def test_invalid_field_name_rejected(self):
        for key in ["WRITE_SECRET\nOTHER", "A=B", "X Y", "x", "1WRITE", ""]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                install.env_text({key: "safe"})

    def test_empty_and_unicode_values_preserved(self):
        self.assertEqual(install.env_text({"EMPTY": "", "TITLE": "Write — 文書"}), 'EMPTY=""\nTITLE="Write — 文書"\n')


class ArchiveTests(unittest.TestCase):
    def archive(self, directory, member):
        path = directory / "bundle.tar"
        with tarfile.open(path, "w") as output:
            good = tarfile.TarInfo("safe.txt")
            good.size = 4
            output.addfile(good, io.BytesIO(b"safe"))
            output.addfile(member, io.BytesIO(b"") if member.isfile() else None)
        return path

    def test_nested_regular_files_can_be_extracted(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            member = tarfile.TarInfo("bin/tool")
            archive = self.archive(directory, member)
            target = directory / "release"
            target.mkdir()
            install.extract(archive, target)
            self.assertEqual((target / "safe.txt").read_bytes(), b"safe")
            self.assertTrue((target / "bin/tool").is_file())

    def test_unsafe_members_reject_entire_archive_before_writing(self):
        cases = [
            ("../outside", tarfile.REGTYPE, ""),
            ("bin/../../outside", tarfile.REGTYPE, ""),
            ("/tmp/write-unsafe-archive", tarfile.REGTYPE, ""),
            ("bin/link", tarfile.SYMTYPE, "../../outside"),
            ("bin/link", tarfile.LNKTYPE, "safe.txt"),
            ("pipe", tarfile.FIFOTYPE, ""),
            ("device", tarfile.CHRTYPE, ""),
        ]
        for name, kind, link in cases:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                target = directory / "release"
                target.mkdir()
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = link
                archive = self.archive(directory, member)
                with self.assertRaises(ValueError):
                    install.extract(archive, target)
                self.assertEqual(list(target.iterdir()), [])
                self.assertFalse((directory / "outside").exists())


class ConverterTests(unittest.TestCase):
    def argv(self, program="pandoc", args=None, resolved="/tmp/write-job"):
        # macOS resolves /tmp to /private/tmp; model the deployed Linux path here.
        with mock.patch.object(Path, "resolve", return_value=PurePosixPath(resolved)):
            return converter.command(program, args or [], "/tmp/write-job")

    def test_network_pid_and_environment_are_isolated(self):
        with mock.patch.dict(os.environ, {"WRITE_APP_SECRET": "must-never-inherit", "AWS_SECRET_ACCESS_KEY": "also-private"}):
            argv = self.argv()
        self.assertEqual(argv[0], "/usr/bin/bwrap")
        for flag in ["--unshare-all", "--clearenv", "--die-with-parent", "--new-session"]:
            self.assertIn(flag, argv[:argv.index("--")])
        self.assertNotIn("--share-net", argv)
        self.assertNotIn("must-never-inherit", argv)
        self.assertNotIn("also-private", argv)

    def test_only_job_directory_is_writable_and_no_app_secret_mount(self):
        argv = self.argv()
        bindings = [(argv[i + 1], argv[i + 2]) for i, value in enumerate(argv) if value == "--bind"]
        self.assertEqual(bindings, [("/tmp/write-job", "/tmp/write-job")])
        reads = [argv[i + 1] for i, value in enumerate(argv) if value == "--ro-bind"]
        self.assertTrue(set(reads).issubset({
            "/usr", "/bin", "/lib", "/lib64", "/etc/fonts", "/etc/alternatives", "/etc/ld.so.cache",
            "/etc/libreoffice", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
        }))
        for path in ["/", "/etc", "/home", "/var/lib/silicon-write", "/etc/silicon-write", "/proc"]:
            self.assertNotIn(path, reads)
        self.assertEqual(argv[argv.index("--chdir") + 1], "/tmp/write-job")

    def test_office_registry_and_user_lookup_files_are_available(self):
        # Ubuntu's Office registry is a symlink into /etc, and profile startup
        # requires the public user/group lookup files even with HOME supplied.
        with mock.patch.object(Path, "exists", return_value=True):
            argv = self.argv(program="soffice")
        reads = [argv[i + 1] for i, value in enumerate(argv) if value == "--ro-bind"]
        self.assertTrue({"/etc/libreoffice", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"}.issubset(reads))

    def test_input_arguments_cannot_become_sandbox_options(self):
        malicious = ["--share-net", "--ro-bind", "/etc", "/etc"]
        argv = self.argv(args=malicious)
        self.assertEqual(argv[argv.index("--") + 1:], ["/usr/bin/pandoc", *malicious])
        self.assertNotIn("--share-net", argv[:argv.index("--")])

    def test_cwd_escape_and_non_job_paths_rejected(self):
        for path in ["/", "/etc", "/tmp", "/tmp-neighbor/job", "/var/lib/silicon-write/data"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.argv(resolved=path)

    def test_each_converter_is_absolute_and_allowlisted(self):
        for program in ["pandoc", "soffice", "pdftotext", "pdfinfo"]:
            with self.subTest(program=program):
                argv = self.argv(program=program)
                self.assertEqual(argv[argv.index("--") + 1], "/usr/bin/" + program)
        for program in ["bash", "../pandoc", "/usr/bin/pandoc"]:
            with self.subTest(program=program), self.assertRaises(ValueError):
                self.argv(program=program)


if __name__ == "__main__":
    unittest.main()
