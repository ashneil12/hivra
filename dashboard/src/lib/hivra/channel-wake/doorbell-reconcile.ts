import "server-only";

// The sweep's check that the host wake doorbell still holds every arm Hivra
// recorded. Rows say armed while the doorbell may have lost the arm: a host
// restart empties its run directory, a remove or a crash loses its memory, a
// ring it gave up on is forgotten. Nothing then hears that sleeping computer.
//
// Once every few minutes per host (one SSH call), for each sleeping agent
// whose doorbell row is armed: the doorbell must hold an arm for its vmid with
// the same arm id, still armed. Anything else (no arm, another arm id, a ring
// in progress or given up, a doorbell that is absent or does not answer)
// wakes the agent. Output that cannot be read changes nothing: the next run
// asks again. Fail toward awake; nothing here ever puts an agent to sleep.

import { log } from "@/lib/logger";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import { buildDoorbellArmsScript, parseDoorbellArms, WAKE_DOORBELL_CHANNELS } from "./doorbell-scripts";
import type { ChannelWakeAgentFacts, ChannelWakeRow } from "./store";

const LOG_SOURCE = "channel-wake-doorbell-reconcile";

/** How often one host's doorbell is asked. */
export const DOORBELL_RECONCILE_INTERVAL_MS = 3 * 60_000;
/** Hosts asked per sweep run. */
export const DOORBELL_RECONCILE_HOSTS_PER_RUN = 4;
/** Time a host call needs; no call starts with less left. */
const HOST_CALL_MS = 20_000;

const ASLEEP = new Set(["napping", "hibernated"]);
const DOORBELL_CHANNELS: ReadonlySet<string> = new Set(WAKE_DOORBELL_CHANNELS);

/** When each host was last asked (per server instance; a cold start only asks sooner). */
const lastAsked = new Map<string, number>();

export interface DoorbellReconcileDeps {
  now: () => number;
  timeLeft: () => number;
  wake: (agentId: string) => void;
  /** Runs the read-only script on the host. Throws, or ok false, when the call itself failed. */
  runOnHost?: (hostId: string, script: string) => Promise<{ ok: boolean; stdout: string }>;
  /** Tests start from a clean slate. */
  lastAsked?: Map<string, number>;
}

async function runOnHostDefault(hostId: string, script: string): Promise<{ ok: boolean; stdout: string }> {
  const { resolveProxmoxTargetConfiguration, runProxmoxHostScript } = await import("@/lib/services/proxmox-instance-service");
  const candidate = resolveProxmoxTargetConfiguration(process.env, hostId);
  const run = await runProxmoxHostScript(script, candidate.env, { timeoutMs: HOST_CALL_MS, maxOutputBytes: 512 * 1024 });
  return { ok: run.ok, stdout: run.stdout };
}

/** Returns the agents it woke. Never throws. */
export async function reconcileDoorbellArms(
  rows: readonly ChannelWakeRow[],
  agents: ReadonlyMap<string, ChannelWakeAgentFacts>,
  deps: DoorbellReconcileDeps,
): Promise<string[]> {
  const asked = deps.lastAsked ?? lastAsked;
  const byHost = new Map<string, Array<{ row: ChannelWakeRow; vmid: number }>>();
  for (const row of rows) {
    if (row.state !== "armed" || !DOORBELL_CHANNELS.has(row.channel)) continue;
    const agent = agents.get(row.agent_id);
    if (!agent || !ASLEEP.has(String(agent.sleep_state)) || agent.status === "stopped") continue;
    if (!Number.isSafeInteger(agent.vmid)) continue;
    const hostId = resolveHivraProxmoxHost(agent.proxmox_host ?? null);
    const list = byHost.get(hostId) ?? [];
    list.push({ row, vmid: agent.vmid as number });
    byHost.set(hostId, list);
  }
  const woke: string[] = [];
  const due = [...byHost.entries()]
    .filter(([hostId]) => deps.now() - (asked.get(hostId) ?? 0) >= DOORBELL_RECONCILE_INTERVAL_MS)
    .slice(0, DOORBELL_RECONCILE_HOSTS_PER_RUN);
  for (const [hostId, entries] of due) {
    if (deps.timeLeft() < HOST_CALL_MS) break;
    asked.set(hostId, deps.now());
    let stdout: string;
    try {
      const run = await (deps.runOnHost ?? runOnHostDefault)(hostId, buildDoorbellArmsScript(hostId));
      stdout = run.stdout;
    } catch {
      continue;
    }
    const parsed = parseDoorbellArms(stdout);
    if (!parsed) continue;
    for (const { row, vmid } of entries) {
      const arm = parsed.answered ? parsed.arms.get(vmid) : undefined;
      const held = Boolean(arm && arm.state === "armed" && (!row.arm_id || arm.armId === row.arm_id.toLowerCase()));
      if (held) continue;
      log.warn("a sleeping agent's doorbell arm is gone; waking it", {
        source: LOG_SOURCE,
        failureType: "channel_wake_doorbell_arm_lost",
        instanceId: row.agent_id,
        channel: row.channel,
        doorbell: parsed.answered ? (arm ? arm.state : "none") : "unreachable",
      });
      if (!woke.includes(row.agent_id)) {
        woke.push(row.agent_id);
        deps.wake(row.agent_id);
      }
    }
  }
  return woke;
}
