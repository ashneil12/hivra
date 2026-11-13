// Host scripts for the per-agent host ingress cutover and rollback (WP6).
// Pure builders: nothing here talks to the network or the database.
//
// Each script prints one or more "HIVRA_INGRESS_STEP <json>" lines; the last
// one is the answer. A run token only ever arrives as SSH stdin
// (runProxmoxHostScriptWithStdin), is copied into a 0600 temp file under /run
// and removed on exit; it is never in argv, the script text or the output.
//
// Nothing host-specific lives here. The VM's MAC and bridge are read from its
// own net0 line on the host, and every path is the same on every host.
//
// Fail toward awake: the attach script never touches the guest, and undoes
// every file, unit and pin it made when any of its checks fail, so the guest
// connector keeps serving. The guest scripts only change the guest's own
// connector and are only run by enable/rollback once the other side is proven.

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  assertMetricsPort,
  assertVmid,
  INGRESS_DIR,
  INGRESS_PINS_DIR,
  INGRESS_PROXY_PROGRAM,
  INGRESS_ROUTES_DIR,
  isPrivateGuestIp,
} from "@/lib/hivra/ingress/route-file";

export const INGRESS_STEP_PREFIX = "HIVRA_INGRESS_STEP ";
export const HOST_CONNECTOR_BINARY = "/usr/local/bin/hivra-cloudflared";
export const HOST_CONNECTOR_TEMPLATE_UNIT = "/etc/systemd/system/hivra-cf@.service";
/** The nft table that holds one prerouting chain per host-ingress computer. */
export const INGRESS_PIN_TABLE = "hivra_ingress_pin";

const TAG = /^[A-Za-z0-9._-]{1,128}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function assertTag(tag: string | null): string {
  if (typeof tag !== "string" || !TAG.test(tag)) throw new Error("Host ingress needs the computer's exact binding tag.");
  return tag;
}

function assertHostname(hostname: string): string {
  if (typeof hostname !== "string" || !HOSTNAME.test(hostname)) throw new Error("Invalid box hostname.");
  return hostname;
}

