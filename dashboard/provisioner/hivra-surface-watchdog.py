#!/usr/bin/env python3
# hivra-surface-watchdog.py — watchdog for wedged agent surfaces.
#
# Runs on every Hivra agent computer. Every POLL_S it:
#
#   1. Honours the managed agent-app update window the gateway uses: while
#      /run/hivra-agent-app-update.lock is fresh (< 30 min) the app is
#      legitimately down for its swap and the gateway's "updating" hold page is
#      correct, so nothing is counted as a failure.
#   2. Probes the agent's real user path through the local hivra-chat gateway —
#      for Agent Zero GET /agent-zero/api/csrf_token, which forces the gateway
#      to sign the box session in, fetch the entry document and validate the
#      CSRF contract end to end. A /healthz-only check is not the user path:
#      the wedge this was written for left the app unserved for hours while
#      the box itself answered health checks.
#   3. When the probe fails continuously past FAIL_AFTER_S, restarts the owning
#      service — at most once per RESTART_COOLDOWN_S and MAX_RESTARTS times per
#      episode. A gateway outage is reported, never answered with an app
#      restart (it would not help).
#   4. Scans systemd for failed units and crash loops (a watched unit whose
#      restart counter is still climbing) so they stop failing silently.
#
# Every action lands in STATE_DIR/events.jsonl and the last known state in
# STATE_DIR/state.json. The gateway's /api/surface-watchdog serves both to the
# dashboard sweep, which relays them to ops_events.
#
# Stdlib only; runs under `python3 -I -B`.

import hashlib
import http.client
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

POLL_S = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_POLL_S") or 30)
# A self-update restart resolves in seconds; a managed update holds its lock.
# Past this window an unanswered surface is a wedge, not an update.
FAIL_AFTER_S = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_FAIL_AFTER_S") or 600)
RESTART_COOLDOWN_S = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_RESTART_COOLDOWN_S") or 900)
MAX_RESTARTS = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_MAX_RESTARTS") or 3)
# A restarted app gets this long to serve again before failures count again.
# (Agent Zero's container cold start can take minutes.)
POST_RESTART_GRACE_S = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_POST_RESTART_GRACE_S") or 180)
UPDATE_LOCK = os.environ.get("HIVRA_AGENT_APP_LOCK") or "/run/hivra-agent-app-update.lock"
UPDATE_LOCK_FRESH_S = 30 * 60
STATE_DIR = os.environ.get("HIVRA_SURFACE_WATCHDOG_DIR") or "/var/lib/hivra/surface-watchdog"
# The unit runs as root but the box credentials live in the agent user's home,
# which the unit sets explicitly (HOME alone is not it).
AGENT_HOME = os.environ.get("HIVRA_AGENT_HOME") or os.environ.get("HOME") or "/root"
STATE_FILE = os.path.join(STATE_DIR, "state.json")
EVENTS_FILE = os.path.join(STATE_DIR, "events.jsonl")
EVENTS_MAX_LINES = 200
EVENTS_MAX_BYTES = 256 * 1024
UNIT_REPORT_COOLDOWN_S = int(os.environ.get("HIVRA_SURFACE_WATCHDOG_UNIT_REPORT_COOLDOWN_S") or 21600)
WATCH_UNIT_PREFIXES = ("bux-", "hivra-")
HTTP_TIMEOUT_S = 8
GATEWAY_PORT = os.environ.get("HIVRA_CHAT_PORT") or "8080"
GATEWAY_ORIGIN = "http://127.0.0.1:%s" % GATEWAY_PORT
AGENT_ZERO_LOGIN = "agent-zero-runtime-login.json"
AGENT_ZERO_CONFIG_LIMIT = 1024 * 1024
AGENT_ZERO_DOTENV = """
import io
import json
import os
import stat
from dotenv import dotenv_values

with os.fdopen(os.open("/a0/usr/.env", os.O_RDONLY | os.O_NONBLOCK), "rb") as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
        raise SystemExit(1)
    config = source.read(1024 * 1024 + 1)
    if len(config) > 1024 * 1024:
        raise SystemExit(1)
values = dotenv_values(stream=io.StringIO(config.decode("utf-8")))
print(json.dumps({"login": values.get("AUTH_LOGIN"), "password": values.get("AUTH_PASSWORD")}, ensure_ascii=False))
"""
agent_zero_synced_digest = None

