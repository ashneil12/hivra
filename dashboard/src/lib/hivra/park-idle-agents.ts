import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";

/**
 * Hivra idle-park sweep — the Hivra-lane analogue of the Hermes
 * capacity-pressure sweep (which only ever touches `hermes_instances`).
 *
 * A Hivra signup provisions a full VM, and a large fraction of signups never
 * open the box — leaving a 1GB+ guest running forever and saturating the host
 * (the fixturenodea RAM exhaustion that stranded new provisions). This parks those
 * boxes the same way the product's own "Stop" button does: graceful
 * `qm shutdown` (RAM freed, disk/login/chats preserved), status -> 'stopped'.
 * The owner clicks Start in HivraManage to wake it on demand (the start path
 * has its own host-RAM admission gate).
 *
 * SAFETY — only ever parks GENUINELY-IDLE, NON-AUTONOMOUS boxes:
 *   - first_usage_at IS NULL: the owner never opened it.
 *   - type is an INTERACTIVE CLI kind (claude-code/codex): does nothing without
 *     a human at the keyboard. Autonomous kinds (aeon — runs goals on its own)
 *     are NEVER parked here, because "never opened" != "doing nothing" for them.
 *   - aged past a floor (default 7d) so a fresh signup mid-onboarding is safe.
 * Reversible by design, and opt-in (HIVRA_IDLE_PARK_ENABLED) like every sweeper.
 */

// Interactive CLI kinds: no autonomous loop, so never-opened == doing nothing.
// Deliberately EXCLUDES aeon (and any web-dashboard/autonomous kind).
export const PARKABLE_INTERACTIVE_KINDS = ["claude-code", "codex"] as const;

// Release fuse: this legacy sweep predates durable provider-operation leases
// and stable VM binding tags. Keep candidate preview available, but never let
// cron mutate a VM until it is migrated onto the shared authority contract.
const IDLE_PARK_PROVIDER_MUTATION_ENABLED = false;

const LOG_SOURCE = "park-idle-hivra-agents";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isIdleParkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HIVRA_IDLE_PARK_ENABLED?.trim().toLowerCase() === "true";
}

interface IdleAgentRow {
  id: string;
  user_id: string;
  type: string;
  vmid: number | null;
  proxmox_host: string | null;
  created_at: string;
}

type ParkAction = "parked" | "would_park" | "failed" | "skipped_no_vmid";

interface ParkIdleResult {
  agentId: string;
  vmid: number | null;
  host: string | null;
  action: ParkAction;
  idleDays: number;
  error?: string;
}

export interface ParkIdleHivraSummary {
  enabled: boolean;
  dryRun: boolean;
  scanned: number;
  parked: number;
  failed: number;
  results: ParkIdleResult[];
}

export interface ParkIdleHivraOptions {
  /** Force a no-op preview even when enabled (the cron passes ?dryRun=1). */
  dryRun?: boolean;
  /** Override the per-run cap (defaults to HIVRA_IDLE_PARK_MAX_PER_RUN or 25). */
  limit?: number;
}

function idleDaysSince(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((nowMs - t) / 86_400_000);
}

// Graceful first (mirrors the HivraManage Stop action), hard-stop fallback. The
// `|| true` keeps a transient host hiccup from failing the whole sweep.
function buildParkScript(vmid: number): string {
  return `qm shutdown ${vmid} --timeout 40 2>/dev/null || qm stop ${vmid} 2>/dev/null || true; echo parked`;
}

