import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
  isProxmoxVmStillRunningResult,
  shutdownProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { reportOpsEvent } from "@/lib/ops-events";

const LOG_SOURCE = "inactivity-sweep";

const FREE_TIER_VALUES = ["credit_base"] as const;
// $HERMES token holders were promised a 30-day idle grace. They sat in
// FREE_TIER_VALUES and were swept at 4 days like any free box, which is how the
// token_base cohort got paused -> reclaimed -> cold-archived down to zero active
// instances. They get their own tier group and their own threshold.
const TOKEN_TIER_VALUES = ["token_base"] as const;
const PAID_TIER_VALUES = ["operator", "fleet", "command"] as const;

const FREE_TIER_IDLE_DAYS_DEFAULT = 4;
const TOKEN_TIER_IDLE_DAYS_DEFAULT = 30;
const SWEEP_BATCH_LIMIT = 50;

// How stale the agent-side probe may be before we declare activity UNKNOWN.
// harvest-agent-usage runs hourly; 36h tolerates a long-but-recoverable harvest
// outage before the sweep stops pausing entirely. Beyond that we would be
// guessing, and guessing wrong destroys a customer's agent.
const AGENT_PROBE_MAX_AGE_HOURS_DEFAULT = 36;

type SweepCandidate = {
  id: string;
  user_id: string;
  resource_tier: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  last_activity_at: string;
  created_at: string | null;
  last_lifecycle_transition_at: string | null;
  // Newest non-cron message the agent's own state.db has seen (Telegram, Discord,
  // standalone WebUI, TUI). Written by harvest-agent-usage.
  last_agent_activity_at: string | null;
  // When that state.db was last read successfully. NULL/stale => activity unknown.
  last_agent_probe_at: string | null;
};

// One DB scan per distinct idle window. Grouping by cutoff (rather than one wide
// scan) keeps SWEEP_BATCH_LIMIT meaningful per tier — a 30-day token window and a
// 4-day free window cannot starve each other's batch.
type TierGroup = {
  tiers: readonly string[];
  idleDays: number;
  cutoffIso: string;
};

export type InactivitySweepSummary = {
  scanned: number;
  swept: number;
  failed: number;
  skipped: number;
  vmMissing: number;
  // Candidates spared because instance_usage_snapshots showed agent-side
  // (Telegram/Discord/standalone-webui) sessions inside the idle window even
  // though last_activity_at looked stale.
  agentActive: number;
  // Candidates spared because their agent-side activity could NOT be determined
  // (harvest never probed them, or the probe is stale). Fail-safe: unknown never
  // means idle.
  activityUnknown: number;
  // Candidates spared because a messaging channel (Telegram/Discord) is connected
  // and the agent has no recorded activity watermark — we cannot prove they are
  // idle, and dashboard silence means nothing for a channel user.
  channelGuarded: number;
  freeIdleDays: number;
  tokenIdleDays: number;
  /** null = paid tiers exempt from the sweep (the default). */
  paidIdleDays: number | null;
  enabled: boolean;
  // True when the pause loop stopped early on its wall-clock budget. The
  // candidate selection (which VMs) is UNCHANGED — this only bounds how many of
  // the already-selected batch we pause this run. The unpaused tail stays
  // lifecycle_state='active' and is re-selected next hourly tick, so the sweep
  // still makes forward progress and never skips a VM, it just spreads a slow
  // batch across runs.
  timedOut: boolean;
};

type PauseOutcome =
  | "paused"
  | "vm_missing"
  | "not_proxmox_backed"
  | "raced"
  // The pre-shutdown re-read could not establish that we know what this agent has
  // been doing. Never pause on an unknown signal.
  | "activity_unknown";

