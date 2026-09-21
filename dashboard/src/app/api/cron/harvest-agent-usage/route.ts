import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { reportOpsEvent } from "@/lib/ops-events";
import { posthogClient } from "@/lib/posthog";
import { supabaseAdmin } from "@/lib/supabase";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import { log } from "@/lib/logger";
import {
  parseAgentProbe,
  parseAgentUsage,
  parseHarvestedGoal,
} from "./usage-parsers";
import type { ParsedAgentProbe } from "./usage-parsers";

/**
 * Runtime usage harvester — the authoritative source for per-model /
 * per-provider / token stats. Pulls each active Proxmox agent's own usage
 * (the same `state.db` the agent's WebUI analytics read) and lands it,
 * per UTC day, in `instance_usage_snapshots`. The daily rollup folds these
 * into platform_stats_daily (model_distribution / provider_distribution /
 * tokens / sessions / api_calls). Managed-Venice / BYO billing tables only
 * cover a subset of agents, so the runtime is what makes the dashboard
 * match reality.
 *
 * Channel (verified against live legacy + webfree agents 2026-06-13): the
 * runtime runs in Docker; `state.db` is mounted at /home/hermes/.hermes/state.db
 * and carries the same `sessions` table on every topology. We SSH into the
 * guest over the Proxmox guest-hop (runs as root via sudo) and run a read-only
 * Python aggregation inside whichever agent container is running:
 *   echo <py-b64> | base64 -d | docker exec -i <agent-container> python3
 * `date(started_at,'unixepoch')` groups by UTC, matching stat_date.
 *
 * Container topology is NOT uniform and is NOT reliably described by the
 * `hermes_instances.webfree` flag (a webfree=false row created today was
 * observed running the webfree compose). So instead of hard-coding
 * `agent-<id>`, we resolve the live container on the guest from a candidate
 * list — `agent-<id>` (legacy), then `agent-<id>-gateway` and
 * `agent-<id>-official-dashboard` (the webui-free compose, which share the
 * webui-state volume so either sees the same state.db). The webfree migration
 * (canary #188/#194/#196/#202-#207/#212 → prod) replaced the bare `agent-<id>`
 * container with these two; the old harvester silently `skipped` every such
 * instance, which is why meaningful snapshots cliff-dropped to ~0 after
 * 2026-06-07 as the webfree share grew.
 *
 * `?days=N` (cap 90) controls how much history to pull — the daily cron
 * uses 2 (today + yesterday); a one-time deep backfill uses 90. Each run
 * emits one ops_event (source 'harvest-agent-usage') with the per-reason
 * skip counts so a harvest outage can never silently rot again.
 */

const DEFAULT_DAYS = 2;
const MAX_DAYS = 90;
// Runs hourly; concurrency is sized so the full active fleet fits inside one
// 300s window (~16s/agent over the double SSH-hop).
const HARVEST_CONCURRENCY = 24;
const SSH_TIMEOUT_MS = 25_000;
// Skip agents harvested within this window so the hourly cron re-reads each
// agent ~once/hour (its today total climbs) without duplicating inside a run.
const RECENT_SKIP_MINUTES = 50;
// Candidate agent containers, tried in order on the guest; the first one that
// is running wins. "" = the legacy bare `agent-<id>`; the suffixed two are the
// webui-free compose (gateway is the runtime that writes state.db,
// official-dashboard mounts the same webui-state volume rw).
const AGENT_CONTAINER_SUFFIXES = ["", "-gateway", "-official-dashboard"] as const;
// Sentinel printed by the guest command when no candidate container is running
// (topology mismatch / dead VM) — distinguishes "unreachable" from an idle
// agent that legitimately returned an empty usage window.
const NO_CONTAINER_MARKER = "__HARVEST_NO_CONTAINER__";
// Floor for the per-run "degraded" alarm: warn only once the no-container count
// crosses this AND a quarter of attempts (below, a couple of paused/booting VMs
// shouldn't flip the run to warn).
const HARVEST_UNREACHABLE_ALARM_MIN = 10;

