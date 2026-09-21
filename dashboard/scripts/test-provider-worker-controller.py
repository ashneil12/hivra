#!/usr/bin/env python3
"""Execute generated recovery wrappers against test-owned files only.

The fixed root path and uid are virtualized for a non-root local test. Real
file opens, modes, links, lengths, hashes and Python compilation still run.
Intercept the verified module's entrypoint so no systemd/guest command runs.
"""
import base64
import builtins
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

FIXTURE = json.loads(sys.stdin.read())
SOURCE = base64.b64decode(FIXTURE["source"], validate=True)
DIRECTORY = "/opt/hivra/provider-bundle/current"
WORKER = DIRECTORY + "/hivra-provider-worker.py"
# Load the reviewed worker's standard-library dependencies before intercepting
# exec. Otherwise an import executes hashlib.py through the same hook. Never
# call its entrypoint, and never preload the mutated per-case file.
exec(compile(SOURCE, "fixture-worker-imports", "exec"), {"__name__": "fixture_worker_imports"})


class ControllerTest(unittest.TestCase):
    def test_original_controller_and_rejections(self):
        for action in ("status", "cancel"):
            for defect in (None, "bytes", "size", "mode", "symlink", "hardlink", "owner", "directory"):
                with self.subTest(action=action, defect=defect), tempfile.TemporaryDirectory(prefix="hivra-controller-test-") as temporary:
                    root = Path(temporary)
                    source = root / "worker.py"
                    source.write_bytes(SOURCE if defect not in ("bytes", "size") else
                                       (b"x" * len(SOURCE) if defect == "bytes" else SOURCE + b"\n"))
                    source.chmod(0o644 if defect == "mode" else 0o600)
                    if defect == "hardlink":
                        os.link(source, root / "other.py")
                    if defect == "symlink":
                        link = root / "linked.py"
                        link.symlink_to(source)
                        source = link
                    real_open, real_fstat, real_exec = os.open, os.fstat, builtins.exec
                    compiled, calls = [], []

                    def lstat(directory):
                        self.assertIn(directory, ("/", "/opt", "/opt/hivra", "/opt/hivra/provider-bundle", DIRECTORY))
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | (0o777 if defect == "directory" else 0o755))

                    def open_worker(name, flags):
                        self.assertEqual(name, WORKER)
                        self.assertEqual(flags, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        return real_open(source, flags)

                    def fstat(fd):
                        info = real_fstat(fd)
                        return SimpleNamespace(st_uid=1 if defect == "owner" else 0,
                                               st_mode=info.st_mode, st_nlink=info.st_nlink, st_size=info.st_size)

                    def execute(code, namespace):
                        self.assertEqual(code.co_filename, WORKER)
                        compiled.append(True)
                        real_exec(code, namespace)

                        def main():
                            request = json.load(sys.stdin)
                            self.assertEqual(request, FIXTURE[action]["request"])
                            self.assertNotIn("launch", request)
                            self.assertNotIn("manifest", request)
                            calls.append(request["action"])
                            return 0
                        namespace["main"] = main

                    with patch.object(os, "lstat", lstat), patch.object(os, "open", open_worker), patch.object(os, "fstat", fstat), \
                            patch.object(builtins, "exec", execute), patch.object(sys, "stdin", io.StringIO()), \
                            patch.object(sys, "argv", []), contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as result:
                            real_exec(compile(FIXTURE[action]["script"], "controller", "exec"), {})
                    self.assertEqual(result.exception.code, 0 if defect is None else 1)
                    self.assertEqual(compiled, [True] if defect is None else [])
                    self.assertEqual(calls, [action] if defect is None else [])


if __name__ == "__main__":
    unittest.main()
