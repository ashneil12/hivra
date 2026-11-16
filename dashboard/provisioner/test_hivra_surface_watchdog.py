"""Tests for the guest surface watchdog (hivra-surface-watchdog.py).

The wedges this guards against are reproduced here with scripted HTTP/systemctl
fixtures — no real gateway, systemd or network is touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "hivra-surface-watchdog.py"
spec = importlib.util.spec_from_file_location("hivra_surface_watchdog", SCRIPT)
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)

TOKEN = "a" * 64
CSRF = json.dumps({"ok": True, "token": "t" * 43, "runtime_id": "0f" * 8}).encode()
CFG = watchdog.SURFACES["agent-zero"]


class FakeHttp:
    """Scripted answers keyed by URL path; each entry is (status, body) or Exception."""

    def __init__(self):
        self.routes = {}
        self.calls = []

    def set(self, path, status, body=b""):
        self.routes[path] = (status, body)

    def fail(self, path, error="ConnectionRefusedError"):
        self.routes[path] = (None, b"", error)

    def __call__(self, url, token, timeout=8):
        self.calls.append(url)
        for path, answer in self.routes.items():
            if url.endswith(path):
                if len(answer) == 3:
                    return answer
                return answer[0], answer[1], None
        raise AssertionError("unexpected fetch: %s" % url)


class FakeRunner:
    """Scripted systemctl: restart calls recorded; show/list answered per table."""

    def __init__(self, restarts=None, failed=None, files=None, rc=0):
        self.restarts = dict(restarts or {})
        self.failed = set(failed or [])
        self.files = list(files if files is not None else (self.restarts or self.failed or ["bux-hivra-chat.service"]))
        self.rc = rc
        self.restarted = []

    def __call__(self, argv, capture_output=True, text=True, timeout=15):
        class Result:
            pass
        result = Result()
        result.returncode = self.rc
        result.stdout = ""
        if argv[:2] == ["systemctl", "restart"]:
            self.restarted.append(argv[2])
        elif "list-unit-files" in argv:
            result.stdout = "\n".join("%s enabled" % name for name in self.files)
        elif "list-units" in argv:
            result.stdout = "\n".join("%s loaded failed failed" % name for name in sorted(self.failed))
        elif argv[1:2] == ["show"]:
            result.stdout = str(self.restarts.get(argv[2], 0))
        return result


def http_ok():
    http = FakeHttp()
    http.set("/healthz", 200, b"ok")
    return http


NOW = 1_763_000_000


def base_state():
    return {"surface": {"status": "ok", "restarts": 0, "failingSince": None}}


class WatchdogTest(unittest.TestCase):

    def test_healthy_surface_produces_no_events(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 200, CSRF)
        state = base_state()
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=FakeRunner())
        self.assertEqual(state["surface"]["status"], "ok")
        self.assertEqual(state["pendingEvents"], [])

    def test_update_lock_pauses_failure_counting(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 503, b"<html>updating</html>")
        state = base_state()
        state["surface"]["failingSince"] = 400
        # lock_fresh is module-level; patch it for the call.
        original = watchdog.lock_fresh
        watchdog.lock_fresh = lambda now=None: True
        try:
            watchdog.tick(state, NOW + 500, "agent-zero", CFG, TOKEN, http=http, runner=FakeRunner())
        finally:
            watchdog.lock_fresh = original
        self.assertEqual(state["surface"]["status"], "updating")
        self.assertIsNone(state["surface"]["failingSince"])
        self.assertEqual([e["type"] for e in state["pendingEvents"]], [])

    def test_persistent_wedge_restarts_unit_once_per_cooldown(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 502, b"")
        runner = FakeRunner()
        state = base_state()
        # Inside the window: failing, no restart yet.
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        self.assertEqual(state["surface"]["status"], "failing")
        self.assertEqual(runner.restarted, [])
        # Past FAIL_AFTER_S: the unit is restarted once and given grace.
        original = watchdog.FAIL_AFTER_S
        watchdog.FAIL_AFTER_S = 60
        try:
            watchdog.tick(state, NOW + 1070, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            self.assertEqual(runner.restarted, ["hivra-agent-zero.service"])
            event = state["pendingEvents"][-1]
            self.assertEqual(event["type"], "unit_restart")
            self.assertTrue(event["ok"])
            self.assertEqual(event["attempt"], 1)
            # Grace suppresses further counting while the app starts.
            watchdog.tick(state, NOW + 1070 + 10, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            self.assertEqual(len(runner.restarted), 1)
        finally:
            watchdog.FAIL_AFTER_S = original

    def test_restart_attempts_are_bounded_then_exhausted(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 502, b"")
        runner = FakeRunner()
        state = base_state()
        originals = (watchdog.FAIL_AFTER_S, watchdog.RESTART_COOLDOWN_S,
                     watchdog.POST_RESTART_GRACE_S, watchdog.MAX_RESTARTS)
        watchdog.FAIL_AFTER_S = 60
        watchdog.RESTART_COOLDOWN_S = 100
        watchdog.POST_RESTART_GRACE_S = 10
        watchdog.MAX_RESTARTS = 2
        try:
            watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            now = NOW + 1070
            watchdog.tick(state, now, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            now += 200  # cooldown + grace elapsed; still failing
            watchdog.tick(state, now, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            now += 200
            watchdog.tick(state, now, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            self.assertEqual(runner.restarted, ["hivra-agent-zero.service"] * 2)
            exhausted = [e for e in state["pendingEvents"] if e["type"] == "recovery_exhausted"]
            self.assertEqual(len(exhausted), 1)
            self.assertEqual(state["surface"]["status"], "exhausted")
            # No more restarts, but probing continues.
            watchdog.tick(state, now + 10000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
            self.assertEqual(len(runner.restarted), 2)
            self.assertEqual(len([e for e in state["pendingEvents"] if e["type"] == "recovery_exhausted"]), 1)
        finally:
            (watchdog.FAIL_AFTER_S, watchdog.RESTART_COOLDOWN_S,
             watchdog.POST_RESTART_GRACE_S, watchdog.MAX_RESTARTS) = originals

    def test_recovery_emits_event_with_downtime(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 502, b"")
        state = base_state()
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=FakeRunner())
        http.set("/agent-zero/api/csrf_token", 200, CSRF)
        watchdog.tick(state, NOW + 1060, "agent-zero", CFG, TOKEN, http=http, runner=FakeRunner())
        recovered = [e for e in state["pendingEvents"] if e["type"] == "recovered"]
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["unit"], "hivra-agent-zero.service")
        self.assertEqual(state["surface"]["status"], "ok")

    def test_gateway_outage_is_reported_not_restarted(self):
        http = FakeHttp()
        http.fail("/healthz")
        runner = FakeRunner()
        state = base_state()
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        self.assertEqual(state["surface"]["status"], "gateway_down")
        self.assertEqual(runner.restarted, [])
        self.assertEqual([e["type"] for e in state["pendingEvents"]], ["gateway_down"])
        # Probe must not even be attempted while the gateway is out.
        self.assertTrue(all(call.endswith("/healthz") for call in http.calls))

    def test_csrf_contract_is_strict(self):
        http = http_ok()
        for body, want in [
            (b'{"ok":true,"token":"%s","runtime_id":"%s"}' % (b"t" * 42, b"0f" * 8), "csrf token failed the contract"),
            (b'{"ok":true,"token":"%s","runtime_id":"%s"}' % (b"t" * 43, b"0f" * 7), "csrf runtime id failed the contract"),
            (b"not json", "csrf answer was not JSON"),
            (b'{"ok":false}', "csrf answer failed the contract"),
        ]:
            http.set("/agent-zero/api/csrf_token", 200, body)
            self.assertEqual(watchdog.probe_surface("agent-zero", CFG, TOKEN, http=http), want)

    def test_failed_unit_is_reported_once_per_cooldown(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 200, CSRF)
        runner = FakeRunner(restarts={"bux-browser-keeper.service": 3864},
                            failed={"bux-browser-keeper.service"},
                            files=["bux-hivra-chat.service", "bux-browser-keeper.service"])
        state = base_state()
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        events = [e for e in state["pendingEvents"] if e["type"] == "unit_failing"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["unit"], "bux-browser-keeper.service")
        self.assertEqual(events[0]["reason"], "failed")
        self.assertEqual(events[0]["nRestarts"], 3864)
        # Same state next cycle: no duplicate report.
        state["pendingEvents"] = []
        watchdog.tick(state, NOW + 1060, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        self.assertEqual([e for e in state["pendingEvents"] if e["type"] == "unit_failing"], [])

    def test_climbing_restart_counter_is_a_crash_loop(self):
        http = http_ok()
        http.set("/agent-zero/api/csrf_token", 200, CSRF)
        runner = FakeRunner(restarts={"bux-browser-keeper.service": 10},
                            files=["bux-hivra-chat.service", "bux-browser-keeper.service"])
        state = base_state()
        watchdog.tick(state, NOW + 1000, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        self.assertEqual([e for e in state["pendingEvents"] if e["type"] == "unit_failing"], [])
        runner.restarts["bux-browser-keeper.service"] = 13
        watchdog.tick(state, NOW + 1060, "agent-zero", CFG, TOKEN, http=http, runner=runner)
        events = [e for e in state["pendingEvents"] if e["type"] == "unit_failing"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["reason"], "restarting")
        self.assertEqual(events[0]["nRestarts"], 13)

    def test_entry_probe_kinds(self):
        http = http_ok()
        cfg = watchdog.SURFACES["aeon"]
        http.set("/aeon/", 200, b"<html>ok</html>")
        self.assertEqual(watchdog.probe_surface("aeon", cfg, TOKEN, http=http), "ok")
        http.set("/aeon/", 503, b"<html>updating</html>")
        self.assertNotEqual(watchdog.probe_surface("aeon", cfg, TOKEN, http=http), "ok")

    def test_probe_marks_itself_so_the_gateway_does_not_count_it_as_use(self):
        # Real sockets: the gateway exempts the probe from use-tracking only
        # because this header arrives from a loopback peer — without it the
        # watchdog keeps the app "in use" forever and managed updates starve.
        import http.server
        import threading
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(dict(self.headers))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")
            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, _body, error = watchdog.http_get("http://127.0.0.1:%d/aeon/" % server.server_port, TOKEN)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(seen[0].get("X-Hivra-Surface-Watchdog"), "1")
        self.assertEqual(seen[0].get("Authorization"), "Bearer " + TOKEN)

    def test_state_round_trip_and_events_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = (watchdog.STATE_DIR, watchdog.STATE_FILE, watchdog.EVENTS_FILE)
            watchdog.STATE_DIR = tmp
            watchdog.STATE_FILE = os.path.join(tmp, "state.json")
            watchdog.EVENTS_FILE = os.path.join(tmp, "events.jsonl")
            try:
                state = base_state()
                event = watchdog.append_event(state, "unit_restart", {"unit": "x.service", "ok": True})
                watchdog.write_state(state)
                loaded = watchdog.load_state()
                self.assertEqual(loaded["surface"]["status"], "ok")
                with open(watchdog.EVENTS_FILE) as handle:
                    lines = handle.read().splitlines()
                self.assertEqual(len(lines), 1)
                record = json.loads(lines[0])
                self.assertEqual(record["id"], event["id"])
                self.assertEqual(record["type"], "unit_restart")
            finally:
                watchdog.STATE_DIR, watchdog.STATE_FILE, watchdog.EVENTS_FILE = original


if __name__ == "__main__":
    unittest.main()
