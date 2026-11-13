// The host wake doorbell (provisioner/hivra-wake-doorbell.py), the pure half:
// its switch, the host scripts that arm and disarm it for one computer, and the
// install, status and remove steps for a host. Nothing here talks to the
// network or the database.
//
// Switch:
//   HIVRA_WAKE_DOORBELLS  comma-separated channels whose host doorbell may act,
//                         e.g. "email,discord". Empty (the default) means none: no
//                         adapter arms a doorbell and the install step refuses.
//
// Credentials. The arm host script reads the computer's mail settings through
// the vmid-bound guest exec and pipes them straight into the doorbell on the
// same host. They are never printed, so they never reach Hivra's servers, its
// logs or its database. Hivra only sees the baseline (UIDVALIDITY, UIDNEXT).
//
// Nothing host-specific lives here: the host is identified by `hostname -s` at
// run time and every path is the same on every host.

import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  managedHivraProvisionerChannelConfiguration,
  type ManagedHivraProvisionerChannel,
} from "@/lib/hivra/managed-provisioner-channel";
import { buildChannelCredReadProgram, buildGuestCredHandoffHostScript, parseIdleProbeRefusal } from "@/lib/hivra/agent-sleep-scripts";
import { ingressHostCredentialEnabled } from "@/lib/hivra/ingress/config";
import { EMAIL_CHANNEL_SPEC } from "./registry";

type Env = Record<string, string | undefined>;

export const WAKE_DOORBELL_CHANNELS = ["email", "discord"] as const;
export type WakeDoorbellChannel = (typeof WAKE_DOORBELL_CHANNELS)[number];

