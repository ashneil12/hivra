/**
 * Apply pending per-instance cap changes by redeploying the container.
 *
 * applyTierChange writes new cpu_limit/ram_limit to the DB and sets
 * `tier_change_pending = true` on any instance whose caps changed. Because the
 * caps are baked into the container's compose `deploy.resources.limits`, the
 * new compute only reaches the agent after a container recreate — for BOTH
 * Hetzner and Proxmox (the qm-set only raises the VM ceiling, not the
 * container cgroup). This module performs that recreate via the existing,
 * volume-safe `applyLiveUpdate` (the same path used for fleet :stable rollouts
 * — it keeps the named webui-state / agent-source volumes, so no data loss),
 * then clears the flag.
 *
 * Two callers: the instant wallet-unlock flow (a user's own instances) and the
 * apply-pending-resizes cron (background sweep).
 */

import "server-only";

import { clerkClient } from "@clerk/nextjs/server";

import { extractGlobalHermesSettings } from "@/lib/instance-settings";
import {
  applyLiveUpdate,
  resolveInstanceIpv4,
  type InstanceRowForOrchestration,
} from "@/lib/services/instance-orchestrator";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { isWebfreeBackend } from "@/lib/types/instance";

const LOG_SOURCE = "pending-resize";

/** Columns redeploy (applyLiveUpdate / resolveInstanceIpv4) needs. */
export const PENDING_RESIZE_SELECT = [
  "id",
  "user_id",
  "name",
  "status",
  "backend",
  "provider",
  "subdomain",
  "hetzner_server_id",
  "gateway_url",
  "api_key_encrypted",
  "api_server_key_encrypted",
  "honcho_api_key_encrypted",
  "config",
  "host_id",
  "ipv4_address",
  "cpu_limit",
  "ram_limit",
  "infrastructure_provider",
  "proxmox_vmid",
].join(", ");

export type PendingResizeRow = InstanceRowForOrchestration & {
  name?: string | null;
  backend?: string | null;
};

interface PendingResizeResult {
  id: string;
  redeployed: boolean;
  skipped?: boolean;
  error?: string;
}

export interface PendingResizeSummary {
  redeployed: number;
  failed: number;
  skipped: number;
  results: PendingResizeResult[];
}

function createSettingsCache(): (userId: string) => Promise<Record<string, unknown>> {
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  return (userId: string) => {
    const hit = cache.get(userId);
    if (hit) return hit;
    const promise = (async () => {
      try {
        const clerk = await clerkClient();
        const user = await clerk.users.getUser(userId);
        return extractGlobalHermesSettings(user.publicMetadata);
      } catch (err) {
        log.warn("pending resize: clerk metadata unavailable", {
          source: LOG_SOURCE,
          userId,
          failureType: "pending_resize_clerk_unavailable",
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return {};
      }
    })();
    cache.set(userId, promise);
    return promise;
  };
}

async function redeployOne(
  row: PendingResizeRow,
  getSettings: (userId: string) => Promise<Record<string, unknown>>,
): Promise<PendingResizeResult> {
  if (!supabaseAdmin) return { id: row.id, redeployed: false, error: "db_unavailable" };

  // Only webfree-backed instances have the applyLiveUpdate recreate path.
  if (!isWebfreeBackend(row.backend)) {
    return { id: row.id, redeployed: false, skipped: true, error: "non_webfree_backend" };
  }

  let ipv4 = "";
  try {
    ipv4 = await resolveInstanceIpv4(row, supabaseAdmin);
  } catch {
    ipv4 = "";
  }
  if (!ipv4) {
    return { id: row.id, redeployed: false, error: "no_reachable_ip" };
  }

  const settings = await getSettings(row.user_id);
  const update = await applyLiveUpdate(row, ipv4, settings, supabaseAdmin);
  if (!update.applied) {
    log.warn("pending resize redeploy failed", {
      source: LOG_SOURCE,
      instanceId: row.id,
      userId: row.user_id,
      failureType: "pending_resize_redeploy_failed",
    });
    return { id: row.id, redeployed: false, error: "redeploy_failed" };
  }

  // Container now carries the new caps — clear the flag. Best-effort: if the
  // clear fails the next sweep simply redeploys again (idempotent).
  const { error: clearErr } = await supabaseAdmin
    .from("hermes_instances")
    .update({ tier_change_pending: false })
    .eq("id", row.id);
  if (clearErr) {
    log.warn("pending resize flag clear failed", {
      source: LOG_SOURCE,
      instanceId: row.id,
      failureType: "pending_resize_flag_clear_failed",
    });
  }

  log.info("pending resize applied", {
    source: LOG_SOURCE,
    instanceId: row.id,
    userId: row.user_id,
  });
  return { id: row.id, redeployed: true };
}

/**
 * Redeploy the given instances to apply their pending caps, clearing the flag
 * on success. Processed in bounded-concurrency waves so a sweep stays inside
 * the function time budget.
 */
export async function redeployPendingResizes(
  rows: PendingResizeRow[],
  opts: { concurrency?: number } = {},
): Promise<PendingResizeSummary> {
  const getSettings = createSettingsCache();
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const results: PendingResizeResult[] = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const wave = rows.slice(i, i + concurrency);
    // allSettled, not all: redeployOne guards resolveInstanceIpv4 and the Clerk
    // lookup, but NOT applyLiveUpdate — which throws on an undecryptable
    // api_key_encrypted (decryptApiKey rethrows), a Bankr/DB hiccup, or an SSH
    // timeout. Under Promise.all one such row rejects the whole wave, so this
    // function rejects, the apply-pending-resizes cron's unguarded `await`
    // 500s the tick, and the backlog ops event meant to escalate the failure
    // never fires — the crash silences the alarm that should report it.
    //
    // That was self-sustaining, not just a lost tick: tier_change_pending only
    // clears on SUCCESS, so a throwing row is re-selected every tick forever,
    // and the sweep is ordered idle-first (last_activity_at ASC NULLS FIRST) —
    // an unreachable box IS idle, so the poison sorts to the FRONT and lands in
    // wave 1, re-poisoning every batch. Paid cap upgrades behind it never land.
    // Turn a rejection into a normal failed result and keep sweeping.
    const settled = await Promise.allSettled(wave.map((row) => redeployOne(row, getSettings)));
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        return;
      }
      const row = wave[index];
      log.error("pending resize redeploy threw", outcome.reason, {
        source: LOG_SOURCE,
        instanceId: row.id,
        userId: row.user_id,
        failureType: "pending_resize_unexpected_throw",
        errorName: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
      });
      results.push({ id: row.id, redeployed: false, error: "redeploy_threw" });
    });
  }
  return {
    redeployed: results.filter((r) => r.redeployed).length,
    failed: results.filter((r) => !r.redeployed && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
}