export async function runParkIdleHivraAgentsSweep(
  opts: ParkIdleHivraOptions = {},
): Promise<ParkIdleHivraSummary> {
  const enabled = isIdleParkEnabled();
  const requestedDryRun = opts.dryRun ?? !enabled;
  const dryRun = requestedDryRun || !IDLE_PARK_PROVIDER_MUTATION_ENABLED;
  const minIdleDays = envInt("HIVRA_IDLE_PARK_MIN_DAYS", 7);
  const cap = Math.max(1, opts.limit ?? envInt("HIVRA_IDLE_PARK_MAX_PER_RUN", 25));
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - minIdleDays * 86_400_000).toISOString();

  const summary: ParkIdleHivraSummary = {
    enabled,
    dryRun,
    scanned: 0,
    parked: 0,
    failed: 0,
    results: [],
  };

  if (enabled && !requestedDryRun && !IDLE_PARK_PROVIDER_MUTATION_ENABLED) {
    log.warn("idle Hivra park mutation is disabled until CAS authority migration", {
      source: LOG_SOURCE,
      failureType: "hivra_idle_park_authority_disabled",
    });
  }

  if (!supabaseAdmin) {
    log.error("supabase admin client unavailable; cannot park idle Hivra agents", new Error("supabaseAdmin missing"), {
      source: LOG_SOURCE,
      failureType: "supabase_admin_unavailable",
    });
    return summary;
  }

  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, user_id, type, vmid, proxmox_host, created_at")
    .eq("status", "running")
    // Managed-fleet policy must never park a VM on user-owned infrastructure.
    .is("deployment_target_id", null)
    .is("first_usage_at", null)
    .in("type", PARKABLE_INTERACTIVE_KINDS as unknown as string[])
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(cap);

  if (error) {
    log.error("failed to load idle Hivra park candidates", error, {
      source: LOG_SOURCE,
      failureType: "park_candidate_query_failed",
    });
    return summary;
  }

  const rows = (data ?? []) as IdleAgentRow[];
  summary.scanned = rows.length;

  for (const row of rows) {
    const idleDays = idleDaysSince(row.created_at, nowMs);
    if (!row.vmid) {
      summary.results.push({ agentId: row.id, vmid: null, host: row.proxmox_host, action: "skipped_no_vmid", idleDays });
      continue;
    }
    if (dryRun) {
      summary.results.push({ agentId: row.id, vmid: row.vmid, host: row.proxmox_host, action: "would_park", idleDays });
      continue;
    }

    try {
      const env = resolveProxmoxTargetConfiguration(process.env, resolveHivraProxmoxHost(row.proxmox_host)).env;
      const r = await runProxmoxHostScript(buildParkScript(row.vmid), env);
      if (!r.ok) throw new Error(r.error || "park script failed");

      // Only flip a row that is still `running` — never clobber a status a
      // concurrent lifecycle action (the owner clicking Start) just set.
      const { data: flipped } = await supabaseAdmin
        .from("hivra_agents")
        .update({ status: "stopped" })
        .eq("id", row.id)
        .eq("status", "running")
        .select("id");

      if (flipped && flipped.length > 0) {
        await logHivraAgentEvent({
          userId: row.user_id,
          event: "stopped",
          agentId: row.id,
          agentType: row.type,
          detail: { by: "cron", reason: "idle_park_unused", idleDays },
        });
        summary.parked += 1;
        summary.results.push({ agentId: row.id, vmid: row.vmid, host: row.proxmox_host, action: "parked", idleDays });
      } else {
        // Row moved out of `running` under us — leave it, the VM is stopped.
        summary.results.push({ agentId: row.id, vmid: row.vmid, host: row.proxmox_host, action: "skipped_no_vmid", idleDays });
      }
    } catch (e) {
      summary.failed += 1;
      summary.results.push({
        agentId: row.id,
        vmid: row.vmid,
        host: row.proxmox_host,
        action: "failed",
        idleDays,
        error: e instanceof Error ? e.message : String(e),
      });
      log.error("failed to park idle Hivra agent", e instanceof Error ? e : new Error(String(e)), {
        source: LOG_SOURCE,
        failureType: "park_action_failed",
        agentId: row.id,
        vmid: row.vmid,
        proxmoxHost: row.proxmox_host,
      });
    }
  }

  log.info("park-idle-hivra-agents sweep complete", {
    source: LOG_SOURCE,
    enabled,
    dryRun,
    minIdleDays,
    scanned: summary.scanned,
    parked: summary.parked,
    failed: summary.failed,
  });
  return summary;
}
