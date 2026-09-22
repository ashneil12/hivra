import { buildHermesTuiBootstrapCommand } from "../hermes-tui-bootstrap";
const HERMES_TUI_BOOTSTRAP_COMMAND = buildHermesTuiBootstrapCommand();
const TERMINAL_PTY_HELPER_CODE = String.raw`import base64
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def clamp_int(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except Exception:
        return default
    return max(minimum, min(maximum, parsed))


def set_window_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        return True
    except OSError:
        return False


command = os.environ.get("HERMES_TERMINAL_COMMAND", "")
if not command:
    emit({"type": "error", "message": "Missing terminal command"})
    sys.exit(1)

cols = clamp_int(os.environ.get("HERMES_TERMINAL_COLS", "80"), 80, 10, 500)
rows = clamp_int(os.environ.get("HERMES_TERMINAL_ROWS", "24"), 24, 2, 200)
master_fd, slave_fd = pty.openpty()
set_window_size(slave_fd, rows, cols)

process = subprocess.Popen(
    ["/bin/sh", "-lc", command],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    start_new_session=True,
    close_fds=True,
)
os.close(slave_fd)

selector = selectors.DefaultSelector()
selector.register(master_fd, selectors.EVENT_READ, "pty")
selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")
pty_open = True
stdin_open = True
stopping = False

while True:
    if process.poll() is not None and not pty_open:
        break

    events = selector.select(timeout=0.1)
    if not events and process.poll() is not None and not stdin_open:
        break

    for key, _ in events:
        if key.data == "pty":
            try:
                chunk = os.read(master_fd, 65536)
            except OSError:
                chunk = b""

            if chunk:
                emit({"type": "output", "data": base64.b64encode(chunk).decode("ascii")})
            else:
                try:
                    selector.unregister(master_fd)
                except Exception:
                    pass
                try:
                    os.close(master_fd)
                except OSError:
                    pass
                pty_open = False
        else:
            line = sys.stdin.buffer.readline()
            if not line:
                stdin_open = False
                continue

            try:
                message = json.loads(line.decode("utf-8"))
            except Exception:
                continue

            message_type = message.get("type")

            if message_type == "input":
                data = message.get("data", "")
                if not isinstance(data, str) or not data:
                    continue
                try:
                    decoded = base64.b64decode(data.encode("ascii"))
                except Exception:
                    continue
                try:
                    os.write(master_fd, decoded)
                except OSError:
                    stdin_open = False
                    break
            elif message_type == "resize":
                cols = clamp_int(message.get("cols", cols), cols, 10, 500)
                rows = clamp_int(message.get("rows", rows), rows, 2, 200)
                set_window_size(master_fd, rows, cols)
                try:
                    os.killpg(process.pid, signal.SIGWINCH)
                except OSError:
                    pass
            elif message_type == "stop":
                stopping = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except OSError:
                    pass
                stdin_open = False

    if stopping and process.poll() is not None:
        break

if process.poll() is None:
    try:
        process.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass

return_code = process.wait()
exit_code = return_code
signal_name = None

if return_code is not None and return_code < 0:
    exit_code = None
    try:
        signal_name = signal.Signals(-return_code).name
    except Exception:
        signal_name = str(-return_code)

emit({"type": "closed", "exitCode": exit_code, "signal": signal_name})
`;

// Native terminals use the same sidecar event/control protocol, but launch an
// argv-pinned Docker exec instead of the legacy shell command. Keep this helper
// separate so gateway-only/legacy terminals retain their existing semantics.
export const DESKTOP_TERMINAL_PTY_HELPER_CODE = String.raw`import base64
from collections import deque
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time

def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

argv = json.loads(os.environ["HERMES_TERMINAL_ARGV"])
marker = os.environ["HERMES_TERMINAL_MARKER"].encode("ascii")
if not isinstance(argv, list) or not argv or any(not isinstance(value, str) for value in argv):
    raise ValueError("Invalid native terminal argv")
master, slave = pty.openpty()
def resize(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
resize(os.environ["HERMES_TERMINAL_ROWS"], os.environ["HERMES_TERMINAL_COLS"])
process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, "pty")
stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
os.set_blocking(master, False)
selector.register(stdin_fd, selectors.EVENT_READ, "stdin")
stopping = False
ready = False
startup = b""
control_buffer = b""
controls = deque()
exited_at = None
prefix = b"\x1eHIVRA_READY:" + marker + b":"
def stop(_signum=None, _frame=None):
    global stopping
    stopping = True
for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(signum, stop)

def accept_controls(data):
    global control_buffer
    control_buffer += data
    if len(control_buffer) > 65536:
        raise ValueError("Native terminal control buffer exceeded limit")
    while b"\n" in control_buffer:
        line, control_buffer = control_buffer.split(b"\n", 1)
        if len(line) > 8192 or len(controls) >= 128:
            raise ValueError("Native terminal control limit exceeded")
        message = json.loads(line)
        kind = message.get("type")
        if kind == "stop":
            stop()
            return
        if kind == "resize":
            rows, cols = message["rows"], message["cols"]
            if not isinstance(rows, int) or not isinstance(cols, int) or not (2 <= rows <= 200 and 10 <= cols <= 500):
                raise ValueError("Invalid native terminal size")
            controls.append(("resize", (rows, cols)))
        elif kind == "input":
            decoded = base64.b64decode(message["data"], validate=True)
            if not decoded or len(decoded) > 4096:
                raise ValueError("Invalid native terminal input")
            controls.append(("input", decoded))
        else:
            raise ValueError("Invalid native terminal control")

def flush_controls():
    while controls and not stopping:
        kind, value = controls[0]
        if kind == "resize":
            resize(*value)
            # The Docker client owns a new session, not this PTY's controlling
            # foreground group. Explicit WINCH makes it forward the new size.
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass
            controls.popleft()
            continue
        try:
            written = os.write(master, value)
        except BlockingIOError:
            break
        if written == len(value):
            controls.popleft()
        else:
            controls[0] = ("input", value[written:])
            break
    selector.modify(master, selectors.EVENT_READ | (selectors.EVENT_WRITE if controls else 0), "pty")

try:
    while not stopping:
        for key, events in selector.select(timeout=0.05):
            if key.data == "stdin":
                try:
                    data = os.read(stdin_fd, 65536)
                except BlockingIOError:
                    continue
                if not data:
                    stop()
                    break
                accept_controls(data)
                flush_controls()
            else:
                if events & selectors.EVENT_WRITE:
                    flush_controls()
                if not events & selectors.EVENT_READ:
                    continue
                try:
                    data = os.read(master, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""
                if not data:
                    stop()
                    break
                if not ready:
                    startup += data
                    if len(startup) > 32768:
                        raise ValueError("Native terminal startup output exceeded limit")
                    begin = startup.find(prefix)
                    end = startup.find(b"\x1f", begin + len(prefix)) if begin >= 0 else -1
                    if end < 0:
                        continue
                    pid = int(startup[begin + len(prefix):end])
                    if pid <= 1:
                        raise ValueError("Invalid native terminal process identity")
                    emit({"type": "ready", "marker": marker.decode("ascii"), "pid": pid})
                    data = startup[:begin] + startup[end + 1:]
                    startup = b""
                    ready = True
                if data:
                    emit({"type": "output", "data": base64.b64encode(data).decode("ascii")})
        if process.poll() is not None:
            # A process can exit before its final PTY bytes become readable.
            # Drain to EOF, with a bounded grace if a descendant kept it open.
            if exited_at is None:
                exited_at = time.monotonic()
            elif time.monotonic() - exited_at >= 0.5:
                stop()
finally:
    selector.close()
    os.close(master)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=0.25)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    code = process.wait()
    emit({"type": "closed", "exitCode": code if code >= 0 else None, "signal": signal.Signals(-code).name if code < 0 else None})
`;

// Runs as the configured non-root user inside one already-verified container.
// pidfds pin process identity across /proc reads and signal delivery; a reused
// numeric PID must never cause an unrelated shell to receive a signal.
export const DESKTOP_TERMINAL_PROCESS_CODE = String.raw`import json
import os
import re
import select
import signal
import sys
import time

def start_ticks(pid):
    # Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. It is
    # readable even for non-dumpable processes whose environment is not.
    with open("/proc/" + str(pid) + "/stat", "rb") as source:
        raw = source.read(4096)
    fields = raw[raw.rindex(b")") + 2:].split()
    value = int(fields[19])
    if value < 0:
        raise RuntimeError("Invalid process start time")
    return value

def owned_processes(marker, uid, started_after):
    result = []
    try:
        for name in os.listdir("/proc"):
            if not name.isdecimal():
                continue
            fd = None
            try:
                process_dir = "/proc/" + name
                if os.stat(process_dir).st_uid != uid:
                    continue
                fd = os.pidfd_open(int(name), 0)
                if select.select([fd], [], [], 0)[0]:
                    continue
                try:
                    with open(process_dir + "/environ", "rb") as source:
                        environment = source.read(262145)
                except PermissionError:
                    # A same-user process the kernel will not let us inspect
                    # (non-dumpable, e.g. a setuid sandbox helper or the user's
                    # systemd manager). It cannot descend from this terminal if
                    # it started before the terminal preflight; ignore only
                    # those, and fail closed on anything newer.
                    started = start_ticks(name)
                    if select.select([fd], [], [], 0)[0]:
                        continue
                    if started < started_after:
                        continue
                    raise
                if len(environment) > 262144:
                    raise RuntimeError("Process environment exceeds inspection limit")
                if b"HIVRA_DESKTOP_TERMINAL_ID=" + marker in environment.split(b"\0"):
                    result.append(fd)
                    fd = None
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        return result
    except Exception:
        for fd in result:
            os.close(fd)
        raise

def main():
    uid = os.getuid()
    if uid == 0 or os.geteuid() != uid:
        raise RuntimeError("A non-root default user is required")
    fd = os.pidfd_open(os.getpid(), 0)
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    if sys.argv[1] == "--preflight":
        if not os.access("/bin/bash", os.X_OK):
            raise RuntimeError("Native shell is unavailable")
        print(json.dumps({"uid": uid, "cwd": os.getcwd(), "shell": "/bin/bash", "pidfd": True,
                          "startTicks": start_ticks(os.getpid())}))
        return
    if (sys.argv[1] != "--cleanup" or len(sys.argv) != 5 or int(sys.argv[3]) != uid
            or not re.fullmatch(r"[0-9]{1,20}", sys.argv[4])):
        raise RuntimeError("Invalid cleanup request")
    started_after = int(sys.argv[4])
    if not re.fullmatch(r"[0-9a-f]{32}", sys.argv[2]):
        raise RuntimeError("Invalid process ownership marker")
    marker = sys.argv[2].encode("ascii")
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        handles = owned_processes(marker, uid, started_after)
        if not handles:
            print('{"clean":true}')
            return
        try:
            for fd in handles:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            time.sleep(0.15)
            for fd in handles:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            for fd in handles:
                os.close(fd)
        time.sleep(0.05)
    raise RuntimeError("Native terminal cleanup was not confirmed")

def deadline_expired(_signum, _frame):
    raise TimeoutError("Native terminal process probe deadline exceeded")

try:
    signal.signal(signal.SIGALRM, deadline_expired)
    signal.alarm(3)
    main()
except Exception:
    print('{"clean":false,"error":"native_terminal_process_check_failed"}')
    sys.exit(1)
finally:
    signal.alarm(0)
`;

