import "server-only";

import { z } from "zod";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { providerGuestBundleScopeSha256 } from "./provider-guest-bundle";
import { parseProviderGuestWorkerReceipt, type ProviderGuestWorkerIdentity } from "./provider-guest-worker";

const Runtime = z.enum(["claude", "codex", "aeon", "openclaw", "agent-zero"]);
const AccessMode = z.enum(["cloudflare-named", "direct-https"]);
export type ProviderGuestRuntimeProbe = {
  scope: FirstBootOperationScope; identity: ProviderGuestWorkerIdentity;
  runtime: z.infer<typeof Runtime>;
  accessMode?: z.infer<typeof AccessMode>;
  captureBootId?: true;
};
const State = z.discriminatedUnion("ready", [
  z.object({ version: z.literal(1), ready: z.literal(true), runtime: Runtime,
    identity: z.unknown(), apiToken: z.string().regex(/^[a-f0-9]{64}$/), bootId: z.string().uuid().optional() }).strict(),
  z.object({ version: z.literal(1), ready: z.literal(false), runtime: Runtime, identity: z.unknown(),
    bootId: z.string().uuid().optional(),
    reason: z.enum(["installer_unverified", "boot_unverified", "runtime_unavailable", "authentication_unverified", "native_unavailable"]) }).strict(),
]);
export type ProviderGuestRuntimeReceipt = z.infer<typeof State>;

function checked(input: ProviderGuestRuntimeProbe) {
  const identity = parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({
    version: 1, identity: input.identity, state: "succeeded", stopped: true,
  })}\n`, input.identity).identity;
  if (identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(input.scope)) throw new Error();
  const captureBootId = z.literal(true).optional().parse(input.captureBootId);
  return { identity, runtime: Runtime.parse(input.runtime),
    accessMode: AccessMode.parse(input.accessMode ?? "cloudflare-named"), ...(captureBootId ? { captureBootId } : {}) };
}

/** Read-only, fixed recipe for an original successfully stopped installer.
 * It neither runs the worker nor trusts an installer exit as service readiness.
 * The bearer is returned only over pinned SSH after the local auth gate passes;
 * it is never put in argv, a log, a URL or a failed receipt. Caller owns the
 * current agent operation and must recheck it before publishing any result.
 */
export function buildProviderGuestRuntimeProbe(input: ProviderGuestRuntimeProbe) {
  let expected: ReturnType<typeof checked>;
  try { expected = checked(input); } catch { throw new Error("Invalid provider runtime probe"); }
  const script = `import base64, json, os, pwd, re, socket, stat, subprocess, sys
from http.client import HTTPConnection
EXPECTED = json.loads(base64.b64decode("${Buffer.from(JSON.stringify(expected)).toString("base64")}", validate=True))
ROOT = "/var/lib/hivra/provider-install"
AGENT_HOME = "/home/bux"
MAX_BODY = 8192

def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value

def directory(path, owner):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise ValueError()

def read_file(path, owner, mode, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        modes = mode if isinstance(mode, tuple) else (mode,)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) not in modes or info.st_size > limit:
            raise ValueError()
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError()
        return data
    finally:
        os.close(fd)

def http(port, path, token=None, body=False):
    connection = HTTPConnection("127.0.0.1", port, timeout=0.6)
    try:
        headers = {"Authorization": "Bearer " + token} if token else {}
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        # No redirects, proxies, external hosts or arbitrary request paths.
        data = response.read(MAX_BODY + 1) if body else b""
        if len(data) > MAX_BODY:
            raise ValueError()
        return response.status, data
    finally:
        connection.close()

class UnixHTTPConnection(HTTPConnection):
    def __init__(self, socket_path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)

