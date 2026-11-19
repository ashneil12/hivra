/**
 * Applies memory floors: once a day, for each awake agent with enough
 * measured memory use, sets the VM's balloon minimum to the floor from
 * memory-floor.ts. The host then may take memory above the floor, and only
 * when the host itself is short; while it has room the agent keeps everything.
 *
 * HIVRA_AGENT_MEMORY_FLOORS: unset or anything else does nothing; `dry` only
 * reports what it would set; `on` sets floors; `restore` gives every agent
 * that has a floor its full memory back.
 */
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost, shellQuote } from "@/lib/hivra/proxmox-target";
import { resolveSleepTarget } from "@/lib/hivra/agent-wake";
import { hostCapacityHostFilter } from "@/lib/hivra/capacity/classify";
import { memoryFloorFor } from "@/lib/hivra/capacity/memory-floor";
import { summarizeMemoryUse, type StoredMemoryUse } from "@/lib/hivra/capacity/memory-use";

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

const LOG_SOURCE = "hivra-memory-floors";
export const MEMORY_FLOOR_RESULT_PREFIX = "HIVRA_FLOOR_RESULT ";
/** A floor is only moved when it changes by at least this much, so it does not flap day to day. */
export const MEMORY_FLOOR_MIN_CHANGE_MB = 128;
/** One run changes at most this many VMs. The rest wait for the next run. */
export const MEMORY_FLOOR_MAX_CHANGES = 25;
/** A peak is only trusted while samples still arrive: the last one must be newer than this. */
const SAMPLE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 60_000;
const RUN_BUDGET_MS = 90_000;
const ROW_LIMIT = 2000;

export type MemoryFloorsMode = "off" | "dry" | "on" | "restore";

export function memoryFloorsMode(env: EnvLike = process.env): MemoryFloorsMode {
  const value = env.HIVRA_AGENT_MEMORY_FLOORS?.trim().toLowerCase();
  return value === "dry" || value === "on" || value === "restore" ? value : "off";
}

export type MemoryFloorScriptInput = { vmid: number; bindingTag: string; floorMb: number; expectMemoryMb: number };

/**
 * Sets one VM's balloon minimum. It changes nothing unless the VM carries the
 * agent's binding tag, has exactly the memory the floor was worked out for,
 * has ballooning on, holds no Proxmox lock (a hibernated VM does) and no other
 * Hivra script is working on it. Prints one HIVRA_FLOOR_RESULT line.
 */
export function buildMemoryFloorHostScript(input: MemoryFloorScriptInput): string {
  const whole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (!whole(input.vmid, 100, 999_999_999)) throw new Error("Invalid VMID.");
  if (!/^hivra-bind-[a-f0-9]{32}$/.test(input.bindingTag)) throw new Error("Invalid binding tag.");
  if (!whole(input.expectMemoryMb, 1024, 4_194_304)) throw new Error("Invalid memory.");
  if (!whole(input.floorMb, 1024, input.expectMemoryMb)) throw new Error("Invalid floor.");
  return `set -euo pipefail
VMID=${input.vmid}
EXPECTED_BINDING_TAG=${shellQuote(input.bindingTag)}
FLOOR_MB=${input.floorMb}
EXPECT_MEMORY_MB=${input.expectMemoryMb}
FROM_MB=0
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 30 qm "$@" </dev/null; }
finish() {
  printf '%s{"ok":%s,"vmid":%s,"reason":"%s","from":%s,"to":%s}\\n' ${shellQuote(MEMORY_FLOOR_RESULT_PREFIX)} "$1" "$VMID" "$2" "$FROM_MB" "$3"
  exit 0
}
field() { printf '%s\\n' "$CONFIG" | awk -v key="$1:" '$1==key {print $2; exit}'; }
install -d -m 0755 /run/lock
exec 9>/run/lock/hivra-vm-$VMID.lock
# A sleep, wake or other Hivra script holds the computer: leave it for the next run.
flock -x -n 9 || finish false busy 0
CONFIG="$(qm config "$VMID" 2>/dev/null)" || finish false unreachable 0
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || finish false binding_mismatch 0
[ -z "$(field lock)" ] || finish false locked 0
[ "$(field template)" != 1 ] || finish false template 0
MEMORY="$(field memory)"
[[ "$MEMORY" =~ ^[0-9]+$ ]] && [ "$MEMORY" = "$EXPECT_MEMORY_MB" ] || finish false memory_changed 0
BALLOON="$(field balloon)"
[ -n "$BALLOON" ] || BALLOON="$MEMORY"
[[ "$BALLOON" =~ ^[0-9]+$ ]] || finish false balloon_unreadable 0
# 0 means ballooning was turned off for this VM on purpose.
[ "$BALLOON" != 0 ] || finish false balloon_disabled 0
FROM_MB="$BALLOON"
[ "$BALLOON" != "$FLOOR_MB" ] || finish true unchanged "$FLOOR_MB"
# A floor is what placement reserves for the computer, so it moves under the host's allocation lock.
exec 8>/run/lock/hivra-allocation.lock
flock -w 30 8 || finish false lock_timeout "$BALLOON"
qm set "$VMID" --balloon "$FLOOR_MB" >/dev/null 2>&1 || finish false set_failed "$BALLOON"
CONFIG="$(qm config "$VMID" 2>/dev/null)" || finish false unconfirmed "$BALLOON"
# A change a running VM has not taken yet shows under pending, and the old value stays here.
[ "$(field balloon)" = "$FLOOR_MB" ] || finish false unconfirmed "$BALLOON"
finish true set "$FLOOR_MB"
`;
}

