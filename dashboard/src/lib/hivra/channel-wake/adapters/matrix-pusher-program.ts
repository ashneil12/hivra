// Matrix wake, the pure half: the pushkey, the push gateway address, and the
// program that registers or removes the pusher from inside the agent's own
// computer. No server imports, so it can be tested on its own.
//
// How Matrix wake works: at opt-in, while the agent is awake, a program run
// through the vmid-bound guest exec reads the agent's Matrix access token from
// ~/.hermes/.env and asks the agent's own homeserver to add an HTTP pusher
// (POST /_matrix/client/v3/pushers/set, kind "http", format "event_id_only")
// whose URL is Hivra's push gateway. The token never leaves the computer: the
// homeserver call is made from inside it, and the program prints only a
// fingerprint and the homeserver's host name. Hivra never stores the token.
//
// The homeserver then calls POST /_matrix/push/v1/notify on Hivra for every
// event its push rules notify on (DMs and mentions by default; in encrypted
// group rooms every message, because the server cannot read them). The
// pushkey names the agent and the opt-in, and carries an HMAC so nobody else
// can make one. Checked against https://spec.matrix.org/latest/push-gateway-api/
// and the client-server pusher API (pushkey at most 512 bytes, app_id at most
// 64 characters, data.url an https URL whose path is /_matrix/push/v1/notify).

import { timingSafeEqual } from "node:crypto";

import { channelWakeArmSecret } from "../config";
import { TELEGRAM_ENV_VALUE_PY } from "../../sleep/idle-probe-program";
import { buildVmidBoundGuestExecPrelude } from "../../vmid-bound-guest-exec";

/** The app_id Hivra's pushers use on every homeserver. Reverse-DNS style, at most 64 characters. */
export const MATRIX_PUSH_APP_ID = "hivra.wake";
/** The fixed path the push gateway API requires. */
export const MATRIX_PUSH_PATH = "/_matrix/push/v1/notify";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PUSHKEY = new RegExp(`^v1\\.(${UUID})\\.(${UUID})\\.([0-9a-f]{64})$`);

/** The pushkey for one opt-in: `v1.<agentId>.<armId>.<hmac>`. Lowercase, 141 characters. */
export function matrixPushkey(secret: string, agentId: string, armId: string): string {
  const agent = agentId.toLowerCase();
  const arm = armId.toLowerCase();
  return `v1.${agent}.${arm}.${channelWakeArmSecret(secret, "matrix", agent, arm)}`;
}

/**
 * The agent and opt-in a pushkey names, only when its HMAC is right. The
 * comparison takes the same time whatever the pushkey holds. Null for
 * anything else, so a caller never reads the database for a forged key.
 */
export function verifyMatrixPushkey(secret: string, pushkey: unknown): { agentId: string; armId: string } | null {
  if (typeof pushkey !== "string" || pushkey.length > 512) return null;
  const m = PUSHKEY.exec(pushkey);
  if (!m) return null;
  const [, agentId, armId, mac] = m;
  const expected = channelWakeArmSecret(secret, "matrix", agentId, armId);
  const ok = timingSafeEqual(Buffer.from(mac, "utf8"), Buffer.from(expected, "utf8"));
  return ok ? { agentId, armId } : null;
}

/**
 * The push gateway URL the pusher calls: the origin of the channel wake base
 * address plus the fixed path (homeservers refuse any other path). Null when
 * the base address is missing or not plain https.
 */
export function matrixPushUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return `${url.origin}${MATRIX_PUSH_PATH}`;
}

// ---------------------------------------------------------------------------
// The guest program and its host script
// ---------------------------------------------------------------------------

export const MATRIX_PUSHER_PREFIX = "HIVRA_MATRIX_PUSHER ";
export const MATRIX_PUSHER_REFUSED_PREFIX = "HIVRA_MATRIX_PUSHER_REFUSED ";

/**
 * Runs as root in the guest. Reads its request (op, app id, pushkey, URL) as
 * JSON on stdin, so nothing but the program itself is in any argv. Reads the
 * Matrix settings from ~/.hermes/.env with the probe's own parser, calls the
 * homeserver from inside the computer with redirects refused (so the token is
 * never sent anywhere else), and prints one line: the credential fingerprint
 * (as the idle probe computes it), the homeserver host and how many old
 * pushers it removed. Never the token.
 *
 * register: adds or updates Hivra's pusher, then removes any other pusher
 * with Hivra's app id (an earlier opt-in). remove: removes every pusher with
 * Hivra's app id.
 */