export const SIDECAR_SERVER_CODE = `const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const { URL } = require('url');

const INSTANCE_ID = process.env.INSTANCE_ID || 'hermes';
const API_KEY = process.env.API_SERVER_KEY;
const DASHBOARD_UPSTREAM_URL = process.env.DASHBOARD_UPSTREAM_URL || 'http://127.0.0.1:9119';
const WEBUI_TERMINAL_UPSTREAM_URL = (process.env.WEBUI_TERMINAL_UPSTREAM_URL || '').trim();
const HOST_PROFILES_DIR = process.env.HOST_PROFILES_DIR || '/profiles';
const MAIN_ENV_FILE = process.env.MAIN_ENV_FILE || '/opt/hermes/instances/' + INSTANCE_ID + '/.env';
const TERMINAL_EXEC_USER = (process.env.TERMINAL_EXEC_USER || '').trim();
const TERMINAL_CWD = (process.env.TERMINAL_CWD || '').trim();
const TERMINAL_SHELL_CWD = (process.env.TERMINAL_SHELL_CWD || TERMINAL_CWD || '').trim();
const TERMINAL_TUI_CWD = (process.env.TERMINAL_TUI_CWD || TERMINAL_CWD || '').trim();
const DASHBOARD_LOGIN_TTL_MS = 60 * 1000;
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DASHBOARD_SESSION_COOKIE = 'hermes_dashboard_session';
const DASHBOARD_PROXY_TIMEOUT_MS = 2 * 1000;
const DASHBOARD_RESTART_WAIT_MS = 1 * 1000;
const DASHBOARD_RECOVERY_WAIT_MS = 15 * 1000;
// DASHBOARD_RECOVERY_DEADLINE_CONSTS_START
// Hard ceiling on the memoized dashboardRecoveryPromise (see withDeadline).
const DASHBOARD_RECOVERY_DEADLINE_MS = 40 * 1000;
// A healthy cold dashboard can take more than the normal 2s action-route guard
// to answer /api/status. Do not misdiagnose that startup latency as a dead
// upstream and restart the container underneath the Desktop bootstrap.
const DASHBOARD_UPSTREAM_PROBE_TIMEOUT_MS = 5 * 1000;
// DASHBOARD_RECOVERY_DEADLINE_CONSTS_END
const SAFE_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/;
const SAFE_INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;
// GENERATED_IMAGE_SUPPORT_START
const DEFAULT_HERMES_HOME = path.dirname(MAIN_ENV_FILE);
const DEFAULT_IMAGE_CACHE_ROOT = path.join(DEFAULT_HERMES_HOME, 'cache', 'images');
const GENERATED_IMAGE_CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});
// GENERATED_IMAGE_SUPPORT_END
const usedDashboardNonces = new Map();
const dashboardSessions = new Map();
let cachedDashboardUpstreamBase = '';
let dashboardRecoveryPromise = null;
const terminalSessions = new Map();
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-hermes-timestamp, x-hermes-signature, x-hermes-trace-id',
};
const SAFE_TERMINAL_SESSION_KEY = /^[a-zA-Z0-9:_-]{1,160}$/;
const SAFE_TERMINAL_SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_INACTIVITY_TTL_MS = 30 * 60 * 1000;
const TERMINAL_MAX_SCROLLBACK = 65536;
const TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES = 8192;
const TERMINAL_PTY_HELPER_CODE = ${JSON.stringify(TERMINAL_PTY_HELPER_CODE)};
const TERMINAL_PTY_HELPER_BOOTSTRAP =
  'PYTHON_BIN=$(command -v python3 || command -v python); ' +
  'if [ -z "$PYTHON_BIN" ] && command -v apk >/dev/null 2>&1; then apk add --no-cache python3 >/dev/null 2>&1 || true; PYTHON_BIN=$(command -v python3 || command -v python); fi; ' +
  'if [ -z "$PYTHON_BIN" ]; then echo "[Terminal Sidecar] Python runtime not found" >&2; exit 127; fi; ' +
  'exec "$PYTHON_BIN" -u -c "$HERMES_TERMINAL_PTY_HELPER"';
// CHAT_STREAM_WORKER_MODULE_PATH removed alongside the chat-stream-worker
// handlers and runtime — see comment near the original loader location.

if (!SAFE_INSTANCE_ID.test(INSTANCE_ID)) {
  throw new Error('Invalid INSTANCE_ID format');
}

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendText(res, statusCode, body, extraHeaders) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function normalizeProfileName(rawProfile) {
  const profile = typeof rawProfile === 'string' && rawProfile.trim() ? rawProfile.trim() : 'default';
  if (profile !== 'default' && !SAFE_PROFILE_NAME.test(profile)) {
    throw createHttpError(400, 'Invalid profile name format');
  }
  return profile;
}

function getSignedPayload(timestamp, rawBody) {
  return rawBody ? timestamp + '.' + rawBody : timestamp;
}

function compareHexSignature(receivedHex, expectedSign, errorMessage) {
  if (!/^[a-f0-9]+$/i.test(receivedHex) || receivedHex.length !== expectedSign.length * 2) {
    throw createHttpError(403, errorMessage);
  }

  const receivedSign = Buffer.from(receivedHex, 'hex');
  if (!crypto.timingSafeEqual(receivedSign, expectedSign)) {
    throw createHttpError(403, errorMessage);
  }
}

function verifyHmacHeaders(req, rawBody) {
  if (!API_KEY) {
    throw createHttpError(500, 'API key not configured');
  }

  const timestamp = req.headers['x-hermes-timestamp'];
  const signature = req.headers['x-hermes-signature'];

  if (!timestamp && !signature) {
    return { attempted: false };
  }

  if (!timestamp || !signature) {
    throw createHttpError(401, 'Missing security headers');
  }

  const now = Date.now();
  const parsedTimestamp = Number.parseInt(String(timestamp), 10);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > 5 * 60 * 1000) {
    throw createHttpError(401, 'Timestamp expired');
  }

  const expectedSign = crypto
    .createHmac('sha256', API_KEY)
    .update(getSignedPayload(String(timestamp), rawBody))
    .digest();

  compareHexSignature(String(signature).trim(), expectedSign, 'Invalid HMAC signature');
  return { attempted: true };
}

function authenticateRequest(req, rawBody) {
  const result = verifyHmacHeaders(req, rawBody);
  if (!result.attempted) {
    throw createHttpError(401, 'Missing security headers');
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(cookieHeader) {
  const parsed = {};
  const raw = typeof cookieHeader === 'string' ? cookieHeader : '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key) continue;
    parsed[key] = value;
  }
  return parsed;
}

function filterDashboardProxyCookieHeader(cookieHeader) {
  return String(cookieHeader || '').split(';').map((part) => part.trim()).filter((part) => part && part.split('=')[0].trim() !== DASHBOARD_SESSION_COOKIE).join('; ');
}

function pruneDashboardState(now) {
  const currentTime = typeof now === 'number' ? now : Date.now();

  for (const [nonce, expiresAt] of usedDashboardNonces.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      usedDashboardNonces.delete(nonce);
    }
  }

  for (const [sessionId, expiresAt] of dashboardSessions.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      dashboardSessions.delete(sessionId);
    }
  }
}

function buildDashboardLoginPayload(expiresAt, nonce, nextPath) {
  return String(expiresAt) + '.' + nonce + '.' + nextPath;
}

function normalizeDashboardNextPath(rawPath) {
  const nextPath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '/';
  if (!nextPath.startsWith('/') || nextPath.startsWith('//') || nextPath.includes('\\\\')) {
    throw createHttpError(400, 'Official dashboard redirects must stay on the instance gateway');
  }
  return nextPath;
}

function shouldUseSecureDashboardCookie() {
  return true;
}

function dashboardCookieSameSiteAttribute(secure) {
  return secure ? '; SameSite=None' : '; SameSite=Lax';
}

function buildDashboardCookie(sessionId, secure = true) {
  return DASHBOARD_SESSION_COOKIE + '=' + sessionId + '; Path=/; HttpOnly' + dashboardCookieSameSiteAttribute(secure) + '; Max-Age=' + Math.floor(DASHBOARD_SESSION_TTL_MS / 1000) + (secure ? '; Secure' : '');
}

function clearDashboardCookie(secure = true) {
  return DASHBOARD_SESSION_COOKIE + '=; Path=/; HttpOnly' + dashboardCookieSameSiteAttribute(secure) + '; Max-Age=0' + (secure ? '; Secure' : '');
}

function createDashboardSession() {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + DASHBOARD_SESSION_TTL_MS;
  dashboardSessions.set(sessionId, expiresAt);
  return { sessionId, expiresAt };
}

function getDashboardSession(req) {
  pruneDashboardState();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[DASHBOARD_SESSION_COOKIE];
  if (!sessionId) return null;

  const expiresAt = dashboardSessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    dashboardSessions.delete(sessionId);
    return null;
  }

  return { sessionId, expiresAt };
}

function buildDashboardAuthFailureMetadata(req) {
  const headers = req && req.headers ? req.headers : {};
  const cookies = parseCookies(headers.cookie);
  return {
    hasCookieHeader: Boolean(headers.cookie),
    hasDashboardSessionCookie: Boolean(cookies[DASHBOARD_SESSION_COOKIE]),
    hasHmacTimestamp: Boolean(headers['x-hermes-timestamp']),
    hasHmacSignature: Boolean(headers['x-hermes-signature']),
  };
}

function annotateDashboardAuthFailure(err, req) {
  err.failureType = 'sidecar_dashboard_auth_rejected';
  err.authFailure = buildDashboardAuthFailureMetadata(req);
  return err;
}

function requireDashboardAccess(req, rawBody) {
  const dashboardSession = getDashboardSession(req);
  if (dashboardSession) {
    return { mode: 'cookie' };
  }

  // WEBUI_SESSION_PROXY_AUTH_START
  // WebUI handoff sessions are defined by WEBUI_HANDOFF_APPENDAGE. Caddy
  // validates the same cookie via /webui-session-check, then proxies the
  // workspace through this gated sidecar so it can attach upstream auth.
  // Accept that already-validated session here as well; otherwise the
  // handoff succeeds but the workspace immediately receives a 401.
  if (typeof getWebuiSession === 'function' && getWebuiSession(req)) {
    return { mode: 'webui_cookie' };
  }
  // WEBUI_SESSION_PROXY_AUTH_END

  let hmacAuth;
  try {
    hmacAuth = verifyHmacHeaders(req, rawBody);
  } catch (err) {
    throw annotateDashboardAuthFailure(err, req);
  }
  if (hmacAuth.attempted) {
    return { mode: 'hmac' };
  }

  throw annotateDashboardAuthFailure(
    createHttpError(401, 'Dashboard access requires Hivra authentication'),
    req,
  );
}

// GENERATED_IMAGE_SUPPORT_START
function buildGeneratedImageAuthFailureMetadata(req) {
  const headers = req && req.headers ? req.headers : {};
  const cookies = parseCookies(headers.cookie);
  return {
    hasCookieHeader: Boolean(headers.cookie),
    hasDashboardSessionCookie: Boolean(cookies[DASHBOARD_SESSION_COOKIE]),
    hasWebuiSessionCookie: typeof hasWebuiSessionCookie === 'function' ? hasWebuiSessionCookie(req) : false,
    hasHmacTimestamp: Boolean(headers['x-hermes-timestamp']),
    hasHmacSignature: Boolean(headers['x-hermes-signature']),
  };
}

function annotateGeneratedImageAuthFailure(err, req) {
  err.failureType = 'sidecar_generated_image_auth_rejected';
  err.authFailure = buildGeneratedImageAuthFailureMetadata(req);
  return err;
}

function requireGeneratedImageAccess(req, rawBody) {
  if (getDashboardSession(req)) {
    return { mode: 'dashboard_cookie' };
  }

  if (typeof getWebuiSession === 'function' && getWebuiSession(req)) {
    return { mode: 'webui_cookie' };
  }

  let hmacAuth;
  try {
    hmacAuth = verifyHmacHeaders(req, rawBody);
  } catch (err) {
    throw annotateGeneratedImageAuthFailure(err, req);
  }
  if (hmacAuth.attempted) {
    return { mode: 'hmac' };
  }

  throw annotateGeneratedImageAuthFailure(
    createHttpError(401, 'Generated image access requires Hivra authentication'),
    req,
  );
}

function generatedImageError(statusCode, message, failureType, metadata) {
  const err = createHttpError(statusCode, message);
  err.failureType = failureType;
  err.generatedImage = metadata || {};
  return err;
}

function isSafeRelativePath(relativePath) {
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function decodeGeneratedImagePathname(pathname) {
  try {
    return decodeURIComponent(String(pathname || ''));
  } catch (err) {
    throw generatedImageError(400, 'Invalid generated image path encoding', 'sidecar_generated_image_bad_path_encoding');
  }
}

function resolveGeneratedImagePath(pathname) {
  const decodedPath = decodeGeneratedImagePathname(pathname);
  const resolvedPath = path.resolve(decodedPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  const contentType = GENERATED_IMAGE_CONTENT_TYPES[extension];

  if (!contentType) {
    throw generatedImageError(415, 'Generated image type is not supported', 'sidecar_generated_image_unsupported_type', {
      extension: extension || null,
    });
  }

  const defaultRelativePath = path.relative(DEFAULT_IMAGE_CACHE_ROOT, resolvedPath);
  if (isSafeRelativePath(defaultRelativePath)) {
    return {
      filePath: resolvedPath,
      contentType,
      root: 'default',
      relativePath: defaultRelativePath,
    };
  }

  const profileRelativePath = path.relative(HOST_PROFILES_DIR, resolvedPath);
  if (isSafeRelativePath(profileRelativePath)) {
    const parts = profileRelativePath.split(path.sep).filter(Boolean);
    if (
      parts.length >= 4 &&
      SAFE_PROFILE_NAME.test(parts[0]) &&
      parts[1] === 'cache' &&
      parts[2] === 'images'
    ) {
      return {
        filePath: resolvedPath,
        contentType,
        root: 'profile',
        profile: parts[0],
        relativePath: parts.slice(3).join('/'),
      };
    }
  }

  throw generatedImageError(404, 'Generated image was not found', 'sidecar_generated_image_path_rejected', {
    requestedPathPrefix: decodedPath.slice(0, 80),
  });
}

function isGeneratedImageRequestPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(String(pathname || ''));
  } catch (_) {
    return false;
  }
  return (
    decodedPath.startsWith(DEFAULT_IMAGE_CACHE_ROOT + '/') ||
    decodedPath.startsWith(HOST_PROFILES_DIR + '/')
  );
}

function handleGeneratedImageRequest(req, res, requestUrl, rawBody) {
  requireGeneratedImageAccess(req, rawBody);

  const resolved = resolveGeneratedImagePath(requestUrl.pathname);
  let stats;
  try {
    stats = fs.statSync(resolved.filePath);
  } catch (err) {
    console.warn('Generated image file missing:', {
      failureType: 'sidecar_generated_image_missing',
      root: resolved.root,
      profile: resolved.profile || null,
      relativePath: resolved.relativePath,
      errorName: err && err.name ? err.name : typeof err,
    });
    throw generatedImageError(404, 'Generated image was not found', 'sidecar_generated_image_missing', {
      root: resolved.root,
      profile: resolved.profile || null,
      relativePath: resolved.relativePath,
    });
  }

  if (!stats.isFile()) {
    throw generatedImageError(404, 'Generated image was not found', 'sidecar_generated_image_not_file', {
      root: resolved.root,
      profile: resolved.profile || null,
      relativePath: resolved.relativePath,
    });
  }

  res.writeHead(200, {
    'Content-Type': resolved.contentType,
    'Content-Length': stats.size,
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': 'inline; filename="' + path.basename(resolved.filePath).replace(/[\\r\\n"]/g, '') + '"',
    'X-Content-Type-Options': 'nosniff',
    ...CORS_HEADERS,
  });

  if ((req.method || 'GET') === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(resolved.filePath);
  stream.on('error', (err) => {
    console.error('Generated image stream failed:', {
      failureType: 'sidecar_generated_image_stream_failed',
      root: resolved.root,
      profile: resolved.profile || null,
      relativePath: resolved.relativePath,
      errorName: err && err.name ? err.name : typeof err,
    });
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Generated image could not be read' });
      return;
    }
    res.destroy(err);
  });
  stream.pipe(res);
}
// GENERATED_IMAGE_SUPPORT_END

async function handleDashboardLogin(req, res, requestUrl) {
  if (!API_KEY) {
    throw createHttpError(500, 'API key not configured');
  }

  const expiresAt = Number.parseInt(String(requestUrl.searchParams.get('exp') || ''), 10);
  const nonce = String(requestUrl.searchParams.get('nonce') || '').trim();
  const nextPath = normalizeDashboardNextPath(requestUrl.searchParams.get('next') || '/');
  const signature = String(requestUrl.searchParams.get('sig') || '').trim();

  if (!/^[a-f0-9]{16,}$/i.test(nonce)) {
    throw createHttpError(400, 'Invalid dashboard login nonce');
  }

  if (!Number.isFinite(expiresAt)) {
    throw createHttpError(400, 'Invalid dashboard login expiry');
  }

  const now = Date.now();
  if (expiresAt < now - DASHBOARD_LOGIN_TTL_MS) {
    throw createHttpError(401, 'Dashboard login link expired');
  }

  const expiresInMs = expiresAt - now;
  if (expiresInMs > DASHBOARD_LOGIN_TTL_MS) {
    console.warn('Dashboard login expiry too far in future', {
      failureType: 'dashboard_login_expiry_too_far_in_future',
      expiresInMs,
      maxFutureMs: DASHBOARD_LOGIN_TTL_MS,
    });
    throw createHttpError(400, 'Dashboard login expiry is invalid');
  }

  const expectedSign = crypto
    .createHmac('sha256', API_KEY)
    .update(buildDashboardLoginPayload(expiresAt, nonce, nextPath))
    .digest();

  compareHexSignature(signature, expectedSign, 'Invalid dashboard login signature');

  pruneDashboardState(now);
  if (usedDashboardNonces.has(nonce)) {
    throw createHttpError(403, 'Dashboard login link already used');
  }

  usedDashboardNonces.set(nonce, expiresAt);
  const { sessionId } = createDashboardSession();
  const secureCookie = shouldUseSecureDashboardCookie(req);

  res.writeHead(302, {
    'Location': nextPath,
    'Set-Cookie': buildDashboardCookie(sessionId, secureCookie),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end();
}

async function handleDashboardLogout(req, res) {
  const secureCookie = shouldUseSecureDashboardCookie(req);
  res.writeHead(302, {
    'Location': '/',
    'Set-Cookie': clearDashboardCookie(secureCookie),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end();
}

function normalizeDashboardUpstreamBase(upstreamBase) {
  const trimmed = String(upstreamBase || '').trim();
  return trimmed ? trimmed.replace(/\\/+$/, '') : '';
}

function buildDashboardUpstreamCandidates() {
  const defaultContainerBase = 'agent-' + INSTANCE_ID;
  const candidates = [
    cachedDashboardUpstreamBase,
    DASHBOARD_UPSTREAM_URL,
    'http://' + defaultContainerBase + '-web:9119',
    'http://' + defaultContainerBase + ':9119',
    'http://127.0.0.1:9119',
  ];
  const seen = new Set();

  return candidates.filter((candidate) => {
    const normalized = normalizeDashboardUpstreamBase(candidate);
    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  }).map((candidate) => normalizeDashboardUpstreamBase(candidate));
}

function execCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs || 20_000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

async function resolveRunningContainerName(requestedName) {
  const result = await execCommand("docker ps --format '{{.Names}}' 2>/dev/null", 10_000);
  const runningContainers = result.stdout
    .split('\\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const containerName of runningContainers) {
    if (containerName === requestedName || containerName.endsWith('_' + requestedName)) {
      return containerName;
    }
  }

  return '';
}

function buildDashboardFallbackStartCommand(containerName) {
  const shellScript = [
    'BASE_HOME="\${HERMES_HOME:-/opt/data}"',
    'LOG_DIR="$BASE_HOME/logs"',
    'mkdir -p "$LOG_DIR"',
    'if command -v pgrep >/dev/null 2>&1 && pgrep -f "hermes dashboard .*9119" >/dev/null 2>&1; then exit 0; fi',
    'HERMES_BIN=""',
    'if [ -x /opt/hermes/.venv/bin/hermes ]; then HERMES_BIN=/opt/hermes/.venv/bin/hermes; fi',
    'if [ -z "$HERMES_BIN" ] && [ -x /opt/venv/bin/hermes ]; then HERMES_BIN=/opt/venv/bin/hermes; fi',
    'if [ -z "$HERMES_BIN" ]; then HERMES_BIN="$(command -v hermes 2>/dev/null || true)"; fi',
    '[ -n "$HERMES_BIN" ] || exit 1',
    'nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --port 9119 --no-open --insecure --tui > "$LOG_DIR/dashboard-web.log" 2>&1 < /dev/null &',
  ].join('; ');

  return 'docker exec ' + JSON.stringify(containerName) + ' sh -lc ' + JSON.stringify(shellScript);
}

async function restartDedicatedDashboardContainer() {
  const containerName = await resolveRunningContainerName('agent-' + INSTANCE_ID + '-web');
  if (!containerName) {
    return false;
  }

  const result = await execCommand(
    'docker restart ' + JSON.stringify(containerName) + ' >/dev/null 2>&1',
    20_000,
  );
  return result.ok;
}

async function startDashboardFallbackInAgentContainer() {
  const containerName = await resolveRunningContainerName('agent-' + INSTANCE_ID);
  if (!containerName) {
    return false;
  }

  const result = await execCommand(buildDashboardFallbackStartCommand(containerName), 20_000);
  return result.ok;
}

// DASHBOARD_RECOVERY_DEADLINE_HELPER_START
// Race a promise vs a wall-clock deadline; rejects with SIDECAR_DEADLINE on
// expiry. Lifeguard against memoized-promise wedges where the inner chain has
// an unbounded TCP-connect await (Node's default connect timeout is Infinity).
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('sidecar deadline exceeded: ' + label);
      err.code = 'SIDECAR_DEADLINE';
      err.deadlineLabel = label;
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    deadline,
  ]);
}
// DASHBOARD_RECOVERY_DEADLINE_HELPER_END

// DASHBOARD_DNS_LOOKUP_START
// Resolve via c-ares (dns.resolve4 = event loop), NOT getaddrinfo (libuv
// threadpool). Dead Docker-name lookups cost a ~5s musl timeout each on the
// 4-thread pool; a burst saturates it and starves the real upstream -> wedge.
// c-ares fast-fails dead names and never touches the pool. See sidecar test.
// (The Hetzner cloud-init bootstrap strips this block to a minified one-liner
// to stay under the 32KB user_data ceiling — see HETZNER_BOOTSTRAP strip list.)
function dashboardDnsLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const all = Boolean(options && typeof options === 'object' && options.all);
  const ipVersion = require('net').isIP(hostname);
  if (ipVersion) {
    cb(null, all ? [{ address: hostname, family: ipVersion }] : hostname, ipVersion);
    return;
  }
  require('dns').resolve4(hostname, (err, addresses) => {
    if (err || !addresses || !addresses.length) {
      cb(Object.assign(new Error('ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }));
      return;
    }
    if (all) {
      cb(null, addresses.map((address) => ({ address, family: 4 })));
    } else {
      cb(null, addresses[0], 4);
    }
  });
}
// DASHBOARD_DNS_LOOKUP_END

function probeDashboardUpstream(upstreamBase) {
  const normalizedBase = normalizeDashboardUpstreamBase(upstreamBase);
  if (!normalizedBase) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const probeUrl = new URL('/api/status', normalizedBase + '/');
    const transport = probeUrl.protocol === 'https:' ? https : http;
    let settled = false;

    const finish = (healthy) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Boolean(healthy));
    };

    const probeReq = transport.request(probeUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      lookup: dashboardDnsLookup,
    }, (probeRes) => {
      if (typeof probeRes.resume === 'function') {
        probeRes.resume();
      }
      finish(Boolean(probeRes.statusCode) && probeRes.statusCode < 500);
    });

    // DASHBOARD_SLOW_PROBE_START
    if (typeof probeReq.setTimeout === 'function') {
      probeReq.setTimeout(DASHBOARD_UPSTREAM_PROBE_TIMEOUT_MS, () => {
        if (typeof probeReq.destroy === 'function') {
          probeReq.destroy();
        }
        finish(false);
      });
    }
    // DASHBOARD_SLOW_PROBE_END

    probeReq.on('error', () => finish(false));
    probeReq.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findHealthyDashboardUpstream() {
  const candidates = buildDashboardUpstreamCandidates();
  for (const candidate of candidates) {
    if (await probeDashboardUpstream(candidate)) {
      cachedDashboardUpstreamBase = candidate;
      return candidate;
    }
  }

  return '';
}

async function waitForHealthyDashboardUpstream(timeoutMs) {
  const deadline = Date.now() + Math.max(timeoutMs || 0, 0);

  do {
    const candidate = await findHealthyDashboardUpstream();
    if (candidate) {
      return candidate;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(500);
  } while (true);

  return '';
}

async function recoverDashboardUpstream() {
  await restartDedicatedDashboardContainer();
  let candidate = await waitForHealthyDashboardUpstream(DASHBOARD_RESTART_WAIT_MS);
  if (candidate) {
    return candidate;
  }

  await startDashboardFallbackInAgentContainer();
  candidate = await waitForHealthyDashboardUpstream(DASHBOARD_RECOVERY_WAIT_MS);
  return candidate;
}

async function resolveDashboardUpstreamBase(forceRecovery) {
  if (!forceRecovery) {
    const existingUpstream = await findHealthyDashboardUpstream();
    if (existingUpstream) {
      return existingUpstream;
    }
  }

  if (!dashboardRecoveryPromise) {
    // DASHBOARD_RECOVERY_DEADLINE_WRAP_START
    // Hard deadline so the memo can't outlive the ceiling; .finally always
    // clears it. Prevents the cross-request wedge from a stuck inner await.
    dashboardRecoveryPromise = withDeadline(
      recoverDashboardUpstream(),
      DASHBOARD_RECOVERY_DEADLINE_MS,
      'recoverDashboardUpstream',
    ).catch((err) => {
      console.error('Dashboard recovery deadline exceeded:', {
        failureType: 'sidecar_dashboard_recovery_deadline_exceeded',
        deadlineMs: DASHBOARD_RECOVERY_DEADLINE_MS,
        errorName: err && err.name ? err.name : typeof err,
      });
      cachedDashboardUpstreamBase = '';
      return '';
    }).finally(() => {
      dashboardRecoveryPromise = null;
    });
    // DASHBOARD_RECOVERY_DEADLINE_WRAP_END
  }

  const recoveredUpstream = await dashboardRecoveryPromise;
  if (recoveredUpstream) {
    return recoveredUpstream;
  }

  return findHealthyDashboardUpstream();
}

function proxyToDashboardOnce(req, res, requestUrl, rawBody, upstreamBase) {
  const normalizedBase = normalizeDashboardUpstreamBase(upstreamBase);
  if (!normalizedBase) {
    return Promise.resolve(false);
  }

  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, normalizedBase + '/');
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  const filteredCookie = filterDashboardProxyCookieHeader(req.headers.cookie);

  delete headers.host;
  if (filteredCookie) {
    headers.cookie = filteredCookie;
  } else {
    delete headers.cookie;
  }

  if (rawBody) {
    headers['content-length'] = Buffer.byteLength(rawBody);
  } else {
    delete headers['content-length'];
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Boolean(ok));
    };

    const proxyReq = transport.request(upstreamUrl, {
      method: req.method || 'GET',
      headers,
      lookup: dashboardDnsLookup,
    }, (proxyRes) => {
      cachedDashboardUpstreamBase = normalizedBase;
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
      finish(true);
    });

    if (typeof proxyReq.setTimeout === 'function') {
      proxyReq.setTimeout(DASHBOARD_PROXY_TIMEOUT_MS, () => {
        if (typeof proxyReq.destroy === 'function') {
          proxyReq.destroy();
        }
        finish(false);
      });
    }

    proxyReq.on('error', (err) => {
      console.error('Dashboard proxy error:', {
        failureType: 'sidecar_dashboard_proxy_failed',
        errorName: err && err.name ? err.name : typeof err,
        strippedDashboardSessionCookie: Boolean(req.headers.cookie && req.headers.cookie !== filteredCookie),
      });
      finish(false);
    });

    if (rawBody) {
      proxyReq.end(rawBody);
      return;
    }

    proxyReq.end();
  });
}

async function proxyToDashboard(req, res, requestUrl, rawBody) {
  const preferredUpstream = await resolveDashboardUpstreamBase(false);
  if (preferredUpstream && await proxyToDashboardOnce(req, res, requestUrl, rawBody, preferredUpstream)) {
    return;
  }

  cachedDashboardUpstreamBase = '';
  const recoveredUpstream = await resolveDashboardUpstreamBase(true);
  if (recoveredUpstream && await proxyToDashboardOnce(req, res, requestUrl, rawBody, recoveredUpstream)) {
    return;
  }

  if (!res.headersSent) {
    sendJson(res, 502, { error: 'Dashboard upstream unavailable' });
    return;
  }

  res.end();
}
// DASHBOARD_GATED_PROXY_START
// ── Gated official-dashboard proxy (hardened-image auth bridge) ─────────────
// The June-2026 auth hardening makes a non-loopback dashboard bind REQUIRE a
// real auth provider; the legacy injected _SESSION_TOKEN (Bearer / X-Hermes-
// Session-Token / ?token=) is rejected once the gate engages. The webfree SPA
// only speaks that token, so this sidecar terminates the SPA's token auth at the
// edge and re-authenticates to the dashboard with its bundled "basic" password
// provider: it logs in once (POST /auth/password-login) with
// DASHBOARD_BASIC_AUTH_USERNAME + API_SERVER_KEY, caches the gated session
// cookie, and attaches it when proxying — for HTTP/SSE, and (via a single-use
// ws-ticket) for the /api/ws|console|pty|pub|events WebSockets. The gated session
// cookie never reaches the browser, so no token is exposed on a public page.
// Active only when DASHBOARD_BASIC_AUTH_USERNAME is set (webfree deploys); the
// whole block is stripped from the size-capped Hetzner bootstrap variant.
const DASHBOARD_BASIC_AUTH_USERNAME = (process.env.DASHBOARD_BASIC_AUTH_USERNAME || '').trim();
const DASHBOARD_WS_PATHS = new Set(['/api/ws', '/api/console', '/api/pty', '/api/pub', '/api/events']);
const DASHBOARD_UPSTREAM_LOGIN_TTL_MS = 10 * 60 * 60 * 1000;
const DASHBOARD_UPSTREAM_FETCH_TIMEOUT_MS = 8 * 1000;
// The official dashboard assembles these read-only bootstrap responses during
// Desktop startup. A healthy cold box can legitimately take several seconds,
// so the normal 2s connect-wedge guard turns a working Desktop into false 502s.
// Keep the strict guard for action routes and widen only this startup set.
const DASHBOARD_BOOTSTRAP_PROXY_TIMEOUT_MS = 12 * 1000;
const DASHBOARD_BOOTSTRAP_PATHS = new Set([
  '/api/status',
  '/api/config',
  '/api/model/info',
  '/api/model/options',
]);
let dashboardUpstreamCookie = '';
let dashboardUpstreamCookieExpiresAt = 0;
let dashboardUpstreamLoginPromise = null;

function dashboardGatedProxyEnabled() {
  return Boolean(DASHBOARD_BASIC_AUTH_USERNAME) && Boolean(API_KEY);
}

function isDashboardWsPath(pathname) {
  return DASHBOARD_WS_PATHS.has(pathname);
}

function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function hasDashboardTokenAuth(req, requestUrl) {
  if (!API_KEY) {
    return false;
  }
  if (timingSafeStringEqual(req.headers['authorization'] || '', 'Bearer ' + API_KEY)) {
    return true;
  }
  if (timingSafeStringEqual(req.headers['x-hermes-session-token'] || '', API_KEY)) {
    return true;
  }
  const queryToken = requestUrl && requestUrl.searchParams ? requestUrl.searchParams.get('token') : '';
  return timingSafeStringEqual(queryToken || '', API_KEY);
}

// Desktop terminals are an adapter over this instance's existing PTY machinery,
// not a browser-controlled Docker endpoint. No target, exec user or command is
// accepted from the browser; legacy platform terminals keep their old contract.
const DESKTOP_TERMINAL_PROCESS_CODE = ${JSON.stringify(DESKTOP_TERMINAL_PROCESS_CODE)};
const DESKTOP_TERMINAL_PTY_HELPER_CODE = ${JSON.stringify(DESKTOP_TERMINAL_PTY_HELPER_CODE)};
const DESKTOP_TERMINAL_START_MS = 10000;
const DESKTOP_TERMINAL_UNATTACHED_MS = 90000;
const DESKTOP_TERMINAL_DETACHED_MS = 10000;
const desktopTerminalLeases = new Map();
const desktopTerminalStarts = [];
const DESKTOP_TERMINAL_SHELL_CODE = [
  'import os,sys,time',
  'if time.time()*1000 >= int(sys.argv[1]): sys.exit(75)',
  'if os.getuid() != int(sys.argv[2]) or os.getuid() == 0: sys.exit(77)',
  'marker=os.environ["HIVRA_DESKTOP_TERMINAL_ID"]',
  'sys.stdout.write("\\x1eHIVRA_READY:"+marker+":"+str(os.getpid())+"\\x1f")',
  'sys.stdout.flush()',
  'os.execv("/bin/bash",["bash","-i"])',
].join('\\n');

function desktopTerminalError(status, code) {
  const error = createHttpError(status, code);
  error.failureType = code;
  return error;
}

function desktopTerminalJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readDesktopTerminalBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(desktopTerminalError(408, 'desktop_terminal_body_timeout')), 5000);
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > 16384) {
        chunks.length = 0;
        finish(desktopTerminalError(413, 'desktop_terminal_body_too_large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.once('error', () => finish(desktopTerminalError(400, 'desktop_terminal_body_failed')));
    req.once('aborted', () => finish(desktopTerminalError(400, 'desktop_terminal_body_aborted')));
  });
}

function validateDesktopTerminalBody(body, requestUrl) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw desktopTerminalError(400, 'desktop_terminal_invalid_body');
  const profiles = requestUrl.searchParams.getAll('profile');
  if (profiles.length > 1 || Array.from(requestUrl.searchParams.keys()).some((key) => key !== 'profile')) {
    throw desktopTerminalError(400, 'desktop_terminal_invalid_query');
  }
  if ((body.profile !== undefined && body.profile !== 'default') || profiles.some((profile) => profile !== 'default')) {
    throw desktopTerminalError(409, 'desktop_terminal_profile_not_supported');
  }
  const fields = {
    start: ['cols', 'rows', 'cwd'],
    input: ['sessionKey', 'sessionToken', 'data'],
    resize: ['sessionKey', 'sessionToken', 'cols', 'rows'],
    stop: ['sessionKey', 'sessionToken'],
    cwd: ['sessionKey', 'sessionToken'],
    attach: ['sessionKey', 'sessionToken'],
  };
  if (typeof body.action !== 'string' || !Object.prototype.hasOwnProperty.call(fields, body.action) ||
      Object.keys(body).some((key) => !['action', 'profile', ...fields[body.action]].includes(key))) {
    throw desktopTerminalError(400, 'desktop_terminal_invalid_fields');
  }
  if (body.action === 'start' || body.action === 'resize') {
    for (const [key, minimum, maximum] of [['cols', 10, 500], ['rows', 2, 200]]) {
      if (body[key] === undefined && body.action === 'start') continue;
      if (!Number.isInteger(body[key]) || body[key] < minimum || body[key] > maximum) {
        throw desktopTerminalError(400, 'desktop_terminal_invalid_size');
      }
    }
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.startsWith('/') ||
      Buffer.byteLength(body.cwd) > 1024 || /[\\x00-\\x1f\\x7f]/.test(body.cwd))) {
    throw desktopTerminalError(400, 'desktop_terminal_invalid_cwd');
  }
  if (body.action === 'input' && (typeof body.data !== 'string' || !body.data || Buffer.byteLength(body.data) > 4096)) {
    throw desktopTerminalError(400, 'desktop_terminal_invalid_input');
  }
}

async function desktopTerminalDocker(args, maximum = 5000) {
  try {
    return await managedGatewayDocker(args, managedGatewayNow() + maximum, maximum);
  } catch {
    throw desktopTerminalError(502, 'desktop_terminal_docker_failed');
  }
}

async function inspectDesktopTerminalTarget() {
  let upstream;
  try { upstream = new URL(DASHBOARD_UPSTREAM_URL); } catch { /* Rejected below. */ }
  const name = 'agent-' + INSTANCE_ID + '-official-dashboard';
  if (!API_KEY || !upstream || upstream.protocol !== 'http:' || upstream.hostname !== name ||
      upstream.port !== '9119' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw desktopTerminalError(409, 'desktop_terminal_runtime_not_supported');
  }
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},' +
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},' +
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},' +
    '"running":{{json .State.Running}},"user":{{json .Config.User}}}';
  let target;
  try { target = JSON.parse(await desktopTerminalDocker(['inspect', '--type', 'container', '--format', format, name])); } catch {
    throw desktopTerminalError(409, 'desktop_terminal_identity_unavailable');
  }
  const user = target && typeof target.user === 'string' ? target.user.split(':')[0] : '';
  if (!target || !/^[a-f0-9]{64}$/.test(target.id || '') || target.name !== '/' + name ||
      target.project !== INSTANCE_ID || target.service !== 'official-dashboard' || target.running !== true ||
      !/^sha256:[a-f0-9]{64}$/.test(target.image || '') || !user || user === 'root' ||
      (/^[0-9]+$/.test(user) && Number(user) === 0) || !/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(target.user)) {
    throw desktopTerminalError(409, 'desktop_terminal_identity_mismatch');
  }
  return target;
}

function desktopTerminalTicket(lease) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, type: 'terminal-ws', exp: Date.now() + 90000,
    sessionKey: lease.sessionKey, sessionToken: lease.sessionToken,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', API_KEY).update(payload).digest('hex');
  return '/_sidecar/api/terminal/ws?token=' + payload + '.' + signature + '&includeScrollback=1';
}

function scheduleDesktopTerminalStop(lease, reason, details) {
  void stopDesktopTerminalSession(lease.sessionKey, reason, details).catch(() => {
    console.error('Native terminal cleanup failed', { failureType: 'desktop_terminal_cleanup_unconfirmed' });
  });
}

async function stopDesktopTerminalSession(sessionKey, reason, details) {
  const lease = desktopTerminalLeases.get(sessionKey);
  if (!lease) return;
  lease.cancelled = true;
  clearTimeout(lease.startTimer);
  clearTimeout(lease.unattachedTimer);
  clearTimeout(lease.detachTimer);
  if (lease.rejectReady) lease.rejectReady(desktopTerminalError(502, 'desktop_terminal_start_failed'));
  if (lease.cleanupPromise) return lease.cleanupPromise;
  lease.cleanupPromise = Promise.resolve().then(async () => {
    const session = terminalSessions.get(sessionKey);
    if (session) sendTerminalControlMessage(session, { type: 'stop' });
    try {
      if (lease.launched) {
        // An aborted Docker exec may still reach its in-container bootstrap.
        // That bootstrap refuses to launch after expiresAt. If it never sent
        // its ownership witness, hold the reservation until that fence passes.
        if (!lease.started && Date.now() < lease.expiresAt) {
          await new Promise((resolve) => setTimeout(resolve, lease.expiresAt - Date.now()));
        }
        const output = await desktopTerminalDocker([
          'exec', lease.target.id, '/usr/bin/python3', '-I', '-S', '-c',
          DESKTOP_TERMINAL_PROCESS_CODE, '--cleanup', lease.marker, String(lease.uid), String(lease.startTicks),
        ], 3500);
        if (JSON.parse(output).clean !== true) throw desktopTerminalError(502, 'desktop_terminal_cleanup_unconfirmed');
      }
      if (session) destroyTerminalSession(sessionKey, reason, { ...details, desktopCleanup: true, cleanupConfirmed: true });
      desktopTerminalLeases.delete(sessionKey);
    } catch {
      if (session) destroyTerminalSession(sessionKey, 'error', { desktopCleanup: true, cleanupConfirmed: false, errorMessage: 'Terminal cleanup could not be confirmed' });
      // Keep the cap reservation; an explicit stop can retry this exact lease.
      lease.cleanupPromise = null;
      throw desktopTerminalError(502, 'desktop_terminal_cleanup_unconfirmed');
    }
  });
  return lease.cleanupPromise;
}

async function startDesktopTerminal(req, res, body) {
  const now = Date.now();
  while (desktopTerminalStarts.length && desktopTerminalStarts[0] <= now - 60000) desktopTerminalStarts.shift();
  if (desktopTerminalLeases.size >= 4 || desktopTerminalStarts.length >= 12) {
    throw desktopTerminalError(429, 'desktop_terminal_limit_reached');
  }
  const lease = {
    sessionKey: 'term:desktop:' + INSTANCE_ID + ':' + crypto.randomUUID(),
    sessionToken: crypto.randomUUID(), marker: crypto.randomBytes(16).toString('hex'),
    expiresAt: now + DESKTOP_TERMINAL_START_MS, cancelled: false, launched: false, started: false,
  };
  desktopTerminalLeases.set(lease.sessionKey, lease);
  desktopTerminalStarts.push(now);
  const abort = () => {
    if (!res.writableEnded) scheduleDesktopTerminalStop(lease, 'aborted');
  };
  req.once('aborted', abort);
  res.once('close', abort);
  lease.startTimer = setTimeout(() => scheduleDesktopTerminalStop(lease, 'start_timeout'), DESKTOP_TERMINAL_START_MS);
  const assertCurrent = () => {
    if (lease.cancelled || req.aborted || res.destroyed || Date.now() >= lease.expiresAt ||
        desktopTerminalLeases.get(lease.sessionKey) !== lease) throw desktopTerminalError(504, 'desktop_terminal_start_expired');
  };
  try {
    assertCurrent();
    lease.target = await inspectDesktopTerminalTarget();
    assertCurrent();
    const args = ['exec'];
    if (body.cwd !== undefined) args.push('--workdir', body.cwd);
    args.push(lease.target.id, '/usr/bin/python3', '-I', '-S', '-c', DESKTOP_TERMINAL_PROCESS_CODE, '--preflight');
    let verified;
    try { verified = JSON.parse(await desktopTerminalDocker(args)); } catch {
      throw desktopTerminalError(409, 'desktop_terminal_preflight_failed');
    }
    assertCurrent();
    const configuredUser = lease.target.user.split(':')[0];
    if (!verified || !Number.isInteger(verified.uid) || verified.uid <= 0 || verified.pidfd !== true ||
        !Number.isSafeInteger(verified.startTicks) || verified.startTicks < 0 ||
        verified.shell !== '/bin/bash' || typeof verified.cwd !== 'string' || !verified.cwd.startsWith('/') ||
        Buffer.byteLength(verified.cwd) > 1024 || /[\\x00-\\x1f\\x7f]/.test(verified.cwd) ||
        (/^[0-9]+$/.test(configuredUser) && Number(configuredUser) !== verified.uid)) {
      throw desktopTerminalError(409, 'desktop_terminal_preflight_mismatch');
    }
    lease.uid = verified.uid;
    lease.startTicks = verified.startTicks;
    lease.cwd = verified.cwd;
    const cols = body.cols === undefined ? 80 : body.cols;
    const rows = body.rows === undefined ? 24 : body.rows;
    const argv = [
      '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock',
      'exec', '--workdir', lease.cwd, '-e', 'TERM=xterm-256color', '-e', 'COLUMNS=' + cols,
      '-e', 'LINES=' + rows, '-e', 'HIVRA_DESKTOP_TERMINAL_ID=' + lease.marker, '-it',
      lease.target.id, '/usr/bin/python3', '-I', '-S', '-c', DESKTOP_TERMINAL_SHELL_CODE,
      String(lease.expiresAt), String(lease.uid),
    ];
    const ready = new Promise((resolve, reject) => { lease.resolveReady = resolve; lease.rejectReady = reject; });
    // Cancellation can reject before the create call returns.
    void ready.catch(() => {});
    lease.launched = true;
    const session = createTerminalSession(lease.sessionKey, lease.sessionToken, cols, rows, 'shell', { lease, argv });
    await ready;
    assertCurrent();
    clearTimeout(lease.startTimer);
    lease.unattachedTimer = setTimeout(() => scheduleDesktopTerminalStop(lease, 'unattached'), DESKTOP_TERMINAL_UNATTACHED_MS);
    desktopTerminalJson(res, 200, {
      ok: true, sessionKey: lease.sessionKey, sessionToken: lease.sessionToken,
      cwd: lease.cwd, shell: 'bash', pid: session.desktopPid || null, webSocketPath: desktopTerminalTicket(lease),
    });
  } catch (error) {
    await stopDesktopTerminalSession(lease.sessionKey, 'start_failed');
    throw error;
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
  }
}

async function handleDesktopTerminal(req, res, requestUrl) {
  // A strict, streaming cap is applied before the legacy unbounded body reader.
  const rawBody = req.method === 'POST' ? await readDesktopTerminalBody(req) : '';
  const access = hasDashboardTokenAuth(req, null) ? { mode: 'token' } : requireDashboardAccess(req, rawBody);
  if (access.mode === 'cookie' || access.mode === 'webui_cookie') {
    let origin;
    try { origin = new URL(req.headers.origin || ''); } catch { /* Rejected below. */ }
    const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() + ':';
    if (!origin || origin.origin === 'null' || origin.host !== req.headers.host || origin.protocol !== protocol ||
        req.headers['sec-fetch-site'] === 'cross-site') throw desktopTerminalError(403, 'desktop_terminal_cross_origin_denied');
  }
  if (req.method !== 'POST') { desktopTerminalJson(res, 405, { error: 'Method not allowed' }); return; }
  if (!/^application\\/json(?:\\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw desktopTerminalError(415, 'desktop_terminal_json_required');
  }
  let body;
  try { body = JSON.parse(rawBody); } catch { throw desktopTerminalError(400, 'desktop_terminal_invalid_json'); }
  validateDesktopTerminalBody(body, requestUrl);
  if (body.action === 'start') { await startDesktopTerminal(req, res, body); return; }
  const sessionKey = normalizeTerminalSessionKey(body.sessionKey);
  const sessionToken = normalizeTerminalSessionToken(body.sessionToken);
  if (!sessionKey.startsWith('term:desktop:' + INSTANCE_ID + ':')) throw desktopTerminalError(404, 'desktop_terminal_session_not_found');
  const lease = desktopTerminalLeases.get(sessionKey);
  if (!lease) {
    if (body.action === 'stop') { desktopTerminalJson(res, 200, { ok: true }); return; }
    throw desktopTerminalError(404, 'desktop_terminal_session_not_found');
  }
  if (!timingSafeStringEqual(sessionToken, lease.sessionToken)) throw desktopTerminalError(404, 'desktop_terminal_session_not_found');
  if (body.action === 'stop') { await stopDesktopTerminalSession(sessionKey, 'stopped'); desktopTerminalJson(res, 200, { ok: true }); return; }
  const session = getTerminalSession(sessionKey, sessionToken);
  if (!session || session.kind !== 'desktop' || lease.cancelled || !lease.started) throw desktopTerminalError(404, 'desktop_terminal_session_not_found');
  if (body.action === 'attach') { desktopTerminalJson(res, 200, { ok: true, webSocketPath: desktopTerminalTicket(lease) }); return; }
  // No fabricated cwd restoration: the live shell may have changed directory.
  if (body.action === 'cwd') { desktopTerminalJson(res, 200, { ok: true, cwd: null }); return; }
  if (session.process.stdin.writableLength > 65536) throw desktopTerminalError(429, 'desktop_terminal_input_backpressure');
  const message = body.action === 'input'
    ? { type: 'input', data: encodeTerminalInput(body.data) }
    : { type: 'resize', cols: body.cols, rows: body.rows };
  if (!sendTerminalControlMessage(session, message)) throw desktopTerminalError(502, 'desktop_terminal_control_failed');
  if (body.action === 'resize') { session.cols = body.cols; session.rows = body.rows; }
  touchTerminalSession(sessionKey, session);
  desktopTerminalJson(res, 200, { ok: true });
}

// Native dashboards have their own PID namespace: their CLI cannot restart
// the messaging gateway. Keep this action in the instance's Docker sidecar,
// never fall back to a native CLI or an unqualified container name.
const MANAGED_GATEWAY_RESTART_TIMEOUT_MS = 180 * 1000;
const MANAGED_GATEWAY_ACTION_POLL_MS = 10 * 1000;
let managedGatewayRestart = null;

function managedGatewayNow() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function managedGatewayError(code, uncertain) {
  const error = new Error(code);
  error.failureType = code;
  error.uncertain = Boolean(uncertain);
  return error;
}

function managedGatewayBudget(deadline, maximum) {
  const remaining = deadline - managedGatewayNow();
  if (remaining <= 0) throw managedGatewayError('gateway_restart_deadline_exceeded');
  return Math.min(remaining, maximum);
}

function managedGatewayDocker(args, deadline, maximum = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = managedGatewayBudget(deadline, maximum);
    const child = spawn('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
    });
    let stdout = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout.trim());
    };
    const stop = (code) => {
      try { child.kill('SIGKILL'); } catch { /* Report the unconfirmed result below. */ }
      finish(managedGatewayError(code, true));
    };
    const timer = setTimeout(() => stop('gateway_docker_timeout'), timeout);
    const collect = (chunk, isStdout) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 32768) { stop('gateway_docker_output_limit'); return; }
      if (isStdout) stdout += chunk.toString();
    };
    child.stdout.on('data', (chunk) => collect(chunk, true));
    child.stderr.on('data', (chunk) => collect(chunk, false));
    child.once('error', () => finish(managedGatewayError('gateway_docker_unavailable')));
    child.once('close', (code) => finish(code === 0 ? null : managedGatewayError(
      'gateway_docker_exit_' + (Number.isInteger(code) ? code : 'signal'),
    )));
  });
}

async function inspectManagedGateway(deadline) {
  const name = 'agent-' + INSTANCE_ID + '-gateway';
  // Do not collect Env, commands, mounts or other potentially secret values.
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},' +
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},' +
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},' +
    '"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},' +
    '"ip":{{json (index .NetworkSettings.Networks "hermes_net").IPAddress}}}';
  let target;
  try {
    target = JSON.parse(await managedGatewayDocker(['inspect', '--type', 'container', '--format', format, name], deadline));
  } catch (error) {
    if (error && error.failureType) throw error;
    throw managedGatewayError('gateway_container_inspect_invalid');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw managedGatewayError('gateway_container_inspect_invalid');
  const ipParts = typeof target.ip === 'string' ? target.ip.split('.') : [];
  const validIp = ipParts.length === 4 && ipParts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
  if (!/^[a-f0-9]{64}$/.test(target.id || '') || target.name !== '/' + name ||
      target.project !== INSTANCE_ID || target.service !== 'gateway' ||
      !/^sha256:[a-f0-9]{64}$/.test(target.image || '') ||
      typeof target.running !== 'boolean' || typeof target.startedAt !== 'string' || !Number.isFinite(Date.parse(target.startedAt)) ||
      !(validIp || (target.running === false && target.ip === ''))) {
    throw managedGatewayError('gateway_container_identity_mismatch');
  }
  return target;
}

function managedGatewayHealth(target, deadline) {
  return new Promise((resolve, reject) => {
    const timeout = managedGatewayBudget(deadline, 4000);
    let settled = false;
    let body = '';
    let size = 0;
    const finish = (error, ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(ready);
    };
    // Pin health to the inspected container's network address, not a DNS name
    // that a concurrent deploy could reassign to a replacement container.
    const request = http.request({
      hostname: target.ip, port: 8642, path: '/health/detailed', method: 'GET',
      headers: { Authorization: 'Bearer ' + API_KEY, Accept: 'application/json' },
    }, (response) => {
      response.on('data', (chunk) => {
        if (settled) return;
        size += Buffer.byteLength(chunk);
        if (size > 32768) {
          finish(managedGatewayError('gateway_health_output_limit'));
          request.destroy();
          return;
        }
        body += chunk.toString();
      });
      response.once('error', () => finish(managedGatewayError('gateway_health_response_failed')));
      response.once('end', () => {
        if (response.statusCode !== 200) {
          finish(managedGatewayError('gateway_health_http_' + response.statusCode));
          return;
        }
        let health;
        try { health = JSON.parse(body); } catch {
          finish(managedGatewayError('gateway_health_invalid_json')); return;
        }
        finish(null, health && health.status === 'ok' && health.gateway_state === 'running' &&
          health.readiness && health.readiness.status === 'ok' &&
          health.readiness.checks && health.readiness.checks.gateway &&
          health.readiness.checks.gateway.status === 'ok');
      });
    });
    const timer = setTimeout(() => {
      finish(managedGatewayError('gateway_health_timeout'));
      request.destroy();
    }, timeout);
    request.once('error', () => finish(managedGatewayError('gateway_health_unreachable')));
    request.end();
  });
}

function sameManagedGateway(target, expected) {
  return target.id === expected.id && target.image === expected.image;
}

async function runManagedGatewayRestart(action) {
  try {
    action.lines.push('Validating the managed gateway container.');
    const before = await inspectManagedGateway(action.deadline);
    action.lines.push('Restarting the validated gateway container.');
    action.mutationStarted = true;
    await managedGatewayDocker(['restart', '--time', '20', before.id], action.deadline, 30000);
    let lastFailure = 'gateway_not_ready';
    while (managedGatewayNow() < action.deadline) {
      const current = await inspectManagedGateway(action.deadline);
      if (!sameManagedGateway(current, before)) throw managedGatewayError('gateway_container_changed_during_restart');
      if (current.running && current.startedAt !== before.startedAt) {
        try {
          if (await managedGatewayHealth(current, action.deadline)) {
            const after = await inspectManagedGateway(action.deadline);
            if (!sameManagedGateway(after, current) || !after.running || after.startedAt !== current.startedAt || after.ip !== current.ip) {
              throw managedGatewayError('gateway_container_changed_during_readiness');
            }
            action.lines.push('Gateway restarted and authenticated readiness is healthy.');
            action.exit_code = 0;
            return;
          }
          lastFailure = 'gateway_readiness_degraded';
        } catch (error) {
          if (error.failureType === 'gateway_container_changed_during_readiness' ||
              error.failureType === 'gateway_health_http_401' || error.failureType === 'gateway_health_http_403') throw error;
          lastFailure = error.failureType || 'gateway_health_failed';
        }
      }
      await new Promise((resolve) => setTimeout(resolve, managedGatewayBudget(action.deadline, 2000)));
    }
    throw managedGatewayError('gateway_readiness_timeout_' + lastFailure);
  } catch (error) {
    const code = error.failureType || 'gateway_restart_failed';
    action.uncertain = action.mutationStarted && Boolean(error.uncertain);
    action.lines.push('Restart failed: ' + code + '. No fallback restart was attempted.');
    action.exit_code = 1;
    console.error('Managed gateway restart failed:', { failureType: code, uncertain: action.uncertain });
  } finally {
    action.running = false;
    action.finishedAt = managedGatewayNow();
  }
}

async function handleManagedGatewayAction(req, res, requestUrl, rawBody) {
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname).replace(/\\/+$/, ''); } catch { return false; }
  const restart = pathname === '/api/gateway/restart';
  if (!restart && pathname !== '/api/actions/gateway-restart/status') return false;
  const access = hasDashboardTokenAuth(req, requestUrl) ? { mode: 'token' } : requireDashboardAccess(req, rawBody);
  if (restart && (access.mode === 'cookie' || access.mode === 'webui_cookie')) {
    let sameOrigin = true;
    try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw createHttpError(403, 'Cross-origin gateway restart is not allowed');
  }
  if ((restart && req.method !== 'POST') || (!restart && req.method !== 'GET')) {
    sendJson(res, 405, { error: 'Method not allowed' }); return true;
  }
  const profiles = requestUrl.searchParams.getAll('profile');
  if (profiles.length > 1) throw createHttpError(400, 'Only one profile may be selected');
  if (normalizeProfileName(profiles[0]) !== 'default') {
    throw createHttpError(409, 'This managed restart supports the default gateway only; use the profile controls for other profiles');
  }
  if (rawBody.trim() && rawBody.trim() !== '{}') throw createHttpError(400, 'Gateway restart does not accept a request body');
  const upstream = new URL(DASHBOARD_UPSTREAM_URL);
  if (!API_KEY || upstream.protocol !== 'http:' || upstream.hostname !== 'agent-' + INSTANCE_ID + '-official-dashboard' || upstream.port !== '9119') {
    throw createHttpError(409, 'Managed gateway restart is not available for this runtime');
  }
  if (restart) {
    if (managedGatewayRestart && managedGatewayRestart.uncertain) {
      throw createHttpError(409, 'The previous restart result is unconfirmed; inspect the gateway before retrying');
    }
    const reuse = managedGatewayRestart && (managedGatewayRestart.running || managedGatewayNow() - managedGatewayRestart.finishedAt < 5000);
    if (!reuse) {
      const action = { running: true, exit_code: null, lines: [], deadline: managedGatewayNow() + MANAGED_GATEWAY_RESTART_TIMEOUT_MS };
      managedGatewayRestart = action;
      action.promise = runManagedGatewayRestart(action);
    }
    // 202 is acceptance, not a success claim. Both native UIs poll this action.
    sendJson(res, 202, { ok: true, accepted: true, name: 'gateway-restart', pid: null, already_running: Boolean(reuse) });
  } else {
    const action = managedGatewayRestart;
    if (!action) throw createHttpError(404, 'No managed gateway restart result is available');
    if (action.running) {
      // Desktop polls only 18 times. Bounded long-polling covers the 180s
      // restart deadline while staying below its 30s HTTP request timeout.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, MANAGED_GATEWAY_ACTION_POLL_MS);
        action.promise.then(() => { clearTimeout(timer); resolve(); });
      });
    }
    sendJson(res, 200, { name: 'gateway-restart', pid: null, running: action.running, exit_code: action.exit_code, lines: action.lines.slice(-20) });
  }
  return true;
}

function collectSetCookiePairs(response) {
  let setCookies = [];
  if (response && response.headers) {
    if (typeof response.headers.getSetCookie === 'function') {
      setCookies = response.headers.getSetCookie();
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) setCookies = [raw];
    }
  }
  const pairs = [];
  for (const entry of setCookies) {
    const first = String(entry || '').split(';')[0].trim();
    if (first && first.includes('=')) {
      pairs.push(first);
    }
  }
  return pairs.join('; ');
}

async function loginDashboardUpstream(base) {
  const normalizedBase = normalizeDashboardUpstreamBase(base) || normalizeDashboardUpstreamBase(DASHBOARD_UPSTREAM_URL);
  if (!normalizedBase) {
    throw createHttpError(502, 'No dashboard upstream available for login');
  }
  const loginUrl = new URL('/auth/password-login', normalizedBase + '/');
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ provider: 'basic', username: DASHBOARD_BASIC_AUTH_USERNAME, password: API_KEY, next: '/' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(DASHBOARD_UPSTREAM_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (typeof response.text === 'function') { await response.text().catch(() => {}); }
    const err = createHttpError(response.status || 502, 'Dashboard upstream login failed');
    err.failureType = 'sidecar_dashboard_upstream_login_failed';
    throw err;
  }
  const cookie = collectSetCookiePairs(response);
  if (!cookie) {
    throw createHttpError(502, 'Dashboard upstream login returned no session cookie');
  }
  dashboardUpstreamCookie = cookie;
  dashboardUpstreamCookieExpiresAt = Date.now() + DASHBOARD_UPSTREAM_LOGIN_TTL_MS;
  return cookie;
}

function ensureDashboardUpstreamCookie(base) {
  if (dashboardUpstreamCookie && Date.now() < dashboardUpstreamCookieExpiresAt) {
    return Promise.resolve(dashboardUpstreamCookie);
  }
  if (!dashboardUpstreamLoginPromise) {
    // Same wedge guard pattern as dashboardRecoveryPromise (PR #482): bound
    // the memoized login with a hard deadline so the memo cannot outlive its
    // ceiling. loginDashboardUpstream uses fetch+AbortSignal.timeout(8s) so it
    // SHOULD self-bound, but this is defense-in-depth + clears the memo
    // cleanly on rejection so the next /desktop request retries fresh
    // instead of awaiting a dead promise forever.
    dashboardUpstreamLoginPromise = withDeadline(
      loginDashboardUpstream(base),
      DASHBOARD_RECOVERY_DEADLINE_MS,
      'loginDashboardUpstream',
    ).catch((err) => {
      console.error('Dashboard upstream login deadline exceeded:', {
        failureType: 'sidecar_dashboard_login_deadline_exceeded',
        deadlineMs: DASHBOARD_RECOVERY_DEADLINE_MS,
        errorName: err && err.name ? err.name : typeof err,
      });
      throw err;
    }).finally(() => {
      dashboardUpstreamLoginPromise = null;
    });
  }
  return dashboardUpstreamLoginPromise;
}

function refreshDashboardUpstreamCookie(base) {
  dashboardUpstreamCookie = '';
  dashboardUpstreamCookieExpiresAt = 0;
  return ensureDashboardUpstreamCookie(base);
}

async function mintDashboardWsTicket(base) {
  const normalizedBase = normalizeDashboardUpstreamBase(base) || normalizeDashboardUpstreamBase(DASHBOARD_UPSTREAM_URL);
  if (!normalizedBase) {
    throw createHttpError(502, 'No dashboard upstream available for ws-ticket');
  }
  const ticketUrl = new URL('/api/auth/ws-ticket', normalizedBase + '/');
  const postTicket = () => fetch(ticketUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', Cookie: dashboardUpstreamCookie },
    signal: AbortSignal.timeout(DASHBOARD_UPSTREAM_FETCH_TIMEOUT_MS),
  });
  await ensureDashboardUpstreamCookie(normalizedBase);
  let response = await postTicket();
  if (response.status === 401 || response.status === 403) {
    await refreshDashboardUpstreamCookie(normalizedBase);
    response = await postTicket();
  }
  if (!response.ok) {
    throw createHttpError(response.status || 502, 'Dashboard ws-ticket mint failed');
  }
  const data = await response.json().catch(() => null);
  const ticket = data && typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) {
    throw createHttpError(502, 'Dashboard ws-ticket response missing ticket');
  }
  return ticket;
}

function dashboardProxyTimeoutMs(requestUrl) {
  return requestUrl && DASHBOARD_BOOTSTRAP_PATHS.has(requestUrl.pathname)
    ? DASHBOARD_BOOTSTRAP_PROXY_TIMEOUT_MS
    : DASHBOARD_PROXY_TIMEOUT_MS;
}

function dashboardProxyOnceWithCookie(req, res, requestUrl, rawBody, upstreamBase, allowAuthRetry) {
  const normalizedBase = normalizeDashboardUpstreamBase(upstreamBase);
  if (!normalizedBase) {
    return Promise.resolve('unavailable');
  }
  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, normalizedBase + '/');
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const proxyTimeoutMs = dashboardProxyTimeoutMs(requestUrl);
  const headers = { ...req.headers };
  delete headers.host;
  // The browser-facing bearer authenticates TO the sidecar; it is not an
  // upstream dashboard credential. Hardened dashboards register their own
  // bearer-token routes before the cookie gate, so forwarding this unrelated
  // bearer makes that outer seam reject the request before the valid session
  // cookie below can be evaluated. Terminate the external credential here and
  // translate it to the internal cookie/session-header contract only.
  delete headers.authorization;
  // Mixed-fleet compatibility: some official-dashboard images still run in
  // legacy token-auth mode (auth_required=false, commonly via --insecure),
  // where password-login cookies are minted but deliberately ignored by the
  // API middleware. Newer gated images use the cookie below. Send the
  // dashboard's dedicated internal session header as well so either mode can
  // authenticate the same sidecar-proxied browser request. This value never
  // leaves the compose network and overwrites any client-supplied header.
  headers['x-hermes-session-token'] = API_KEY;
  if (dashboardUpstreamCookie) {
    headers.cookie = dashboardUpstreamCookie;
  } else {
    delete headers.cookie;
  }
  if (rawBody) {
    headers['content-length'] = Buffer.byteLength(rawBody);
  } else {
    delete headers['content-length'];
  }
  return new Promise((resolve) => {
    let settled = false;
    const ac = new AbortController();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (value === 'unavailable') {
        try { ac.abort(); } catch {}
      }
      resolve(value);
    };
    // Wall-clock kill-timer from request CREATION. Bounds TCP-connect stalls
    // (Node default connect timeout is Infinity, proxyReq.setTimeout below
    // only counts post-socket-assign). This is the durable fix for the gated
    // /desktop wedge confirmed 2026-06-26 on NOBLEAGENT (b4687efc): dashboard
    // momentarily down -> cached cookie still valid -> proxy request stalls
    // forever on a half-open socket -> the proxyToGatedDashboard caller
    // awaits it and the sidecar wedges for the whole request, despite
    // PR #482's withDeadline on resolveDashboardUpstreamBase.
    const killTimer = setTimeout(() => {
      try { ac.abort(); } catch {}
      finish('unavailable');
    }, proxyTimeoutMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    const proxyReq = transport.request(upstreamUrl, { method: req.method || 'GET', headers, signal: ac.signal, lookup: dashboardDnsLookup }, (proxyRes) => {
      // Headers received — drop the connect timeout so long-lived SSE streams
      // (chat tokens with multi-second gaps) are not severed mid-stream.
      // Also clear the kill-timer: from here on, body streaming may legitimately
      // take longer than DASHBOARD_PROXY_TIMEOUT_MS and we must not abort it.
      try { proxyReq.setTimeout(0); } catch (_) {}
      clearTimeout(killTimer);
      if (allowAuthRetry && proxyRes.statusCode === 401) {
        if (typeof proxyRes.resume === 'function') proxyRes.resume();
        finish('auth');
        return;
      }
      cachedDashboardUpstreamBase = normalizedBase;
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
      finish('ok');
    });
    if (typeof proxyReq.setTimeout === 'function') {
      proxyReq.setTimeout(proxyTimeoutMs, () => {
        if (typeof proxyReq.destroy === 'function') proxyReq.destroy();
        finish('unavailable');
      });
    }
    proxyReq.on('error', () => finish('unavailable'));
    if (rawBody) {
      proxyReq.end(rawBody);
    } else {
      proxyReq.end();
    }
  });
}

async function proxyToGatedDashboard(req, res, requestUrl, rawBody) {
  const base = await resolveDashboardUpstreamBase(false);
  if (base) {
    await ensureDashboardUpstreamCookie(base).catch(() => {});
    const outcome = await dashboardProxyOnceWithCookie(req, res, requestUrl, rawBody, base, true);
    if (outcome === 'ok') return;
    if (outcome === 'auth') {
      await refreshDashboardUpstreamCookie(base).catch(() => {});
      const retry = await dashboardProxyOnceWithCookie(req, res, requestUrl, rawBody, base, false);
      if (retry === 'ok' || retry === 'auth') return;
    }
  }
  cachedDashboardUpstreamBase = '';
  const recovered = await resolveDashboardUpstreamBase(true);
  if (recovered) {
    await ensureDashboardUpstreamCookie(recovered).catch(() => {});
    const outcome = await dashboardProxyOnceWithCookie(req, res, requestUrl, rawBody, recovered, true);
    if (outcome === 'ok') return;
    if (outcome === 'auth') {
      await refreshDashboardUpstreamCookie(recovered).catch(() => {});
      const retry = await dashboardProxyOnceWithCookie(req, res, requestUrl, rawBody, recovered, false);
      if (retry === 'ok' || retry === 'auth') return;
    }
  }
  if (!res.headersSent) {
    sendJson(res, 502, { error: 'Dashboard upstream unavailable' });
    return;
  }
  res.end();
}

async function handleGatedDashboardRequest(req, res, requestUrl, rawBody) {
  if (!hasDashboardTokenAuth(req, requestUrl)) {
    // No SPA token — fall back to the existing browser-cookie / HMAC gate.
    requireDashboardAccess(req, rawBody);
  }
  await proxyToGatedDashboard(req, res, requestUrl, rawBody);
}

async function handleGatedDashboardWsUpgrade(req, socket, head, requestUrl) {
  // Guard the raw client socket while we do the async ticket mint below — a
  // client disconnect mid-handshake would otherwise emit an unhandled 'error'.
  socket.on('error', () => {});
  if (!hasDashboardTokenAuth(req, requestUrl)) {
    rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  let base = await resolveDashboardUpstreamBase(false);
  if (!base) {
    base = normalizeDashboardUpstreamBase(DASHBOARD_UPSTREAM_URL);
  }
  if (!base) {
    rejectWebSocketUpgrade(socket, 502, 'No dashboard upstream');
    return;
  }
  // Mint a single-use ws-ticket against the gated dashboard. If that fails
  // because the dashboard ISN'T gated (older image with no /api/auth/ws-ticket
  // route — e.g. a fork that hasn't synced the hardening yet), fall back to
  // forwarding the SPA's original ?token= verbatim: the ungated /api/ws accepts
  // the token it already trusts. On a genuinely gated dashboard ?token= is
  // unconditionally rejected, so this fallback never weakens the gate — it only
  // keeps the bridge backward-compatible during a mixed-fleet rollout.
  let ticket = null;
  try {
    ticket = await mintDashboardWsTicket(base);
  } catch (_) {
    ticket = null;
  }
  const upstreamUrl = new URL(requestUrl.pathname, normalizeDashboardUpstreamBase(base) + '/');
  if (ticket) {
    for (const [key, value] of requestUrl.searchParams) {
      if (key !== 'token') upstreamUrl.searchParams.set(key, value);
    }
    upstreamUrl.searchParams.set('ticket', ticket);
  } else {
    for (const [key, value] of requestUrl.searchParams) {
      upstreamUrl.searchParams.set(key, value);
    }
  }
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = {
    Host: upstreamUrl.host,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': req.headers['sec-websocket-version'] || '13',
    'Sec-WebSocket-Key': req.headers['sec-websocket-key'] || '',
  };
  if (req.headers['sec-websocket-protocol']) headers['Sec-WebSocket-Protocol'] = req.headers['sec-websocket-protocol'];
  if (req.headers['sec-websocket-extensions']) headers['Sec-WebSocket-Extensions'] = req.headers['sec-websocket-extensions'];
  if (dashboardUpstreamCookie) headers.Cookie = dashboardUpstreamCookie;
  const upstreamReq = transport.request(upstreamUrl, { method: 'GET', headers, lookup: dashboardDnsLookup });
  let settled = false;
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    settled = true;
    const responseLines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
    if (upstreamRes.headers['sec-websocket-accept']) {
      responseLines.push('Sec-WebSocket-Accept: ' + upstreamRes.headers['sec-websocket-accept']);
    }
    if (upstreamRes.headers['sec-websocket-protocol']) {
      responseLines.push('Sec-WebSocket-Protocol: ' + upstreamRes.headers['sec-websocket-protocol']);
    }
    // This is a byte-for-byte tunnel after the 101 response. If the client
    // offers permessage-deflate and the dashboard accepts it, omitting the
    // negotiated extension here makes the browser interpret compressed frames
    // as uncompressed data: the handshake opens, then the first
    // gateway.ready frame trips RSV1 and the socket dies with code 1006.
    // Reflect the upstream negotiation exactly because this relay does not
    // terminate or transform WebSocket frames.
    if (upstreamRes.headers['sec-websocket-extensions']) {
      responseLines.push('Sec-WebSocket-Extensions: ' + upstreamRes.headers['sec-websocket-extensions']);
    }
    try {
      socket.write(responseLines.join('\\r\\n') + '\\r\\n\\r\\n');
      if (head && head.length) upstreamSocket.write(head);
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
    } catch (_) {
      try { upstreamSocket.destroy(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return;
    }
    socket.setNoDelay(true);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const cleanup = () => {
      try { upstreamSocket.destroy(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
    };
    upstreamSocket.on('error', cleanup);
    socket.on('error', cleanup);
    upstreamSocket.on('close', () => { try { socket.end(); } catch (_) {} });
    socket.on('close', () => { try { upstreamSocket.end(); } catch (_) {} });
  });
  upstreamReq.on('response', (upstreamRes) => {
    if (settled) return;
    settled = true;
    if (typeof upstreamRes.resume === 'function') upstreamRes.resume();
    rejectWebSocketUpgrade(socket, upstreamRes.statusCode || 502, 'Dashboard did not upgrade websocket');
  });
  upstreamReq.on('error', () => {
    if (settled) return;
    settled = true;
    rejectWebSocketUpgrade(socket, 502, 'Dashboard websocket dial failed');
  });
  if (typeof upstreamReq.setTimeout === 'function') {
    upstreamReq.setTimeout(DASHBOARD_UPSTREAM_FETCH_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      try { upstreamReq.destroy(); } catch (_) {}
      rejectWebSocketUpgrade(socket, 504, 'Dashboard websocket timeout');
    });
  }
  upstreamReq.end();
}
// DASHBOARD_GATED_PROXY_END

function getTargetEnvFile(profile) {
  const isSubProfile = profile && profile !== 'default';
  return isSubProfile
    ? path.join(HOST_PROFILES_DIR, profile, '.env')
    : MAIN_ENV_FILE;
}

function makeWebUIWritable(targetPath, mode) {
  try {
    fs.chownSync(targetPath, 1024, 1024);
  } catch (_) {}
  try {
    fs.chmodSync(targetPath, mode);
  } catch (_) {}
}

function markGatewayProfileActive(profile) {
  const normalizedProfile = profile || 'default';
  const baseHome = path.dirname(MAIN_ENV_FILE);
  const profileHome = normalizedProfile === 'default'
    ? baseHome
    : path.join(HOST_PROFILES_DIR, normalizedProfile);
  const activeDir = path.join(baseHome, 'gateway-profiles.d');
  const markerPath = path.join(activeDir, normalizedProfile + '.active');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(markerPath, profileHome + '\\\\n', 'utf8');
  makeWebUIWritable(activeDir, 0o755);
  makeWebUIWritable(markerPath, 0o600);
}

function readKeysPresent(targetEnvFile) {
  let currentEnv = '';
  if (fs.existsSync(targetEnvFile)) {
    currentEnv = fs.readFileSync(targetEnvFile, 'utf8');
  }

  return currentEnv
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .filter((line) => !isCanaryShapeProbeEnvLine(line))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
    .filter(Boolean);
}

function isCanaryShapeProbeEnvLine(line) {
  const value = String(line || '').slice(String(line || '').indexOf('=') + 1).trim();
  return value.includes('CANARY_SHAPE_PROBE');
}

function writeEnvFile(targetEnvFile, envUpdates, prefixToRemove, keysToRemove) {
  let currentEnv = '';
  if (fs.existsSync(targetEnvFile)) {
    currentEnv = fs.readFileSync(targetEnvFile, 'utf8');
  }

  let lines = currentEnv.split('\\n');
  if (prefixToRemove) {
    lines = lines.filter((line) => !line.startsWith(prefixToRemove));
  }

  if (Array.isArray(keysToRemove) && keysToRemove.length > 0) {
    lines = lines.filter((line) => {
      if (!line.includes('=')) return true;
      const key = line.split('=')[0].trim();
      return !keysToRemove.includes(key);
    });
  }

  if (Array.isArray(envUpdates)) {
    lines.push(...envUpdates);
  }

  const newContent = lines.join('\\n').trim() + '\\n';
  fs.mkdirSync(path.dirname(targetEnvFile), { recursive: true });
  fs.writeFileSync(targetEnvFile, newContent, 'utf8');
  makeWebUIWritable(path.dirname(targetEnvFile), 0o755);
  makeWebUIWritable(targetEnvFile, 0o600);
}

function restartProfile(profile, isSubProfile) {
  if (isSubProfile) {
        // Stop the gateway so the supervisor (installed by the start / SSH-CONNECT
        // paths) respawns it with the new .env. No relaunch here: this sidecar is
        // inlined into the size-capped userdata so it can't carry a supervisor of
        // its own. See dashboard/src/lib/services/gateway-supervisor.ts.
        setTimeout(() => {
          const restartCommand =
            "docker exec agent-" + INSTANCE_ID +
            " sh -c 'BASE_HOME=\\\"" + '$' + "{HERMES_HOME:-/root/.hermes}\\\"; " +
            "PROFILE_HOME=\\\"$BASE_HOME/profiles/" + profile + "\\\"; " +
            "HERMES_BIN=/opt/venv/bin/hermes; " +
            "if [ ! -x \\\"$HERMES_BIN\\\" ]; then HERMES_BIN=/opt/hermes/.venv/bin/hermes; fi; " +
            "if [ ! -x \\\"$HERMES_BIN\\\" ]; then HERMES_BIN=$(command -v hermes); fi; " +
            "HERMES_HOME=\\\"$PROFILE_HOME\\\" \\\"$HERMES_BIN\\\" gateway stop || true'";
          exec(restartCommand, () => {});
        }, 1000);

    return;
  }

  exec('sleep 1 && (docker restart agent-' + INSTANCE_ID + '-gateway || docker restart agent-' + INSTANCE_ID + ')', (e) => {
    if (e) console.error('integration gateway restart failed', { failureType: 'sidecar_integrations_gateway_restart_failed', instanceId: INSTANCE_ID, errorName: e.name });
  });
}

function normalizeTerminalSessionKey(rawSessionKey) {
  const sessionKey = typeof rawSessionKey === 'string' ? rawSessionKey.trim() : '';
  if (!SAFE_TERMINAL_SESSION_KEY.test(sessionKey)) {
    throw createHttpError(400, 'Invalid terminal session key');
  }
  return sessionKey;
}

function normalizeTerminalSessionToken(rawSessionToken) {
  const sessionToken = typeof rawSessionToken === 'string' ? rawSessionToken.trim() : '';
  if (!SAFE_TERMINAL_SESSION_TOKEN.test(sessionToken)) {
    throw createHttpError(400, 'Invalid terminal session token');
  }
  return sessionToken;
}

function normalizeTerminalSessionMode(rawMode) {
  return rawMode === 'tui' ? 'tui' : 'shell';
}

function buildTerminalSessionKey(mode) {
  return 'term:sidecar:' + INSTANCE_ID + ':' + normalizeTerminalSessionMode(mode);
}

function resolveTerminalStartSessionIdentity(parsedBody) {
  const mode = normalizeTerminalSessionMode(parsedBody && parsedBody.mode);
  const rawSessionKey = typeof parsedBody.sessionKey === 'string' ? parsedBody.sessionKey.trim() : '';
  const rawSessionToken = typeof parsedBody.sessionToken === 'string' ? parsedBody.sessionToken.trim() : '';

  return {
    mode,
    sessionKey: rawSessionKey ? normalizeTerminalSessionKey(rawSessionKey) : buildTerminalSessionKey(mode),
    sessionToken: rawSessionToken ? normalizeTerminalSessionToken(rawSessionToken) : crypto.randomUUID(),
  };
}

function getTerminalSession(sessionKey, sessionToken) {
  const session = terminalSessions.get(sessionKey) || null;
  if (!session) {
    return null;
  }

  if (sessionToken && session.sessionToken !== sessionToken) {
    return null;
  }

  return session;
}

function trimTerminalScrollback(scrollback) {
  if (scrollback.length <= TERMINAL_MAX_SCROLLBACK) {
    return scrollback;
  }
  return scrollback.slice(-TERMINAL_MAX_SCROLLBACK);
}

// DESKTOP_TERMINAL_TOUCH_START
function touchTerminalSession(sessionKey, session) {
  clearTimeout(session.inactivityTimer);
  session.lastActivity = Date.now();
  session.inactivityTimer = setTimeout(() => {
    destroyTerminalSession(sessionKey, 'inactive');
  }, session.kind === 'desktop' ? 5 * 60 * 1000 : TERMINAL_INACTIVITY_TTL_MS);
}
// DESKTOP_TERMINAL_TOUCH_END

function buildTerminalClosedPayload(reason, details) {
  const normalizedReason = typeof reason === 'string' && reason ? reason : 'closed';
  const exitCode = details && typeof details.exitCode === 'number' ? details.exitCode : null;
  const signal = details && typeof details.signal === 'string' ? details.signal : null;
  const errorMessage = details && typeof details.errorMessage === 'string' ? details.errorMessage : '';

  let message = 'Session closed by the terminal process.';
  if (normalizedReason === 'stopped') {
    message = 'Session closed by the dashboard.';
  } else if (normalizedReason === 'inactive') {
    message = 'Session closed after 30 minutes of inactivity.';
  } else if (normalizedReason === 'error') {
    message = errorMessage
      ? 'Session closed after a terminal error: ' + errorMessage
      : 'Session closed after a terminal error.';
  } else if (typeof exitCode === 'number') {
    message = exitCode === 0
      ? 'Session ended cleanly.'
      : 'Session exited with code ' + exitCode + '.';
  } else if (signal) {
    message = 'Session exited after signal ' + signal + '.';
  }

  return {
    type: 'closed',
    reason: normalizedReason,
    message,
    exitCode,
    signal,
  };
}

function emitTerminalData(sessionKey, session, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  if (!text) return;

  session.scrollback = trimTerminalScrollback(session.scrollback + text);
  touchTerminalSession(sessionKey, session);

  for (const listener of session.listeners) {
    try {
      listener({ type: 'output', data: text });
    } catch {}
  }
}

function encodeTerminalInput(data) {
  return Buffer.from(String(data || ''), 'utf8').toString('base64');
}

function decodeTerminalOutput(data) {
  return Buffer.from(String(data || ''), 'base64').toString('utf8');
}

function sendTerminalControlMessage(session, payload) {
  if (!session || !session.process || !session.process.stdin || session.process.stdin.destroyed) {
    return false;
  }

  try {
    session.process.stdin.write(JSON.stringify(payload) + '\\n');
    return true;
  } catch {
    return false;
  }
}

function consumeTerminalHelperOutput(sessionKey, session, chunk) {
  session.helperOutputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  const lines = session.helperOutputBuffer.split('\\n');
  session.helperOutputBuffer = lines.pop() || '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      emitTerminalData(sessionKey, session, rawLine + '\\n');
      continue;
    }

    // DESKTOP_TERMINAL_READY_START
    if (session.kind === 'desktop' && parsed.type === 'ready') {
      const lease = session.desktopLease;
      if (parsed.marker !== lease.marker || !Number.isInteger(parsed.pid) || parsed.pid <= 1) {
        destroyTerminalSession(sessionKey, 'error', { errorMessage: 'Invalid native terminal process identity' });
        return;
      }
      lease.started = true;
      session.desktopPid = parsed.pid;
      if (!lease.cancelled) lease.resolveReady();
      continue;
    }
    // DESKTOP_TERMINAL_READY_END

    if (parsed.type === 'output' && typeof parsed.data === 'string') {
      // DESKTOP_TERMINAL_DECODE_START
      const output = session.kind === 'desktop'
        ? session.outputDecoder.write(Buffer.from(parsed.data, 'base64'))
        : decodeTerminalOutput(parsed.data);
      emitTerminalData(sessionKey, session, output);
      // DESKTOP_TERMINAL_DECODE_END
      continue;
    }

    if (parsed.type === 'error' && typeof parsed.message === 'string' && parsed.message) {
      emitTerminalData(sessionKey, session, '\\r\\n\\x1b[31m' + parsed.message + '\\x1b[0m\\r\\n');
      continue;
    }

    if (parsed.type === 'closed') {
      destroyTerminalSession(sessionKey, 'closed', {
        exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
        signal: typeof parsed.signal === 'string' ? parsed.signal : null,
      });
    }
  }
}

function destroyTerminalSession(sessionKey, reason, details) {
  const session = terminalSessions.get(sessionKey);
  if (!session) return;

  // DESKTOP_TERMINAL_DESTROY_START
  if (session.kind === 'desktop' && (!details || details.desktopCleanup !== true)) {
    scheduleDesktopTerminalStop(session.desktopLease, reason, details);
    return;
  }
  // DESKTOP_TERMINAL_DESTROY_END
  clearTimeout(session.inactivityTimer);
  const closedPayload = buildTerminalClosedPayload(reason, details);
  // DESKTOP_TERMINAL_CLOSED_START
  if (session.kind === 'desktop') {
    closedPayload.cleanupConfirmed = !!details && details.cleanupConfirmed === true;
    if (reason === 'inactive') closedPayload.message = 'Session closed after 5 minutes of inactivity.';
  }
  // DESKTOP_TERMINAL_CLOSED_END

  for (const listener of session.listeners) {
    try {
      listener(closedPayload);
    } catch {}
  }
  session.listeners.clear();

  // WEBUI_TERMINAL_PROXY_DESTROY_START
  if (session.kind === 'webui') {
    if (session.streamAbortController) {
      session.streamAbortController.abort();
    }
    if (!details || details.skipWebUIClose !== true) {
      closeWebUITerminal(session).catch(() => {});
    }
    terminalSessions.delete(sessionKey);
    console.log('[Terminal Sidecar] Session closed:', sessionKey, closedPayload.reason || 'unknown');
    return;
  }
  // WEBUI_TERMINAL_PROXY_DESTROY_END

  sendTerminalControlMessage(session, { type: 'stop' });

  try {
    session.process.stdin.end();
  } catch {}

  const forceKillTimer = setTimeout(() => {
    try {
      session.process.kill('SIGTERM');
    } catch {}
  }, 250);

  if (typeof forceKillTimer.unref === 'function') {
    forceKillTimer.unref();
  }

  session.process.once('close', () => {
    clearTimeout(forceKillTimer);
  });

  terminalSessions.delete(sessionKey);
  console.log('[Terminal Sidecar] Session closed:', sessionKey, closedPayload.reason || 'unknown');
}

function buildTuiBootstrapCommand() {
  return ${JSON.stringify(HERMES_TUI_BOOTSTRAP_COMMAND)};
}

function buildTerminalContainerResolutionCommand() {
  const candidates = [
    'agent-' + INSTANCE_ID,
    'agent-' + INSTANCE_ID + '-gateway',
    'agent-' + INSTANCE_ID + '-official-dashboard',
  ];

  return [
    'TERMINAL_CONTAINER=""',
    'for TERMINAL_CANDIDATE in ' + candidates.map((candidate) => JSON.stringify(candidate)).join(' ') + '; do',
    "  if docker inspect -f '{{.State.Running}}' \\\"$TERMINAL_CANDIDATE\\\" 2>/dev/null | grep -q true; then TERMINAL_CONTAINER=\\\"$TERMINAL_CANDIDATE\\\"; break; fi",
    'done',
    'if [ -z "$TERMINAL_CONTAINER" ]; then echo "no running terminal container for agent-' + INSTANCE_ID + '" >&2; exit 1; fi',
  ].join('\\n');
}

function buildTerminalCommand(cols, rows, mode) {
  const execUserArgs = TERMINAL_EXEC_USER ? ' --user ' + JSON.stringify(TERMINAL_EXEC_USER) : '';
  const workdir = mode === 'tui' ? TERMINAL_TUI_CWD : TERMINAL_SHELL_CWD;
  const workdirArgs = workdir ? ' --workdir ' + JSON.stringify(workdir) : '';
  const containerResolution = buildTerminalContainerResolutionCommand();

  if (mode === 'tui') {
    return containerResolution + '; exec docker exec' + execUserArgs + workdirArgs +
      ' -e TERM=xterm-256color -e COLUMNS=' + cols +
      ' -e LINES=' + rows +
      ' -it "$TERMINAL_CONTAINER" bash -lc ' + JSON.stringify(buildTuiBootstrapCommand());
  }

  return containerResolution + '; exec docker exec' + execUserArgs + workdirArgs +
    ' -e TERM=xterm-256color -e COLUMNS=' + cols +
    ' -e LINES=' + rows +
    ' -it "$TERMINAL_CONTAINER" bash -i';
}

function createTerminalSession(sessionKey, sessionToken, cols, rows, mode, desktopOptions) {
  const existing = getTerminalSession(sessionKey);
  // DESKTOP_TERMINAL_EXISTING_START
  if (existing && (desktopOptions || existing.kind === 'desktop')) {
    throw createHttpError(409, 'Terminal session already exists');
  }
  // DESKTOP_TERMINAL_EXISTING_END
  if (existing && mode !== 'tui') {
    existing.sessionToken = sessionToken;
    touchTerminalSession(sessionKey, existing);
    return existing;
  }

  if (existing) {
    destroyTerminalSession(sessionKey, 'stopped');
  }

  const safeCols = Number.isFinite(cols) ? Math.min(Math.max(Math.floor(cols), 10), 500) : 80;
  const safeRows = Number.isFinite(rows) ? Math.min(Math.max(Math.floor(rows), 2), 200) : 24;
  const sessionMode = normalizeTerminalSessionMode(mode);
  // DESKTOP_TERMINAL_SPAWN_START
  const terminalCommand = desktopOptions ? '' : buildTerminalCommand(safeCols, safeRows, sessionMode);
  const helperCode = desktopOptions ? DESKTOP_TERMINAL_PTY_HELPER_CODE : TERMINAL_PTY_HELPER_CODE;
  const helperBootstrap = desktopOptions
    ? 'PYTHON_BIN=$(command -v python3 || command -v python); [ -n "$PYTHON_BIN" ] || exit 127; exec "$PYTHON_BIN" -I -S -u -c "$HERMES_TERMINAL_PTY_HELPER"'
    : TERMINAL_PTY_HELPER_BOOTSTRAP;
  const terminalProcess = spawn('/bin/sh', ['-lc', helperBootstrap], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...(desktopOptions ? { PATH: '/usr/local/bin:/usr/bin:/bin' } : process.env),
      ...(desktopOptions ? {
        HERMES_TERMINAL_ARGV: JSON.stringify(desktopOptions.argv),
        HERMES_TERMINAL_MARKER: desktopOptions.lease.marker,
      } : {}),
      HERMES_TERMINAL_PTY_HELPER: helperCode,
      HERMES_TERMINAL_COMMAND: terminalCommand,
      HERMES_TERMINAL_COLS: String(safeCols),
      HERMES_TERMINAL_ROWS: String(safeRows),
    },
  });
  // DESKTOP_TERMINAL_SPAWN_END
  terminalProcess.stdin.on('error', () => {});

  const session = {
    // DESKTOP_TERMINAL_SESSION_START
    ...(desktopOptions ? {
      kind: 'desktop', desktopLease: desktopOptions.lease, desktopSockets: new Set(),
      outputDecoder: new (require('string_decoder').StringDecoder)('utf8'),
    } : {}),
    // DESKTOP_TERMINAL_SESSION_END
    process: terminalProcess,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scrollback: '',
    listeners: new Set(),
    cols: safeCols,
    rows: safeRows,
    mode: sessionMode,
    sessionToken,
    helperOutputBuffer: '',
    // DESKTOP_TERMINAL_TTL_START
    inactivityTimer: setTimeout(() => {
      destroyTerminalSession(sessionKey, 'inactive');
    }, desktopOptions ? 5 * 60 * 1000 : TERMINAL_INACTIVITY_TTL_MS),
    // DESKTOP_TERMINAL_TTL_END
  };

  terminalProcess.stdout.on('data', (chunk) => {
    consumeTerminalHelperOutput(sessionKey, session, chunk);
  });

  terminalProcess.stderr.on('data', (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (!text) return;
    emitTerminalData(sessionKey, session, '\\r\\n\\x1b[31m' + text.replace(/\\n/g, '\\r\\n') + '\\x1b[0m');
  });

  terminalProcess.on('error', (err) => {
    const safeTerminalProcessMessage = 'Terminal process failed';
    emitTerminalData(sessionKey, session, '\\r\\n\\x1b[31m' + safeTerminalProcessMessage + '\\x1b[0m\\r\\n');
    destroyTerminalSession(sessionKey, 'error', {
      errorMessage: safeTerminalProcessMessage,
    });
  });

  terminalProcess.on('close', (code, signal) => {
    destroyTerminalSession(sessionKey, 'closed', {
      exitCode: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    });
  });

  terminalSessions.set(sessionKey, session);
  return session;
}

function sendTerminalEvent(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\\n\\n');
}

// WEBUI_TERMINAL_PROXY_FUNCTIONS_START
function webUITerminalProxyEnabled() {
  return Boolean(WEBUI_TERMINAL_UPSTREAM_URL);
}

function shouldFallbackToContainerTerminal(err) {
  return Boolean(err && (err.statusCode === 404 || err.statusCode === 405));
}

function webUITerminalUrl(pathname, searchParams) {
  const base = WEBUI_TERMINAL_UPSTREAM_URL.endsWith('/')
    ? WEBUI_TERMINAL_UPSTREAM_URL
    : WEBUI_TERMINAL_UPSTREAM_URL + '/';
  const url = new URL(String(pathname || '').replace(/^\\//, ''), base);
  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function webUITerminalHeaders(accept, includeJson) {
  return {
    Accept: accept,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    'x-hermes-session-token': API_KEY,
  };
}

function logWebUITerminalProxyFailure(stage, err, context) {
  console.error('WebUI terminal proxy failed:', {
    failureType: 'sidecar_webui_terminal_proxy_failed',
    stage,
    errorName: err && err.name ? err.name : typeof err,
    statusCode: err && err.statusCode ? err.statusCode : null,
    mode: context && context.mode ? context.mode : undefined,
    action: context && context.action ? context.action : undefined,
    upstreamConfigured: webUITerminalProxyEnabled(),
  });
}

async function fetchWebUITerminalJson(pathname, payload) {
  const response = await fetch(webUITerminalUrl(pathname), {
    method: 'POST',
    headers: webUITerminalHeaders('application/json', true),
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    const message = parsed && typeof parsed.error === 'string' && parsed.error
      ? parsed.error
      : 'WebUI terminal request failed';
    const err = createHttpError(response.status, message);
    err.failureType = 'sidecar_webui_terminal_proxy_upstream_error';
    throw err;
  }

  return parsed || {};
}

async function closeWebUITerminal(session) {
  if (!session || !session.webuiSessionId || !webUITerminalProxyEnabled()) return;
  await fetchWebUITerminalJson('/api/terminal/close', {
    session_id: session.webuiSessionId,
  });
}

async function bootstrapWebUITerminalTui(session) {
  if (!session || session.mode !== 'tui') return;
  await fetchWebUITerminalJson('/api/terminal/input', {
    session_id: session.webuiSessionId,
    data: buildTuiBootstrapCommand() + '\\n',
  });
}

async function proxyWebUITerminalStart(sessionKey, sessionToken, cols, rows, mode) {
  const existing = getTerminalSession(sessionKey);
  const sessionMode = normalizeTerminalSessionMode(mode);
  if (existing && existing.kind === 'webui' && sessionMode !== 'tui') {
    existing.sessionToken = sessionToken;
    await ensureWebUITerminalStream(sessionKey, existing);
    touchTerminalSession(sessionKey, existing);
    return existing;
  }

  if (existing) {
    destroyTerminalSession(sessionKey, 'stopped');
  }

  const safeCols = Number.isFinite(cols) ? Math.min(Math.max(Math.floor(cols), 10), 500) : 80;
  const safeRows = Number.isFinite(rows) ? Math.min(Math.max(Math.floor(rows), 2), 200) : 24;
  const workspace = sessionMode === 'tui'
    ? (TERMINAL_TUI_CWD || TERMINAL_CWD || '/workspace')
    : (TERMINAL_SHELL_CWD || TERMINAL_CWD || '/workspace');
  const webuiSessionId = sessionKey;

  await fetchWebUITerminalJson('/api/terminal/start', {
    session_id: webuiSessionId,
    workspace,
    rows: safeRows,
    cols: safeCols,
    restart: sessionMode === 'tui',
  });

  const session = {
    kind: 'webui',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scrollback: '',
    listeners: new Set(),
    cols: safeCols,
    rows: safeRows,
    mode: sessionMode,
    sessionToken,
    webuiSessionId,
    streamAbortController: null,
    streamReadyPromise: null,
    inactivityTimer: setTimeout(() => {
      destroyTerminalSession(sessionKey, 'inactive');
    }, TERMINAL_INACTIVITY_TTL_MS),
  };

  terminalSessions.set(sessionKey, session);
  try {
    await ensureWebUITerminalStream(sessionKey, session);
    await bootstrapWebUITerminalTui(session);
  } catch (err) {
    destroyTerminalSession(sessionKey, 'error');
    throw err;
  }
  return session;
}

async function proxyWebUITerminalControl(action, session, parsedBody) {
  try {
    if (action === 'input') {
      await fetchWebUITerminalJson('/api/terminal/input', {
        session_id: session.webuiSessionId,
        data: parsedBody.data,
      });
      return;
    }

    if (action === 'resize') {
      await fetchWebUITerminalJson('/api/terminal/resize', {
        session_id: session.webuiSessionId,
        rows: session.rows,
        cols: session.cols,
      });
      return;
    }

    throw createHttpError(400, 'Unknown terminal action');
  } catch (err) {
    logWebUITerminalProxyFailure(action, err, {
      action,
      mode: session && session.mode,
    });
    throw err;
  }
}

function readWebUITerminalOutputText(parsed) {
  if (parsed && typeof parsed.text === 'string') return parsed.text;
  if (parsed && typeof parsed.data === 'string') return parsed.data;
  return '';
}

function translateWebUITerminalSseEvent(sessionKey, session, res, eventName, rawData) {
  let parsed = null;
  try {
    parsed = rawData ? JSON.parse(rawData) : null;
  } catch {
    parsed = null;
  }

  if (eventName === 'output') {
    const text = readWebUITerminalOutputText(parsed);
    if (text) {
      emitTerminalData(sessionKey, session, text);
      if (res) {
        sendTerminalEvent(res, { type: 'output', data: text });
      }
    }
    return false;
  }

  if (eventName === 'terminal_closed') {
    const exitCode = parsed && typeof parsed.exit_code === 'number'
      ? parsed.exit_code
      : (parsed && typeof parsed.exitCode === 'number' ? parsed.exitCode : null);
    const closedPayload = buildTerminalClosedPayload('closed', { exitCode });
    if (res) {
      sendTerminalEvent(res, closedPayload);
    }
    destroyTerminalSession(sessionKey, 'closed', { exitCode, skipWebUIClose: true });
    return true;
  }

  if (eventName === 'terminal_error') {
    const errorMessage = parsed && typeof parsed.error === 'string' && parsed.error
      ? parsed.error
      : 'Terminal error';
    emitTerminalData(sessionKey, session, '\\r\\n\\x1b[31m' + errorMessage + '\\x1b[0m\\r\\n');
    const closedPayload = buildTerminalClosedPayload('error', { errorMessage });
    if (res) {
      sendTerminalEvent(res, closedPayload);
    }
    destroyTerminalSession(sessionKey, 'error', { errorMessage, skipWebUIClose: true });
    return true;
  }

  return false;
}

async function ensureWebUITerminalStream(sessionKey, session) {
  if (!session || session.kind !== 'webui') return;
  if (session.streamReadyPromise) {
    await session.streamReadyPromise;
    return;
  }

  const ac = new AbortController();
  let done = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (done) return;
    done = true;
    resolveReady();
  };

  session.streamAbortController = ac;
  session.streamReadyPromise = ready;

  (async () => {
    try {
      await pipeWebUITerminalSse(sessionKey, session, null, ac, markReady);
      markReady();
    } catch (err) {
      if (!done) {
        done = true;
        if (rejectReady) rejectReady(err);
      }
      if (!ac.signal.aborted && terminalSessions.get(sessionKey) === session) {
        logWebUITerminalProxyFailure('output', err, { mode: session.mode });
        emitTerminalData(sessionKey, session, '\\r\\n\\x1b[31mFailed to attach terminal stream\\x1b[0m\\r\\n');
        destroyTerminalSession(sessionKey, 'error', { errorMessage: 'Failed to attach terminal stream', skipWebUIClose: true });
      }
    } finally {
      if (session.streamAbortController === ac) {
        session.streamAbortController = null;
      }
      if (session.streamReadyPromise === ready) {
        session.streamReadyPromise = null;
      }
    }
  })();

  await ready;
}

async function pipeWebUITerminalSse(sessionKey, session, res, abortController, onReady) {
  const url = webUITerminalUrl('/api/terminal/output', new URLSearchParams({
    session_id: session.webuiSessionId,
  }));
  const response = await fetch(url, {
    method: 'GET',
    headers: webUITerminalHeaders('text/event-stream', false),
    signal: abortController.signal,
  });

  if (!response.ok || !response.body) {
    throw createHttpError(response.status || 502, 'Failed to attach WebUI terminal stream');
  }

  if (typeof onReady === 'function') {
    onReady();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let eventName = 'message';
  let dataLines = [];

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = 'message';
      return false;
    }
    const shouldClose = translateWebUITerminalSseEvent(
      sessionKey,
      session,
      res,
      eventName,
      dataLines.join('\\n'),
    );
    eventName = 'message';
    dataLines = [];
    return shouldClose;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      dispatch();
      return;
    }

    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split(/\\r?\\n/);
    lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line) {
        if (dispatch()) return;
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
  }
}
// WEBUI_TERMINAL_PROXY_FUNCTIONS_END

function normalizeTerminalWebSocketToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > 4096 || token.indexOf('.') <= 0) {
    throw createHttpError(401, 'Invalid terminal websocket token');
  }
  return token;
}

function verifyTerminalWebSocketToken(rawToken) {
  if (!API_KEY) {
    throw createHttpError(500, 'API key not configured');
  }

  const token = normalizeTerminalWebSocketToken(rawToken);
  const dotIndex = token.indexOf('.');
  const encodedPayload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const expectedSign = crypto
    .createHmac('sha256', API_KEY)
    .update(encodedPayload)
    .digest();

  compareHexSignature(signature, expectedSign, 'Invalid terminal websocket token');

  let parsedPayload = null;
  try {
    parsedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw createHttpError(401, 'Invalid terminal websocket token payload');
  }

  if (!parsedPayload || parsedPayload.v !== 1 || parsedPayload.type !== 'terminal-ws') {
    throw createHttpError(401, 'Invalid terminal websocket token payload');
  }

  const expiresAt = Number(parsedPayload.exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw createHttpError(401, 'Terminal websocket token expired');
  }

  return {
    sessionKey: normalizeTerminalSessionKey(parsedPayload.sessionKey),
    sessionToken: normalizeTerminalSessionToken(parsedPayload.sessionToken),
  };
}

function buildWebSocketAcceptValue(rawKey) {
  const key = Array.isArray(rawKey) ? String(rawKey[0] || '').trim() : String(rawKey || '').trim();
  if (!key) {
    throw createHttpError(400, 'Missing websocket key');
  }

  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function buildWebSocketFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const length = body.length;
  let header = null;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body]);
}

function sendWebSocketJson(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(buildWebSocketFrame(0x1, JSON.stringify(payload)));
}

function sendWebSocketControlFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(buildWebSocketFrame(opcode, payload || Buffer.alloc(0)));
}

function sendWebSocketClose(socket, code, reason) {
  if (!socket || socket.destroyed) return;

  const closeCode = Number.isFinite(code) ? Math.floor(code) : 1000;
  const reasonBuffer = Buffer.from(String(reason || ''), 'utf8').subarray(0, 120);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(closeCode, 0);
  reasonBuffer.copy(payload, 2);
  sendWebSocketControlFrame(socket, 0x8, payload);
}

function parseWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) === 0x80;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (!masked) {
      throw createHttpError(400, 'Client websocket frames must be masked');
    }

    if (payloadLength === 126) {
      if (buffer.length - cursor < 2) break;
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (buffer.length - cursor < 8) break;
      const parsedLength = Number(buffer.readBigUInt64BE(cursor));
      if (!Number.isFinite(parsedLength) || parsedLength > TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES) {
        throw createHttpError(1009, 'Terminal websocket frame too large');
      }
      payloadLength = parsedLength;
      cursor += 8;
    }

    if (payloadLength > TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES) {
      throw createHttpError(1009, 'Terminal websocket frame too large');
    }

    if (buffer.length - cursor < 4) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;

    if (buffer.length - cursor < payloadLength) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLength));
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + payloadLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

function rejectWebSocketUpgrade(socket, statusCode, message) {
  if (!socket || socket.destroyed) return;

  const status = Number.isFinite(statusCode) && statusCode >= 100 ? Math.floor(statusCode) : 400;
  const reason = http.STATUS_CODES[status] || 'Bad Request';
  const body = String(message || 'WebSocket upgrade rejected');
  const response =
    'HTTP/1.1 ' + status + ' ' + reason + '\\r\\n' +
    'Content-Type: text/plain; charset=utf-8\\r\\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n' +
    'Connection: close\\r\\n\\r\\n' +
    body;

  try {
    socket.write(response);
  } catch {}
  socket.destroy();
}

async function handleTerminalWebSocketMessage(sessionKey, session, socket, payload) {
  let parsed = null;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    sendWebSocketClose(socket, 1007, 'Malformed terminal message');
    socket.end();
    return false;
  }

  // DESKTOP_TERMINAL_WS_MESSAGE_START
  const type = parsed && typeof parsed.type === 'string' ? parsed.type.trim() : '';
  if (session.kind === 'desktop') {
    const allowed = type === 'input' ? ['type', 'data'] : type === 'resize' ? ['type', 'cols', 'rows'] : ['type'];
    if (session.desktopLease.cancelled || !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => !allowed.includes(key)) ||
        (type === 'input' && (typeof parsed.data !== 'string' || !parsed.data || Buffer.byteLength(parsed.data) > 4096)) ||
        (type === 'resize' && (!Number.isInteger(parsed.cols) || parsed.cols < 10 || parsed.cols > 500 ||
          !Number.isInteger(parsed.rows) || parsed.rows < 2 || parsed.rows > 200)) ||
        session.process.stdin.writableLength > 65536) {
      sendWebSocketClose(socket, 1008, 'Invalid native terminal control');
      socket.end();
      return false;
    }
  }
  // DESKTOP_TERMINAL_WS_MESSAGE_END

  if (type === 'input') {
    const data = typeof parsed.data === 'string' ? parsed.data : '';
    if (!data || data.length > 4096) {
      sendWebSocketClose(socket, 1008, 'Invalid terminal input');
      socket.end();
      return false;
    }

    // WEBUI_TERMINAL_PROXY_WS_START
    if (session.kind === 'webui') {
      await proxyWebUITerminalControl(type, session, { ...parsed, data });
      touchTerminalSession(sessionKey, session);
      return true;
    }
    // WEBUI_TERMINAL_PROXY_WS_END

    if (!sendTerminalControlMessage(session, {
      type: 'input',
      data: encodeTerminalInput(data),
    })) {
      sendWebSocketClose(socket, 1011, 'Failed writing terminal input');
      socket.end();
      return false;
    }

    touchTerminalSession(sessionKey, session);

    return true;
  }

  if (type === 'resize') {
    session.cols = Number.isFinite(parsed.cols) ? Math.min(Math.max(Math.floor(parsed.cols), 10), 500) : session.cols;
    session.rows = Number.isFinite(parsed.rows) ? Math.min(Math.max(Math.floor(parsed.rows), 2), 200) : session.rows;

    // WEBUI_TERMINAL_PROXY_WS_START
    if (session.kind === 'webui') {
      await proxyWebUITerminalControl(type, session, parsed);
      touchTerminalSession(sessionKey, session);
      return true;
    }
    // WEBUI_TERMINAL_PROXY_WS_END

    if (!sendTerminalControlMessage(session, {
      type: 'resize',
      cols: session.cols,
      rows: session.rows,
    })) {
      sendWebSocketClose(socket, 1011, 'Failed resizing terminal');
      socket.end();
      return false;
    }

    touchTerminalSession(sessionKey, session);
    return true;
  }

  if (type === 'ping') {
    sendWebSocketJson(socket, { type: 'pong' });
    return true;
  }

  sendWebSocketClose(socket, 1008, 'Unknown terminal message');
  socket.end();
  return false;
}

function attachTerminalWebSocket(sessionKey, session, socket, options) {
  const includeScrollback = !options || options.includeScrollback !== false;
  let cleanedUp = false;
  let buffered = options && Buffer.isBuffer(options.head) ? Buffer.from(options.head) : Buffer.alloc(0);

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    session.listeners.delete(onData);
    // DESKTOP_TERMINAL_DETACH_START
    if (session.kind === 'desktop') {
      session.desktopSockets.delete(socket);
      if (!session.desktopSockets.size && !session.desktopLease.cancelled) {
        clearTimeout(session.desktopLease.detachTimer);
        session.desktopLease.detachTimer = setTimeout(
          () => scheduleDesktopTerminalStop(session.desktopLease, 'disconnected'),
          DESKTOP_TERMINAL_DETACHED_MS,
        );
      }
    }
    // DESKTOP_TERMINAL_DETACH_END
  }

  const onData = (event) => {
    try {
      // DESKTOP_TERMINAL_OUTPUT_LIMIT_START
      if (session.kind === 'desktop' && socket.writableLength > 262144) {
        cleanup();
        socket.destroy();
        return;
      }
      // DESKTOP_TERMINAL_OUTPUT_LIMIT_END
      sendWebSocketJson(socket, event);
      if (event && event.type === 'closed') {
        cleanup();
        sendWebSocketClose(socket, 1000, 'Terminal session closed');
        socket.end();
      }
    } catch {
      cleanup();
      socket.destroy();
    }
  };

  session.listeners.add(onData);
  // DESKTOP_TERMINAL_ATTACH_START
  if (session.kind === 'desktop') {
    session.desktopSockets.add(socket);
    clearTimeout(session.desktopLease.unattachedTimer);
    clearTimeout(session.desktopLease.detachTimer);
  }
  // DESKTOP_TERMINAL_ATTACH_END
  touchTerminalSession(sessionKey, session);
  socket.setNoDelay(true);
  socket.setTimeout(0);

  if (includeScrollback && session.scrollback) {
    sendWebSocketJson(socket, { type: 'output', data: session.scrollback });
  }

  let frameProcessing = Promise.resolve();

  const handleFrameProcessingError = (err) => {
    const websocketStatusCode = err && err.statusCode ? err.statusCode : 1011;
    const websocketMessage = websocketStatusCode >= 500
      ? 'Terminal websocket error'
      : (err && err.message ? err.message : 'Terminal websocket error');
    sendWebSocketClose(socket, websocketStatusCode, websocketMessage);
    cleanup();
    socket.end();
  };

  const consumeBufferedFrames = async () => {
    if (!buffered.length) return;

    const parsed = parseWebSocketFrames(buffered);
    buffered = Buffer.from(parsed.remaining);

    for (const frame of parsed.frames) {
      if (!frame.fin) {
        sendWebSocketClose(socket, 1003, 'Fragmented websocket frames are not supported');
        cleanup();
        socket.end();
        return;
      }

      if (frame.opcode === 0x8) {
        cleanup();
        sendWebSocketClose(socket, 1000, 'Client closed the websocket');
        socket.end();
        return;
      }

      if (frame.opcode === 0x9) {
        sendWebSocketControlFrame(socket, 0xA, frame.payload);
        continue;
      }

      if (frame.opcode === 0xA) {
        continue;
      }

      if (frame.opcode !== 0x1) {
        sendWebSocketClose(socket, 1003, 'Unsupported websocket frame');
        cleanup();
        socket.end();
        return;
      }

      if (!await handleTerminalWebSocketMessage(sessionKey, session, socket, frame.payload)) {
        cleanup();
        return;
      }
    }
  };

  const scheduleBufferedFrameConsumption = () => {
    frameProcessing = frameProcessing
      .then(() => consumeBufferedFrames())
      .catch(handleFrameProcessingError);
    return frameProcessing;
  };

  void scheduleBufferedFrameConsumption();

  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length > TERMINAL_WEBSOCKET_MAX_MESSAGE_BYTES * 2) {
      sendWebSocketClose(socket, 1009, 'Terminal websocket buffer exceeded limit');
      cleanup();
      socket.end();
      return;
    }
    void scheduleBufferedFrameConsumption();
  });

  socket.on('error', cleanup);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
}

function handleTerminalWebSocketUpgrade(req, socket, head) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const auth = verifyTerminalWebSocketToken(requestUrl.searchParams.get('token'));
  const session = getTerminalSession(auth.sessionKey, auth.sessionToken);
  if (!session) {
    throw createHttpError(404, 'Session not found');
  }
  // DESKTOP_TERMINAL_UPGRADE_START
  if (session.kind === 'desktop' && (session.desktopLease.cancelled || !session.desktopLease.started ||
      session.desktopSockets.size >= 2)) {
    throw createHttpError(409, 'Native terminal session is unavailable');
  }
  // DESKTOP_TERMINAL_UPGRADE_END
  // WEBUI_TERMINAL_PROXY_WS_START
  if (session.kind === 'webui') {
    void ensureWebUITerminalStream(auth.sessionKey, session).catch((err) => {
      logWebUITerminalProxyFailure('output', err, { mode: session.mode });
      destroyTerminalSession(auth.sessionKey, 'error', {
        errorMessage: 'Failed to attach terminal stream',
        skipWebUIClose: true,
      });
    });
  }
  // WEBUI_TERMINAL_PROXY_WS_END

  const acceptValue = buildWebSocketAcceptValue(req.headers['sec-websocket-key']);
  const includeScrollback = requestUrl.searchParams.get('includeScrollback') !== '0';

  socket.write(
    'HTTP/1.1 101 Switching Protocols\\r\\n' +
    'Upgrade: websocket\\r\\n' +
    'Connection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + acceptValue + '\\r\\n\\r\\n'
  );

  attachTerminalWebSocket(auth.sessionKey, session, socket, {
    includeScrollback,
    head,
  });
}

async function handleGetTerminal(req, res, requestUrl, rawBody) {
  const sessionKey = normalizeTerminalSessionKey(requestUrl.searchParams.get('sessionKey'));
  const sessionToken = normalizeTerminalSessionToken(requestUrl.searchParams.get('sessionToken'));
  const includeScrollback = requestUrl.searchParams.get('includeScrollback') !== '0';
  const session = getTerminalSession(sessionKey, sessionToken);
  if (!session) {
    throw createHttpError(404, 'Session not found');
  }

  touchTerminalSession(sessionKey, session);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  });

  if (includeScrollback && session.scrollback) {
    sendTerminalEvent(res, { type: 'output', data: session.scrollback });
  }

  const onData = (event) => {
    try {
      sendTerminalEvent(res, event);
      if (event && event.type === 'closed') {
        cleanup();
        res.end();
      }
    } catch {
      cleanup();
    }
  };

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\\n\\n');
    } catch {
      cleanup();
    }
  }, 15000);

  function cleanup() {
    clearInterval(heartbeat);
    session.listeners.delete(onData);
  }

  session.listeners.add(onData);
  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

async function handlePostTerminal(req, res, rawBody) {
  const parsedBody = rawBody ? JSON.parse(rawBody) : {};
  const action = typeof parsedBody.action === 'string' ? parsedBody.action.trim() : '';

  if (action === 'start') {
    const { mode, sessionKey, sessionToken } = resolveTerminalStartSessionIdentity(parsedBody);
    try {
      // WEBUI_TERMINAL_PROXY_START_ACTION_START
      if (webUITerminalProxyEnabled()) {
        try {
          await proxyWebUITerminalStart(sessionKey, sessionToken, parsedBody.cols, parsedBody.rows, mode);
        } catch (err) {
          if (!shouldFallbackToContainerTerminal(err)) throw err;
          console.warn('[Terminal Sidecar] WebUI terminal REST API unavailable; using the live runtime container');
          createTerminalSession(sessionKey, sessionToken, parsedBody.cols, parsedBody.rows, mode);
        }
      } else {
        createTerminalSession(sessionKey, sessionToken, parsedBody.cols, parsedBody.rows, mode);
      }
      // WEBUI_TERMINAL_PROXY_START_ACTION_END
      sendJson(res, 200, { ok: true, sessionKey, sessionToken });
      return;
    } catch (err) {
      // WEBUI_TERMINAL_PROXY_START_CATCH_START
      if (webUITerminalProxyEnabled()) {
        logWebUITerminalProxyFailure('start', err, { mode });
      }
      const wrapped = createHttpError(500, 'Failed to create terminal session');
      wrapped.failureType = webUITerminalProxyEnabled()
        ? 'sidecar_webui_terminal_proxy_failed'
        : 'sidecar_terminal_process_failed';
      throw wrapped;
      // WEBUI_TERMINAL_PROXY_START_CATCH_END
    }
  }

  const sessionKey = normalizeTerminalSessionKey(parsedBody.sessionKey);
  const sessionToken = normalizeTerminalSessionToken(parsedBody.sessionToken);
  const session = getTerminalSession(sessionKey, sessionToken);
  if (action === 'stop' && !session) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!session) {
    throw createHttpError(404, 'Session not found');
  }

  if (action === 'input') {
    const data = typeof parsedBody.data === 'string' ? parsedBody.data : '';
    if (!data) {
      throw createHttpError(400, 'Missing terminal input data');
    }

    // WEBUI_TERMINAL_PROXY_INPUT_START
    if (session.kind === 'webui') {
      await proxyWebUITerminalControl(action, session, { ...parsedBody, data });
      touchTerminalSession(sessionKey, session);
      sendJson(res, 200, { ok: true });
      return;
    }
    // WEBUI_TERMINAL_PROXY_INPUT_END

    if (!sendTerminalControlMessage(session, {
      type: 'input',
      data: encodeTerminalInput(data),
    })) {
      throw createHttpError(500, 'Failed to write to terminal session');
    }

    touchTerminalSession(sessionKey, session);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (action === 'resize') {
    session.cols = Number.isFinite(parsedBody.cols) ? Math.min(Math.max(Math.floor(parsedBody.cols), 10), 500) : session.cols;
    session.rows = Number.isFinite(parsedBody.rows) ? Math.min(Math.max(Math.floor(parsedBody.rows), 2), 200) : session.rows;

    // WEBUI_TERMINAL_PROXY_RESIZE_START
    if (session.kind === 'webui') {
      await proxyWebUITerminalControl(action, session, parsedBody);
      touchTerminalSession(sessionKey, session);
      sendJson(res, 200, { ok: true });
      return;
    }
    // WEBUI_TERMINAL_PROXY_RESIZE_END

    if (!sendTerminalControlMessage(session, {
      type: 'resize',
      cols: session.cols,
      rows: session.rows,
    })) {
      throw createHttpError(500, 'Failed to resize terminal session');
    }

    touchTerminalSession(sessionKey, session);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (action === 'stop') {
    destroyTerminalSession(sessionKey, 'stopped');
    sendJson(res, 200, { ok: true });
    return;
  }

  throw createHttpError(400, 'Unknown terminal action');
}

async function handleGetIntegrations(req, res, requestUrl) {
  const profile = normalizeProfileName(requestUrl.searchParams.get('profile'));
  const targetEnvFile = getTargetEnvFile(profile);
  const keysPresent = readKeysPresent(targetEnvFile);

  sendJson(res, 200, { success: true, profile, keysPresent });
}

async function handlePostIntegrations(req, res, rawBody) {
  const parsedBody = rawBody ? JSON.parse(rawBody) : {};
  const profile = normalizeProfileName(parsedBody.profile);
  const isSubProfile = profile && profile !== 'default';
  const targetEnvFile = getTargetEnvFile(profile);

  writeEnvFile(
    targetEnvFile,
    parsedBody.envUpdates,
    parsedBody.prefixToRemove,
    parsedBody.keysToRemove
  );
  markGatewayProfileActive(profile);
  restartProfile(profile, isSubProfile);

  sendJson(res, 200, { success: true });
}

// TAILSCALE_HANDLERS_START
function redactTsKey(text, key) {
  if (!key || typeof text !== 'string') return text || '';
  return text.split(key).join('[REDACTED]');
}
function tsSpawn(args, timeoutMs) {
  return new Promise((resolve) => {
    const out = [], err = [];
    let done = false;
    const child = spawn('tailscale', args);
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch (e) {}
      resolve({ ok: false, code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: (Buffer.concat(err).toString('utf8') + '\\ntimed out').trim() });
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: (Buffer.concat(err).toString('utf8') + '\\n' + e.message).trim() }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: code === 0, code: code === null ? -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
  });
}
async function ensureTs() {
  const c = await execCommand('command -v tailscale', 5000);
  if (!c.ok) {
    const i = await execCommand('curl -fsSL https://tailscale.com/install.sh | sh', 180000);
    if (!i.ok) return { ok: false, stdout: i.stdout, stderr: i.stderr, error: 'tailscale install failed' };
  }
  const systemd = await execCommand('command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]', 5000);
  if (systemd.ok) {
    const e = await execCommand('systemctl enable --now tailscaled', 30000);
    if (!e.ok) return { ok: false, stdout: e.stdout, stderr: e.stderr, error: 'systemctl enable tailscaled failed' };
    return { ok: true };
  }
  const running = await execCommand('[ -S /var/run/tailscale/tailscaled.sock ] || (command -v pgrep >/dev/null 2>&1 && pgrep -x tailscaled >/dev/null 2>&1)', 5000);
  if (!running.ok) {
    const start = await execCommand([
      'mkdir -p /var/lib/tailscale /var/run/tailscale',
      'if ! command -v tailscaled >/dev/null 2>&1; then echo "tailscaled binary was not installed by the Tailscale installer" >&2; exit 127; fi',
      'nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=userspace-networking > /var/log/hermes-tailscaled.log 2>&1 < /dev/null &',
    ].join(' && '), 10000);
    if (!start.ok) return { ok: false, stdout: start.stdout, stderr: start.stderr, error: 'tailscaled start failed' };
  }
  for (let i = 0; i < 15; i += 1) {
    const ready = await tsSpawn(['status', '--json'], 5000);
    if (ready.ok) return { ok: true };
    await sleep(1000);
  }
  const log = await execCommand('tail -n 80 /var/log/hermes-tailscaled.log 2>/dev/null || true', 5000);
  return {
    ok: false,
    stdout: log.stdout,
    stderr: log.stderr,
    error: 'tailscaled did not become ready; see /var/log/hermes-tailscaled.log',
  };
}
async function handleTailscaleUp(req, res, rawBody) {
  const b = rawBody ? JSON.parse(rawBody) : {};
  const k = typeof b.authKey === 'string' ? b.authKey.trim() : '';
  if (!k) { sendJson(res, 400, { error: 'authKey is required' }); return; }
  const inst = await ensureTs();
  if (!inst.ok) { sendJson(res, 500, { error: inst.error, stdout: inst.stdout || '', stderr: inst.stderr || '' }); return; }
  const args = ['up', '--auth-key=' + k];
  if (typeof b.machineName === 'string' && b.machineName.trim()) args.push('--hostname=' + b.machineName.trim());
  if (Array.isArray(b.tags) && b.tags.length) {
    const tg = b.tags.filter((t) => typeof t === 'string' && t.trim());
    if (tg.length) args.push('--advertise-tags=' + tg.join(','));
  }
  if (b.enableSsh === true) args.push('--ssh');
  const up = await tsSpawn(args, 120000);
  if (!up.ok) { sendJson(res, 500, { error: 'tailscale up failed', stdout: redactTsKey(up.stdout, k), stderr: redactTsKey(up.stderr, k), code: up.code }); return; }
  const s = await tsSpawn(['status', '--json'], 20000);
  if (!s.ok) { sendJson(res, 500, { error: 'tailscale status failed', stdout: redactTsKey(s.stdout, k), stderr: redactTsKey(s.stderr, k), code: s.code }); return; }
  sendJson(res, 200, { ok: true, statusJson: s.stdout });
}
async function handleTailscaleSet(req, res, rawBody) {
  const b = rawBody ? JSON.parse(rawBody) : {};
  const args = ['set'];
  if (typeof b.machineName === 'string' && b.machineName.trim()) args.push('--hostname=' + b.machineName.trim());
  if (b.enableSsh === true) args.push('--ssh');
  else if (b.enableSsh === false) args.push('--ssh=false');
  if (args.length === 1) { sendJson(res, 400, { error: 'No tailscale settings supplied' }); return; }
  const u = await tsSpawn(args, 30000);
  if (!u.ok) { sendJson(res, 500, { error: 'tailscale set failed', stdout: u.stdout, stderr: u.stderr, code: u.code }); return; }
  const s = await tsSpawn(['status', '--json'], 20000);
  if (!s.ok) { sendJson(res, 500, { error: 'tailscale status failed', stdout: s.stdout, stderr: s.stderr, code: s.code }); return; }
  sendJson(res, 200, { ok: true, statusJson: s.stdout });
}
async function handleTailscaleStatus(req, res) {
  const s = await tsSpawn(['status', '--json'], 20000);
  if (!s.ok) { sendJson(res, 500, { error: 'tailscale status failed', stdout: s.stdout, stderr: s.stderr, code: s.code }); return; }
  sendJson(res, 200, { ok: true, statusJson: s.stdout });
}
async function handleTailscaleDown(req, res) {
  const lo = await tsSpawn(['logout'], 20000);
  const systemd = await execCommand('command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]', 5000);
  const di = systemd.ok
    ? await execCommand('systemctl disable --now tailscaled', 20000)
    : await execCommand('if command -v pkill >/dev/null 2>&1; then pkill -x tailscaled || true; fi', 20000);
  sendJson(res, 200, { ok: true, logoutOk: lo.ok, disableOk: di.ok, logoutStderr: lo.stderr, disableStderr: di.stderr });
}
// TAILSCALE_HANDLERS_END

// chat-stream-worker runtime removed; WebUI iframe bypasses this path.

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    // DESKTOP_TERMINAL_ROUTE_START
    if (requestUrl.pathname === '/api/desktop-terminal') {
      if (typeof handleDesktopTerminal !== 'function') {
        throw createHttpError(409, 'Native Desktop terminal is not supported by this runtime');
      }
      await handleDesktopTerminal(req, res, requestUrl);
      return;
    }
    // DESKTOP_TERMINAL_ROUTE_END
    const rawBody = method === 'GET' || method === 'HEAD' ? '' : await readRawBody(req);

    if (requestUrl.pathname === '/dashboard-login') {
      await handleDashboardLogin(req, res, requestUrl);
      return;
    }

    if (requestUrl.pathname === '/dashboard-logout') {
      await handleDashboardLogout(req, res);
      return;
    }

    if (requestUrl.pathname === '/dashboard-session-check') {
      requireDashboardAccess(req, rawBody);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GENERATED_IMAGE_SUPPORT_START
    if (isGeneratedImageRequestPath(requestUrl.pathname)) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      handleGeneratedImageRequest(req, res, requestUrl, rawBody);
      return;
    }
    // GENERATED_IMAGE_SUPPORT_END

    if (requestUrl.pathname === '/api/mirror-sync/health') {
      authenticateRequest(req, rawBody);

      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      sendJson(res, 410, {
        ok: false,
        error: 'Mirror sync is retired',
        failureType: 'mirror_sync_retired',
      });
      return;
    }

    if (requestUrl.pathname === '/api/integrations') {
      authenticateRequest(req, rawBody);

      if (method === 'GET') {
        await handleGetIntegrations(req, res, requestUrl);
        return;
      }

      if (method === 'POST') {
        await handlePostIntegrations(req, res, rawBody);
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // TAILSCALE_ROUTES_START
    if (requestUrl.pathname === '/api/tailscale/up') {
      authenticateRequest(req, rawBody);
      if (method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      await handleTailscaleUp(req, res, rawBody);
      return;
    }
    if (requestUrl.pathname === '/api/tailscale/set') {
      authenticateRequest(req, rawBody);
      if (method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      await handleTailscaleSet(req, res, rawBody);
      return;
    }
    if (requestUrl.pathname === '/api/tailscale/status') {
      authenticateRequest(req, rawBody);
      if (method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      await handleTailscaleStatus(req, res);
      return;
    }
    if (requestUrl.pathname === '/api/tailscale/down') {
      authenticateRequest(req, rawBody);
      if (method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      await handleTailscaleDown(req, res);
      return;
    }
    // TAILSCALE_ROUTES_END

    if (requestUrl.pathname === '/api/terminal') {
      authenticateRequest(req, rawBody);

      if (method === 'GET') {
        await handleGetTerminal(req, res, requestUrl, rawBody);
        return;
      }

      if (method === 'POST') {
        await handlePostTerminal(req, res, rawBody);
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    // DASHBOARD_GATED_PROXY_START
    if (await handleManagedGatewayAction(req, res, requestUrl, rawBody)) return;
    if (dashboardGatedProxyEnabled()) {
      await handleGatedDashboardRequest(req, res, requestUrl, rawBody);
      return;
    }
    // DASHBOARD_GATED_PROXY_END

    requireDashboardAccess(req, rawBody);
    await proxyToDashboard(req, res, requestUrl, rawBody);
  } catch (e) {
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    const safeErrorMessage = statusCode >= 500
      ? 'Internal error'
      : (e && e.message ? e.message : 'Internal error');
    console.error('Sidecar request failed:', {
      failureType: e && e.failureType ? e.failureType : 'sidecar_integrations_failed',
      errorName: e && e.name ? e.name : typeof e,
      statusCode,
      ...(e && e.authFailure ? e.authFailure : {}),
      ...(e && e.generatedImage ? { generatedImage: e.generatedImage } : {}),
    });
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if ((statusCode === 401 || statusCode === 403) && acceptsHtml) {
      sendText(res, statusCode, 'Open this dashboard from Hivra to authenticate.', {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      return;
    }
    // DESKTOP_TERMINAL_ABORT_RESPONSE_START
    if (e && String(e.failureType || '').startsWith('desktop_terminal_') && (res.destroyed || res.writableEnded)) return;
    // DESKTOP_TERMINAL_ABORT_RESPONSE_END
    sendJson(res, statusCode, { error: safeErrorMessage });
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/api/terminal/ws') {
      // DASHBOARD_GATED_PROXY_START
      if (dashboardGatedProxyEnabled() && isDashboardWsPath(requestUrl.pathname)) {
        void handleGatedDashboardWsUpgrade(req, socket, head, requestUrl).catch(() => {
          rejectWebSocketUpgrade(socket, 502, 'Dashboard websocket proxy failed');
        });
        return;
      }
      // DASHBOARD_GATED_PROXY_END
      rejectWebSocketUpgrade(socket, 404, 'WebSocket route not found');
      return;
    }

    handleTerminalWebSocketUpgrade(req, socket, head);
  } catch (e) {
    const statusCode = e && e.statusCode ? e.statusCode : 500;
    const safeErrorMessage = statusCode >= 500
      ? 'Terminal websocket upgrade failed'
      : (e && e.message ? e.message : 'Terminal websocket upgrade failed');
    console.error('Terminal websocket error:', {
      failureType: 'sidecar_terminal_websocket_failed',
      errorName: e && e.name ? e.name : typeof e,
      statusCode,
    });
    rejectWebSocketUpgrade(
      socket,
      statusCode,
      safeErrorMessage,
    );
  }
});

const PORT = process.env.PORT || 9090;
server.listen(PORT, () => {
  console.log('Hermes Sidecar API listening on port ' + PORT);
});
`;

