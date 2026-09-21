#!/usr/bin/env python3
"""Run actual generated v2 wrappers on disposable local files, never a guest.

Virtualize fixed paths/uid only. Real symlinks, hard links, flags, byte reads,
hashes and compilation remain. The verified module entrypoint is intercepted
before systemd or guest mutation. Current-bundle reads are forbidden whenever
a retained controller should be used.
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
ROOT = "/var/lib/hivra/provider-install"
RETAINED = ROOT + "/controller.py"
CURRENT = "/opt/hivra/provider-bundle/current/hivra-provider-worker.py"
exec(compile(SOURCE, "fixture-native-worker-imports", "exec"), {"__name__": "fixture_native_imports"})


class NativeControllerTest(unittest.TestCase):
    def test_exact_retained_controller_and_rejections(self):
        defects = (None, "current_missing", "current_changed", "before_dispatch", "before_root", "before_parent",
                   "bytes", "size", "mode", "symlink", "hardlink", "owner", "root_mode", "root_symlink",
                   "parent_symlink", "controller_directory", "lstat_denied", "missing_dispatched", "missing_started",
                   "missing_before_dispatch", "changed_before_dispatch")
        for action in ("status", "cancel"):
            for defect in defects:
                with self.subTest(action=action, defect=defect), tempfile.TemporaryDirectory(prefix="hivra-native-controller-") as temporary:
                    root = Path(temporary)
                    retained = root / "retained.py"
                    retained.write_bytes(SOURCE if defect not in ("bytes", "size") else
                                         (b"x" * len(SOURCE) if defect == "bytes" else SOURCE + b"\n"))
                    retained.chmod(0o644 if defect == "mode" else 0o600)
                    current = root / "current.py"
                    current.write_bytes(b"x" * len(SOURCE) if defect in ("current_changed", "changed_before_dispatch") else SOURCE)
                    current.chmod(0o600)
                    if defect == "hardlink":
                        os.link(retained, root / "other.py")
                    if defect == "symlink":
                        link = root / "symlink.py"
                        link.symlink_to(retained)
                        retained = link
                    if defect == "controller_directory":
                        retained = root / "directory"
                        retained.mkdir()
                    real_open, real_lstat, real_fstat, real_exec = os.open, os.lstat, os.fstat, builtins.exec
                    compiled, calls, reads, accessed = [], [], [], []
                    predispatch = defect in ("before_dispatch", "before_root", "before_parent", "missing_before_dispatch", "changed_before_dispatch")
                    success = defect in (None, "current_missing", "current_changed", "before_dispatch", "before_root", "before_parent")
                    expected_path = CURRENT if predispatch else RETAINED

                    def lstat(name):
                        accessed.append(name)
                        if name == RETAINED:
                            if defect == "lstat_denied":
                                raise PermissionError()
                            if predispatch or defect in ("missing_dispatched", "missing_started"):
                                raise FileNotFoundError()
                            return real_lstat(retained)
                        if name in (ROOT + "/dispatch.json", ROOT + "/started.json"):
                            if (defect == "missing_dispatched" and name.endswith("/dispatch.json")) or (defect == "missing_started" and name.endswith("/started.json")):
                                return SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
                            raise FileNotFoundError()
                        self.assertIn(name, ("/", "/var", "/var/lib", "/var/lib/hivra", ROOT, "/opt", "/opt/hivra", "/opt/hivra/provider-bundle", "/opt/hivra/provider-bundle/current"))
                        if (name == ROOT and defect == "before_root") or (name == "/var/lib/hivra" and defect == "before_parent"):
                            raise FileNotFoundError()
                        if (name == ROOT and defect == "root_symlink") or (name == "/var/lib/hivra" and defect == "parent_symlink"):
                            return SimpleNamespace(st_uid=0, st_mode=stat.S_IFLNK | 0o777)
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | (0o777 if name == ROOT and defect == "root_mode" else 0o755))

                    def open_worker(name, flags):
                        self.assertIn(name, (RETAINED, CURRENT))
                        reads.append(name)
                        self.assertEqual(flags, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        if name == CURRENT and defect == "missing_before_dispatch":
                            raise FileNotFoundError()
                        return real_open(retained if name == RETAINED else current, flags)

                    def fstat(fd):
                        info = real_fstat(fd)
                        return SimpleNamespace(st_uid=1 if defect == "owner" else 0,
                                               st_mode=info.st_mode, st_nlink=info.st_nlink, st_size=info.st_size)

                    def execute(code, namespace):
                        self.assertEqual(code.co_filename, expected_path)
                        compiled.append(True)
                        real_exec(code, namespace)

                        def main():
                            request = json.load(sys.stdin)
                            self.assertEqual(request, FIXTURE[action]["request"])
                            self.assertNotIn("launch", request)
                            self.assertNotIn("manifest", request)
                            # Actual Python identity admission must agree with
                            # the TypeScript-generated original v2 identity.
                            self.assertEqual(namespace["identity"](request["identity"]), request["identity"])
                            calls.append(action)
                            return 0
                        namespace["main"] = main

                    with patch.object(os, "lstat", lstat), patch.object(os, "open", open_worker), patch.object(os, "fstat", fstat), \
                            patch.object(builtins, "exec", execute), patch.object(sys, "stdin", io.StringIO()), \
                            patch.object(sys, "argv", []), contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as result:
                            real_exec(compile(FIXTURE[action]["script"], "controller", "exec"), {})
                    self.assertEqual(result.exception.code, 0 if success else 1)
                    self.assertEqual(compiled, [True] if success else [])
                    self.assertEqual(calls, [action] if success else [])
                    if not predispatch:
                        self.assertNotIn(CURRENT, reads)
                        self.assertFalse(any(name.startswith("/opt") for name in accessed))


if __name__ == "__main__":
    unittest.main()
