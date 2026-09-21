import {
  runProxmoxHostScript,
  resolveProxmoxHostEnv,
  resolveProxmoxOperationEnv,
  type HostScriptResult,
  type ProxmoxHostRoutingConfig,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";

/**
 * Wake-admission control.
 *
 * Before starting (waking) a paused/stopped agent, check the host has enough
 * headroom. This guard is the prerequisite called out before scale-to-zero can
 * be mass-enabled AND before any reactivation campaign points dormant users at
 * their box URLs: when many parked agents wake at once, a bare `qm start` with
 * no admission check risks OOM-ing the host.
 *
 * Two layers, checked in ONE host round-trip by `acquireHostWakeSlot`:
 *
 *   1. Concurrency: at most N wakes may be in-flight per host at a time
 *      (marker files under /run/hermes-wake-slots with a short TTL — a wake
 *      completes in ~70-90s, so slots self-expire; no DB table needed and the
 *      host is the natural serialization point across serverless lambdas).
 *   2. RAM: the host must have the VM's RAM + a 512 MB margin available.
 *
 * FAIL-OPEN: if the capacity probe errors, can't run, or its output can't be
 * parsed, the wake is allowed (never block a legitimate start on a flaky
 * probe). A wake is deferred ONLY when the host positively measured
 * insufficient headroom — and deferrals are retryable 429s, not failures.
 */

type EnvLike = Record<string, string | undefined>;

const WAKE_RAM_SAFETY_MARGIN_MB = 512;
export const DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST = 2;
/** Minutes before an in-flight wake slot marker self-expires on the host.
 *  Must comfortably cover the ~70-90s wake-in-place window. */
const WAKE_SLOT_TTL_MINUTES = 2;
/** Suggested client retry delay when a wake is deferred. One TTL window is
 *  guaranteed to free at least one slot, so ~half of it is a good cadence. */
export const WAKE_DEFER_RETRY_AFTER_SECONDS = 30;

const WAKE_ADMISSION_MARKER = "HERMES_WAKE_ADMISSION";
const WAKE_SLOT_DIR = "/run/hermes-wake-slots";

type WakeAdmissionDeferReason = "concurrency" | "host_ram";

export type WakeAdmissionDecision =
  | {
      admitted: true;
      freeMb: number | null;
      activeWakes: number | null;
    }
  | {
      admitted: false;
      reason: WakeAdmissionDeferReason;
      freeMb: number | null;
      activeWakes: number | null;
      cap: number;
      retryAfterSeconds: number;
    };

/** Per-host concurrent-wake cap. Env-tunable for ops without a deploy. */
export function resolveMaxConcurrentWakesPerHost(env: EnvLike): number {
  const raw = env.HERMES_WAKE_MAX_CONCURRENT_PER_HOST?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(parsed, 20);
    }
  }
  return DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST;
}

/**
 * Normalize a hermes_instances.ram_limit value to MB for admission math.
 * The column canonically stores MB (tier-specs ramLimitMb, e.g. 1024), but
 * tolerate small legacy GB values; missing/invalid falls back to the free-tier
 * 1024 MB so admission never under-reserves to zero.
 */
export function normalizeWakeRamMb(ramLimit: unknown): number {
  const raw = Number(ramLimit);
  if (Number.isFinite(raw) && raw > 0) {
    return raw < 128 ? Math.floor(raw * 1024) : Math.floor(raw);
  }
  return 1024;
}

function sanitizeSlotKey(instanceId: string): string {
  const cleaned = instanceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned || "unknown-instance";
}

/**
 * Build the host-side admission script. Single round-trip that atomically
 * (best-effort mkdir mutex — no inheritable fd, mirroring the provisioning
 * lock style) prunes expired slots, counts in-flight wakes, checks free RAM,
 * and either claims a slot or reports a deferral on stdout.
 *
 * Output contract (one line, parsed by `parseWakeAdmissionOutput`):
 *   HERMES_WAKE_ADMISSION ADMIT active=<n> cap=<n> free_mb=<n|na>
 *   HERMES_WAKE_ADMISSION DEFER reason=concurrency active=<n> cap=<n> free_mb=<n|na>
 *   HERMES_WAKE_ADMISSION DEFER reason=host_ram active=<n> cap=<n> free_mb=<n> need_mb=<n>
 */
