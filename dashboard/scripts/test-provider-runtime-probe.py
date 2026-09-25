"""Run generated read-only probes with simulated services/HTTP and real file guards.

No SSH, cloud calls, credentials, sudo or systemd mutations. Temporary local
files exercise the exact no-follow/ownership/mode/type/size reader.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = json.load(sys.stdin)


class Probe(unittest.TestCase):
    def setUp(self):
        self.runtime = "codex"
        self.module = {"__name__": "probe_test"}
        exec(compile(SCRIPTS[self.runtime], "provider-runtime-check.py", "exec"), self.module)
        self.token = "a" * 64
        self.change = None
        self.calls = []
        self.boot_reads = 0
        self.boot_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        self.reboot_during_probe = False

    def run_probe(self, runtime="codex", power=False):
        module = {"__name__": "probe_test"}
        exec(compile(SCRIPTS[runtime + ("-power" if power else "")], "provider-runtime-check.py", "exec"), module)
        identity = module["EXPECTED"]["identity"]
        files = {
            "/var/lib/hivra/provider-install/identity.json": json.dumps(identity).encode(),
            "/var/lib/hivra/provider-install/result.json": json.dumps({"identity": identity, "exitCode": 0}).encode(),
            "/home/bux/.hivra/agent-kind": (runtime + "\n").encode(),
            "/home/bux/.hivra/api-token": self.token.encode(),
            "/proc/sys/kernel/random/boot_id": (self.boot_id + "\n").encode(),
        }
        statuses = {}
        meta = {"agentKind": runtime, "surfaceAuth": "post-cookie-v1"}
        units = {"returncode": 0, "active": True}
        if self.change:
            self.change(files, statuses, meta, units)
        test = self

        class Response:
            def __init__(self, status, data):
                self.status, self.data = status, data

            def read(self, limit):
                return self.data[:limit]

        class Connection:
            def __init__(self, host, port, timeout):
                test.assertEqual(host, "127.0.0.1")
                test.assertIn(port, (8080, 7681, 7682))
                test.assertEqual(timeout, 0.6)
                self.port = port

            def request(self, method, path, headers):
                test.assertEqual(method, "GET")
                test.calls.append((self.port, path, headers))
                self.path, self.headers = path, headers

            def getresponse(self):
                authenticated = self.headers.get("Authorization") == "Bearer " + test.token
                default = 401 if self.path == "/api/model" and not authenticated else 200
                data = json.dumps(meta).encode() if self.path == "/api/meta" else b"ok"
                status = statuses.get((self.port, self.path, authenticated), default)
                if isinstance(status, Exception):
                    raise status
                if status == "oversized":
                    status, data = 200, b"x" * 8193
                return Response(status, data)

            def close(self):
                pass

        def run(args, **options):
            self.assertEqual(args[:2], ["/usr/bin/systemctl", "is-active"])
            self.assertEqual(options["timeout"], 1)
            self.assertFalse(options["check"])
            self.assertEqual(options["stdin"], subprocess.DEVNULL)
            self.assertNotIn("shell", options)
            output = [b"active"] * (len(args) - 2)
            if not units["active"]:
                output[-1] = b"inactive"
            return SimpleNamespace(returncode=units["returncode"], stdout=b"\n".join(output) + b"\n")

        def read_file(path, owner, mode, limit):
            if path == "/proc/sys/kernel/random/boot_id":
                self.assertEqual((owner, mode, limit), (0, 0o444, 64))
                self.boot_reads += 1
                if self.reboot_during_probe and self.boot_reads > 1:
                    return b"cccccccc-cccc-4ccc-8ccc-cccccccccccc\n"
            return files[path]

        with patch.dict(module, {"directory": lambda *_: None, "read_file": read_file, "HTTPConnection": Connection}), \
             patch.object(module["pwd"], "getpwnam", return_value=SimpleNamespace(pw_uid=1001, pw_dir="/home/bux")), \
             patch.object(module["subprocess"], "run", run):
            return module["inspect"]()

    def test_all_catalog_runtimes(self):
        for runtime in (key for key in SCRIPTS if not key.endswith("-power")):
            for power in (False, True):
                self.calls = []
                self.boot_reads = 0
                result = self.run_probe(runtime, power)
                self.assertTrue(result["ready"])
                self.assertEqual(result["apiToken"], self.token)
                self.assertNotIn("reason", result)
                self.assertEqual(result["runtime"], runtime)
                self.assertEqual(result.get("bootId"), self.boot_id if power else None)
                self.assertEqual(self.boot_reads, 2 if power else 0)
                self.assertIn((8080, "/api/model", {}), self.calls)
                self.assertIn((8080, "/api/model", {"Authorization": "Bearer " + self.token}), self.calls)

    def test_failures_return_no_secret(self):
        def corrupt_result(files, *_):
            files["/var/lib/hivra/provider-install/result.json"] = b'{"exitCode":0}'

        def boolean_identity(files, *_):
            item = json.loads(files["/var/lib/hivra/provider-install/identity.json"])
            item["version"] = True
            files["/var/lib/hivra/provider-install/identity.json"] = json.dumps(item).encode()

        cases = [
            (corrupt_result, "installer_unverified"),
            (boolean_identity, "installer_unverified"),
            (lambda f, *_: f.__setitem__("/home/bux/.hivra/agent-kind", b"claude\n"), "runtime_unavailable"),
            (lambda f, s, m, u: u.update(active=False), "runtime_unavailable"),
            (lambda f, s, m, u: u.update(returncode=1), "runtime_unavailable"),
            (lambda f, s, m, u: m.update(agentKind="claude"), "runtime_unavailable"),
            (lambda f, s, m, u: m.update(surfaceAuth="query-token"), "runtime_unavailable"),
            (lambda f, s, *_: s.update({(8080, "/healthz", False): 302}), "runtime_unavailable"),
            (lambda f, s, *_: s.update({(8080, "/api/meta", False): "oversized"}), "runtime_unavailable"),
            (lambda f, s, *_: s.update({(8080, "/api/model", False): 200}), "authentication_unverified"),
            (lambda f, s, *_: s.update({(8080, "/api/model", True): 401}), "authentication_unverified"),
            (lambda f, *_: f.__setitem__("/home/bux/.hivra/api-token", b"PRIVATE_BAD_TOKEN"), "authentication_unverified"),
            (lambda f, s, *_: s.update({(7681, "/terminal/", False): 503}), "native_unavailable"),
            (lambda f, s, *_: s.update({(7682, "/box-terminal/", False): TimeoutError("PRIVATE_MESSAGE")}), "native_unavailable"),
        ]
        for change, reason in cases:
            with self.subTest(reason=reason):
                self.change = change
                result = self.run_probe()
                self.assertFalse(result["ready"])
                self.assertEqual(result["reason"], reason)
                self.assertNotIn("apiToken", result)
                self.assertNotIn("PRIVATE", json.dumps(result))

    def test_native_service_failure_is_not_ready(self):
        self.change = lambda f, s, *_: s.update({(8080, "/aeon/", True): 502})
        self.assertEqual(self.run_probe("aeon")["reason"], "native_unavailable")
        self.change = lambda f, s, *_: s.update({(8080, "/aeon/", True): 308})
        self.assertTrue(self.run_probe("aeon")["ready"])

    def test_unhealthy_runtime_still_proves_original_boot(self):
        self.change = lambda f, s, m, u: u.update(active=False)
        result = self.run_probe(power=True)
        self.assertFalse(result["ready"])
        self.assertEqual(result["reason"], "runtime_unavailable")
        self.assertEqual(result["bootId"], self.boot_id)
        self.assertNotIn("apiToken", result)
        self.assertEqual(self.boot_reads, 2)

    def test_boot_and_installer_failures_do_not_return_boot_or_secret(self):
        for value in (b"", b"not-a-uuid\n", self.boot_id.encode(), (self.boot_id + "\n\n").encode()):
            self.change = lambda f, *_: f.__setitem__("/proc/sys/kernel/random/boot_id", value)
            result = self.run_probe(power=True)
            self.assertFalse(result["ready"])
            self.assertEqual(result["reason"], "boot_unverified")
            self.assertNotIn("bootId", result)
            self.assertNotIn("apiToken", result)
        self.boot_reads = 0
        self.change = lambda f, *_: f.__setitem__("/var/lib/hivra/provider-install/result.json", b'{}')
        result = self.run_probe(power=True)
        self.assertEqual(result["reason"], "installer_unverified")
        self.assertNotIn("bootId", result)
        self.assertEqual(self.boot_reads, 0)

    def test_changed_boot_invalidates_even_a_healthy_runtime_receipt(self):
        self.reboot_during_probe = True
        result = self.run_probe(power=True)
        self.assertEqual(result["reason"], "boot_unverified")
        self.assertFalse(result["ready"])
        self.assertNotIn("bootId", result)
        self.assertNotIn("apiToken", result)

    def test_real_file_guards(self):
        read = self.module["read_file"]
        with tempfile.TemporaryDirectory(prefix="hivra-runtime-reader-") as temporary:
            root = Path(temporary)
            source = root / "token"
            source.write_bytes(self.token.encode())
            source.chmod(0o600)
            owner = os.getuid()
            self.assertEqual(read(str(source), owner, 0o600, 64), self.token.encode())
            with self.assertRaises(ValueError):
                read(str(source), owner + 1, 0o600, 64)
            with self.assertRaises(ValueError):
                read(str(source), owner, 0o600, 63)
            source.chmod(0o644)
            self.assertEqual(read(str(source), owner, (0o600, 0o644), 64), self.token.encode())
            with self.assertRaises(ValueError):
                read(str(source), owner, 0o600, 64)
            source.chmod(0o444)
            self.assertEqual(read(str(source), owner, 0o444, 64), self.token.encode())
            source.chmod(0o600)
            alias = root / "link"
            alias.symlink_to(source)
            with self.assertRaises(OSError):
                read(str(alias), owner, 0o600, 64)
            hard = root / "hard"
            os.link(source, hard)
            with self.assertRaises(ValueError):
                read(str(source), owner, 0o600, 64)
            fifo = root / "fifo"
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError):
                read(str(fifo), owner, 0o600, 64)
            root.chmod(0o777)
            with self.assertRaises(ValueError):
                self.module["directory"](str(root), owner)

    def test_terminal_socket_modes(self):
        # ttyd's libwebsockets creates its socket 0660 (found on a real Ubuntu
        # 24.04 VM). The 0700 bux folder is the boundary, so the probe accepts
        # group bits on the socket and refuses a socket others may connect to.
        import stat as stat_module
        terminal = self.module["terminal"]
        owner = 1001
        answers = []

        class Unix:
            def __init__(self, path, timeout):
                answers.append(path)

            def request(self, method, path):
                self.path = path

            def getresponse(self):
                return SimpleNamespace(status=200)

            def close(self):
                pass

        def fake(folder_mode, socket_mode, socket_uid=owner):
            def lstat(path):
                if path.endswith(".sock"):
                    return os.stat_result((stat_module.S_IFSOCK | socket_mode, 0, 0, 1, socket_uid, 1001, 0, 0, 0, 0))
                return os.stat_result((stat_module.S_IFDIR | folder_mode, 0, 0, 2, owner, 1001, 0, 0, 0, 0))
            return lstat

        for folder_mode, socket_mode in ((0o700, 0o660), (0o700, 0o600), (0o700, 0o755)):
            with patch.object(self.module["os"], "lstat", fake(folder_mode, socket_mode)), \
                 patch.dict(self.module, {"UnixHTTPConnection": Unix}):
                self.assertEqual(terminal(7681, "/terminal/", owner), 200)
        self.assertEqual(answers, ["/run/hivra-terminal/ttyd.sock"] * 3)
        for folder_mode, socket_mode, socket_uid in ((0o700, 0o666, owner), (0o750, 0o660, owner),
                                                     (0o705, 0o600, owner), (0o700, 0o600, owner + 1)):
            with patch.object(self.module["os"], "lstat", fake(folder_mode, socket_mode, socket_uid)), \
                 patch.dict(self.module, {"UnixHTTPConnection": Unix}):
                with self.assertRaises(ValueError):
                    terminal(7682, "/box-terminal/", owner)
        self.assertEqual(len(answers), 3)


if __name__ == "__main__":
    unittest.main()