/** The doorbell channels HIVRA_WAKE_DOORBELLS lists. Unknown names are dropped. */
export function parseWakeDoorbells(value: string | undefined | null): ReadonlySet<WakeDoorbellChannel> {
  const names = String(value ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  return new Set(WAKE_DOORBELL_CHANNELS.filter((channel) => names.includes(channel)));
}

export function wakeDoorbellEnabled(channel: WakeDoorbellChannel, env: Env = process.env): boolean {
  return parseWakeDoorbells(env.HIVRA_WAKE_DOORBELLS).has(channel);
}

/**
 * Why a doorbell channel cannot cover a sleeping computer now, or null. The
 * doorbell's rings reach Hivra only through the host credential, so with
 * HIVRA_INGRESS_HOST_CREDENTIAL off every ring would fail.
 */
export function wakeDoorbellBlocker(channel: WakeDoorbellChannel, env: Env = process.env): "doorbell_off" | "host_credential_off" | null {
  if (!wakeDoorbellEnabled(channel, env)) return "doorbell_off";
  if (!ingressHostCredentialEnabled(env)) return "host_credential_off";
  return null;
}

export function anyWakeDoorbellEnabled(env: Env = process.env): boolean {
  return parseWakeDoorbells(env.HIVRA_WAKE_DOORBELLS).size > 0;
}

// ---------------------------------------------------------------------------
// Arm and disarm one computer
// ---------------------------------------------------------------------------

export const DOORBELL_LIB_DIR = "/usr/local/lib/hivra-doorbell";
export const DOORBELL_SCRIPT = `${DOORBELL_LIB_DIR}/hivra-wake-doorbell.py`;
export const DOORBELL_UNIT = "hivra-wake-doorbell.service";
export const DOORBELL_ARM_PREFIX = "HIVRA_DOORBELL_ARM ";
export const DOORBELL_DISARM_PREFIX = "HIVRA_DOORBELL_DISARM ";
export const EMAIL_CRED_PREFIX = "HIVRA_EMAIL_CRED ";
export const EMAIL_CRED_NONE_PREFIX = "HIVRA_EMAIL_CRED_NONE ";

/** Every ~/.hermes/.env key the doorbell needs to watch a mailbox the way Hermes reads it. */
export const EMAIL_DOORBELL_KEYS = [
  "EMAIL_ADDRESS",
  "EMAIL_PASSWORD",
  "EMAIL_IMAP_HOST",
  "EMAIL_IMAP_PORT",
  "EMAIL_IMAP_SECURITY",
  "EMAIL_IMAP_TLS_VERIFY",
  "EMAIL_ALLOWED_USERS",
  "GATEWAY_ALLOWED_USERS",
] as const;

/** The guest program: the mail settings and the probe's fingerprint of them, for the doorbell only. */
export const EMAIL_CRED_READ_PROGRAM = buildChannelCredReadProgram({
  fpKeys: EMAIL_CHANNEL_SPEC.credKeys,
  keys: EMAIL_DOORBELL_KEYS,
  prefix: EMAIL_CRED_PREFIX,
  nonePrefix: EMAIL_CRED_NONE_PREFIX,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;

function assertVmid(vmid: number): void {
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new Error("Doorbell scripts need a valid vmid.");
}

/**
 * Arms the email doorbell for one computer, while it is still plainly
 * running: reads the settings in the guest, checks they are the ones the
 * owner opted in with (fingerprint), and hands them to the doorbell, which
 * answers once it has the INBOX baseline. Prints one HIVRA_DOORBELL_ARM line
 * (never a credential), or one HIVRA_IDLE_REFUSED line.
 */
export function buildEmailDoorbellArmHostScript(input: {
  vmid: number;
  bindingTag: string | null;
  armId: string;
  credFp: string;
}): string {
  assertVmid(input.vmid);
  const armId = input.armId.toLowerCase();
  if (!UUID.test(armId) || !FINGERPRINT.test(input.credFp)) throw new Error("Doorbell arm needs an arm id and a fingerprint.");
  return buildGuestCredHandoffHostScript({ vmid: input.vmid, bindingTag: input.bindingTag }, EMAIL_CRED_READ_PROGRAM, {
    // Checked before anything is read from the computer: no doorbell, nothing to hand over.
    preflight: `[ -f ${shellQuote(DOORBELL_SCRIPT)} ] || refuse doorbell_missing
systemctl is-active --quiet ${DOORBELL_UNIT} </dev/null || refuse doorbell_down`,
    command: `/usr/bin/python3 -I -B ${shellQuote(DOORBELL_SCRIPT)} arm-from-guest ${input.vmid} ${shellQuote(armId)} ${shellQuote(input.credFp)}`,
  });
}

export type DoorbellArmResult =
  | { ok: true; uidvalidity: number; uidnext: number; idle: boolean }
  | { ok: false; reason: string };

const REASON = /^[a-z0-9_]{1,40}$/;

/** The one line of JSON after `prefix` in a host script's output, or null (none, several, or not an object). */
export function doorbellAnswerLine(stdout: string, prefix: string): Record<string, unknown> | null {
  const lines = String(stdout ?? "").split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0].slice(prefix.length));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseDoorbellArmOutput(stdout: string, expected: { vmid: number; armId: string }): DoorbellArmResult {
  const answer = doorbellAnswerLine(stdout, DOORBELL_ARM_PREFIX);
  if (!answer) return { ok: false, reason: parseIdleProbeRefusal(stdout) ?? "no_answer" };
  if (answer.ok !== true) {
    return { ok: false, reason: typeof answer.error === "string" && REASON.test(answer.error) ? answer.error : "refused" };
  }
  const { uidvalidity, uidnext } = answer;
  if (answer.vmid !== expected.vmid || answer.arm_id !== expected.armId.toLowerCase()
    || !Number.isSafeInteger(uidvalidity) || !Number.isSafeInteger(uidnext)) {
    return { ok: false, reason: "bad_answer" };
  }
  return { ok: true, uidvalidity: uidvalidity as number, uidnext: uidnext as number, idle: answer.idle === true };
}

/**
 * Takes one computer's doorbell arm down (only that arm: an older arm id never
 * removes a newer one). Touches no VM. A host without the doorbell has
 * nothing armed and answers absent.
 */
export function buildDoorbellDisarmHostScript(input: { vmid: number; armId: string | null }): string {
  assertVmid(input.vmid);
  const armId = input.armId?.toLowerCase() ?? null;
  if (armId !== null && !UUID.test(armId)) throw new Error("Doorbell disarm needs a valid arm id.");
  const request = JSON.stringify({ cmd: "disarm", vmid: input.vmid, ...(armId ? { arm_id: armId } : {}) });
  return `set -euo pipefail
if [ ! -f ${shellQuote(DOORBELL_SCRIPT)} ]; then
  printf '${DOORBELL_DISARM_PREFIX}%s\\n' '{"ok":true,"was":"absent"}'
  exit 0
fi
OUT="$(printf '%s\\n' ${shellQuote(request)} | /usr/bin/python3 -I -B ${shellQuote(DOORBELL_SCRIPT)} ctl 2>/dev/null)" || true
[ -n "$OUT" ] || OUT='{"ok":false,"error":"unreachable"}'
printf '${DOORBELL_DISARM_PREFIX}%s\\n' "$OUT"
`;
}

export function parseDoorbellDisarmOutput(stdout: string): { ok: boolean; was: string | null } {
  const answer = doorbellAnswerLine(stdout, DOORBELL_DISARM_PREFIX);
  if (!answer || answer.ok !== true) return { ok: false, was: null };
  return { ok: true, was: typeof answer.was === "string" && REASON.test(answer.was) ? answer.was : null };
}

// ---------------------------------------------------------------------------
// Install, status and remove on a host
// ---------------------------------------------------------------------------

export const DOORBELL_RESULT_MARKER = "HIVRA_DOORBELL_RESULT";
export const DOORBELL_STATUS_MARKER = "HIVRA_DOORBELL_STATUS";

export const DOORBELL_PLACEMENTS = [
  { bundlePath: "hivra-wake-doorbell.py", dest: DOORBELL_SCRIPT, mode: "0644" },
  { bundlePath: "hivra-wake-doorbell.service", dest: `/etc/systemd/system/${DOORBELL_UNIT}`, mode: "0644" },
] as const;
export type DoorbellBundlePath = (typeof DOORBELL_PLACEMENTS)[number]["bundlePath"];
export const DOORBELL_BUNDLE_FILES: readonly DoorbellBundlePath[] = DOORBELL_PLACEMENTS.map((entry) => entry.bundlePath);

const SHA256_RE = /^[0-9a-f]{64}$/;
const TARGET_RE = /^[a-z][a-z0-9_]{0,62}$/;
const VERSION_RE = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}$/;

function assertTarget(targetId: string): void {
  if (!TARGET_RE.test(targetId)) throw new Error("Doorbell scripts require an explicit Proxmox host id.");
}

function prelude(targetId: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
EXPECTED_HOSTNAME=${shellQuote(targetId)}
uptime_ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }
STARTED_MS="$(uptime_ms)"
ACTUAL_HOSTNAME="$(hostname -s | tr '[:upper:]' '[:lower:]')"
[ "$ACTUAL_HOSTNAME" = "$EXPECTED_HOSTNAME" ] \\
  || { echo "doorbell target identity mismatch" >&2; printf '${DOORBELL_RESULT_MARKER} status=failed step=identity changed=0 ms=0\\n'; exit 1; }
LIB_DIR=${shellQuote(DOORBELL_LIB_DIR)}
PY=${shellQuote(DOORBELL_SCRIPT)}
UNIT=${shellQuote(DOORBELL_UNIT)}
# The doorbell's own answer to health, one line of JSON, or nothing.
doorbell_health() { printf '%s\\n' '{"cmd":"health"}' | /usr/bin/python3 -I -B "$PY" ctl 2>/dev/null || true; }
health_field() { /usr/bin/python3 -I -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); v=d.get(sys.argv[2]); print(int(v) if isinstance(v,(bool,int)) else 0)' "$1" "$2" 2>/dev/null || printf '0\\n'; }
`;
}

export interface DoorbellInstallInput {
  targetId: string;
  channel: ManagedHivraProvisionerChannel;
  bundleVersion: string;
  fileDigests: Readonly<Record<DoorbellBundlePath, string>>;
  healthDeadlineSeconds?: number;
}

/**
 * Install (or converge) the doorbell on one host. Needs the wake proxy's
 * helper running there (the doorbell asks it for wakes). Idempotent; any
 * failure after the first change restores the previous files and unit state
 * and prints status=rolled_back. Touches no VM.
 */
export function buildDoorbellInstallScript(input: DoorbellInstallInput): string {
  assertTarget(input.targetId);
  if (!VERSION_RE.test(input.bundleVersion)) throw new Error("Doorbell install needs an exact bundle version.");
  for (const name of DOORBELL_BUNDLE_FILES) {
    if (!SHA256_RE.test(input.fileDigests[name] ?? "")) throw new Error(`Doorbell install has no reviewed digest for ${name}.`);
  }
  const deadline = input.healthDeadlineSeconds ?? 30;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 120) throw new Error("Doorbell health deadline must be 1 to 120 seconds.");
  const bundle = managedHivraProvisionerChannelConfiguration(input.channel).runtime.provisionerDirectory;
  const checks = DOORBELL_PLACEMENTS.map((entry) =>
    `grep -qxF ${shellQuote(`${input.fileDigests[entry.bundlePath]}  ${entry.bundlePath}`)} "$BUNDLE/BUNDLE.sha256" \\
  || { echo ${shellQuote(`bundle manifest does not list the reviewed ${entry.bundlePath}`)} >&2; exit 1; }
[ "$(sha256sum < "$BUNDLE/${entry.bundlePath}" | cut -d' ' -f1)" = ${shellQuote(input.fileDigests[entry.bundlePath])} ] \\
  || { echo ${shellQuote(`bundle file ${entry.bundlePath} does not match its reviewed digest`)} >&2; exit 1; }`).join("\n");
  const placements = DOORBELL_PLACEMENTS.map((entry, index) =>
    `place_file "$BUNDLE/${entry.bundlePath}" ${shellQuote(entry.dest)} ${entry.mode} ${index}`).join("\n");
  return `${prelude(input.targetId)}umask 022
MARK=${shellQuote(DOORBELL_RESULT_MARKER)}
BUNDLE=${shellQuote(bundle)}
EXPECTED_VERSION=${shellQuote(input.bundleVersion)}
STEP=preflight
CHANGED=0
TOUCHED=0
COMMITTED=0
CREATED_USER=0
CREATED_LIB_DIR=0
STAGE=""
WAS_ACTIVE=0
WAS_ENABLED=0
emit() {
  printf '%s status=%s step=%s changed=%s ms=%s\\n' "$MARK" "$1" "$STEP" "$CHANGED" "$(( $(uptime_ms) - STARTED_MS ))"
}
place_file() {
  src="$1"; dest="$2"; mode="$3"; idx="$4"
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s -- "$src" "$dest"; then return 0; fi
  TOUCHED=1
  if [ -e "$dest" ] || [ -L "$dest" ]; then cp -a -- "$dest" "$STAGE/prev.$idx"; fi
  printf '%s\\n' "$dest" > "$STAGE/dest.$idx"
  install -m "$mode" -o root -g root -- "$src" "$dest.hivra-new"
  mv -f -- "$dest.hivra-new" "$dest"
  CHANGED=1
}
restore_files() {
  for marker in "$STAGE"/dest.*; do
    [ -f "$marker" ] || continue
    idx="\${marker##*.}"
    dest="$(cat "$marker")"
    rm -f -- "$dest.hivra-new"
    if [ -e "$STAGE/prev.$idx" ] || [ -L "$STAGE/prev.$idx" ]; then mv -f -- "$STAGE/prev.$idx" "$dest"; else rm -f -- "$dest"; fi
  done
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$COMMITTED" = 1 ]; then [ -z "$STAGE" ] || rm -rf -- "$STAGE"; exit "$status"; fi
  set +e
  [ "$status" != 0 ] || status=1
  if [ "$TOUCHED" = 1 ]; then
    [ "$WAS_ACTIVE" = 1 ] || systemctl stop "$UNIT" 2>/dev/null
    [ "$WAS_ENABLED" = 1 ] || systemctl disable "$UNIT" 2>/dev/null
    restore_files
    systemctl daemon-reload
    [ "$WAS_ENABLED" = 0 ] || systemctl enable "$UNIT" 2>/dev/null
    [ "$WAS_ACTIVE" = 0 ] || systemctl restart "$UNIT"
    if [ "$CREATED_LIB_DIR" = 1 ]; then rmdir -- "$LIB_DIR" 2>/dev/null; fi
    if [ "$CREATED_USER" = 1 ]; then userdel hivra-doorbell 2>/dev/null; fi
    emit rolled_back
  else
    emit failed
  fi
  [ -z "$STAGE" ] || rm -rf -- "$STAGE"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for tool in python3 systemctl sha256sum flock install cmp mktemp getent useradd awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "doorbell install needs $tool" >&2; exit 1; }
done
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra allocation lock" >&2; exit 1; }
STEP=bundle
[ -d "$BUNDLE" ] && [ -f "$BUNDLE/BUNDLE.sha256" ] || { echo "channel bundle directory is missing" >&2; exit 1; }
(cd "$BUNDLE" && sha256sum -c --status BUNDLE.sha256) || { echo "channel bundle does not match its BUNDLE.sha256" >&2; exit 1; }
[ "$(tr -d '[:space:]' < "$BUNDLE/VERSION")" = "$EXPECTED_VERSION" ] \\
  || { echo "channel bundle is not the expected provisioner version" >&2; exit 1; }
${checks}
python3 -I -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")' "$BUNDLE/hivra-wake-doorbell.py"
STEP=preflight
# The doorbell asks the wake proxy's helper for every wake: without it, an arm would leave a computer deaf.
systemctl is-active --quiet hivra-wake-helper.service || { echo "the wake proxy helper is not running on this host" >&2; exit 1; }
getent group hivra-ingress >/dev/null 2>&1 || { echo "the wake proxy's group is missing on this host" >&2; exit 1; }
systemctl is-active --quiet "$UNIT" && WAS_ACTIVE=1
systemctl is-enabled --quiet "$UNIT" 2>/dev/null && WAS_ENABLED=1
STAGE="$(mktemp -d /root/.hivra-doorbell-install.XXXXXXXX)"
STEP=user
if ! getent passwd hivra-doorbell >/dev/null 2>&1; then
  TOUCHED=1
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hivra-doorbell
  CREATED_USER=1
fi
STEP=files
if [ ! -d "$LIB_DIR" ]; then TOUCHED=1; install -d -m 0755 -o root -g root "$LIB_DIR"; CREATED_LIB_DIR=1; fi
${placements}
STEP=start
if [ "$CHANGED" = 1 ]; then systemctl daemon-reload; fi
if [ "$WAS_ENABLED" = 0 ]; then TOUCHED=1; systemctl enable "$UNIT"; fi
if [ "$CHANGED" = 1 ]; then
  # A restart forgets every credential it held; the doorbell rings for each computer it had armed.
  systemctl restart "$UNIT"
elif [ "$WAS_ACTIVE" = 0 ]; then
  TOUCHED=1
  systemctl start "$UNIT"
fi
STEP=health
health_ok() {
  systemctl is-active --quiet "$UNIT" || return 1
  HEALTH="$(doorbell_health)"
  [ "$(health_field "$HEALTH" ok)" = 1 ] && [ "$(health_field "$HEALTH" helper)" = 1 ]
}
HEALTH_DEADLINE_MS=$(( $(uptime_ms) + ${deadline * 1000} ))
until health_ok; do
  if [ "$(uptime_ms)" -ge "$HEALTH_DEADLINE_MS" ]; then echo "doorbell health check failed (is the wake helper new enough?)" >&2; exit 1; fi
  sleep 0.5
done
COMMITTED=1
if [ "$CHANGED" = 1 ]; then emit installed; else emit unchanged; fi
`;
}

/** Read-only: installed, running, and the doorbell's own counts. Never a credential. */
export function buildDoorbellStatusScript(targetId: string): string {
  assertTarget(targetId);
  return `${prelude(targetId)}INSTALLED=0; [ -f "$PY" ] && INSTALLED=1
ACTIVE="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
HEALTH=""
if [ "$INSTALLED" = 1 ] && [ "$ACTIVE" = active ]; then HEALTH="$(doorbell_health)"; fi
printf '${DOORBELL_STATUS_MARKER} installed=%s active=%s ok=%s armed=%s fired=%s helper=%s credential=%s\\n' \\
  "$INSTALLED" "\${ACTIVE:-unknown}" "$(health_field "$HEALTH" ok)" "$(health_field "$HEALTH" armed)" "$(health_field "$HEALTH" fired)" \\
  "$(health_field "$HEALTH" helper)" "$(health_field "$HEALTH" credential)"
`;
}

export const DOORBELL_ARMS_PREFIX = "HIVRA_DOORBELL_ARMS ";
const MAX_ARMS_BYTES = 256 * 1024;

/**
 * Read-only: every arm the doorbell holds on this host (vmid, arm id, state),
 * as one HIVRA_DOORBELL_ARMS line of JSON. Never a credential. A doorbell
 * that is not installed or does not answer says so in that line.
 */
export function buildDoorbellArmsScript(targetId: string): string {
  assertTarget(targetId);
  return `${prelude(targetId)}if [ ! -f "$PY" ]; then printf '${DOORBELL_ARMS_PREFIX}%s\\n' '{"ok":false,"error":"absent"}'; exit 0; fi
OUT="$(printf '%s\\n' '{"cmd":"status"}' | command timeout -k 2 10 /usr/bin/python3 -I -B "$PY" ctl 2>/dev/null | head -n 1 | head -c ${MAX_ARMS_BYTES})" || true
[ -n "$OUT" ] || OUT='{"ok":false,"error":"unreachable"}'
printf '${DOORBELL_ARMS_PREFIX}%s\\n' "$OUT"
`;
}

export interface DoorbellArm {
  armId: string | null;
  state: string;
}

/**
 * The doorbell's arms by vmid; `{ answered: false }` when it is absent or
 * did not answer (nobody on the host can hear a computer then); null when the
 * script's output cannot be read (nothing is known: try again later).
 */
export function parseDoorbellArms(stdout: string): { answered: true; arms: Map<number, DoorbellArm> } | { answered: false } | null {
  const answer = doorbellAnswerLine(stdout, DOORBELL_ARMS_PREFIX);
  if (!answer) return null;
  if (answer.ok !== true) return { answered: false };
  const vms = answer.vms;
  if (!vms || typeof vms !== "object" || Array.isArray(vms)) return null;
  const arms = new Map<number, DoorbellArm>();
  for (const [key, value] of Object.entries(vms as Record<string, unknown>)) {
    const vmid = Number(key);
    if (!Number.isSafeInteger(vmid) || !value || typeof value !== "object") continue;
    const view = value as Record<string, unknown>;
    const armId = typeof view.arm_id === "string" && UUID.test(view.arm_id) ? view.arm_id : null;
    const state = typeof view.state === "string" && REASON.test(view.state) ? view.state : "unknown";
    arms.set(vmid, { armId, state });
  }
  return { answered: true, arms };
}

/**
 * Remove the doorbell from a host. Refuses while it holds any arm, armed or
 * ringing: a computer asleep on it would lose its only way to hear mail.
 */
export function buildDoorbellRemoveScript(targetId: string): string {
  assertTarget(targetId);
  const files = DOORBELL_PLACEMENTS.map((entry) => shellQuote(entry.dest)).join(" ");
  return `${prelude(targetId)}MARK=${shellQuote(DOORBELL_RESULT_MARKER)}
STEP=preflight
CHANGED=0
emit() {
  printf '%s status=%s step=%s changed=%s ms=%s\\n' "$MARK" "$1" "$STEP" "$CHANGED" "$(( $(uptime_ms) - STARTED_MS ))"
}
trap 'status=$?; trap - EXIT; if [ "$status" != 0 ]; then emit failed; fi; exit "$status"' EXIT
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra allocation lock" >&2; exit 1; }
STEP=dependents
if [ -f "$PY" ] && systemctl is-active --quiet "$UNIT"; then
  HEALTH="$(doorbell_health)"
  if [ "$(health_field "$HEALTH" ok)" != 1 ] || [ "$(health_field "$HEALTH" armed)" != 0 ] || [ "$(health_field "$HEALTH" fired)" != 0 ]; then
    echo "the doorbell holds arms (or cannot say); wake those computers first" >&2
    trap - EXIT
    emit refused
    exit 1
  fi
fi
STEP=stop
if systemctl is-active --quiet "$UNIT" || systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
  CHANGED=1
  systemctl disable --now "$UNIT" 2>/dev/null || systemctl stop "$UNIT"
fi
STEP=files
for path in ${files}; do
  if [ -e "$path" ] || [ -L "$path" ]; then CHANGED=1; rm -f -- "$path"; fi
done
if [ -d "$LIB_DIR" ]; then CHANGED=1; rmdir -- "$LIB_DIR"; fi
systemctl daemon-reload
if getent passwd hivra-doorbell >/dev/null 2>&1; then CHANGED=1; userdel hivra-doorbell; fi
trap - EXIT
if [ "$CHANGED" = 1 ]; then emit removed; else emit absent; fi
`;
}

export interface DoorbellResult {
  status: "installed" | "unchanged" | "rolled_back" | "failed" | "removed" | "absent" | "refused";
  step: string;
  changed: boolean;
  ms: number;
}

export function parseDoorbellResult(stdout: string): DoorbellResult | null {
  const lines = String(stdout ?? "").split("\n").filter((line) => line.startsWith(`${DOORBELL_RESULT_MARKER} `));
  if (lines.length === 0) return null;
  const m = /^HIVRA_DOORBELL_RESULT status=(installed|unchanged|rolled_back|failed|removed|absent|refused) step=([a-z_]{1,20}) changed=([01]) ms=([0-9]{1,9})$/
    .exec(lines[lines.length - 1].trim());
  if (!m) return null;
  return { status: m[1] as DoorbellResult["status"], step: m[2], changed: m[3] === "1", ms: Number(m[4]) };
}

export interface DoorbellStatus {
  installed: boolean;
  active: string;
  ok: boolean;
  armed: number;
  fired: number;
  helper: boolean;
  credential: boolean;
}

export function parseDoorbellStatus(stdout: string): DoorbellStatus | null {
  const line = String(stdout ?? "").split("\n").find((entry) => entry.startsWith(`${DOORBELL_STATUS_MARKER} `));
  const m = line && /^HIVRA_DOORBELL_STATUS installed=([01]) active=([a-z-]{1,20}) ok=([01]) armed=([0-9]{1,6}) fired=([0-9]{1,6}) helper=([01]) credential=([01])$/
    .exec(line.trim());
  if (!m) return null;
  return {
    installed: m[1] === "1", active: m[2], ok: m[3] === "1", armed: Number(m[4]), fired: Number(m[5]),
    helper: m[6] === "1", credential: m[7] === "1",
  };
}
