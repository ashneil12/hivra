#!/usr/bin/env python3
"""Run only in an owned root Linux container with no network or host mounts.

Requires /tmp/run-attached-codex-stage.py, /tmp/stage-attached-codex.py and the
root-owned, pinned /tmp/codex.tar.gz. Real staging runs once; negative tests use
separate owned journals, never repeat installation. Container teardown removes
all fixture state, accounts and binaries.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", "/tmp/run-attached-codex-stage.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
IDENTITY = {
    "operationId": "11111111-1111-4111-8111-111111111111",
    "dispatchId": "22222222-2222-4222-8222-222222222222",
    "installationId": "33333333-3333-4333-8333-333333333333",
    "bindingId": "44444444-4444-4444-8444-444444444444",
    "computerId": "55555555-5555-4555-8555-555555555555",
    "sourceId": "66666666-6666-4666-8666-666666666666",
    "architecture": "x86_64",
}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        worker.ROOT = Path("/var/lib/hivra/worker-tests") / self._testMethodName
        worker.secure_directory()

    def run_worker(self, identity=None):
        return worker.run(identity or IDENTITY, "/tmp/stage-attached-codex.py", "/tmp/codex.tar.gz",
                          Path("/proc/sys/kernel/random/boot_id").read_text().strip())

    def test_changed_boot_refuses_before_journal_or_installer(self):
        with patch.object(worker, "secure_directory", side_effect=AssertionError("must not mutate")):
            for boot in (None, "invalid", "99999999-9999-4999-8999-999999999999"):
                with self.assertRaises(ValueError):
                    worker.run(IDENTITY, "/tmp/stage-attached-codex.py", "/tmp/codex.tar.gz", boot)

    def test_real_staging_lost_response_and_replay(self):
        # Discard the first return value, as if the caller lost the response.
        self.run_worker()
        original = (worker.ROOT / "staging.json").read_bytes()
        receipt = json.loads(original)["receipt"]
        executable = Path(receipt["executable"])
        before = (executable.stat().st_ino, hashlib.sha256(executable.read_bytes()).hexdigest())
        with patch.object(worker.subprocess, "run", side_effect=AssertionError("replayed installer")):
            replay = self.run_worker()
            with self.assertRaises(ValueError):
                self.run_worker(dict(IDENTITY, dispatchId="77777777-7777-4777-8777-777777777777"))
        self.assertEqual(replay, json.loads(original))
        self.assertEqual((worker.ROOT / "staging.json").read_bytes(), original)
        self.assertEqual((executable.stat().st_ino, hashlib.sha256(executable.read_bytes()).hexdigest()), before)
        self.assertEqual(replay["phase"], "staged")

    def test_spawn_uncertainty_is_durable_and_never_retried(self):
        def uncertain(*args, **kwargs):
            self.assertEqual(json.loads((worker.ROOT / "staging.json").read_text())["phase"], "started")
            self.assertEqual(args[0][:4], ["/usr/bin/python3", "-I", "-B", "-"])
            self.assertEqual(hashlib.sha256(kwargs["input"]).hexdigest(), worker.STAGER_SHA256)
            self.assertEqual(len(kwargs["pass_fds"]), 1)
            raise subprocess.TimeoutExpired(args[0], 300)
        with patch.object(worker.subprocess, "run", side_effect=uncertain) as launch:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_worker()
            for identity in (IDENTITY, dict(IDENTITY, operationId="88888888-8888-4888-8888-888888888888")):
                with self.assertRaises(ValueError):
                    self.run_worker(identity)
            self.assertEqual(launch.call_count, 1)

    def test_null_journal_is_not_absence(self):
        worker.publish(None)
        with patch.object(worker.subprocess, "run", side_effect=AssertionError("unexpected spawn")):
            with self.assertRaises(ValueError):
                self.run_worker()

    def test_dangling_journal_symlink_is_not_absence(self):
        (worker.ROOT / "staging.json").symlink_to(worker.ROOT / "missing")
        with self.assertRaises(OSError):
            self.run_worker()

    def test_old_boot_requires_reconciliation(self):
        worker.publish({"version": 1, "identity": IDENTITY, "bootId": "99999999-9999-4999-8999-999999999999", "phase": "staged", "receipt": {}})
        with self.assertRaises(ValueError):
            self.run_worker()

    def test_wrong_stager_never_creates_started_record(self):
        wrong = worker.ROOT / "wrong.py"
        wrong.write_text("raise SystemExit('never execute')")
        wrong.chmod(0o600)
        with self.assertRaises(ValueError):
            worker.run(IDENTITY, wrong, "/tmp/codex.tar.gz", Path("/proc/sys/kernel/random/boot_id").read_text().strip())
        self.assertFalse((worker.ROOT / "staging.json").exists())

    def test_held_lock_blocks_dispatch(self):
        fd = os.open(worker.ROOT / "installer.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.run_worker()
        finally:
            os.close(fd)

    def test_receipt_rejects_boolean_ids_and_ready_state(self):
        installation = IDENTITY["installationId"]
        receipt = {
            "version": 1, "state": "staged", "operationId": IDENTITY["operationId"],
            "installationId": installation, "runtimeId": "codex", "runtimeVersion": "0.149.1",
            "architecture": "x86_64", "archiveSha256": worker.PINS["x86_64"][0],
            "binarySha256": worker.PINS["x86_64"][1], "uid": 1001, "gid": 1001,
            "account": "hva_" + installation.replace("-", "")[:24],
            "home": "/var/lib/hivra/agent-homes/" + installation,
            "executable": "/opt/hivra/agent-installations/" + installation + "/codex",
        }
        self.assertEqual(worker.checked_receipt(receipt, IDENTITY), receipt)
        for key, value in (("uid", True), ("gid", True), ("version", True), ("state", "ready"),
                           ("binarySha256", "0" * 64), ("uid", 0), ("gid", 4294967295)):
            with self.subTest(field=key, value=value):
                with self.assertRaises(ValueError):
                    worker.checked_receipt(dict(receipt, **{key: value}), IDENTITY)


if __name__ == "__main__":
    if os.geteuid() != 0 or not Path("/.dockerenv").exists():
        raise SystemExit("owned root Docker fixture required")
    unittest.main(verbosity=2)