export const maxDuration = 300;

const INSTANCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Read-only per-day aggregation run inside the agent container against its
// mounted state.db. Emits scalar daily counters plus per-day model and
// provider breakdowns. Opened `mode=ro` with a busy_timeout so it never blocks
// the live writer or touches the file, and the whole thing is wrapped so it
// ALWAYS prints valid JSON — a sqlite hiccup degrades to an empty window
// (harmless skip) instead of empty stdout the caller can't tell apart from a
// missing container.
function buildHarvestPy(days: number): string {
  return `import sqlite3, json, time
out = {"daily": [], "models": [], "providers": [], "goals": []}
try:
    db = sqlite3.connect("file:/home/hermes/.hermes/state.db?mode=ro", uri=True, timeout=5); db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=5000")
    cut = time.time() - ${days} * 86400
    out["daily"] = [dict(r) for r in db.execute("SELECT date(started_at,'unixepoch') day, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(reasoning_tokens),0) reasoning_tokens, COALESCE(SUM(estimated_cost_usd),0) estimated_cost, COUNT(*) sessions, COALESCE(SUM(api_call_count),0) api_calls FROM sessions WHERE started_at>? GROUP BY day", (cut,))]
    out["models"] = [dict(r) for r in db.execute("SELECT date(started_at,'unixepoch') day, model, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(api_call_count),0) requests FROM sessions WHERE started_at>? AND model IS NOT NULL AND model<>'' GROUP BY day, model", (cut,))]
    out["providers"] = [dict(r) for r in db.execute("SELECT date(started_at,'unixepoch') day, COALESCE(NULLIF(billing_provider,''),'unknown') provider, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(api_call_count),0) requests FROM sessions WHERE started_at>? GROUP BY day, provider", (cut,))]
    # Standing goals (the Ralph-loop objective the user set in chat) live in the
    # same state.db, table state_meta, keyed 'goal:<session_id>', value = a
    # GoalState JSON blob. We harvest the raw blobs so the control plane can
    # write the captured objective back to hermes_instances.first_task (which is
    # NULL for ~all default-lane boxes — the onboarding form that used to fill it
    # was removed, so auto-seed + goal-personalized emails currently have no
    # fuel). Inner try so a pre-state_meta box never degrades the usage harvest.
    try:
        out["goals"] = [r["value"] for r in db.execute("SELECT value FROM state_meta WHERE key LIKE 'goal:%'")]
    except Exception:
        pass
    # Last REAL user/agent message exchange, unbounded by the ${days}-day window and
    # independent of when its session started. \`sessions\` above keys on
    # date(started_at) -- a long-lived Telegram thread opened last week and used
    # every day since produces NO row in the window and reads as idle. messages.timestamp
    # is the truth. Verified live: sessions.source in ('telegram','tui','cron'),
    # messages.timestamp is a REAL unix epoch.
    # 'cron' sessions are scheduled/standing tasks the PLATFORM runs, not the human --
    # counting them would make every agent with a standing task look permanently active.
    row = db.execute("SELECT MAX(m.timestamp) ts FROM messages m JOIN sessions s ON s.id=m.session_id WHERE COALESCE(s.source,'') <> 'cron'").fetchone()
    out["last_activity"] = row["ts"] if row and row["ts"] is not None else None
    # Explicit success marker: lets the caller distinguish "read the db, agent is
    # genuinely idle" (empty daily, ok=True) from "could not read the db" (ok absent).
    out["ok"] = True
except Exception as e:
    out["_error"] = str(e)
print(json.dumps(out))`;
}