function readPositiveIntEnv(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Paid tiers are EXEMPT from the inactivity sweep unless an idle window is
// explicitly configured. "Always-on — never paused for inactivity" is a paid
// differentiator surfaced in plans.ts and the lifecycle emails, so pausing a
// paying customer's agent must be a deliberate env opt-in, not a default.
function readPaidIdleDays(): number | null {
  const raw = process.env.HERMES_INACTIVITY_PAID_DAYS?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readProbeMaxAgeMs(): number {
  return (
    readPositiveIntEnv(
      "HERMES_INACTIVITY_PROBE_MAX_AGE_HOURS",
      AGENT_PROBE_MAX_AGE_HOURS_DEFAULT
    ) *
    60 *
    60 *
    1000
  );
}

// Positive evidence that we know what this agent has been doing. The harvester
// stamps last_agent_probe_at every time it reads the box's state.db — including
// when the box is genuinely idle. So a MISSING or STALE probe means the activity
// signal is blind for this instance, not that the instance is dormant.
//
// This distinction is the whole point. instance_usage_snapshots stores nothing at
// all for an idle agent, so "no usage rows" is produced identically by a quiet
// agent and by a harvester that has been broken for a week (which is exactly what
// the 2026-06-07 webfree migration did to it, silently, fleet-wide).
//
// FAIL-SAFE INVARIANT: this returning false must always mean "spare", never "pause".
// Callers may not invert it. Until the harvester has stamped a box we cannot
// distinguish a dormant agent from an unreachable one, and pausing the second kind
// is what cold-archived agents that were serving their owner daily.
function hasFreshAgentProbe(
  probedAtIso: string | null | undefined,
  nowMs: number,
  maxAgeMs: number
): boolean {
  const probedAt = parseTime(probedAtIso);
  return probedAt !== null && nowMs - probedAt <= maxAgeMs;
}

function isSweepEnabled(): boolean {
  return (
    process.env.HERMES_INACTIVITY_SWEEP_ENABLED?.trim().toLowerCase() === "true"
  );
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

// Dormancy is judged on GENUINE USER activity only.
//
// last_activity_at is the DASHBOARD-mediated user-activity signal — written by
// real user actions routed through this app (chat / responses / terminal /
// webui-login / user lifecycle actions / settings; see instance-activity.ts
// INSTANCE_USER_ACTIVITY_SOURCES), including wake-on-access.
//
// last_agent_activity_at is the AGENT-SIDE signal: the newest non-cron message in
// the box's own state.db, harvested hourly. It is the only anchor that sees a user
// who talks to their agent exclusively over Telegram, Discord, or the box's own
// standalone web UI. Those users generate ZERO dashboard activity; before this
// anchor existed they read as perfectly idle and were paused at 4 days, reclaimed
// at 7, and cold-archived 48h later while their agent was serving them daily.
// Cron/standing-task sessions are excluded at harvest time so a scheduled job
// cannot masquerade as a human.
//
// created_at is the floor for instances that have never had activity of either
// kind (freshly provisioned), so a brand-new box is never paused before its owner
// has had a chance to use it.
//
// last_lifecycle_transition_at is deliberately NOT an anchor: it is bumped by
// PLATFORM maintenance (redeploys, reconciles, migrations, archive/retention
// sweeps) as well as by user actions, so counting it as "activity" lets a
// single fleet-wide maintenance pass reset every instance's idle clock and
// starve the sweep. That is exactly what happened on 2026-06-08 — the webfree
// migration touched ~599 idle instances and the sweep then paused nothing for
// days. User-initiated transitions (e.g. resume) already bump last_activity_at,
// so ignoring it here loses no genuine user signal.
function getMostRecentActivityAnchor(candidate: SweepCandidate): number | null {
  const anchors = [
    parseTime(candidate.last_activity_at),
    parseTime(candidate.last_agent_activity_at),
    parseTime(candidate.created_at),
  ].filter((value): value is number => value !== null);

  return anchors.length > 0 ? Math.max(...anchors) : null;
}

function isConfirmedDormant(candidate: SweepCandidate, cutoffIso: string): boolean {
  const cutoff = parseTime(cutoffIso);
  const mostRecentAnchor = getMostRecentActivityAnchor(candidate);
  return cutoff !== null && mostRecentAnchor !== null && mostRecentAnchor < cutoff;
}

// Agent-side usage is the SECOND activity signal the sweep consults, corroborating
// last_agent_activity_at. The harvest-agent-usage cron reads each agent's own
// state.db and lands per-UTC-day session counts in instance_usage_snapshots; a row
// with sessions>0 on a stat_date inside the idle window is proof of genuine
// agent-side use.
//
// Returns instanceId -> newest stat_date with sessions>0, so each candidate can be
// judged against ITS OWN cutoff. (Querying once against the widest window and
// treating every hit as "active" would spare a 4-day free box on a session it ran
// 29 days ago, once token_base widened the window to 30 days.)
//
// Note this signal keys on the day a session STARTED, so it cannot see a long-lived
// Telegram thread opened before the window and used inside it. last_agent_activity_at
// is the anchor that closes that gap; this stays as corroboration and as the signal
// that already covers history harvested before the new columns existed.
//
// A query error fails CLOSED (see runInactivitySweep): it skips the whole pause pass
// rather than risk pausing an actively-used-over-Telegram agent on a blind signal.
async function fetchLatestAgentUsageByInstance(
  instanceIds: string[],
  earliestCutoffIso: string
): Promise<
  { ok: true; latestByInstance: Map<string, string> } | { ok: false; error: string }
> {
  const supabase = supabaseAdmin;
  if (!supabase) return { ok: false, error: "Database not configured" };
  if (instanceIds.length === 0) return { ok: true, latestByInstance: new Map() };

  // stat_date is a DATE (UTC day); compare against the cutoff's calendar day so an
  // agent that ran any session on the cutoff day still counts as active.
  const cutoffDay = earliestCutoffIso.slice(0, 10);

  const { data, error } = await supabase
    .from("instance_usage_snapshots")
    .select("instance_id, stat_date")
    .in("instance_id", instanceIds)
    .gt("sessions", 0)
    .gte("stat_date", cutoffDay);

  if (error) {
    return { ok: false, error: error.message };
  }

  const latestByInstance = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    instance_id: string;
    stat_date: string;
  }>) {
    const current = latestByInstance.get(row.instance_id);
    // stat_date is a zero-padded ISO calendar day, so lexicographic max == newest.
    if (!current || row.stat_date > current) {
      latestByInstance.set(row.instance_id, row.stat_date);
    }
  }
  return { ok: true, latestByInstance };
}

// Instances whose owner has wired up a messaging channel (Telegram today, Discord
// as it lands). channel_connections rows are per-instance for the Hermes lane
// (target_kind='hermes', target_id == hermes_instances.id) and are upsert-only, so
// presence means "this user has, at some point, chosen to talk to this agent
// somewhere other than the dashboard". For those instances dashboard silence
// carries no information at all.
//
// target_kind is filtered explicitly (as in seed-standing-tasks.ts): target_id is a
// plain text column shared with the hivra lane, so the kind is what makes the id
// unambiguous rather than an accident of uuid non-collision.
//
// Fails CLOSED for the same reason the usage query does: if we cannot tell who is
// channel-connected we must not pause anybody.
async function fetchChannelConnectedInstanceIds(
  instanceIds: string[]
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: string }> {
  const supabase = supabaseAdmin;
  if (!supabase) return { ok: false, error: "Database not configured" };
  if (instanceIds.length === 0) return { ok: true, ids: new Set() };

  const { data, error } = await supabase
    .from("channel_connections")
    .select("target_id")
    .eq("target_kind", "hermes")
    .in("target_id", instanceIds);

  if (error) {
    return { ok: false, error: error.message };
  }

  const ids = new Set(
    (data ?? [])
      .map((row: { target_id: string | null }) => row.target_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  return { ok: true, ids };
}

async function fetchSweepCandidates(
  tiers: readonly string[],
  cutoffIso: string
): Promise<SweepCandidate[]> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  // lifecycle_state='active' is deliberately strict: the sweep only pauses
  // genuinely-active rows. It is also the blind-spot that lets the
  // "paused-but-running" drift persist — a row a host reboot brought back up
  // still reads lifecycle_state='paused', so the sweep can never re-pause it
  // and it accumulates idle time invisibly. The fix is NOT to widen this filter
  // (matching paused rows here would race a legitimate pause and risk
  // double-shutdown); it's the fleet-status-reconcile cron, which flips a
  // confirmed-running paused row back to active, RE-ARMING it so this query
  // picks it up on the next cycle and pauses it again (now with onboot:0).
  //
  // The `.or()` on last_agent_activity_at pushes the agent-side anchor down into
  // the SELECT rather than filtering it out in memory afterwards. That matters
  // because SWEEP_BATCH_LIMIT caps the batch at 50: a fleet where 50 Telegram-only
  // users have stale DASHBOARD activity would otherwise fill every batch with rows
  // that get spared in memory, and genuinely-dormant boxes would never be reached.
  // NULL is deliberately kept in the candidate set (rather than excluded as
  // "unknown") so the in-memory fail-safe — not this query — decides what to do
  // with an unprobed instance, and so its skip is COUNTED and logged instead of
  // silently vanishing from `scanned`.
  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, resource_tier, proxmox_node, proxmox_vmid, host_id, config, last_activity_at, created_at, last_lifecycle_transition_at, last_agent_activity_at, last_agent_probe_at"
    )
    .eq("lifecycle_state", "active")
    .in("resource_tier", Array.from(tiers))
    .lt("last_activity_at", cutoffIso)
    .or(
      `last_agent_activity_at.is.null,last_agent_activity_at.lt.${cutoffIso}`
    )
    .limit(SWEEP_BATCH_LIMIT);

  if (error) {
    throw new Error(
      `Failed to load inactivity sweep candidates: ${error.message}`
    );
  }

  return (data ?? []) as SweepCandidate[];
}

async function pauseInstance(
  candidate: SweepCandidate,
  cutoffIso: string,
  probe: { nowMs: number; maxAgeMs: number }
): Promise<PauseOutcome> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  // Re-validate immediately before the (irreversible) qm shutdown. The
  // candidate snapshot was taken earlier in the batch; a user resume or fresh
  // activity may have landed since. Acting on the stale snapshot would shut
  // down a VM the user just brought back online. This shrinks the TOCTOU
  // window from the whole batch duration to the few ms before the shutdown.
  const cutoffMs = new Date(cutoffIso).getTime();
  const { data: current, error: recheckError } = await supabase
    .from("hermes_instances")
    .select(
      "lifecycle_state, last_activity_at, last_agent_activity_at, last_agent_probe_at"
    )
    .eq("id", candidate.id)
    .maybeSingle();
  if (recheckError) {
    throw new Error(
      `Failed to re-validate instance ${candidate.id} before pause: ${recheckError.message}`
    );
  }
  if (
    !current ||
    current.lifecycle_state !== "active" ||
    (current.last_activity_at &&
      new Date(current.last_activity_at).getTime() >= cutoffMs) ||
    // A Telegram/Discord message landing mid-batch is a resume too. The harvester
    // may have moved the agent-side watermark since selection; re-read it and back off.
    (current.last_agent_activity_at &&
      new Date(current.last_agent_activity_at).getTime() >= cutoffMs)
  ) {
    // Resumed or active again since selection — leave it alone.
    return "raced";
  }

  // LAST FAIL-SAFE before the irreversible shutdown. Everything above proves the
  // instance LOOKS idle; this proves we were actually in a position to see it.
  // The batch-level gate already checked the candidate snapshot, but the harvest
  // could have gone stale between selection and now (a long batch of slow SSH
  // shutdowns spans minutes), and a re-read is the only way to notice. If the
  // freshly-read row has no fresh probe, we do not know what this agent has been
  // doing and we must not shut it down. Silence is not idleness.
  if (!hasFreshAgentProbe(current.last_agent_probe_at, probe.nowMs, probe.maxAgeMs)) {
    return "activity_unknown";
  }

  const infra =
    getProxmoxInfrastructure(candidate.config) ??
    (candidate.proxmox_vmid && candidate.proxmox_node
      ? ({
          provider: "proxmox" as const,
          node: candidate.proxmox_node,
          vmid: candidate.proxmox_vmid,
          privateIpv4: "",
          gatewayHost: "",
        } satisfies ProxmoxInfrastructure)
      : null);

  if (!infra) {
    // Hetzner-backed agent (legacy single-tenant box) — those paths
    // already have their own lifecycle handling and don't participate
    // in pve packing. Skip rather than ssh-shutdown a customer box.
    return "not_proxmox_backed";
  }

  const result = await shutdownProxmoxInstance(infra, {
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
      host_id: candidate.host_id,
    }),
    // Clear onboot so a HOST reboot doesn't auto-start the VM we just paused.
    // Every VM is provisioned onboot:1, so without this the hypervisor brings
    // paused free-tier agents back up on the next host reboot while the DB row
    // still reads stopped — the "paused-but-running" drift the
    // fleet-status-reconcile cron exists to mop up. Clearing it at the source
    // is the structural fix; the reconciler is the safety net. Best-effort
    // (|| true in the host script): a failed `qm set` never blocks the pause.
    setOnboot: 0,
  });

  if (isProxmoxVmMissingResult(result)) {
    // The VM was destroyed out from under us (typically Phase 2 bootstrap
    // cleanup after a failed provision). qm shutdown on a missing VM
    // returns exit 64 via our power script. Mark the row failed so the
    // sweep stops retrying it and the user sees a clear re-create path.
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("hermes_instances")
      .update(buildInstanceLifecyclePatch("error", { now: nowIso }))
      .eq("id", candidate.id);

    if (updateError) {
      throw new Error(
        `Failed to mark missing-VM instance ${candidate.id} as failed: ${updateError.message}`
      );
    }
    return "vm_missing";
  }

  if (isProxmoxVmStillRunningResult(result)) {
    // The shutdown script verified the guest is STILL running after both a
    // graceful `qm shutdown` and a hard `qm stop`. Writing paused/stopped now
    // would mint exactly the paused-but-running ghost the reconciler exists to
    // clean up, so we refuse the DB write and surface a failure. The sweep
    // retries next tick; a genuinely-wedged VM is left for ops.
    throw new Error(
      `Proxmox VM ${infra.vmid} on ${infra.node} did not power off (still running after qm shutdown + qm stop); skipping pause to avoid a paused-but-running ghost`
    );
  }

  if (!result.ok) {
    throw new Error(
      result.error ||
        result.stderr ||
        "Proxmox graceful shutdown returned non-zero"
    );
  }

  // Conditional write: only stamp 'paused' if the row is still the active,
  // idle row we shut down. If a resume landed in the tiny window after the
  // recheck, this affects 0 rows — we do NOT clobber the user's resume.
  //
  // The VM is already stopped, so a row left active-but-stopped DOES recover,
  // but not the way this comment used to claim. recover-unhealthy-active does
  // NOT restart it: that cron calls applyLiveUpdate, which SSHes into the guest
  // and never `qm start`s it, so against a powered-off VM it can only burn its
  // SSH readiness budget and fail. The actual recovery is that failure flipping
  // the row to lifecycle_state='failed', which is what finally makes
  // recover-stuck-instances (the cron that does `qm start`) eligible to pick it
  // up. That detour is expensive and noisy — an error-level ops event and a
  // ~75s SSH session per tick — so it is a backstop, NOT a licence to leave the
  // pause write unreliable. The 2026-07-16 42703 (#593) is what proved the cost:
  // the shutdown landed, this write didn't, and ~33 free-tier boxes ground
  // through that loop hourly for a week.
  //
  // The agent-side watermark is guarded here as well as in the recheck: a harvest
  // landing a fresh Telegram message between the recheck and this write is the
  // same "the user came back" event as a dashboard resume, and the row must not be
  // labelled paused/inactivity when we now have proof it was in use.
  const { data: pausedRows, error: updateError } = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      paused_reason: "inactivity",
      status: "stopped",
      last_lifecycle_transition_at: new Date().toISOString(),
    })
    .eq("id", candidate.id)
    .eq("lifecycle_state", "active")
    .lt("last_activity_at", cutoffIso)
    .or(
      `last_agent_activity_at.is.null,last_agent_activity_at.lt.${cutoffIso}`
    )
    // last_agent_activity_at MUST stay in this projection because the .or()
    // above references it. On a mutation that asks for a representation back,
    // PostgREST resolves `or=` against the RETURNING projection rather than the
    // base table, so a column filtered on but not selected raises
    //   42703 column hermes_instances.last_agent_activity_at does not exist
    // even though the column plainly exists. That is what broke this write from
    // 2026-07-09 (#525) to 2026-07-16: the shutdown above had already run, the
    // pause never got stamped, the row stayed active with a stopped VM, and
    // recover-unhealthy-active-instances restarted it — an hourly
    // stop/fail/restart loop across ~33 free-tier boxes. The plain .eq()/.lt()
    // filters resolve against the base table and are unaffected, which is why
    // only the .or() column is implicated. Verified against prod PostgREST: the
    // or= still correctly restricts which rows are UPDATED (it is not merely a
    // filter on what comes back), so the race guard's semantics are intact.
    .select("id, last_agent_activity_at");

  if (updateError) {
    throw new Error(
      `Failed to mark instance ${candidate.id} as paused: ${updateError.message}`
    );
  }
  if (!pausedRows || pausedRows.length === 0) {
    return "raced";
  }
  return "paused";
}