function replaceMarkedGeneratedBlock(
  source: string,
  marker: string,
  replacement = ""
): string {
  return source.replace(
    new RegExp(`\\n?\\s*// ${marker}_START[\\s\\S]*?\\n\\s*// ${marker}_END\\n?`, "g"),
    replacement
  );
}

export const HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE = [
  // Gateway-only bootstraps cannot run the native Desktop broker. Keep shared
  // legacy PTY code byte-stable and return an explicit capability error there.
  ["DESKTOP_TERMINAL_TOUCH", "\nfunction touchTerminalSession(sessionKey, session) {\n  clearTimeout(session.inactivityTimer);\n  session.lastActivity = Date.now();\n  session.inactivityTimer = setTimeout(() => {\n    destroyTerminalSession(sessionKey, 'inactive');\n  }, TERMINAL_INACTIVITY_TTL_MS);\n}\n"],
  ["DESKTOP_TERMINAL_READY", "\n"],
  ["DESKTOP_TERMINAL_DECODE", "\n      emitTerminalData(sessionKey, session, decodeTerminalOutput(parsed.data));\n"],
  ["DESKTOP_TERMINAL_DESTROY", "\n"],
  ["DESKTOP_TERMINAL_CLOSED", "\n"],
  ["DESKTOP_TERMINAL_EXISTING", "\n"],
  ["DESKTOP_TERMINAL_SPAWN", "\n  const terminalCommand = buildTerminalCommand(safeCols, safeRows, sessionMode);\n  const terminalProcess = spawn('/bin/sh', ['-lc', TERMINAL_PTY_HELPER_BOOTSTRAP], {\n    stdio: ['pipe', 'pipe', 'pipe'],\n    env: {\n      ...process.env,\n      HERMES_TERMINAL_PTY_HELPER: TERMINAL_PTY_HELPER_CODE,\n      HERMES_TERMINAL_COMMAND: terminalCommand,\n      HERMES_TERMINAL_COLS: String(safeCols),\n      HERMES_TERMINAL_ROWS: String(safeRows),\n    },\n  });\n"],
  ["DESKTOP_TERMINAL_SESSION", "\n"],
  ["DESKTOP_TERMINAL_TTL", "\n    inactivityTimer: setTimeout(() => {\n      destroyTerminalSession(sessionKey, 'inactive');\n    }, TERMINAL_INACTIVITY_TTL_MS),\n"],
  ["DESKTOP_TERMINAL_WS_MESSAGE", "\n  const type = typeof parsed.type === 'string' ? parsed.type.trim() : '';\n"],
  ["DESKTOP_TERMINAL_DETACH", "\n"],
  ["DESKTOP_TERMINAL_OUTPUT_LIMIT", "\n"],
  ["DESKTOP_TERMINAL_ATTACH", "\n"],
  ["DESKTOP_TERMINAL_UPGRADE", "\n"],
  ["DESKTOP_TERMINAL_ROUTE", "\n    if (requestUrl.pathname === '/api/desktop-terminal') throw createHttpError(409, 'Native terminal unsupported');\n"],
  ["DESKTOP_TERMINAL_ABORT_RESPONSE", "\n"],
  ["WEBUI_SESSION_PROXY_AUTH", ""],
  ["WEBUI_TERMINAL_PROXY_FUNCTIONS", ""],
  ["WEBUI_TERMINAL_PROXY_START_ACTION", "\n      createTerminalSession(sessionKey,sessionToken,parsedBody.cols,parsedBody.rows,mode);\n"],
  ["WEBUI_TERMINAL_PROXY_START_CATCH", "\n      throw createHttpError(500,'Failed to create terminal session');\n"],
  ["WEBUI_TERMINAL_PROXY_DESTROY", ""],
  ["WEBUI_TERMINAL_PROXY_WS", ""],
  ["WEBUI_TERMINAL_PROXY_GET", ""],
  ["WEBUI_TERMINAL_PROXY_INPUT", ""],
  ["WEBUI_TERMINAL_PROXY_RESIZE", ""],
  ["GENERATED_IMAGE_SUPPORT", "\n"],
  // Tailscale handlers are only used by the Proxmox/WebUI sidecar
  // variants (where the host→guest SSH bridge is the failure mode the
  // sidecar path avoids). The legacy Hetzner bootstrap has direct SSH
  // and a hard 32KB cloud-init user_data ceiling, so the handlers are
  // stripped here to stay under the limit. Replacement is "\n" rather
  // than "" so the bootstrap variant ends up byte-identical to the
  // pre-marker code around it — even a 2-byte raw shift can perturb
  // gzip's dictionary enough to add 4-5 compressed bytes downstream
  // and trip the user_data limit test (PR #114 landed with "" and
  // immediately broke main's Hetzner user_data budget — see the new
  // 'keeps the surrounding code byte-stable after the Tailscale marker
  // strip' regression in sidecar-script.test.ts).
  ["TAILSCALE_HANDLERS", "\n"],
  ["TAILSCALE_ROUTES", "\n"],
  // The gated official-dashboard proxy (basic-provider login + cookie/ws-ticket
  // translation) only serves Proxmox/webfree deploys, which have an
  // official-dashboard container behind the sidecar. Legacy Hetzner agents are
  // gateway-only and ship via the 32KB-capped cloud-init user_data, so strip the
  // whole block here. Replacement "\n" keeps the surrounding bytes stable (same
  // rationale as the Tailscale strip above).
  ["DASHBOARD_GATED_PROXY", "\n"],
  // The dashboardRecoveryPromise wedge-prevention deadline (withDeadline
  // helper + 40s ceiling around the memoized recovery promise) primarily
  // protects Proxmox/webfree fleet boxes where the gated bridge runs many
  // /desktop requests per second through the sidecar. Legacy Hetzner agents
  // are gateway-only with a much simpler topology and a hard 32KB cloud-init
  // ceiling, so we strip the deadline guards here and let the bootstrap
  // sidecar use the original unbounded form (worst case it would need a
  // sidecar container restart on a connect-stall, which is fine for the
  // simpler Hetzner topology). Replacement "\n" keeps byte alignment;
  // DASHBOARD_RECOVERY_DEADLINE_WRAP_END strips the inner withDeadline body
  // back to the original 3-line .finally form.
  ["DASHBOARD_RECOVERY_DEADLINE_CONSTS", "\n"],
  ["DASHBOARD_RECOVERY_DEADLINE_HELPER", "\n"],
  ["DASHBOARD_SLOW_PROBE",
    "\n    if (typeof probeReq.setTimeout === 'function') {\n      probeReq.setTimeout(DASHBOARD_PROXY_TIMEOUT_MS, () => {\n        if (typeof probeReq.destroy === 'function') {\n          probeReq.destroy();\n        }\n        finish(false);\n      });\n    }\n"],
  ["DASHBOARD_RECOVERY_DEADLINE_WRAP",
    "\n    dashboardRecoveryPromise = recoverDashboardUpstream().finally(() => {\n      dashboardRecoveryPromise = null;\n    });\n   "],
  // The c-ares lookup helper is the webfree/Proxmox fleet fix (those boxes proxy
  // to a separate official-dashboard container and suffer the dead-candidate DNS
  // threadpool wedge). Legacy Hetzner agents are gateway-only with a much simpler
  // topology, have NO reported wedge, and have a hard 32KB cloud-init user_data
  // ceiling that a full helper would blow. So strip it to an undefined binding:
  // every `lookup: dashboardDnsLookup` then evaluates to `lookup: undefined`,
  // which makes http fall back to the default getaddrinfo resolver — i.e. the
  // exact pre-fix Hetzner behaviour, with no ReferenceError. Same precedent as
  // the DASHBOARD_RECOVERY_DEADLINE strip above (Hetzner keeps the simpler form).
  ["DASHBOARD_DNS_LOOKUP", "\nvar dashboardDnsLookup;\n"],
].reduce(
  (source, [marker, replacement]) => replaceMarkedGeneratedBlock(source, marker, replacement),
  SIDECAR_SERVER_CODE
).replace(/\nconst WEBUI_TERMINAL_UPSTREAM_URL = .*;\n/, "\n")
  .replace("function createTerminalSession(sessionKey, sessionToken, cols, rows, mode, desktopOptions)", "function createTerminalSession(sessionKey, sessionToken, cols, rows, mode)");