export function buildWakeAdmissionScript(params: {
  instanceId: string;
  neededRamMb: number;
  cap: number;
}): string {
  const slotKey = sanitizeSlotKey(params.instanceId);
  const needMb = Math.max(0, Math.floor(params.neededRamMb));
  const cap = Math.max(1, Math.floor(params.cap));

  return `#!/usr/bin/env bash
set -u
NEED_MB=${needMb}
CAP=${cap}
SLOT_KEY='${slotKey}'
SLOT_DIR='${WAKE_SLOT_DIR}'
mkdir -p "$SLOT_DIR"

# Best-effort mutex around the count-and-claim. mkdir (not flock) so no fd can
# leak into child processes; a lock older than a minute is a dead holder.
LOCK_DIR="$SLOT_DIR/.lock.d"
find "$SLOT_DIR" -maxdepth 1 -name '.lock.d' -mmin +1 -exec rm -rf {} + 2>/dev/null || true
HAVE_LOCK=0
for _ in $(seq 1 50); do
  if mkdir "$LOCK_DIR" 2>/dev/null; then HAVE_LOCK=1; break; fi
  sleep 0.1
done
cleanup() { if [ "$HAVE_LOCK" = "1" ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi; }
trap cleanup EXIT

# Expire slots past the TTL — a wake-in-place completes in ~70-90s, so any
# older marker is a finished (or dead) wake, not an in-flight one.
find "$SLOT_DIR" -maxdepth 1 -name '*.slot' -mmin +${WAKE_SLOT_TTL_MINUTES} -delete 2>/dev/null || true

FREE_MB="$(free -m | awk '/^Mem:/ {print $7}')"
# Exclude our own marker so an instance retrying its own wake is never queued
# behind itself.
ACTIVE="$(find "$SLOT_DIR" -maxdepth 1 -name '*.slot' ! -name "$SLOT_KEY.slot" 2>/dev/null | wc -l | tr -d ' ')"

if [ "\${ACTIVE:-0}" -ge "$CAP" ] 2>/dev/null; then
  echo "${WAKE_ADMISSION_MARKER} DEFER reason=concurrency active=$ACTIVE cap=$CAP free_mb=\${FREE_MB:-na}"
  exit 0
fi
if [ -n "\${FREE_MB:-}" ] && [ "$FREE_MB" -lt "$((NEED_MB + ${WAKE_RAM_SAFETY_MARGIN_MB}))" ] 2>/dev/null; then
  echo "${WAKE_ADMISSION_MARKER} DEFER reason=host_ram active=$ACTIVE cap=$CAP free_mb=$FREE_MB need_mb=$NEED_MB"
  exit 0
fi

touch "$SLOT_DIR/$SLOT_KEY.slot"
echo "${WAKE_ADMISSION_MARKER} ADMIT active=$ACTIVE cap=$CAP free_mb=\${FREE_MB:-na}"
`;
}

export interface ParsedWakeAdmission {
  verdict: "admit" | "defer";
  reason?: WakeAdmissionDeferReason;
  activeWakes: number | null;
  cap: number | null;
  freeMb: number | null;
}

/** Parse the admission script's marker line. Returns null when the output is
 *  missing/garbled — callers treat that as fail-open. */