def terminal(port, path, owner):
    # Terminals from the socket release listen only on a bux-owned unix socket
    # in a 0700 runtime folder; earlier releases on the loopback port.
    socket_path = {7681: "/run/hivra-terminal/ttyd.sock", 7682: "/run/hivra-box-terminal/ttyd.sock"}[port]
    try:
        folder, info = os.lstat(os.path.dirname(socket_path)), os.lstat(socket_path)
    except FileNotFoundError:
        return http(port, path)[0]
    if not stat.S_ISDIR(folder.st_mode) or folder.st_uid != owner or folder.st_mode & 0o077 or not stat.S_ISSOCK(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise ValueError()
    connection = UnixHTTPConnection(socket_path, 0.6)
    try:
        connection.request("GET", path)
        return connection.getresponse().status
    finally:
        connection.close()

def read_boot_id():
    for path in ("/proc", "/proc/sys", "/proc/sys/kernel", "/proc/sys/kernel/random"):
        directory(path, 0)
    value = read_file("/proc/sys/kernel/random/boot_id", 0, 0o444, 64).decode("ascii")
    if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\n", value):
        raise ValueError()
    return value.rstrip("\\n")

def inspect():
    reason = "installer_unverified"
    result = {"version": 1, "identity": EXPECTED["identity"], "runtime": EXPECTED["runtime"], "ready": False}
    try:
        for path in ("/", "/var", "/var/lib", "/var/lib/hivra", ROOT):
            directory(path, 0)
        installed = json.loads(read_file(ROOT + "/identity.json", 0, 0o600, MAX_BODY), object_pairs_hook=unique)
        finished = json.loads(read_file(ROOT + "/result.json", 0, 0o600, MAX_BODY), object_pairs_hook=unique)
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
        if canonical(installed) != canonical(EXPECTED["identity"]) or not isinstance(finished, dict) or set(finished) != {"identity", "exitCode"} or canonical(finished["identity"]) != canonical(installed) or type(finished["exitCode"]) is not int or finished["exitCode"] != 0:
            raise ValueError()
        # A restart can repair an unhealthy runtime. Record the original boot
        # independently, but only after verifying the original installer files.
        if EXPECTED.get("captureBootId"):
            reason = "boot_unverified"
            result["bootId"] = read_boot_id()
        reason = "runtime_unavailable"
        user = pwd.getpwnam("bux")
        if user.pw_uid <= 0 or user.pw_dir != AGENT_HOME:
            raise ValueError()
        directory("/home", 0)
        directory(AGENT_HOME, user.pw_uid)
        directory(AGENT_HOME + "/.hivra", user.pw_uid)
        kind = read_file(AGENT_HOME + "/.hivra/agent-kind", user.pw_uid, (0o600, 0o644), 64).decode("ascii").strip()
        if kind != EXPECTED["runtime"]:
            raise ValueError()
        access_unit = "hivra-direct-access.service" if EXPECTED["accessMode"] == "direct-https" else "hivra-cf-tunnel.service"
        units = ["bux-hivra-chat.service", "bux-ttyd.service", "bux-box-ttyd.service", access_unit]
        extra = {"aeon": "bux-aeon.service", "openclaw": "bux-openclaw.service", "agent-zero": "hivra-agent-zero.service"}.get(kind)
        if extra:
            units.append(extra)
        active = subprocess.run(["/usr/bin/systemctl", "is-active", *units], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=1, check=False, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        if active.returncode != 0 or active.stdout.splitlines() != [b"active"] * len(units):
            raise ValueError()
        if http(8080, "/healthz", body=True) != (200, b"ok"):
            raise ValueError()
        status, raw = http(8080, "/api/meta", body=True)
        meta = json.loads(raw, object_pairs_hook=unique)
        if status != 200 or not isinstance(meta, dict) or meta.get("agentKind") != kind or meta.get("surfaceAuth") != "post-cookie-v1":
            raise ValueError()
        reason = "authentication_unverified"
        token = read_file(AGENT_HOME + "/.hivra/api-token", user.pw_uid, 0o600, 64).decode("ascii")
        if not re.fullmatch(r"[a-f0-9]{64}", token) or http(8080, "/api/model")[0] != 401 or http(8080, "/api/model", token)[0] != 200:
            raise ValueError()
        reason = "native_unavailable"
        for port, path in ((7681, "/terminal/"), (7682, "/box-terminal/")):
            if terminal(port, path, user.pw_uid) != 200:
                raise ValueError()
        # Agent login is separate from service readiness; a native login page
        # or an in-app redirect can be a legitimate first-run interface.
        native = {"aeon": "/aeon/", "openclaw": "/openclaw/", "agent-zero": "/agent-zero/"}.get(kind)
        if native and http(8080, native, token)[0] not in (200, 301, 302, 303, 307, 308, 401, 403):
            raise ValueError()
        result.update(ready=True, apiToken=token)
    except Exception:
        result["reason"] = reason
    if "bootId" in result:
        try:
            if read_boot_id() != result["bootId"]:
                raise ValueError()
        except Exception:
            result.pop("apiToken", None)
            result.pop("bootId", None)
            result.update(ready=False, reason="boot_unverified")
    return result

if __name__ == "__main__":
    print("HIVRA_PROVIDER_RUNTIME_V1 " + json.dumps(inspect(), separators=(",", ":")), flush=True)
`;
  return { ...expected, script };
}

export function parseProviderGuestRuntimeReceipt(output: string, input: ProviderGuestRuntimeProbe): ProviderGuestRuntimeReceipt {
  try {
    const expected = checked(input), marker = "HIVRA_PROVIDER_RUNTIME_V1 ";
    if (Buffer.byteLength(output) > 4096 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const value = State.parse(JSON.parse(output.slice(marker.length)));
    if (value.runtime !== expected.runtime) throw new Error();
    const bootUnavailable = !value.ready && ["installer_unverified", "boot_unverified"].includes(value.reason);
    if (expected.captureBootId) {
      if (bootUnavailable === (value.bootId !== undefined)) throw new Error();
    } else if (value.bootId !== undefined || (!value.ready && value.reason === "boot_unverified")) throw new Error();
    parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({
      version: 1, identity: value.identity, state: "succeeded", stopped: true,
    })}\n`, expected.identity);
    return value;
  } catch { throw new Error("Invalid provider runtime receipt"); }
}