// ────────────────────────────────────────────────────────────────────────
// WebUI iframe handoff appendage
// ────────────────────────────────────────────────────────────────────────
//
// The WebUI deploy concatenates this onto SIDECAR_SERVER_CODE before
// writing sidecar_server.js into the per-instance compose. Legacy
// gateway-only Hetzner agents never iframe the dashboard, so they ship
// only the base sidecar — keeping HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE
// byte-identical to its pre-iframe-migration baseline (otherwise even a
// few uncompressed bytes shifted gzip in unfavorable ways and the agent
// user_data crept past Hetzner's 32KB cloud-init ceiling).
//
// The appendage hooks the existing http.Server's `request` event by
// removing the inline createServer listener and re-adding a wrapper that
// short-circuits /webui-login + /webui-session-check, then falls through
// to the original handler for everything else. Same auth model as
// /dashboard-login (HMAC of expiresAt.nonce.nextPath, signed with
// API_SERVER_KEY, replay-protected via a separate nonce map).

export const WEBUI_HANDOFF_APPENDAGE = `
// ── WebUI iframe handoff (appended to base sidecar for WebUI deploys) ──
// Clock-skew tolerance (2026-07-01 fixturenodea blank-chat fix): the login handlers accept a
// token whose exp is within +-TTL of the box clock (the "expired" check subtracts TTL,
// mirroring the "too far in future" check). The dashboard mints exp=now+30s, so a box
// clock drifting ahead no longer reads a fresh token as already-expired -> 401 -> blank
// chat. WEBUI uses 180s here; the base/DASHBOARD handler reuses its 60s TTL the same way
// (kept at 60s to stay under Hetzner's 32KB cloud-init user_data ceiling). Real fix is
// host NTP discipline; this + the instance-health-sweep skew guard are defense-in-depth.
const WEBUI_LOGIN_TTL_MS = 180 * 1000;
const WEBUI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const WEBUI_SESSION_COOKIE = 'hermes_webui_session';
const usedWebuiNonces = new Map();
const webuiSessions = new Map();

function pruneWebuiState(now) {
  const t = typeof now === 'number' ? now : Date.now();
  for (const [n, e] of usedWebuiNonces.entries()) {
    if (!Number.isFinite(e) || e <= t) usedWebuiNonces.delete(n);
  }
  for (const [s, e] of webuiSessions.entries()) {
    if (!Number.isFinite(e) || e <= t) webuiSessions.delete(s);
  }
}

function normalizeWebuiNextPath(rawPath) {
  const p = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '/';
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\\\')) {
    throw createHttpError(400, 'WebUI iframe redirects must stay on the instance gateway');
  }
  return p;
}

function buildWebuiCookie(sessionId) {
  // SameSite=None; Secure. Production traffic is HTTPS-only via the
  // outer Caddy, so unconditional Secure is required by the browser
  // when SameSite=None. Earlier attempts added Partitioned (CHIPS) for
  // the inline iframe path, but that broke top-level navigation and
  // wasn't reliable in iframe contexts either. The "Open in new tab"
  // button is the supported path: top-level navigation, plain
  // SameSite=None;Secure cookie, identical to the working
  // dashboard-login flow.
  return WEBUI_SESSION_COOKIE + '=' + sessionId +
    '; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=' +
    Math.floor(WEBUI_SESSION_TTL_MS / 1000);
}

function createWebuiSession() {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + WEBUI_SESSION_TTL_MS;
  webuiSessions.set(sessionId, expiresAt);
  return { sessionId, expiresAt };
}

function getWebuiSession(req) {
  pruneWebuiState();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[WEBUI_SESSION_COOKIE];
  if (!sessionId) return null;
  const expiresAt = webuiSessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    webuiSessions.delete(sessionId);
    return null;
  }
  return { sessionId, expiresAt };
}

function hasWebuiSessionCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies[WEBUI_SESSION_COOKIE]);
}

async function handleWebuiLogin(req, res, u) {
  if (!API_KEY) throw createHttpError(500, 'API key not configured');
  const e = Number.parseInt(String(u.searchParams.get('exp') || ''), 10);
  const n = String(u.searchParams.get('nonce') || '').trim();
  const p = normalizeWebuiNextPath(u.searchParams.get('next') || '/');
  const s = String(u.searchParams.get('sig') || '').trim();
  if (!/^[a-f0-9]{16,}$/i.test(n)) throw createHttpError(400, 'Invalid WebUI login nonce');
  if (!Number.isFinite(e)) throw createHttpError(400, 'Invalid WebUI login expiry');
  const t = Date.now();
  if (e < t - WEBUI_LOGIN_TTL_MS) throw createHttpError(401, 'WebUI login link expired');
  if (e - t > WEBUI_LOGIN_TTL_MS) {
    console.warn('WebUI login expiry too far in future', {
      failureType: 'webui_login_expiry_too_far_in_future',
      expiresInMs: e - t,
      maxFutureMs: WEBUI_LOGIN_TTL_MS,
    });
    throw createHttpError(400, 'WebUI login expiry is invalid');
  }
  const sig = crypto.createHmac('sha256', API_KEY)
    .update(buildDashboardLoginPayload(e, n, p))
    .digest();
  compareHexSignature(s, sig, 'Invalid WebUI login signature');
  pruneWebuiState(t);
  if (usedWebuiNonces.has(n)) throw createHttpError(403, 'WebUI login link already used');
  usedWebuiNonces.set(n, e);
  res.writeHead(302, {
    'Location': p,
    'Set-Cookie': buildWebuiCookie(createWebuiSession().sessionId),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end();
}

async function handleWebuiSessionCheck(req, res) {
  res.writeHead(getWebuiSession(req) ? 200 : 401, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end();
}

// Hook the existing http.Server's request handler. The base sidecar
// installs an inline async handler via http.createServer(...); we lift it
// off and reinstall with our /webui-* short-circuits in front, then
// delegate to the original for everything else.
;(function() {
  if (typeof server === 'undefined' || !server.listeners) return;
  const baseListeners = server.listeners('request').slice();
  if (baseListeners.length === 0) return;
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
      if (u.pathname === '/webui-login') {
        try { await handleWebuiLogin(req, res, u); }
        catch (err) {
          const status = err && err.statusCode ? err.statusCode : 500;
          if (!res.headersSent) {
            res.writeHead(status, { 'Cache-Control': 'no-store, no-cache, must-revalidate' });
            res.end();
          }
        }
        return;
      }
      if (u.pathname === '/webui-session-check') {
        try { await handleWebuiSessionCheck(req, res); }
        catch {
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        }
        return;
      }
    } catch {
      // Fall through to base listeners for any URL parsing failures.
    }
    for (const listener of baseListeners) listener.call(server, req, res);
  });
})();
`;