export const MATRIX_PUSHER_GUEST_PROGRAM = String.raw`import hashlib, json, os, re, sys, urllib.error, urllib.parse, urllib.request
# hivra-matrix-pusher v1. Runs as root via the guest agent. Prints one line and never the access token.
import signal
signal.alarm(40)
${TELEGRAM_ENV_VALUE_PY}
def out(d):
    sys.stdout.write("${MATRIX_PUSHER_PREFIX}" + json.dumps(d, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    os._exit(0)
def fail(why): out({"ok": False, "reason": why})
try: req = json.loads(sys.stdin.read(16384) or "null")
except Exception: req = None
if not isinstance(req, dict): fail("bad_request")
op, app_id, keep, url = req.get("op"), req.get("appId"), req.get("pushkey"), req.get("url")
if op not in ("register", "remove") or not isinstance(app_id, str) or not re.match(r"^[a-z][a-z0-9.]{2,63}$", app_id): fail("bad_request")
if op == "register" and not (isinstance(keep, str) and re.match(r"^[A-Za-z0-9._-]{1,512}$", keep)
        and isinstance(url, str) and re.match(r"^https://[A-Za-z0-9.-]+/_matrix/push/v1/notify$", url)): fail("bad_request")
try:
    fd = os.open("/home/bux/.hermes/.env", os.O_RDONLY | os.O_NOFOLLOW)
    try: text = os.read(fd, 65536).decode("utf-8", "replace")
    finally: os.close(fd)
except OSError:
    fail("no_env")
hs = env_value(text, "MATRIX_HOMESERVER")
tok = env_value(text, "MATRIX_ACCESS_TOKEN")
if not hs: fail("no_homeserver")
if not tok: fail("password_login" if env_value(text, "MATRIX_PASSWORD") else "no_token")
# The same fingerprint the idle probe prints for this channel (registry credKeys order).
fp = hashlib.sha256("\n".join([hs, tok]).encode("utf-8")).hexdigest()[:16]
try: u = urllib.parse.urlsplit(hs)
except ValueError: fail("bad_homeserver")
if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password or u.query or u.fragment: fail("bad_homeserver")
base = hs.rstrip("/")
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(_NoRedirect)
def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    r = urllib.request.Request(base + path, data=data, method=method, headers={
        "Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "hivra-wake"})
    try:
        with opener.open(r, timeout=10) as resp:
            raw = resp.read(262144)
            try: return resp.status, json.loads(raw or b"{}")
            except ValueError: return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None
def bad(st):
    if st in (401, 403): fail("token_rejected")
    fail("homeserver_unreachable" if st == 0 else "homeserver_error")
st, cur = call("GET", "/_matrix/client/v3/pushers")
if st != 200 or not isinstance(cur, dict) or not isinstance(cur.get("pushers"), list): bad(st)
ours = [p.get("pushkey") for p in cur["pushers"]
        if isinstance(p, dict) and p.get("app_id") == app_id and isinstance(p.get("pushkey"), str)]
if op == "register":
    st, _ = call("POST", "/_matrix/client/v3/pushers/set", {
        "kind": "http", "app_id": app_id, "pushkey": keep, "app_display_name": "Hivra wake",
        "device_display_name": "Hivra wake", "lang": "en", "append": False,
        "data": {"url": url, "format": "event_id_only"}})
    if st != 200: bad(st)
removed = 0
for k in ours:
    if op == "register" and k == keep: continue
    st, _ = call("POST", "/_matrix/client/v3/pushers/set", {"kind": None, "app_id": app_id, "pushkey": k})
    if st == 200: removed += 1
    elif op == "remove": bad(st)
out({"ok": True, "fp": fp, "homeserverHost": u.hostname.lower()[:253], "removed": removed})
`;

const MIN_VMID = 100;
const MAX_VMID = 999_999_999;
const QGA_LOCK_WAIT_SECONDS = 30;
/** The program gives up after 40 s; the host's own qm call is cut off a little later. */
const MATRIX_PUSHER_QM_TIMEOUT_SECONDS = 55;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The host side. Only the VMID and binding tag (both checked) are in the
 * script; the request rides on the script's stdin (runProxmoxHostScriptWithStdin)
 * and only the guest exec reads it. A VM that is not plainly running, or not
 * this computer, is refused by name before anything reaches the guest.
 */