export function parseWakeAdmissionOutput(stdout: string): ParsedWakeAdmission | null {
  const line = (stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${WAKE_ADMISSION_MARKER} `));
  if (!line) return null;

  const parts = line.split(/\s+/);
  const verdictToken = parts[1];
  if (verdictToken !== "ADMIT" && verdictToken !== "DEFER") return null;

  const kv: Record<string, string> = {};
  for (const token of parts.slice(2)) {
    const eq = token.indexOf("=");
    if (eq > 0) kv[token.slice(0, eq)] = token.slice(eq + 1);
  }
  const num = (key: string): number | null => {
    const parsed = Number.parseInt(kv[key] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (verdictToken === "ADMIT") {
    return { verdict: "admit", activeWakes: num("active"), cap: num("cap"), freeMb: num("free_mb") };
  }

  const reason =
    kv.reason === "host_ram" ? "host_ram" : kv.reason === "concurrency" ? "concurrency" : null;
  if (!reason) return null; // unknown deferral shape → fail-open at the caller
  return { verdict: "defer", reason, activeWakes: num("active"), cap: num("cap"), freeMb: num("free_mb") };
}

function resolveWakeAdmissionEnv(
  infrastructure: Pick<ProxmoxInfrastructure, "node">,
  params: { hostConfig?: ProxmoxHostRoutingConfig | null; env?: EnvLike },
): EnvLike {
  const baseEnv = params.env ?? process.env;
  return params.hostConfig
    ? resolveProxmoxHostEnv(params.hostConfig, baseEnv)
    : resolveProxmoxOperationEnv(baseEnv, infrastructure);
}

/**
 * Hermes-lane wake admission: claim an in-flight wake slot on the instance's
 * PVE host, enforcing the per-host concurrency cap and the free-RAM gate in a
 * single SSH round-trip. Mirrors `startProxmoxInstance`'s host/env resolution
 * so it always lands on the same host the start will.
 *
 * FAIL-OPEN by contract (see module docs).
 */
export async function acquireHostWakeSlot(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  params: {
    instanceId: string;
    neededRamMb: number;
    hostConfig?: ProxmoxHostRoutingConfig | null;
    env?: EnvLike;
    runHostScript?: (script: string) => Promise<HostScriptResult>;
  },
): Promise<WakeAdmissionDecision> {
  try {
    const env = resolveWakeAdmissionEnv(infrastructure, params);
    const cap = resolveMaxConcurrentWakesPerHost(env);
    const script = buildWakeAdmissionScript({
      instanceId: params.instanceId,
      neededRamMb: params.neededRamMb,
      cap,
    });
    const runner =
      params.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
    const result = await runner(script);
    const parsed = parseWakeAdmissionOutput(result?.stdout ?? "");
    if (!parsed) {
      return { admitted: true, freeMb: null, activeWakes: null }; // fail-open
    }
    if (parsed.verdict === "admit") {
      return { admitted: true, freeMb: parsed.freeMb, activeWakes: parsed.activeWakes };
    }
    return {
      admitted: false,
      reason: parsed.reason as WakeAdmissionDeferReason,
      freeMb: parsed.freeMb,
      activeWakes: parsed.activeWakes,
      cap: parsed.cap ?? cap,
      retryAfterSeconds: WAKE_DEFER_RETRY_AFTER_SECONDS,
    };
  } catch {
    return { admitted: true, freeMb: null, activeWakes: null }; // fail-open
  }
}

/**
 * Free this instance's wake slot early (best-effort). Called when the start
 * fails outright so an immediate retry isn't queued behind a corpse; slots
 * self-expire after WAKE_SLOT_TTL_MINUTES regardless.
 */
export async function releaseHostWakeSlot(
  infrastructure: Pick<ProxmoxInfrastructure, "vmid" | "node">,
  params: {
    instanceId: string;
    hostConfig?: ProxmoxHostRoutingConfig | null;
    env?: EnvLike;
    runHostScript?: (script: string) => Promise<HostScriptResult>;
  },
): Promise<void> {
  try {
    const env = resolveWakeAdmissionEnv(infrastructure, params);
    const slotKey = sanitizeSlotKey(params.instanceId);
    const script = `rm -f '${WAKE_SLOT_DIR}/${slotKey}.slot' 2>/dev/null || true; echo released`;
    const runner =
      params.runHostScript ?? ((hostScript: string) => runProxmoxHostScript(hostScript, env));
    await runner(script);
  } catch {
    // Best-effort — the TTL prune is the backstop.
  }
}

/**
 * Legacy single-check RAM gate (Hivra catalog lane). Kept as-is for the
 * existing callers in /api/hivra/agents; the Hermes lane uses
 * `acquireHostWakeSlot` which folds this check into the slot claim.
 *
 * FAIL-OPEN: if the capacity probe errors or can't be parsed, the wake is
 * allowed (never block a legitimate start on a flaky probe). `ok` is false
 * ONLY when we positively measured insufficient free RAM.
 */
export async function checkHostWakeCapacity(
  neededRamMb: number,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; freeMb: number | null }> {
  try {
    // `free -m` column 7 (/^Mem:/) is "available" memory.
    const r = await runProxmoxHostScript(`free -m | awk '/^Mem:/ {print $7}'`, env);
    const freeMb = parseInt((r.stdout || "").trim(), 10);
    if (!Number.isFinite(freeMb)) return { ok: true, freeMb: null }; // fail-open
    // Keep a 512 MB safety margin above the agent's need.
    return { ok: freeMb >= neededRamMb + WAKE_RAM_SAFETY_MARGIN_MB, freeMb };
  } catch {
    return { ok: true, freeMb: null }; // fail-open
  }
}