/** Shared head: strict bash, the VMID, an uptime clock, the step printer and the proxy CLI. */
function head(vmid: number, script: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${assertVmid(vmid)}
SCRIPT=${shellQuote(script)}
INGRESS_DIR=${shellQuote(INGRESS_DIR)}
ROUTES_DIR=${shellQuote(INGRESS_ROUTES_DIR)}
PINS_DIR=${shellQuote(INGRESS_PINS_DIR)}
PROXY_PY=${shellQuote(INGRESS_PROXY_PROGRAM)}
PIN_TABLE=${shellQuote(INGRESS_PIN_TABLE)}
` + String.raw`ROUTE_FILE="$ROUTES_DIR/$VMID.json"
ENV_FILE="$INGRESS_DIR/$VMID.env"
PIN_NFT="$PINS_DIR/$VMID.nft"
PIN_NEIGH="$PINS_DIR/$VMID.neigh"
UNIT="hivra-cf@$VMID.service"
STEP="$SCRIPT"
uptime_ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }
STARTED_MS="$(uptime_ms)"
# step <ok> [reason]: one result line; reasons are fixed [a-z_] words.
step() {
  local ms=$(( $(uptime_ms) - STARTED_MS ))
  if [ "$#" -ge 2 ]; then
    printf 'HIVRA_INGRESS_STEP {"step":"%s","ok":%s,"reason":"%s","ms":%d}\n' "$STEP" "$1" "$2" "$ms"
  else
    printf 'HIVRA_INGRESS_STEP {"step":"%s","ok":%s,"ms":%d}\n' "$STEP" "$1" "$ms"
  fi
}
fail() { step false "$1"; exit 0; }
qmq() { command timeout -k 5 45 qm "$@" </dev/null; }
proxy_ctl() { command timeout -k 2 20 python3 -I -B "$PROXY_PY" ctl "$@" </dev/null; }
# The VM must carry the expected binding tag and run plainly (not paused, not locked).
check_vm() {
  local config verbose status qmp lock
  config="$(qmq config "$VMID" 2>/dev/null)" || fail unreachable
  printf '%s\n' "$config" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null || fail binding_mismatch
  verbose="$(qmq status "$VMID" --verbose 2>/dev/null)" || fail unreachable
  status="$(printf '%s\n' "$verbose" | awk '$1=="status:" {print $2; exit}')"
  qmp="$(printf '%s\n' "$verbose" | awk '$1=="qmpstatus:" {print $2; exit}')"
  lock="$(printf '%s\n' "$config" | awk '$1=="lock:" {print $2; exit}')"
  [ "$status/$qmp/$lock" = "running/running/" ] || fail not_running
  VM_CONFIG="$config"
}
# The local proxy's answer for a Host header and path, or 0.
front_door() {
  python3 -I -c 'import http.client,sys; c=http.client.HTTPConnection("127.0.0.1",8080,timeout=3); c.request("GET",sys.argv[2],headers={"Host":sys.argv[1]}); print(c.getresponse().status)' "$1" "$2" 2>/dev/null </dev/null || printf '0\n'
}
connector_ready() {
  python3 -I -c 'import http.client,sys; c=http.client.HTTPConnection("127.0.0.1",int(sys.argv[1]),timeout=2); c.request("GET","/ready"); print(c.getresponse().status)' "$1" 2>/dev/null </dev/null || printf '0\n'
}
remove_pin() {
  if nft list chain bridge "$PIN_TABLE" "vm_$VMID" >/dev/null 2>&1; then
    printf 'flush chain bridge %s vm_%s\ndelete chain bridge %s vm_%s\n' "$PIN_TABLE" "$VMID" "$PIN_TABLE" "$VMID" | nft -f - >/dev/null 2>&1 || return 1
  fi
  if [ -f "$PIN_NEIGH" ]; then
    local pin_ip pin_mac pin_bridge
    read -r pin_ip pin_mac pin_bridge < "$PIN_NEIGH" || true
    if [[ "$pin_ip" =~ ^[0-9.]{7,15}$ ]] && [[ "$pin_bridge" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then
      ip neigh del "$pin_ip" dev "$pin_bridge" >/dev/null 2>&1 || true
    fi
  fi
  rm -f -- "$PIN_NFT" "$PIN_NEIGH"
}
# Everything a host connector for this VM uses. Idempotent.
remove_host_side() {
  local rc=0
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  if systemctl is-active --quiet "$UNIT" 2>/dev/null; then rc=1; fi
  rm -f -- "$ROUTE_FILE" "$ENV_FILE" || rc=1
  remove_pin || rc=1
  proxy_ctl reload >/dev/null 2>&1 || true
  return "$rc"
}
`;
}

/**
 * Read-only preflight: the VM is the bound, running computer; the wake proxy
 * answers; the pinned host connector and its unit are installed; nft is there.
 */
export function buildIngressPreflightScript(input: { vmid: number; bindingTag: string | null }): string {
  return head(input.vmid, "preflight") + `EXPECTED_BINDING_TAG=${shellQuote(assertTag(input.bindingTag))}
CONNECTOR_BIN=${shellQuote(HOST_CONNECTOR_BINARY)}
CONNECTOR_TEMPLATE=${shellQuote(HOST_CONNECTOR_TEMPLATE_UNIT)}
` + String.raw`exec </dev/null
check_vm
[ -x "$CONNECTOR_BIN" ] || fail connector_binary_missing
[ -f "$CONNECTOR_TEMPLATE" ] || fail connector_unit_missing
command -v nft >/dev/null 2>&1 || fail nft_missing
proxy_ctl health >/dev/null 2>&1 || fail proxy_unhealthy
[ "$(front_door hivra-health.invalid /)" = "503" ] || fail front_door_unexpected
step true
`;
}

/** Writes the route, env and pin files from the stdin document. Never prints the token. */
const ATTACH_WRITER = String.raw`import json, os, re, sys
payload_path, vmid, tag, hostname, guest_ip, port, mac, routes_dir, env_path = sys.argv[1:10]
TOKEN = re.compile(r"^[A-Za-z0-9+/=_-]{40,4096}$")
def bad(reason):
    sys.stdout.write(reason + "\n")
    sys.exit(3)
try:
    with open(payload_path, "rb") as handle:
        doc = json.loads(handle.read(65536).decode("utf-8"))
except Exception:
    bad("payload_invalid")
if not isinstance(doc, dict):
    bad("payload_invalid")
route, token, metrics = doc.get("route"), doc.get("token"), doc.get("metrics_port")
if not isinstance(route, dict) or not isinstance(token, str) or not TOKEN.match(token):
    bad("payload_invalid")
if (route.get("vmid") != int(vmid) or route.get("binding_tag") != tag or route.get("hostname") != hostname
        or route.get("guest_ip") != guest_ip or metrics != int(port)):
    bad("payload_mismatch")
route = dict(route)
route["guest_mac"] = mac
def write(path, data):
    tmp = path + ".hivra-tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
try:
    os.makedirs(routes_dir, mode=0o700, exist_ok=True)
    write(env_path, ("TUNNEL_TOKEN=" + token + "\nTUNNEL_METRICS=127.0.0.1:" + port + "\n").encode("ascii"))
    write(os.path.join(routes_dir, vmid + ".json"),
          (json.dumps(route, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"))
except OSError:
    bad("write_failed")
`;

/**
 * Attach the host side for one computer: ARP/IP pin, connector env file and
 * route file (stdin carries the token and the route), proxy reload, a local
 * check through the proxy to the guest forwarder, then the host connector
 * until its /ready answers. Any failure removes everything it made again.
 */
export function buildIngressAttachScript(input: {
  vmid: number;
  bindingTag: string | null;
  hostname: string;
  guestIp: string;
  metricsPort: number;
}): string {
  const tag = assertTag(input.bindingTag);
  const hostname = assertHostname(input.hostname);
  if (!isPrivateGuestIp(input.guestIp)) throw new Error("Invalid guest address.");
  const port = assertMetricsPort(input.metricsPort);
  return head(input.vmid, "attach") + `EXPECTED_BINDING_TAG=${shellQuote(tag)}
BOX_HOSTNAME=${shellQuote(hostname)}
GUEST_IP=${shellQuote(input.guestIp)}
METRICS_PORT=${port}
WRITER=${shellQuote(ATTACH_WRITER)}
` + String.raw`PAYLOAD="$(mktemp /run/hivra-ingress-payload.XXXXXXXX)"
chmod 0600 "$PAYLOAD"
trap 'rm -f -- "$PAYLOAD"' EXIT
head -c 65536 > "$PAYLOAD"
exec </dev/null
check_vm
install -d -m 0755 /run/lock
exec 8>"/run/lock/hivra-ingress-$VMID.lock"
flock -x -w 30 8 || fail busy
NET0="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^net0:[[:space:]]*//p' | head -n 1)"
MAC="$(printf '%s\n' "$NET0" | tr ',' '\n' | sed -n 's/^[a-z0-9]*=\([0-9A-Fa-f][0-9A-Fa-f]\(:[0-9A-Fa-f][0-9A-Fa-f]\)\{5\}\)$/\1/p' | head -n 1 | tr 'A-F' 'a-f')"
BRIDGE="$(printf '%s\n' "$NET0" | tr ',' '\n' | sed -n 's/^bridge=//p' | head -n 1)"
[[ "$MAC" =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || fail mac_unknown
[[ "$BRIDGE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail bridge_unknown
# A metrics port held by anything but this computer's own connector is a clash.
if ! systemctl is-active --quiet "$UNIT" 2>/dev/null && [ -n "$(ss -Hltn "sport = :$METRICS_PORT" 2>/dev/null)" ]; then
  fail metrics_port_busy
fi
undo() { remove_host_side >/dev/null 2>&1 || true; }

STEP=pin
install -d -m 0700 "$INGRESS_DIR" "$PINS_DIR"
OWN="$(printf '{ "tap%si0", "fwpr%sp0" }' "$VMID" "$VMID")"
{
  printf 'add table bridge %s\n' "$PIN_TABLE"
  printf 'add chain bridge %s vm_%s { type filter hook prerouting priority -300; policy accept; }\n' "$PIN_TABLE" "$VMID"
  printf 'flush chain bridge %s vm_%s\n' "$PIN_TABLE" "$VMID"
  printf 'add rule bridge %s vm_%s iifname %s ether saddr != %s drop\n' "$PIN_TABLE" "$VMID" "$OWN" "$MAC"
  printf 'add rule bridge %s vm_%s iifname %s arp saddr ether != %s drop\n' "$PIN_TABLE" "$VMID" "$OWN" "$MAC"
  printf 'add rule bridge %s vm_%s iifname %s arp saddr ip != { %s, 0.0.0.0 } drop\n' "$PIN_TABLE" "$VMID" "$OWN" "$GUEST_IP"
  printf 'add rule bridge %s vm_%s iifname %s ip saddr != { %s, 0.0.0.0 } drop\n' "$PIN_TABLE" "$VMID" "$OWN" "$GUEST_IP"
  printf 'add rule bridge %s vm_%s meta ibrname "%s" iifname != %s arp saddr ip %s drop\n' "$PIN_TABLE" "$VMID" "$BRIDGE" "$OWN" "$GUEST_IP"
  printf 'add rule bridge %s vm_%s meta ibrname "%s" iifname != %s ip saddr %s drop\n' "$PIN_TABLE" "$VMID" "$BRIDGE" "$OWN" "$GUEST_IP"
} > "$PIN_NFT.tmp"
chmod 0600 "$PIN_NFT.tmp"
nft -c -f "$PIN_NFT.tmp" >/dev/null 2>&1 || { rm -f -- "$PIN_NFT.tmp"; undo; fail pin_invalid; }
mv -f -- "$PIN_NFT.tmp" "$PIN_NFT"
printf '%s %s %s\n' "$GUEST_IP" "$MAC" "$BRIDGE" > "$PIN_NEIGH"
chmod 0600 "$PIN_NEIGH"
nft -f "$PIN_NFT" >/dev/null 2>&1 || { undo; fail pin_failed; }
ip neigh replace "$GUEST_IP" lladdr "$MAC" dev "$BRIDGE" nud permanent >/dev/null 2>&1 || { undo; fail neigh_failed; }

STEP=files
WRITE_ERR="$(python3 -I -B -c "$WRITER" "$PAYLOAD" "$VMID" "$EXPECTED_BINDING_TAG" "$BOX_HOSTNAME" "$GUEST_IP" "$METRICS_PORT" "$MAC" "$ROUTES_DIR" "$ENV_FILE" 2>/dev/null)" || {
  undo
  case "$WRITE_ERR" in payload_invalid|payload_mismatch|write_failed) fail "$WRITE_ERR" ;; *) fail write_failed ;; esac
}
rm -f -- "$PAYLOAD"

STEP=route
proxy_ctl reload >/dev/null 2>&1 || { undo; fail proxy_reload_failed; }
proxy_ctl status "$VMID" 2>/dev/null | grep -Eq '"route": ?true' || { undo; fail route_rejected; }

STEP=local
LOCAL_OK=0
for _ in $(seq 1 40); do
  if [ "$(front_door "$BOX_HOSTNAME" /healthz)" = "200" ]; then LOCAL_OK=1; break; fi
  sleep 0.25
done
[ "$LOCAL_OK" = 1 ] || { undo; fail local_unhealthy; }

STEP=connector
if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  systemctl restart "$UNIT" >/dev/null 2>&1 || { undo; fail connector_start_failed; }
else
  systemctl enable --now "$UNIT" >/dev/null 2>&1 || { undo; fail connector_start_failed; }
fi
READY_OK=0
READY_DEADLINE=$(( $(uptime_ms) + 30000 ))
while [ "$(uptime_ms)" -lt "$READY_DEADLINE" ]; do
  if [ "$(connector_ready "$METRICS_PORT")" = "200" ]; then READY_OK=1; break; fi
  sleep 0.5
done
[ "$READY_OK" = 1 ] || { undo; fail connector_not_ready; }
STEP=attach
step true
`;
}

/**
 * Remove this computer's host side: stop and disable its connector, remove
 * its env, route and pin files and the nft chain, reload the proxy. Refuses
 * when the route file belongs to another hostname (a recycled VMID).
 */
export function buildIngressDetachScript(input: { vmid: number; hostname: string }): string {
  const hostname = assertHostname(input.hostname);
  return head(input.vmid, "detach") + `BOX_HOSTNAME=${shellQuote(hostname)}
` + String.raw`exec </dev/null
install -d -m 0755 /run/lock
exec 8>"/run/lock/hivra-ingress-$VMID.lock"
flock -x -w 30 8 || fail busy
if [ -f "$ROUTE_FILE" ]; then
  OWNER="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hostname",""))' "$ROUTE_FILE" 2>/dev/null || true)"
  [ "$OWNER" = "$BOX_HOSTNAME" ] || fail hostname_mismatch
fi
if [ ! -e "$ROUTE_FILE" ] && [ ! -e "$ENV_FILE" ] && [ ! -e "$PIN_NFT" ] && [ ! -e "$PIN_NEIGH" ] \
  && ! systemctl is-active --quiet "$UNIT" 2>/dev/null \
  && ! nft list chain bridge "$PIN_TABLE" "vm_$VMID" >/dev/null 2>&1; then
  STEP=detach_absent
  step true
  exit 0
fi
remove_host_side || fail remove_incomplete
step true
`;
}

/** Read-only: what the host has for this computer. Prints one HIVRA_INGRESS_STEP line with the facts. */
export function buildIngressStatusScript(input: { vmid: number; metricsPort: number | null }): string {
  const port = input.metricsPort === null ? 0 : assertMetricsPort(input.metricsPort);
  return head(input.vmid, "status") + `METRICS_PORT=${port}
` + String.raw`exec </dev/null
ROUTE=false; ENVF=false; ACTIVE=false; READY=false; PIN=false; PROXY=false
[ -f "$ROUTE_FILE" ] && ROUTE=true
[ -f "$ENV_FILE" ] && ENVF=true
systemctl is-active --quiet "$UNIT" 2>/dev/null && ACTIVE=true
if [ "$METRICS_PORT" != 0 ] && [ "$(connector_ready "$METRICS_PORT")" = "200" ]; then READY=true; fi
nft list chain bridge "$PIN_TABLE" "vm_$VMID" >/dev/null 2>&1 && PIN=true
proxy_ctl status "$VMID" 2>/dev/null | grep -Eq '"route": ?true' && PROXY=true
printf 'HIVRA_INGRESS_STEP {"step":"status","ok":true,"ms":%d,"route":%s,"env":%s,"connector":%s,"ready":%s,"pin":%s,"proxy_route":%s}\n' \
  "$(( $(uptime_ms) - STARTED_MS ))" "$ROUTE" "$ENVF" "$ACTIVE" "$READY" "$PIN" "$PROXY"
`;
}

/**
 * The guest half: turn the guest's own connector off (and delete its token
 * file), or put a token back (from stdin) and turn it on.
 */
export const GUEST_TUNNEL_PROGRAM = String.raw`import json, os, re, subprocess, sys, time
TOKEN_FILE = "/etc/hivra-cf-token.env"
UNIT = "hivra-cf-tunnel.service"
UNIT_FILE = "/etc/systemd/system/hivra-cf-tunnel.service"
TOKEN = re.compile(r"^[A-Za-z0-9+/=_-]{40,4096}$")
started = time.monotonic()
op = sys.argv[1] if len(sys.argv) > 1 else ""
def done(ok, reason=None, **extra):
    record = {"step": "guest_" + (op if op in ("disable", "enable") else "unknown"), "ok": ok,
              "ms": int((time.monotonic() - started) * 1000)}
    if reason:
        record["reason"] = reason
    record.update(extra)
    sys.stdout.write("HIVRA_INGRESS_STEP " + json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()
    sys.exit(0)
def systemctl(*args):
    try:
        return subprocess.run(("systemctl",) + args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=200).returncode
    except Exception:
        return 255
if op == "disable":
    systemctl("disable", "--now", UNIT)
    if systemctl("is-active", "--quiet", UNIT) == 0:
        done(False, "still_active")
    try:
        os.unlink(TOKEN_FILE)
        removed = True
    except FileNotFoundError:
        removed = False
    except OSError:
        done(False, "token_remove_failed")
    done(True, removed=removed)
elif op == "enable":
    try:
        doc = json.loads(sys.stdin.buffer.read(16384).decode("utf-8"))
        token = doc.get("token") if isinstance(doc, dict) else None
    except Exception:
        token = None
    if not isinstance(token, str) or not TOKEN.match(token):
        done(False, "payload_invalid")
    if not os.path.isfile(UNIT_FILE):
        done(False, "unit_missing")
    tmp = TOKEN_FILE + ".hivra-tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(("TUNNEL_TOKEN=" + token + "\n").encode("ascii"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        if os.geteuid() == 0:
            os.chown(tmp, 0, 0)
        os.replace(tmp, TOKEN_FILE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        done(False, "token_write_failed")
    if systemctl("enable", UNIT) != 0:
        done(False, "enable_failed")
    if systemctl("restart", UNIT) != 0:
        done(False, "restart_failed")
    if systemctl("is-active", "--quiet", UNIT) != 0:
        done(False, "not_active")
    done(True)
else:
    done(False, "bad_op")
`;

/**
 * Run the guest program in the exact, running VM through the VMID-bound guest
 * agent. "enable" needs the token document on SSH stdin
 * (buildGuestTokenPayload); "disable" takes none.
 */
export function buildIngressGuestTunnelScript(input: {
  vmid: number;
  bindingTag: string | null;
  op: "disable" | "enable";
}): string {
  if (input.op !== "disable" && input.op !== "enable") throw new Error("Invalid guest tunnel operation.");
  const run = input.op === "enable"
    ? String.raw`OUT="$(run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c "$PROGRAM" enable < "$PAYLOAD" 2>/dev/null)" || fail guest_failed`
    : String.raw`OUT="$(run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c "$PROGRAM" disable 2>/dev/null)" || fail guest_failed`;
  return head(input.vmid, `guest_${input.op}`) + `EXPECTED_BINDING_TAG=${shellQuote(assertTag(input.bindingTag))}
PROGRAM=${shellQuote(GUEST_TUNNEL_PROGRAM)}
` + String.raw`PAYLOAD="$(mktemp /run/hivra-ingress-payload.XXXXXXXX)"
chmod 0600 "$PAYLOAD"
trap 'rm -f -- "$PAYLOAD"' EXIT
` + (input.op === "enable" ? String.raw`head -c 16384 > "$PAYLOAD"
` : "") + String.raw`exec </dev/null
check_vm
` + buildVmidBoundGuestExecPrelude() + String.raw`
trap 'cleanup_hivra_qga_result; rm -f -- "$PAYLOAD"' EXIT
# Not </dev/null here: the enable call feeds the token file to the guest agent.
qm() { command timeout -k 5 240 qm "$@"; }
install -d -m 0755 /run/lock
exec 7>"/run/lock/hivra-qga-$VMID.lock"
flock -x -w 30 7 || fail guest_busy
` + run + String.raw`
LINE="$(printf '%s\n' "$OUT" | grep '^HIVRA_INGRESS_STEP ' | tail -n 1)"
[ -n "$LINE" ] || fail guest_no_answer
printf '%s\n' "$LINE"
`;
}

export interface IngressStepResult {
  step: string;
  ok: boolean;
  reason?: string;
  ms: number;
  [fact: string]: unknown;
}

const STEP_NAME = /^[a-z_]{1,40}$/;

/** The last well-formed HIVRA_INGRESS_STEP line, or null. */
export function parseIngressStep(stdout: string): IngressStepResult | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(INGRESS_STEP_PREFIX));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let value: unknown;
    try { value = JSON.parse(lines[index].slice(INGRESS_STEP_PREFIX.length)); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.step !== "string" || !STEP_NAME.test(v.step) || typeof v.ok !== "boolean") continue;
    if (!Number.isSafeInteger(v.ms) || (v.ms as number) < 0) continue;
    if (v.reason !== undefined && (typeof v.reason !== "string" || !STEP_NAME.test(v.reason))) continue;
    if (v.ok === false && v.reason === undefined) continue;
    return v as IngressStepResult;
  }
  return null;
}
