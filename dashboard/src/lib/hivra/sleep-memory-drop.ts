import "server-only";

import { log } from "@/lib/logger";
import type { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { sleepMemoryDropAfterDays } from "./agent-sleep-policy";
import { buildMemoryDropHostScript, parseMemoryDropReceipt } from "./agent-sleep-scripts";
import { readHivraAgentRow, resolveSleepTarget } from "./agent-wake";
import { resolveHivraProxmoxHost } from "./proxmox-target";

/**
 * Long sleepers: an agent in deep sleep for days (HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS)
 * gives the disk space of its saved memory back to the host. Its own disk stays,
 * so nothing of the owner's is lost; the next wake boots it from disk, which
 * takes longer than a restore.
 *
 * The host script acts only on a computer that is off with saved memory, under
 * the same per-computer lock as sleep and wake, so no lease is taken here: a
 * wake that arrives first wins, and one that arrives after boots the computer
 * from its disk. Off unless the setting holds a number of days.
 */

const LOG_SOURCE = "sleep-memory-drop";

/** An agent that was looked at is not looked at again for this long, whatever came of it. */
export const MEMORY_DROP_COOLDOWN_MS = 6 * 60 * 60_000;
export const MEMORY_DROP_MAX_PER_RUN = 2;
const MEMORY_DROP_SCAN_LIMIT = 20;
const MEMORY_DROP_SCRIPT_TIMEOUT_MS = 90_000;

const cooldowns = new Map<string, number>();
export function resetSleepMemoryDropCooldowns(): void {
  cooldowns.clear();
}

export interface MemoryDropCounts {
  candidates: number;
  dropped: number;
  /** Not in deep sleep any more, or another script holds the computer. */
  refused: number;
  failed: number;
}

export interface SleepMemoryDropInput {
  db: NonNullable<typeof supabaseAdmin>;
  env: Record<string, string | undefined>;
  now: () => number;
  /** No host call starts unless it can finish before this. */
  deadline: number;
  /** Whether sleep acts on this host at all. */
  hostActs: (host: string) => boolean;
}

/** Null when the setting is off. */
export async function runSleepMemoryDrops(
  input: SleepMemoryDropInput,
): Promise<{ counts: MemoryDropCounts; errors: number } | null> {
  const days = sleepMemoryDropAfterDays(input.env.HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS);
  if (days === null) return null;
  const counts: MemoryDropCounts = { candidates: 0, dropped: 0, refused: 0, failed: 0 };
  let errors = 0;
  const problem = (message: string, error: unknown, failureType: string) => {
    errors += 1;
    log.error(message, error instanceof Error ? error : new Error(JSON.stringify(error)), { source: LOG_SOURCE, failureType });
  };

  const cutoff = new Date(input.now() - days * 86_400_000).toISOString();
  const { data, error } = await input.db.rpc("hivra_sleep_memory_drop_candidates", {
    p_cutoff: cutoff,
    p_limit: MEMORY_DROP_SCAN_LIMIT,
  });
  if (error) {
    problem("failed to load memory drop candidates", error, "sleep_memory_drop_query_failed");
    return { counts, errors };
  }
  const candidates = ((data ?? []) as Array<{ id: string; proxmox_host: string | null }>)
    .filter((row) => input.hostActs(resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null)))
    .map((row) => String(row.id))
    .filter((id) => (cooldowns.get(id) ?? 0) <= input.now());
  counts.candidates = candidates.length;

  for (const agentId of candidates.slice(0, MEMORY_DROP_MAX_PER_RUN)) {
    if (input.deadline - input.now() < MEMORY_DROP_SCRIPT_TIMEOUT_MS) break;
    cooldowns.set(agentId, input.now() + MEMORY_DROP_COOLDOWN_MS);
    try {
      const row = await readHivraAgentRow(agentId);
      if (!row || row.status !== "running" || row.sleep_state !== "hibernated" || row.operation_id) {
        counts.refused += 1;
        continue;
      }
      const resolved = await resolveSleepTarget(row, LOG_SOURCE);
      if (!resolved.ok) {
        counts.refused += 1;
        continue;
      }
      const target = resolved.target;
      const run = await runProxmoxHostScript(
        buildMemoryDropHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }),
        target.env,
        { timeoutMs: MEMORY_DROP_SCRIPT_TIMEOUT_MS },
      );
      const receipt = parseMemoryDropReceipt(run?.stdout ?? "", target.vmid);
      if (!receipt?.ok) {
        const reason = receipt?.reason ?? "no_receipt";
        if (reason === "busy" || reason === "not_hibernated") counts.refused += 1;
        else {
          counts.failed += 1;
          errors += 1;
        }
        log.warn("saved memory of a long sleeper was not dropped", {
          source: LOG_SOURCE,
          failureType: "sleep_memory_drop_failed",
          instanceId: agentId,
          reason,
        });
        continue;
      }
      // Recorded only while it is still the same deep sleep.
      const { error: updateError } = await input.db
        .from("hivra_agents")
        .update({ sleep_memory_dropped_at: new Date(input.now()).toISOString() })
        .eq("id", agentId)
        .eq("sleep_state", "hibernated");
      if (updateError) problem("failed to record a memory drop", updateError, "sleep_memory_drop_record_failed");
      counts.dropped += 1;
      log.info("saved memory of a long sleeper dropped; its disk is kept", {
        source: LOG_SOURCE,
        instanceId: agentId,
        afterDays: days,
      });
    } catch (caught) {
      counts.failed += 1;
      problem("memory drop failed unexpectedly", caught, "sleep_memory_drop_error");
    }
  }
  return { counts, errors };
}