export async function runInactivitySweep(
  options: { now?: Date; timeBudgetMs?: number; clock?: () => number } = {}
): Promise<InactivitySweepSummary> {
  const now = options.now ?? new Date();
  // Wall-clock budget for the pause loop. Each pause SSHes the pve host
  // (qm shutdown, graceful timeout) so a batch of slow shutdowns can run past
  // the function ceiling and get SIGKILLed mid-pause. When set, we stop starting
  // NEW pauses a margin under maxDuration; the unpaused remainder is picked up
  // next tick. CONSERVATIVE: this does NOT change candidate selection — same
  // VMs, same thresholds, same filters — it only caps how many of the selected
  // batch we pause per run. Default null = unbounded (preserves existing
  // behavior for callers/tests that don't pass a budget).
  const clock = options.clock ?? Date.now;
  const deadline =
    typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0
      ? clock() + options.timeBudgetMs
      : null;
  const freeIdleDays = readPositiveIntEnv(
    "HERMES_INACTIVITY_FREE_DAYS",
    FREE_TIER_IDLE_DAYS_DEFAULT
  );
  const tokenIdleDays = readPositiveIntEnv(
    "HERMES_INACTIVITY_TOKEN_DAYS",
    TOKEN_TIER_IDLE_DAYS_DEFAULT
  );
  const paidIdleDays = readPaidIdleDays();

  if (!isSweepEnabled()) {
    log.warn("inactivity sweep is disabled", {
      source: LOG_SOURCE,
      reason: "explicit_opt_in_required",
      optInEnv: "HERMES_INACTIVITY_SWEEP_ENABLED",
    });
    return {
      scanned: 0,
      swept: 0,
      failed: 0,
      skipped: 0,
      vmMissing: 0,
      agentActive: 0,
      activityUnknown: 0,
      channelGuarded: 0,
      freeIdleDays,
      tokenIdleDays,
      paidIdleDays,
      enabled: false,
      timedOut: false,
    };
  }

  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const probeMaxAgeMs = readProbeMaxAgeMs();
  const nowMs = now.getTime();
  const cutoffFor = (idleDays: number): string =>
    new Date(nowMs - idleDays * 24 * 60 * 60 * 1000).toISOString();

  // One group per distinct idle window. token_base gets a 30-day grace (the promise
  // made to $HERMES holders); credit_base keeps 4 days; paid tiers stay exempt
  // unless HERMES_INACTIVITY_PAID_DAYS opts them in.
  const tierGroups: TierGroup[] = [
    {
      tiers: FREE_TIER_VALUES,
      idleDays: freeIdleDays,
      cutoffIso: cutoffFor(freeIdleDays),
    },
    {
      tiers: TOKEN_TIER_VALUES,
      idleDays: tokenIdleDays,
      cutoffIso: cutoffFor(tokenIdleDays),
    },
    ...(paidIdleDays === null
      ? []
      : [
          {
            tiers: PAID_TIER_VALUES,
            idleDays: paidIdleDays,
            cutoffIso: cutoffFor(paidIdleDays),
          },
        ]),
  ];

  const groupCandidates = await Promise.all(
    tierGroups.map((group) => fetchSweepCandidates(group.tiers, group.cutoffIso))
  );

  // idleDays rides along purely so the logs say which window a box was judged
  // against — the only way to confirm in prod that a token_base row was measured
  // on 30 days and not the 4-day free window.
  const taggedCandidates = tierGroups.flatMap((group, index) =>
    groupCandidates[index].map((candidate) => ({
      candidate,
      cutoffIso: group.cutoffIso,
      idleDays: group.idleDays,
    }))
  );
  let swept = 0;
  let failed = 0;
  let skipped = 0;
  let vmMissing = 0;
  let agentActive = 0;
  let activityUnknown = 0;
  let channelGuarded = 0;

  const candidateIds = taggedCandidates.map(({ candidate }) => candidate.id);

  // Corroborating activity gate: spare any candidate that shows agent-side sessions
  // inside ITS OWN idle window. The widest window (largest idleDays => oldest
  // cutoff) bounds every group's window, so one read against that cutoff covers all
  // candidates; each is then compared against its own group's cutoff.
  //
  // Fail CLOSED: if the usage table can't be read, skip the whole pause pass rather
  // than pause an agent that's actively used over Telegram on a blind
  // dashboard-only signal.
  const earliestCutoff = tierGroups.reduce(
    (oldest, group) => (group.cutoffIso < oldest ? group.cutoffIso : oldest),
    tierGroups[0].cutoffIso
  );

  const [agentUsage, channelConnected] = await Promise.all([
    fetchLatestAgentUsageByInstance(candidateIds, earliestCutoff),
    fetchChannelConnectedInstanceIds(candidateIds),
  ]);

  // Either signal being unreadable blinds the sweep in a way that could only be
  // resolved by pausing on guesswork. Both abort the whole pass, loudly.
  const abortBlind = async (
    signal: string,
    error: string
  ): Promise<InactivitySweepSummary> => {
    log.error(
      "inactivity sweep aborting: could not read an activity signal",
      new Error(error),
      {
        source: LOG_SOURCE,
        failureType: "inactivity_sweep_agent_usage_unreadable",
        signal,
        scanned: taggedCandidates.length,
      }
    );
    try {
      await reportOpsEvent({
        source: LOG_SOURCE,
        title: "inactivity_sweep_agent_usage_unreadable",
        message: `inactivity sweep skipped: activity signal (${signal}) was unreadable; failing closed to avoid pausing actively-used agents`,
        severity: "warn",
        metadata: { error, signal, scanned: taggedCandidates.length },
      });
    } catch {
      // best-effort
    }
    return {
      scanned: taggedCandidates.length,
      swept: 0,
      failed: 0,
      skipped: taggedCandidates.length,
      vmMissing: 0,
      agentActive: 0,
      activityUnknown: 0,
      channelGuarded: 0,
      freeIdleDays,
      tokenIdleDays,
      paidIdleDays,
      enabled: true,
      timedOut: false,
    };
  };

  if (!agentUsage.ok) {
    return abortBlind("instance_usage_snapshots", agentUsage.error);
  }
  if (!channelConnected.ok) {
    return abortBlind("channel_connections", channelConnected.error);
  }

  const latestAgentUsage = agentUsage.latestByInstance;
  const channelConnectedIds = channelConnected.ids;
  let timedOut = false;

  for (const { candidate, cutoffIso, idleDays } of taggedCandidates) {
    if (!isConfirmedDormant(candidate, cutoffIso)) {
      skipped += 1;
      log.info("inactivity sweep skipped recently touched instance", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        resourceTier: candidate.resource_tier,
        proxmoxNode: candidate.proxmox_node,
        lastActivityAt: candidate.last_activity_at,
        lastAgentActivityAt: candidate.last_agent_activity_at,
        createdAt: candidate.created_at,
        lastLifecycleTransitionAt: candidate.last_lifecycle_transition_at,
        cutoffIso,
      });
      continue;
    }

    // FAIL-SAFE, ahead of every other gate: if we cannot establish what this agent
    // has been doing, we do not touch it. A missing probe (harvester has never
    // reached this box) and a stale probe (harvester has been broken) are both
    // UNKNOWN, and unknown is not idle. This is the invariant that would have
    // prevented the cold-archiving of agents whose owners were talking to them
    // over Telegram the whole time.
    if (!hasFreshAgentProbe(candidate.last_agent_probe_at, nowMs, probeMaxAgeMs)) {
      activityUnknown += 1;
      log.info("inactivity sweep spared instance with UNKNOWN agent activity", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        resourceTier: candidate.resource_tier,
        proxmoxNode: candidate.proxmox_node,
        lastActivityAt: candidate.last_activity_at,
        lastAgentProbeAt: candidate.last_agent_probe_at,
        probeMaxAgeMs,
        cutoffIso,
        reason: candidate.last_agent_probe_at ? "probe_stale" : "never_probed",
      });
      continue;
    }

    // stat_date is a UTC calendar day; compare against the cutoff's own day so an
    // agent that ran any session on the cutoff day still counts as active.
    const latestUsageDay = latestAgentUsage.get(candidate.id);
    if (latestUsageDay && latestUsageDay >= cutoffIso.slice(0, 10)) {
      agentActive += 1;
      log.info("inactivity sweep spared agent-side-active instance", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        resourceTier: candidate.resource_tier,
        proxmoxNode: candidate.proxmox_node,
        lastActivityAt: candidate.last_activity_at,
        latestUsageDay,
        cutoffIso,
        signal: "instance_usage_snapshots.sessions",
      });
      continue;
    }

    // The owner wired this agent to a messaging channel but the harvester has never
    // seen it exchange a non-cron message. We have a fresh probe, so the box is
    // reachable — but a channel user generates no dashboard activity by definition,
    // and an empty message watermark means we have no idea whether they are using
    // it. Spare them. The cost is one idle VM; the cost of being wrong is deleting
    // a working agent.
    if (channelConnectedIds.has(candidate.id) && !candidate.last_agent_activity_at) {
      channelGuarded += 1;
      log.info("inactivity sweep spared channel-connected instance", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        resourceTier: candidate.resource_tier,
        proxmoxNode: candidate.proxmox_node,
        lastActivityAt: candidate.last_activity_at,
        cutoffIso,
        signal: "channel_connections",
      });
      continue;
    }

    // Wall-clock budget gate — placed right before the SSH-bound pause so the
    // cheap, no-I/O filtering above (dormancy + agent-active) still runs for the
    // whole batch. Once the budget is spent we stop starting NEW pauses: the
    // remaining confirmed-dormant candidates are left lifecycle_state='active'
    // (untouched) and re-selected next tick. Same VMs, just spread across runs.
    if (deadline !== null && clock() >= deadline) {
      timedOut = true;
      log.warn("inactivity sweep hit time budget; remaining candidates deferred to next tick", {
        source: LOG_SOURCE,
        failureType: "inactivity_sweep_budget_exhausted",
        swept,
        failed,
        skipped,
        vmMissing,
      });
      break;
    }

    try {
      const outcome = await pauseInstance(candidate, cutoffIso, {
        nowMs,
        maxAgeMs: probeMaxAgeMs,
      });
      if (outcome === "paused") {
        swept += 1;
        log.info("inactivity sweep paused instance", {
          source: LOG_SOURCE,
          instanceId: candidate.id,
          userId: candidate.user_id,
          resourceTier: candidate.resource_tier,
          proxmoxNode: candidate.proxmox_node,
          lastActivityAt: candidate.last_activity_at,
          lastAgentActivityAt: candidate.last_agent_activity_at,
          idleDays,
          cutoffIso,
        });
      } else if (outcome === "activity_unknown") {
        // The pre-shutdown re-read found the probe had gone stale since selection.
        activityUnknown += 1;
        log.warn(
          "inactivity sweep aborted pause — agent activity became UNKNOWN since selection",
          {
            source: LOG_SOURCE,
            instanceId: candidate.id,
            userId: candidate.user_id,
            resourceTier: candidate.resource_tier,
            reason: "probe_stale_at_pause_time",
          }
        );
      } else if (outcome === "raced") {
        skipped += 1;
        log.info("inactivity sweep skipped instance — state changed since selection", {
          source: LOG_SOURCE,
          instanceId: candidate.id,
          userId: candidate.user_id,
          resourceTier: candidate.resource_tier,
          reason: "resumed_or_active_since_selection",
        });
      } else if (outcome === "vm_missing") {
        vmMissing += 1;
        log.warn("inactivity sweep found missing VM, marked failed", {
          source: LOG_SOURCE,
          failureType: "inactivity_sweep_vm_missing",
          instanceId: candidate.id,
          userId: candidate.user_id,
          resourceTier: candidate.resource_tier,
          proxmoxNode: candidate.proxmox_node,
          proxmoxVmid: candidate.proxmox_vmid,
        });
      } else {
        skipped += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed += 1;
      log.error("inactivity sweep failed to pause instance", err, {
        source: LOG_SOURCE,
        failureType: "inactivity_sweep_pause_failed",
        instanceId: candidate.id,
        userId: candidate.user_id,
        resourceTier: candidate.resource_tier,
        proxmoxNode: candidate.proxmox_node,
      });
      try {
        await reportOpsEvent({
          source: LOG_SOURCE,
          title: "inactivity_sweep_pause_failed",
          message: "inactivity sweep failed to pause instance",
          severity: "error",
          instanceId: candidate.id,
          userId: candidate.user_id,
          metadata: { error: message },
        });
      } catch {
        // Ops-event logging is best-effort; never let it derail the sweep.
      }
    }
  }

  return {
    scanned: taggedCandidates.length,
    swept,
    failed,
    skipped,
    vmMissing,
    agentActive,
    activityUnknown,
    channelGuarded,
    freeIdleDays,
    tokenIdleDays,
    paidIdleDays,
    enabled: true,
    timedOut,
  };
}