export function buildMatrixPusherHostScript(target: { vmid: number; bindingTag: string | null }): string {
  if (!Number.isSafeInteger(target.vmid) || target.vmid < MIN_VMID || target.vmid > MAX_VMID) {
    throw new Error("Invalid Matrix pusher VMID.");
  }
  if (typeof target.bindingTag !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(target.bindingTag)) {
    throw new Error("The Matrix pusher needs the computer's exact binding tag.");
  }
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
# The request is this script's stdin; only the guest exec may read it.
qm() { command timeout -k 5 25 qm "$@" </dev/null; }
refuse() { printf '${MATRIX_PUSHER_REFUSED_PREFIX}%s\\n' "$1"; exit 0; }
CONFIG="$(qm config "$VMID" 2>/dev/null)" || refuse unreachable
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || refuse binding_mismatch
VERBOSE="$(qm status "$VMID" --verbose 2>/dev/null)" || refuse unreachable
STATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="status:" {print $2; exit}')"
QMPSTATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="qmpstatus:" {print $2; exit}')"
LOCK="$(printf '%s\\n' "$CONFIG" | awk '$1=="lock:" {print $2; exit}')"
case "$STATUS/\${QMPSTATUS:-none}/\${LOCK:-none}" in
  running/running/none) ;;
  running/paused/none|stopped/*/suspended) refuse asleep ;;
  stopped/*/none) refuse not_running ;;
  *) refuse unexpected_state ;;
esac
${buildVmidBoundGuestExecPrelude()}
install -d -m 0755 /run/lock
exec 7>/run/lock/hivra-qga-${target.vmid}.lock
flock -x -w ${QGA_LOCK_WAIT_SECONDS} 7 || refuse guest_busy
qm() { command timeout -k 5 ${MATRIX_PUSHER_QM_TIMEOUT_SECONDS} qm "$@"; }
run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ${shellQuote(MATRIX_PUSHER_GUEST_PROGRAM)} 2>/dev/null || refuse guest_unreachable
`;
}

export interface MatrixPusherRequest {
  op: "register" | "remove";
  pushkey?: string;
  url?: string;
}

/** The JSON the guest program reads, sent as the host script's stdin. */
export function buildMatrixPusherPayload(request: MatrixPusherRequest): string {
  if (request.op === "register") {
    if (typeof request.pushkey !== "string" || !request.pushkey || typeof request.url !== "string" || !request.url) {
      throw new Error("Invalid Matrix pusher request.");
    }
    return JSON.stringify({ op: "register", appId: MATRIX_PUSH_APP_ID, pushkey: request.pushkey, url: request.url });
  }
  return JSON.stringify({ op: "remove", appId: MATRIX_PUSH_APP_ID });
}

export type MatrixPusherResult =
  | { ok: true; fp: string; homeserverHost: string; removed: number }
  | { ok: false; reason: string };

const REASON = /^[a-z_]{1,40}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

/** Strict read of the one answer line. Anything else is a failure with a short reason. */
export function parseMatrixPusherOutput(stdout: string): MatrixPusherResult {
  if (typeof stdout !== "string") return { ok: false, reason: "no_answer" };
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const refused = lines.filter((line) => line.startsWith(MATRIX_PUSHER_REFUSED_PREFIX));
  const answers = lines.filter((line) => line.startsWith(MATRIX_PUSHER_PREFIX));
  if (refused.length === 1 && answers.length === 0) {
    const reason = refused[0].slice(MATRIX_PUSHER_REFUSED_PREFIX.length).trim();
    return { ok: false, reason: REASON.test(reason) ? reason : "no_answer" };
  }
  if (answers.length !== 1 || refused.length !== 0) return { ok: false, reason: "no_answer" };
  let value: unknown;
  try {
    value = JSON.parse(answers[0].slice(MATRIX_PUSHER_PREFIX.length));
  } catch {
    return { ok: false, reason: "no_answer" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "no_answer" };
  const row = value as Record<string, unknown>;
  if (row.ok === false) {
    return { ok: false, reason: typeof row.reason === "string" && REASON.test(row.reason) ? row.reason : "no_answer" };
  }
  if (row.ok !== true || typeof row.fp !== "string" || !/^[0-9a-f]{16}$/.test(row.fp)
      || typeof row.homeserverHost !== "string" || !HOST.test(row.homeserverHost)
      || !Number.isSafeInteger(row.removed) || (row.removed as number) < 0) {
    return { ok: false, reason: "no_answer" };
  }
  return { ok: true, fp: row.fp, homeserverHost: row.homeserverHost, removed: row.removed as number };
}