// Resolve the agent container on the guest and pipe the read-only Python into
// it. Runs the candidate loop in the same SSH round-trip as the exec (no extra
// hop): for each candidate, check `docker inspect .State.Running` and use the
// first that is up. If none are running it prints NO_CONTAINER_MARKER so the
// caller can count "unreachable container" separately from "idle agent".
function buildGuestHarvestCommand(instanceId: string, harvestPyB64: string): string {
  const candidates = AGENT_CONTAINER_SUFFIXES.map((s) => `"agent-${instanceId}${s}"`).join(" ");
  return [
    `set -u`,
    `AGENT_CONTAINER=""`,
    `for c in ${candidates}; do`,
    `  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -q true; then AGENT_CONTAINER="$c"; break; fi`,
    `done`,
    `if [ -z "$AGENT_CONTAINER" ]; then echo "${NO_CONTAINER_MARKER}"; exit 0; fi`,
    `echo "${harvestPyB64}" | base64 -d | docker exec -i "$AGENT_CONTAINER" python3`,
  ].join("\n");
}

interface HarvestableInstance {
  id: string;
  user_id?: string | null;
  host_id?: string | null;
  proxmox_node?: string | null;
  config?: unknown;
  first_usage_at?: string | null;
  // Current agent-activity watermark. Carried so the stamp below only ever moves
  // FORWARD — a cold-restore from an older state.db snapshot must not roll the
  // watermark back and make an active agent look idle to the sweep.
  last_agent_activity_at?: string | null;
  // Diagnostic only — the harvest channel is resolved from the live container
  // topology, not this flag (it has drifted from reality). Carried so the
  // ops_event can report how many unreachable agents were webfree-flagged.
  webfree?: boolean | null;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "harvest-agent-usage",
      route: "/api/cron/harvest-agent-usage",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    log.error("Supabase admin client is not configured", new Error("missing supabase admin"), {
      source: "harvest-agent-usage",
      route: "/api/cron/harvest-agent-usage",
      method: "GET",
      failureType: "supabase_admin_missing",
    });
    return apiError("Supabase service role is not configured", 500);
  }

  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days") ?? String(DEFAULT_DAYS));
  const days = Number.isFinite(daysRaw)
    ? Math.min(Math.max(Math.trunc(daysRaw), 1), MAX_DAYS)
    : DEFAULT_DAYS;
  // The fleet exceeds one 300s function window, so skip agents already
  // harvested recently — each run works the remaining tail and coverage
  // converges within a day across the hourly schedule (vercel.json: 0 * * * *).
  // ?force=1 bypasses (deep backfill / re-harvest).
  const force = url.searchParams.get("force") === "1";
  const harvestPyB64 = Buffer.from(buildHarvestPy(days), "utf8").toString("base64");

  let instances: HarvestableInstance[];
  try {
    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select(
        "id, user_id, host_id, proxmox_node, config, first_usage_at, webfree, last_agent_activity_at"
      )
      .eq("lifecycle_state", "active")
      .eq("infrastructure_provider", "proxmox");
    if (error) throw new Error(error.message || "Failed to load active instances");
    instances = (data ?? []) as HarvestableInstance[];
  } catch (err) {
    return apiError("Failed to load active instances", 500, {
      failureType: "harvest_load_instances_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  let recentlyHarvested = new Set<string>();
  if (!force) {
    const recentCutoff = new Date(Date.now() - RECENT_SKIP_MINUTES * 60_000).toISOString();
    const { data: doneRows } = await supabaseAdmin
      .from("instance_usage_snapshots")
      .select("instance_id")
      .gte("harvested_at", recentCutoff);
    recentlyHarvested = new Set((doneRows ?? []).map((r: { instance_id: string }) => r.instance_id));
  }

  let harvested = 0;
  let errors = 0;
  // Number of boxes where this run newly populated first_task from a harvested
  // standing goal (first_task was NULL → now set). Surfaced in the summary so
  // the first post-deploy run shows whether boxes actually carry standing goals.
  let goalsCaptured = 0;
  // Granular skip reasons. Only `skippedNoContainer` is the topology-rot signal
  // the migration introduced; host-unreachable (VM booting/paused) and empty
  // (idle agent) are normal and must not drown it out.
  let skippedRecent = 0;
  let skippedNoIp = 0;
  let skippedNoContainer = 0;
  let skippedEmpty = 0;
  let skippedHostUnreachable = 0;
  // Container answered with valid JSON but could not read state.db (sqlite error /
  // corrupt db). Previously indistinguishable from `skippedEmpty` (an idle agent),
  // which is precisely the ambiguity that let the sweep pause blind.
  let skippedProbeFailed = 0;
  // Instances whose state.db we read cleanly this run — the durable evidence the
  // inactivity sweep needs before it may pause anything.
  let probed = 0;
  const unreachableSamples: Array<{ id: string; webfree: boolean | null; node: string | null }> = [];
  const noteUnreachable = (instance: HarvestableInstance): void => {
    if (unreachableSamples.length < 12) {
      unreachableSamples.push({
        id: instance.id,
        webfree: instance.webfree ?? null,
        node: instance.proxmox_node ?? null,
      });
    }
  };

  // Record that this agent's state.db was READ SUCCESSFULLY, and move its
  // activity watermark forward. `last_agent_probe_at` is the coverage marker the
  // inactivity sweep keys its fail-safe on: no fresh probe => activity UNKNOWN =>
  // never pause. Crucially this is stamped even when the agent reports zero usage,
  // because "harvested and idle" and "never harvested" must not look the same.
  // Best-effort — a failed stamp must never fail the harvest (worst case the sweep
  // sees a stale probe and conservatively spares the box).
  const stampAgentActivity = async (
    instance: HarvestableInstance,
    probe: ParsedAgentProbe,
    probedAt: string
  ): Promise<void> => {
    const patch: Record<string, string> = { last_agent_probe_at: probedAt };

    const incoming = probe.lastActivityAt ? Date.parse(probe.lastActivityAt) : NaN;
    const existing = instance.last_agent_activity_at
      ? Date.parse(instance.last_agent_activity_at)
      : NaN;
    if (
      Number.isFinite(incoming) &&
      (!Number.isFinite(existing) || incoming > existing)
    ) {
      patch.last_agent_activity_at = probe.lastActivityAt as string;
    }

    const { error } = await supabaseAdmin!
      .from("hermes_instances")
      .update(patch)
      .eq("id", instance.id);

    if (error) {
      log.warn("failed to stamp agent activity probe", {
        source: "harvest-agent-usage",
        route: "/api/cron/harvest-agent-usage",
        method: "GET",
        instanceId: instance.id,
        failureType: "agent_probe_stamp_failed",
      });
      return;
    }
    probed++;
  };

  const harvestOne = async (instance: HarvestableInstance): Promise<void> => {
    if (recentlyHarvested.has(instance.id)) {
      skippedRecent++;
      return;
    }
    if (!INSTANCE_ID_RE.test(instance.id)) {
      errors++;
      return;
    }
    const infrastructure = getProxmoxInfrastructure(instance.config);
    if (!infrastructure?.privateIpv4) {
      skippedNoIp++;
      return;
    }

    const hostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
      {
        node: infrastructure.node ?? instance.proxmox_node ?? undefined,
        ...(infrastructure.hostId ? { hostId: infrastructure.hostId } : {}),
        ...(infrastructure.hostSlug ? { hostSlug: infrastructure.hostSlug } : {}),
        ...(infrastructure.hostEnvPrefix ? { hostEnvPrefix: infrastructure.hostEnvPrefix } : {}),
      },
      { host_id: instance.host_id ?? null }
    );

    // Resolve the live agent container on the guest, then pipe the base64
    // script into its python3. The wrapper prints NO_CONTAINER_MARKER when no
    // candidate is running; stderr (docker errors) stays separate so stdout is
    // pure JSON otherwise.
    const command = buildGuestHarvestCommand(instance.id, harvestPyB64);

    let stdout: string;
    try {
      const result = await sshExec(infrastructure.privateIpv4, command, {
        proxmoxHostConfig: hostConfig,
        timeoutMs: SSH_TIMEOUT_MS,
      });
      if (!result.ok) {
        // SSH/host failure (VM down, booting, key churn) — transient, not the
        // topology rot. Counted separately so it doesn't trip the alarm.
        skippedHostUnreachable++;
        return;
      }
      stdout = result.stdout.trim();
    } catch {
      skippedHostUnreachable++;
      return;
    }

    if (stdout === NO_CONTAINER_MARKER) {
      // No agent container is running for an active instance — the exact
      // failure the webfree migration introduced. This is the signal.
      skippedNoContainer++;
      noteUnreachable(instance);
      return;
    }
    if (!stdout) {
      // Container resolved but produced nothing (died mid-exec / odd state).
      skippedHostUnreachable++;
      return;
    }

    // Probe FIRST, before the usage-window shortcut below. A clean read of an
    // idle agent still has to leave a durable "we looked, on this date" marker;
    // that marker is what lets the inactivity sweep pause a genuinely-dormant box
    // while sparing one whose signal it simply cannot see.
    const harvestedAt = new Date().toISOString();
    const probe = parseAgentProbe(stdout);
    if (!probe.ok) {
      // Valid JSON, but the guest raised reading state.db. Activity is UNKNOWN:
      // stamp nothing, so the sweep keeps failing safe for this instance.
      skippedProbeFailed++;
      noteUnreachable(instance);
      return;
    }
    await stampAgentActivity(instance, probe, harvestedAt);

    const days = parseAgentUsage(stdout);
    if (!days || days.length === 0) {
      // Valid JSON, no usage in the window — an idle agent. Legitimate, and now
      // provably so: the probe above recorded that we read its state.db cleanly.
      skippedEmpty++;
      return;
    }
    const rows = days.map((d) => ({
      instance_id: instance.id,
      stat_date: d.stat_date,
      input_tokens: d.input_tokens,
      output_tokens: d.output_tokens,
      total_tokens: d.total_tokens,
      cache_read_tokens: d.cache_read_tokens,
      reasoning_tokens: d.reasoning_tokens,
      estimated_cost_usd: d.estimated_cost_usd,
      sessions: d.sessions,
      api_calls: d.api_calls,
      by_model: d.by_model,
      by_provider: d.by_provider,
      source: "agent_state_db",
      harvested_at: harvestedAt,
    }));

    const { error: upsertError } = await supabaseAdmin!
      .from("instance_usage_snapshots")
      .upsert(rows, { onConflict: "instance_id,stat_date" });

    if (upsertError) {
      log.error("failed to upsert usage snapshot", new Error(upsertError.message || "upsert failed"), {
        source: "harvest-agent-usage",
        route: "/api/cron/harvest-agent-usage",
        method: "GET",
        instanceId: instance.id,
        failureType: "usage_snapshot_upsert_failed",
      });
      errors++;
      return;
    }

    // agent_first_message_sent revival (Hermes lane): chat happens inside the
    // upstream iframe, so the harvested session counts are the only signal a
    // user actually talked to their agent. Stamp first_usage_at write-once
    // (conditional UPDATE ... WHERE first_usage_at IS NULL) and fire the
    // server-side capture exactly when this run won the stamp (rows=1).
    // Best-effort: a failed stamp never fails the harvest.
    const firstUsageDay = days
      .filter((d) => d.sessions > 0)
      .map((d) => d.stat_date)
      .sort()[0];
    if (firstUsageDay && !instance.first_usage_at) {
      const { data: stampedRows, error: stampError } = await supabaseAdmin!
        .from("hermes_instances")
        .update({ first_usage_at: `${firstUsageDay}T00:00:00.000Z` })
        .eq("id", instance.id)
        .is("first_usage_at", null)
        .select("id");

      if (stampError) {
        log.warn("failed to stamp first_usage_at", {
          source: "harvest-agent-usage",
          route: "/api/cron/harvest-agent-usage",
          method: "GET",
          instanceId: instance.id,
          failureType: "first_usage_stamp_failed",
        });
      } else if ((stampedRows?.length ?? 0) === 1 && instance.user_id) {
        try {
          posthogClient.capture({
            distinctId: instance.user_id,
            event: "agent_first_message_sent",
            properties: {
              instance_id: instance.id,
              lane: "hermes",
              $insert_id: `agent_first_message_sent_${instance.id}`,
            },
          });
          await posthogClient.flush();
        } catch (captureErr) {
          log.warn("failed to capture agent_first_message_sent", {
            source: "harvest-agent-usage",
            route: "/api/cron/harvest-agent-usage",
            method: "GET",
            instanceId: instance.id,
            failureType: "first_usage_capture_failed",
          }, captureErr);
        }
      }
    }

    // last_activity_at bump (Hermes lane): real chat happens INSIDE the box
    // iframe, which never calls the dashboard proxy routes that
    // recordInstanceUserActivity() bumps. So an actively-chatting free user
    // goes DB-silent after their single webui_login and wrongly ages out of the
    // engaged/digest cohort AND the conversion-funnel `usedPastDay1` stage
    // (last_activity_at > first_active_at + 1d). Use the harvested session
    // dates as a second, push-independent activity signal: advance
    // last_activity_at to the latest day that had sessions — but ONLY when it
    // is newer than whatever the proxy routes already recorded. The DB-side
    // .or() guard makes this race-safe (evaluated atomically at write time, so
    // a concurrent proxy bump to now() is never clobbered) and never moves the
    // timestamp backwards. Best-effort: a failed bump never fails the harvest.
    const usedDays = days
      .filter((d) => d.sessions > 0)
      .map((d) => d.stat_date)
      .sort();
    const lastUsageDay = usedDays[usedDays.length - 1];
    if (lastUsageDay) {
      const lastUsageTs = `${lastUsageDay}T12:00:00Z`;
      const { error: activityError } = await supabaseAdmin!
        .from("hermes_instances")
        .update({ last_activity_at: lastUsageTs })
        .eq("id", instance.id)
        .or(`last_activity_at.is.null,last_activity_at.lt.${lastUsageTs}`);
      if (activityError) {
        log.warn("failed to bump last_activity_at from harvest", {
          source: "harvest-agent-usage",
          route: "/api/cron/harvest-agent-usage",
          method: "GET",
          instanceId: instance.id,
          failureType: "last_activity_bump_failed",
        });
      }
    }

    // Goal capture: write the harvested standing-goal text to first_task
    // write-once (only when it is still NULL, via the .is guard) so we never
    // clobber a user-entered objective or thrash the column. Populating
    // first_task makes the box eligible for the auto-seed cron
    // (seed-standing-tasks gates on .or(goal,first_task)) and gives the day-N
    // lifecycle emails a real objective to personalize — both have ~no fuel
    // today because the onboarding form that filled first_task was removed.
    // Best-effort: a failed write never fails the harvest. The .select() lets us
    // count only the rows we actually transitioned NULL→set.
    const harvestedGoal = parseHarvestedGoal(stdout);
    if (harvestedGoal) {
      const { data: goalRows, error: goalError } = await supabaseAdmin!
        .from("hermes_instances")
        .update({ first_task: harvestedGoal })
        .eq("id", instance.id)
        .is("first_task", null)
        .select("id");
      if (goalError) {
        log.warn("failed to write harvested goal to first_task", {
          source: "harvest-agent-usage",
          route: "/api/cron/harvest-agent-usage",
          method: "GET",
          instanceId: instance.id,
          failureType: "goal_capture_write_failed",
        });
      } else if ((goalRows?.length ?? 0) === 1) {
        goalsCaptured++;
      }
    }

    harvested++;
  };

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(HARVEST_CONCURRENCY, instances.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= instances.length) return;
          try {
            await harvestOne(instances[idx]);
          } catch {
            errors++;
          }
        }
      })()
    );
  }
  await Promise.all(workers);

  // Refresh today's rollup so the public /stats + admin numbers reflect this
  // harvest immediately (non-fatal — the daily rollup also catches up).
  let rollupOk = false;
  try {
    const { error: rollupErr } = await supabaseAdmin.rpc("compute_platform_stats_snapshot", {
      p_date: todayUtc,
    });
    rollupOk = !rollupErr;
  } catch {
    rollupOk = false;
  }

  // `reachable` = instances we got an SSH response from AND tried to exec a
  // container in (excludes recently-done, no-IP, and host-down — an idle agent
  // that returns an empty window still counts as reachable). The run is
  // "degraded" only when a container exec errored, or when a meaningful slice
  // of reachable instances had NO running agent container — the silent-rot
  // condition that killed harvest after 2026-06-07. A quiet fleet where every
  // reachable agent is simply idle is healthy, not degraded.
  //
  // Emit ONE ops_event every run (info when healthy, warn when degraded) so a
  // stalled harvester surfaces as a stale `last_seen_at` instead of vanishing
  // for a week. Best-effort: never fail the cron on telemetry.
  const reachable =
    harvested + skippedNoContainer + skippedEmpty + skippedProbeFailed + errors;
  const attempted = reachable + skippedHostUnreachable;
  const skipped =
    skippedRecent +
    skippedNoIp +
    skippedNoContainer +
    skippedEmpty +
    skippedProbeFailed +
    skippedHostUnreachable;
  // A mass SSH/key-churn outage shows up as everything landing in
  // skippedHostUnreachable: reachable≈0, skippedNoContainer≈0, so the original
  // two conditions both stayed false and the run reported "healthy" during a
  // fleet-wide outage. Add a third condition: a meaningful slice of the
  // ATTEMPTED instances (reachable + host-unreachable) being host-unreachable is
  // itself degraded. Purely additive — never weakens the existing checks.
  const hostUnreachableDegraded =
    skippedHostUnreachable >= Math.max(HARVEST_UNREACHABLE_ALARM_MIN, Math.ceil(attempted * 0.25));
  const degraded =
    errors > 0 ||
    skippedNoContainer >= Math.max(HARVEST_UNREACHABLE_ALARM_MIN, Math.ceil(reachable * 0.25)) ||
    hostUnreachableDegraded ||
    // A wave of unreadable state.db files blinds the inactivity sweep's activity
    // signal just as thoroughly as an SSH outage does. Alarm on it.
    skippedProbeFailed >= Math.max(HARVEST_UNREACHABLE_ALARM_MIN, Math.ceil(reachable * 0.25));

  const harvestSummary = {
    harvested,
    goalsCaptured,
    probed,
    skipped,
    errors,
    skippedRecent,
    skippedNoIp,
    skippedNoContainer,
    skippedEmpty,
    skippedProbeFailed,
    skippedHostUnreachable,
    attempted,
    total: instances.length,
    days,
    force,
    rollupOk,
  };

  try {
    await reportOpsEvent({
      source: "harvest-agent-usage",
      route: "/api/cron/harvest-agent-usage",
      severity: degraded ? "warn" : "info",
      // Stable title+message per branch so reportOpsEvent dedupes to a single
      // updating row (occurrence_count + last_seen_at climb); the live counts
      // ride in metadata, and the unreachable instance ids help triage.
      title: degraded ? "Usage harvest degraded" : "Usage harvest healthy",
      message: degraded
        ? "Usage harvest is degraded: container exec errored, a meaningful slice of reachable agents " +
          "had no running container, or a large share of hosts were unreachable (possible fleet-wide " +
          "SSH/key-churn outage). Check SSH/host health + the agent container topology (legacy " +
          "agent-<id> vs webfree gateway/official-dashboard)."
        : "Usage harvest completed and refreshed instance_usage_snapshots.",
      metadata: { ...harvestSummary, unreachableSamples },
    });
  } catch {
    // telemetry must never break the harvest
  }

  return apiSuccess({ ...harvestSummary, degraded });
}