# Each agent-app kind's real user path through the gateway and the unit that
# owns it. agent-zero is the deep check (login -> entry -> CSRF contract); the
# other kinds' mounted entry through the gateway already proves the upstream
# answers (a dropped upstream is the hold page / a 5xx, not a document).
SURFACES = {
    "agent-zero": {"unit": "hivra-agent-zero.service", "probe": "/agent-zero/api/csrf_token", "check": "csrf"},
    "aeon": {"unit": "bux-aeon.service", "probe": "/aeon/", "check": "entry"},
    "openclaw": {"unit": "bux-openclaw.service", "probe": "/openclaw/", "check": "entry"},
    "openbot": {"unit": "hivra-openbot.service", "probe": "/openbot/", "check": "entry"},
    "nuphos": {"unit": "hivra-nuphos.service", "probe": "/nuphos/", "check": "entry"},
    "catalog-app": {"unit": "hivra-catalog-app.service", "probe": "/app/", "check": "entry"},
    "hermes": {"unit": "bux-hermes.service", "probe": "/hermes/", "check": "entry"},
}

TOKEN_FILE = os.path.join(AGENT_HOME, ".hivra", "api-token")
KIND_FILE = os.path.join(AGENT_HOME, ".hivra", "agent-kind")
# The gateway exempts a marked probe from app-use tracking only when the header
# carries this box-local secret (root reads it; bux's gateway reads it; a
# proxied remote caller cannot know it). Absent -> probes count as use.
KEY_FILE = os.path.join(AGENT_HOME, ".hivra", "surface-watchdog-key")
CSRF_TOKEN = re.compile(r"^.{43}$")
CSRF_RUNTIME_ID = re.compile(r"^[0-9a-f]{16}$")
UNIT_NAME = re.compile(r"^[A-Za-z0-9_.@:-]{1,128}\.service$")