export type MemoryFloorReceipt = { ok: boolean; vmid: number; reason: string; from: number; to: number };

export function parseMemoryFloorReceipt(stdout: string, expectedVmid: number): MemoryFloorReceipt | null {
  const lines = (stdout ?? "").split("\n").filter((line) => line.startsWith(MEMORY_FLOOR_RESULT_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const row = JSON.parse(lines[0].slice(MEMORY_FLOOR_RESULT_PREFIX.length)) as Partial<MemoryFloorReceipt>;
    if (typeof row.ok !== "boolean" || row.vmid !== expectedVmid || typeof row.reason !== "string" || !/^[a-z_]{1,40}$/.test(row.reason)) return null;
    if (!Number.isInteger(row.from) || !Number.isInteger(row.to) || (row.from as number) < 0 || (row.to as number) < 0) return null;
    return row as MemoryFloorReceipt;
  } catch {
    return null;
  }
}

export type MemoryFloorSweepSummary = {
  skipped: boolean;
  reason?: string;
  failed?: boolean;
  mode: MemoryFloorsMode;
  considered: number;
  /** Agents whose floor should move. In `dry` mode nothing is done about them. */
  wanted: number;
  set: number;
  unchanged: number;
  refused: Record<string, number>;
  errors: number;
  /** In `dry` mode: what would be set, numbers only. */
  plan?: Array<{ vmid: number; memoryMb: number; fromMb: number; toMb: number; peakUsedMb: number | null }>;
};

export type MemoryFloorSweepDeps = {
  db?: Db;
  env?: EnvLike;
  now?: () => number;
  runHostScript?: typeof runProxmoxHostScript;
  resolveTarget?: typeof resolveSleepTarget;
};

type UseRow = StoredMemoryUse & { floor_mb: number | null };
type AgentRow = Record<string, unknown> & {
  id: string; vmid: number | null; proxmox_host: string | null; ram: number | null; ram_max: number | null;
  sleep_state: string | null; status: string | null;
};

export async function runMemoryFloorSweep(deps: MemoryFloorSweepDeps = {}): Promise<MemoryFloorSweepSummary> {
  const env = deps.env ?? process.env;
  const mode = memoryFloorsMode(env);
  const summary: MemoryFloorSweepSummary = {
    skipped: false, mode, considered: 0, wanted: 0, set: 0, unchanged: 0, refused: {}, errors: 0,
  };
  if (mode === "off") return { ...summary, skipped: true, reason: "flag_off" };
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ...summary, skipped: true, reason: "no_database" };
  const now = deps.now ?? Date.now;
  const runHostScript = deps.runHostScript ?? runProxmoxHostScript;
  const resolveTarget = deps.resolveTarget ?? resolveSleepTarget;
  const startedAt = now();

  const { data: useData, error: useError } = await db
    .from("hivra_agent_memory_use")
    .select("agent_id, vmid, total_mb, last_used_mb, first_sample_at, last_sample_at, days, floor_mb")
    .order("agent_id", { ascending: true })
    .limit(ROW_LIMIT);
  if (useError) return { ...summary, failed: true, errors: 1, reason: "memory_use_query_failed" };
  const useRows = ((useData ?? []) as UseRow[]).filter((row) => mode !== "restore" || row.floor_mb !== null);
  if (useRows.length === 0) return summary;

  const { data: agentData, error: agentError } = await db
    .from("hivra_agents")
    .select("*")
    .eq("deployment_mode", "hivra-managed")
    .eq("computer_substrate", "proxmox-kvm")
    .is("deployment_target_id", null)
    .eq("status", "running")
    .in("id", useRows.map((row) => row.agent_id));
  if (agentError) return { ...summary, failed: true, errors: 1, reason: "agents_query_failed" };
  const agents = new Map(((agentData ?? []) as AgentRow[]).map((row) => [row.id, row]));
  const onlyHosts = hostCapacityHostFilter(env);
  const refuse = (reason: string) => { summary.refused[reason] = (summary.refused[reason] ?? 0) + 1; };
  if (mode === "dry") summary.plan = [];

  let changes = 0;
  for (const use of useRows) {
    const agent = agents.get(use.agent_id);
    if (!agent || agent.vmid !== use.vmid) continue;
    if (onlyHosts && !onlyHosts.has(resolveHivraProxmoxHost(agent.proxmox_host).toLowerCase())) continue;
    // A sleeping computer is left alone: its own scripts hold it, and a hibernated one cannot take the change.
    if ((agent.sleep_state ?? "awake") !== "awake") continue;
    summary.considered += 1;

    // The VM's memory is its maximum (ram_max, GB) when one is set, else ram (GB), as the capacity sweep reads it.
    const memoryMb = Math.round(Math.max(Number(agent.ram) || 0, Number(agent.ram_max) || 0) * 1024);
    if (memoryMb < 1024) continue;
    const current = use.floor_mb ?? memoryMb;
    const measured = summarizeMemoryUse(use, now());
    const fresh = now() - Date.parse(use.last_sample_at) <= SAMPLE_MAX_AGE_MS;
    const wanted = mode === "restore" || !fresh
      ? memoryMb
      : memoryFloorFor({ memoryMb, ...measured }).floorMb;
    if (wanted < 1024 || wanted > memoryMb) continue;
    // A raise is never held back. A cut smaller than the step is not worth a change.
    if (wanted === current || (wanted < current && current - wanted < MEMORY_FLOOR_MIN_CHANGE_MB)) {
      summary.unchanged += 1;
      continue;
    }
    summary.wanted += 1;
    if (mode === "dry") {
      summary.plan?.push({ vmid: use.vmid, memoryMb, fromMb: current, toMb: wanted, peakUsedMb: measured.peakUsedMb });
      continue;
    }
    if (changes >= MEMORY_FLOOR_MAX_CHANGES || now() - startedAt > RUN_BUDGET_MS) { refuse("next_run"); continue; }
    changes += 1;

    let receipt: MemoryFloorReceipt | null = null;
    try {
      const resolved = await resolveTarget(agent, LOG_SOURCE);
      if (!resolved.ok) { refuse(`target_${resolved.code}`); continue; }
      const target = resolved.target;
      if (!target.bindingTag || target.vmid !== use.vmid) { refuse("binding_not_enforced"); continue; }
      const script = buildMemoryFloorHostScript({ vmid: target.vmid, bindingTag: target.bindingTag, floorMb: wanted, expectMemoryMb: memoryMb });
      const run = await runHostScript(script, target.env, { timeoutMs: SCRIPT_TIMEOUT_MS });
      receipt = parseMemoryFloorReceipt(run?.stdout ?? "", target.vmid);
    } catch {
      receipt = null;
    }
    if (!receipt) {
      summary.errors += 1;
      log.warn("memory floors: no receipt from the host", { source: LOG_SOURCE, failureType: "memory_floor_no_receipt", instanceId: use.agent_id });
      continue;
    }
    if (!receipt.ok) { refuse(receipt.reason); continue; }
    if (receipt.reason === "set") summary.set += 1; else summary.unchanged += 1;
    const { error: writeError } = await db
      .from("hivra_agent_memory_use")
      .update({ floor_mb: wanted === memoryMb ? null : wanted, floor_set_at: new Date(now()).toISOString() })
      .eq("agent_id", use.agent_id);
    if (writeError) summary.errors += 1;
    log.info("memory floors: floor set", {
      source: LOG_SOURCE, instanceId: use.agent_id, fromMb: receipt.from, toMb: receipt.to, memoryMb, peakUsedMb: measured.peakUsedMb,
    });
  }
  return summary;
}
