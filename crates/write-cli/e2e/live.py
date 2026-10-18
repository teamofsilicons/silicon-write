#!/usr/bin/env python3
"""Exercise real co-writing CLI processes using the e2e runner's isolated sign-ins."""

import argparse
import json
import pathlib
import select
import signal
import subprocess
import time
import urllib.parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", required=True)
    parser.add_argument("--owner-home", required=True)
    parser.add_argument("--silicon-home", required=True)
    parser.add_argument("--viewer-home", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if urllib.parse.urlsplit(args.api_url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        parser.error("Live CLI fixtures must use a loopback test API.")
    args.output.mkdir(parents=True, exist_ok=True)
    processes = []
    handles = []
    checks = []

    def command(home, *words):
        return [args.write, "--home", home, "--api-url", args.api_url, "--json", *words]

    def run(home, *words, stdin=None, expected=0):
        result = subprocess.run(command(home, *words), input=stdin, text=True, capture_output=True, timeout=20)
        assert result.returncode == expected, f"{words[0]} exited {result.returncode}, expected {expected}: {(result.stdout or result.stderr)[:400]}"
        return json.loads(result.stdout)

    def passed(label):
        checks.append(label)
        print(f"  ok    {label}", flush=True)

    def wait_until(predicate, label, seconds=6):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.1)
        raise AssertionError(label)

    def context(doc):
        return run(args.owner_home, "context", doc)

    silicon = run(args.silicon_home, "whoami")
    viewer = run(args.viewer_home, "whoami")

    def present(doc):
        return any(person.get("account", {}).get("uuid") == silicon["uuid"] for person in context(doc)["presence"])

    def start(name, doc, *words, blocked=False):
        stderr = (args.output / f"{name}.stderr").open("wb")
        handles.append(stderr)
        output = subprocess.PIPE
        if not blocked:
            output = (args.output / f"{name}.jsonl").open("wb")
            handles.append(output)
        process = subprocess.Popen(command(args.silicon_home, *words, doc), stdout=output, stderr=stderr)
        processes.append(process)
        return process

    def events(name):
        path = args.output / f"{name}.jsonl"
        rows = []
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # The writer may be part-way through its final line while we poll.
                continue
        return rows

    def finish(process, *, terminate=False, timeout=8):
        if terminate:
            process.send_signal(signal.SIGTERM)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise AssertionError("The live CLI failed to exit; cancellation may be blocked on stdout.")
        assert code == 0, f"Live CLI exited {code}; inspect the retained fixture stderr."
        if process.stdout:
            process.stdout.close()

    try:
        doc = run(args.owner_home, "new", "--title", "CLI co-writing fixture", "--file", "-", stdin="# Co-writing\n\nKeep this passage.\n\nBudget: small.\n")["id"]
        run(args.owner_home, "share", doc, silicon["id"], "--role", "editor")
        run(args.owner_home, "share", doc, viewer["id"], "--role", "viewer")
        initial = run(args.silicon_home, "context", doc)
        assert initial["doc"]["id"] == doc and initial["doc"]["seq"] == initial["seq"]
        assert initial["cursor"] and initial["prosemirror"]["type"] == "doc"
        assert isinstance(initial["threads"], list) and isinstance(initial["revisions"], list)
        assert initial["authors"]["blocks"] and initial["permissions"]["comments"]
        viewed = run(args.viewer_home, "context", doc)
        assert viewed["threads"] is None and viewed["revisions"] is None
        passed("context returns anchored content and role-filtered collaboration details")

        joined = start("duration", doc, "join", "--duration", "3")
        wait_until(lambda: present(doc), "A joined Silicon never became visible.")
        finish(joined)
        wait_until(lambda: not present(doc), "Duration expiry left stale presence.")
        rows = events("duration")
        assert any(row["event"] == "snapshot" for row in rows)
        assert rows[-1]["event"] == "connection" and rows[-1]["data"]["status"] == "left"
        assert context(doc)["markdown"] == initial["markdown"]
        passed("join duration announces and removes Silicon presence without changing prose")

        cursor = context(doc)["cursor"]
        watcher = start("watch", doc, "watch", "--after", cursor, "--duration", "12")
        wait_until(lambda: events("watch"), "Watch never connected.")
        assert not present(doc)
        thread = run(args.owner_home, "comment", doc, "--quote", "Keep this passage.", "--body", "A comment while watching.")
        created = wait_until(lambda: next((row for row in events("watch") if row["event"] == "comments" and row["data"].get("thread_id") == thread["id"]), None), "Watch missed a comment-only change.")
        assert created["id"] != cursor and context(doc)["seq"] == initial["seq"]
        finish(watcher, terminate=True)
        run(args.owner_home, "reply", thread["id"], "--body", "A reply while the watcher was disconnected.")
        resumed = start("resume", doc, "watch", "--after", created["id"], "--duration", "2")
        finish(resumed)
        rows = events("resume")
        changes = [row for row in rows if row["event"] == "comments"]
        assert len(changes) == 1 and changes[0]["data"]["thread_id"] == thread["id"]
        assert changes[0]["id"] != created["id"]
        assert not any(row["event"] in {"snapshot", "reset"} for row in rows)
        assert not present(doc)
        passed("watch stays invisible and resumes a comment-only reply from its last cursor")

        current = context(doc)
        run(args.owner_home, "edit", doc, "--old", "Budget: small.", "--new", "Budget: medium.")
        before = context(doc)
        rejected = run(args.silicon_home, "edit", doc, "--old", "Keep this passage.", "--new", "Stale replacement.", "--expect-seq", str(current["seq"]), expected=5)
        assert rejected["error"]["code"] == "conflict"
        after = context(doc)
        assert after["markdown"] == before["markdown"] and after["seq"] == before["seq"]
        accepted = run(args.silicon_home, "edit", doc, "--old", "Keep this passage.", "--new", "Keep this revised passage.", "--expect-seq", str(after["seq"]))
        assert "Keep this revised passage." in accepted["markdown"]
        passed("stale expect-seq exits5 without mutation; a fresh guard permits the edit")

        large = run(args.owner_home, "new", "--title", "CLI backpressure fixture", "--file", "-", stdin="# Large context\n\n" + "A sizeable snapshot exercises a blocked reader. " * 4096 + "\n")["id"]
        run(args.owner_home, "share", large, silicon["id"], "--role", "editor")
        blocked = start("blocked-duration", large, "join", "--duration", "3", blocked=True)
        wait_until(lambda: present(large), "Blocked-output join never became visible.")
        # Never drain stdout: a snapshot larger than the pipe must not defeat cancellation.
        finish(blocked)
        wait_until(lambda: not present(large), "Blocked stdout retained presence after duration expiry.")
        passed("duration cancels a join even when its large snapshot blocks stdout")

        blocked = start("blocked-sigterm", large, "join", blocked=True)
        wait_until(lambda: present(large), "Second blocked-output join never became visible.")
        wait_until(lambda: select.select([blocked.stdout], [], [], 0)[0], "Join never produced stdout.")
        time.sleep(0.2)
        finish(blocked, terminate=True)
        wait_until(lambda: not present(large), "SIGTERM left joined presence behind.")
        passed("SIGTERM cancels blocked output and removes joined presence")
        (args.output / "verification.json").write_text(json.dumps({"checks": checks, "document": doc, "large_document": large}, indent=2) + "\n")
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
            if process.stdout:
                process.stdout.close()
        for handle in handles:
            handle.close()


if __name__ == "__main__":
    main()