def read_trimmed(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8", errors="replace") as handle:
            state = json.load(handle)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


AGENT_GID = None


def agent_gid():
    # The agent user's group: the bux gateway reads these receipts for the
    # dashboard's GET /api/surface-watchdog.
    global AGENT_GID
    if AGENT_GID is None:
        try:
            AGENT_GID = os.stat(AGENT_HOME).st_gid
        except OSError:
            AGENT_GID = -1
    return AGENT_GID


def share_with_agent(path):
    """Owner-only receipts must stay unreadable by other users except bux."""
    try:
        gid = agent_gid()
        if gid >= 0:
            os.chown(path, -1, gid)
        os.chmod(path, 0o640)
    except OSError:
        pass


def write_state(state):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="state.", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
        share_with_agent(tmp)
        os.replace(tmp, STATE_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_event(state, kind, detail):
    seq = state.get("eventSeq", 0) + 1
    state["eventSeq"] = seq
    at = detail.pop("at", None)
    event = {"id": "e%d-%d" % (int(time.time() * 1000), seq), "at": at or iso_now(), "type": kind}
    event.update(detail)
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    try:
        lines = []
        try:
            with open(EVENTS_FILE, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.read().splitlines()
        except OSError:
            pass
        lines.append(json.dumps(event, sort_keys=True))
        if len(lines) > EVENTS_MAX_LINES or sum(len(line) for line in lines) > EVENTS_MAX_BYTES:
            lines = lines[-EVENTS_MAX_LINES:]
        fd, tmp = tempfile.mkstemp(prefix="events.", dir=STATE_DIR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        share_with_agent(tmp)
        os.replace(tmp, EVENTS_FILE)
    except OSError:
        pass
    return event


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % (int(time.time() * 1000) % 1000)


def lock_fresh(now=None):
    try:
        return (now if now is not None else time.time()) - os.stat(UPDATE_LOCK).st_mtime < UPDATE_LOCK_FRESH_S
    except OSError:
        return False


def http_get(url, token, timeout=HTTP_TIMEOUT_S):
    """(status, body_bytes, error) — error set on transport failure."""
    headers = {
        "Accept": "application/json, text/html",
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-store",
    }
    # The gateway counts authenticated app requests as use; a probe must not
    # keep the app "in use" and starve a managed update's idle window. It
    # exempts the probe only when the marker carries the box-local key.
    key = read_trimmed(KEY_FILE)
    if key:
        headers["X-Hivra-Surface-Watchdog"] = key
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(65536), None
    except urllib.error.HTTPError as error:
        try:
            body = error.read(4096)
        except Exception:
            body = b""
        return error.code, body, None
    except Exception as error:  # refused, reset, DNS, timeout — all "no answer"
        return None, b"", type(error).__name__


def gateway_up(http=http_get):
    status, body, error = http(GATEWAY_ORIGIN + "/healthz", "")
    return status == 200 and body.strip() == b"ok"


def agent_zero_docker(*args):
    # The upstream dotenv parser runs inside the managed container. Host root
    # never follows a path from the container's writable settings directory.
    result = subprocess.run(
        ["/usr/bin/docker", *args], capture_output=True, text=True, timeout=5, check=False,
    )
    return result.stdout if result.returncode == 0 and len(result.stdout.encode()) <= AGENT_ZERO_CONFIG_LIMIT else ""


def read_agent_zero_runtime_login():
    return agent_zero_docker(
        "exec", "hivra-agent-zero", "/bin/sh", "-c",
        'if [ -x /opt/venv-a0/bin/python ]; then exec /opt/venv-a0/bin/python "$@"; fi; exec /opt/venv/bin/python "$@"',
        "hivra-agent-zero-credentials", "-I", "-B", "-c", AGENT_ZERO_DOTENV,
    )


def agent_zero_login_accepted(port, pair):
    body = urllib.parse.urlencode({"username": pair["login"], "password": pair["password"], "next": "/"})
    client = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
    try:
        client.request("POST", "/login", body, {"Content-Type": "application/x-www-form-urlencoded"})
        response = client.getresponse()
        return (
            response.status in (302, 303)
            and response.getheader("Location") == "/"
            and any(
                name.lower() == "set-cookie" and re.match(r"^session(?:_[0-9a-f]{16})?=[^;\s]+", value)
                for name, value in response.getheaders()
            )
        )
    finally:
        client.close()


def sync_agent_zero_login():
    global agent_zero_synced_digest
    try:
        raw = read_agent_zero_runtime_login()
        digest = hashlib.sha256(raw.encode()).digest()
        if digest == agent_zero_synced_digest:
            return
        pair = json.loads(raw)
        if (not isinstance(pair, dict) or set(pair) != {"login", "password"}
                or any(not isinstance(value, str) or not value for value in pair.values())):
            return
        # Check that the expected, loopback-only port is published, then prove
        # the running app accepts this pair. A partial settings save may not.
        mapping = agent_zero_docker("port", "hivra-agent-zero", "80/tcp").strip()
        port = re.fullmatch(r"127\.0\.0\.1:(\d{1,5})", mapping)
        if not port or not 0 < int(port[1]) <= 65535 or not agent_zero_login_accepted(int(port[1]), pair):
            return
        if lock_fresh() or raw != read_agent_zero_runtime_login():
            return
        write_agent_zero_login(pair)
        agent_zero_synced_digest = digest
    except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException):
        # Fail closed and try the next normal poll. Exception payloads can
        # contain a fragment of an upstream response or parsed credential.
        return


def write_agent_zero_login(pair):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    home = os.open(AGENT_HOME, flags)
    try:
        directory = os.open(".hivra", flags, dir_fd=home)
        try:
            owner = os.fstat(directory)
            if owner.st_uid != os.fstat(home).st_uid or owner.st_mode & 0o022:
                raise PermissionError("unsafe Agent Zero credential directory")
            temp = ".agent-zero-login-" + secrets.token_hex(8)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    os.fchown(handle.fileno(), owner.st_uid, owner.st_gid)
                    json.dump(pair, handle, ensure_ascii=False)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, AGENT_ZERO_LOGIN, src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temp, dir_fd=directory)
                except FileNotFoundError:
                    pass
        finally:
            os.close(directory)
    finally:
        os.close(home)


def probe_surface(kind, cfg, token, http=http_get):
    """ProbeResult: "ok" | (why it failed). Never raises."""
    status, body, error = http(GATEWAY_ORIGIN + cfg["probe"], token)
    if error is not None:
        return "no answer: %s" % error
    if cfg["check"] == "csrf":
        if status != 200:
            return "csrf answered HTTP %s" % status
        try:
            doc = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return "csrf answer was not JSON"
        if not isinstance(doc, dict) or doc.get("ok") is not True:
            return "csrf answer failed the contract"
        if not CSRF_TOKEN.match(str(doc.get("token") or "")):
            return "csrf token failed the contract"
        if not CSRF_RUNTIME_ID.match(str(doc.get("runtime_id") or "")):
            return "csrf runtime id failed the contract"
        return "ok"
    # "entry": the mounted document through the gateway. A dropped upstream is
    # the updating hold page (503) or a proxy 5xx — both count as down.
    if 200 <= status < 400:
        return "ok"
    return "entry answered HTTP %s" % status


def run_systemctl(args, runner=subprocess.run):
    try:
        result = runner(["systemctl"] + args, capture_output=True, text=True, timeout=15)
        return result.returncode, result.stdout or ""
    except Exception:
        return 1, ""


def failed_units(runner=subprocess.run):
    """Units currently in the failed state."""
    rc, out = run_systemctl(["list-units", "--all", "--state=failed", "--no-legend", "--plain"], runner)
    units = []
    for line in out.splitlines():
        name = line.split(None, 1)[0] if line.split() else ""
        if UNIT_NAME.match(name):
            units.append(name)
    return units


def unit_restarts(name, runner=subprocess.run):
    rc, out = run_systemctl(["show", name, "--property=NRestarts", "--value"], runner)
    if rc != 0:
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def watched_units(runner=subprocess.run):
    """Watched hivra/bux units that exist on this box."""
    rc, out = run_systemctl(["list-unit-files", "--no-legend", "--plain"], runner)
    names = set()
    for line in out.splitlines():
        name = line.split(None, 1)[0] if line.split() else ""
        if UNIT_NAME.match(name) and name.startswith(WATCH_UNIT_PREFIXES):
            names.add(name)
    return names


def scan_units(state, events, now, runner=subprocess.run):
    """Failed units and still-climbing restart counters -> unit_failing events."""
    known = state.setdefault("units", {})
    failing = set(failed_units(runner))
    for name in sorted(watched_units(runner) | failing):
        restarts = unit_restarts(name, runner)
        previous = known.get(name) or {}
        was = previous.get("nRestarts")
        reported_at = previous.get("reportedAt", 0)
        reason = None
        if name in failing:
            reason = "failed"
        elif was is not None and restarts is not None and restarts > was:
            reason = "restarting"
        current = {"nRestarts": restarts, "failed": name in failing, "reportedAt": reported_at}
        if reason and now - reported_at >= UNIT_REPORT_COOLDOWN_S:
            current["reportedAt"] = now
            events.append({
                "type": "unit_failing", "unit": name,
                "reason": reason,
                "nRestarts": restarts,
            })
        known[name] = current
    # Units that recovered stop counting as failures on the next report.
    for name, entry in list(known.items()):
        if name not in failing and entry.get("failed"):
            entry["failed"] = False
    # state.json is served through a bounded read: keep the units map small.
    if len(known) > 40:
        stale = sorted(known.items(), key=lambda item: item[1].get("reportedAt", 0))
        for name, _ in stale[: len(known) - 40]:
            if name not in failing:
                del known[name]


def tick(state, now, kind, cfg, token, http=http_get, runner=subprocess.run):
    """One watchdog cycle. Appends reportable events to state["pendingEvents"]."""
    events = state.setdefault("pendingEvents", [])
    surface = state.setdefault("surface", {"status": "unknown", "restarts": 0})

    if not gateway_up(http):
        if surface.get("status") != "gateway_down":
            surface["status"] = "gateway_down"
            events.append({"type": "gateway_down", "unit": "bux-hivra-chat.service"})
        surface["failingSince"] = None
        surface["reason"] = "gateway unreachable"
        # Unit failures keep recording while the gateway is down: the sweep
        # cannot read the endpoint now, but the receipts land on recovery.
        scan_units(state, events, now, runner)
        return

    if not cfg:
        # A kind with no agent-app surface: unit scanning only.
        if surface.get("status") == "gateway_down":
            events.append({"type": "gateway_recovered", "unit": "bux-hivra-chat.service"})
        surface["status"] = "not_applicable"
        scan_units(state, events, now, runner)
        return

    if lock_fresh(now):
        # Managed app update window: the hold page is correct, count nothing.
        surface["status"] = "updating"
        surface["failingSince"] = None
        scan_units(state, events, now, runner)
        return

    if kind == "agent-zero":
        sync_agent_zero_login()
    reason = probe_surface(kind, cfg, token, http)

    if reason == "ok":
        if surface.get("status") == "gateway_down":
            events.append({"type": "gateway_recovered", "unit": "bux-hivra-chat.service"})
        if surface.get("status") in ("failing", "restarting", "exhausted") or surface.get("failingSince"):
            events.append({
                "type": "recovered", "unit": cfg["unit"], "kind": kind,
                "downForS": round(now - (surface.get("failingSince") or now)),
                "restarts": surface.get("restarts", 0),
            })
        surface.update({"status": "ok", "failingSince": None, "restarts": 0, "reason": None})
        scan_units(state, events, now, runner)
        return

    # Probe failed.
    grace_until = surface.get("graceUntil") or 0
    if now < grace_until:
        surface["status"] = "restarting"
        surface["reason"] = reason
        scan_units(state, events, now, runner)
        return

    failing_since = surface.get("failingSince")
    if failing_since is None:
        surface["failingSince"] = now
        surface["status"] = "failing"
        surface["reason"] = reason
        scan_units(state, events, now, runner)
        return

    surface["reason"] = reason
    down_for = now - failing_since
    if down_for < FAIL_AFTER_S:
        surface["status"] = "failing"
        scan_units(state, events, now, runner)
        return

    # Past the bounded window: restart the owning unit, bounded too.
    last_restart = surface.get("lastRestartAt") or 0
    restarts = surface.get("restarts") or 0
    if restarts >= MAX_RESTARTS:
        if surface.get("status") != "exhausted":
            surface["status"] = "exhausted"
            events.append({
                "type": "recovery_exhausted", "unit": cfg["unit"], "kind": kind,
                "downForS": round(down_for), "restarts": restarts, "reason": reason,
            })
        scan_units(state, events, now, runner)
        return
    if now - last_restart < RESTART_COOLDOWN_S:
        surface["status"] = "failing"
        scan_units(state, events, now, runner)
        return

    rc, _ = run_systemctl(["restart", cfg["unit"]], runner)
    surface["lastRestartAt"] = now
    surface["restarts"] = restarts + 1
    surface["graceUntil"] = now + POST_RESTART_GRACE_S
    surface["status"] = "restarting"
    events.append({
        "type": "unit_restart", "unit": cfg["unit"], "kind": kind,
        "ok": rc == 0, "downForS": round(down_for), "reason": reason,
        "attempt": surface["restarts"],
    })
    scan_units(state, events, now, runner)


def flush_events(state):
    pending = state.pop("pendingEvents", [])
    for event in pending:
        detail = {k: v for k, v in event.items() if k != "type"}
        append_event(state, event["type"], detail)


def main():
    kind = read_trimmed(KIND_FILE).lower()
    cfg = SURFACES.get(kind)
    token = read_trimmed(TOKEN_FILE)
    if kind in SURFACES and not re.match(r"^[0-9a-f]{64}$", token):
        sys.stderr.write("hivra-surface-watchdog: %s is missing or malformed\n" % TOKEN_FILE)
        sys.exit(1)
    sys.stderr.write("hivra-surface-watchdog: watching %s%s\n"
                     % (kind or "unknown", " (%s)" % cfg["unit"] if cfg else ""))
    while True:
        now = time.time()
        state = load_state()
        state["agentKind"] = kind or None
        try:
            tick(state, now, kind, cfg, token)
        except Exception as error:  # a watchdog must never die on one cycle
            state.setdefault("pendingEvents", []).append({"type": "watchdog_error", "reason": repr(error)[:200]})
        state["updatedAt"] = iso_now()
        try:
            flush_events(state)
        except Exception:
            pass
        try:
            write_state(state)
        except OSError:
            pass
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
