import "server-only";

import { after } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";

import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { getRuntimeAgentSettings } from "@/lib/instance-settings";
import { isPausedLifecycleState } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { ONBOARDING_RITUAL } from "@/lib/onboarding-ritual";
import { isOperatorosFlavorConfig } from "@/lib/operatoros-flavor";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import {
  resolveInstanceIpv4,
  type InstanceRowForOrchestration,
} from "@/lib/services/instance-orchestrator";
import {
  getHermesGuestSshTarget,
} from "@/lib/services/proxmox-infrastructure";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend, WEBFREE_BACKENDS } from "@/lib/types/instance";
import {
  readWebUIProfileSystemPrompt,
  writeWebUIProfileSystemPrompt,
} from "@/lib/webui/profile-files";
import { isFactoryOrRitualSoul } from "@/lib/webui/soul-guard";

/**
 * Post-provision SOUL.md reconcile.
 *
 * WHY THIS EXISTS (the gap #475 didn't close). The provision-time seeder
 * (webui-instance-builder.ts `seed_onboarding_soul`) fires INSIDE the bootstrap
 * health-wait, but on a slow canary provision the agent container writes its
 * factory-default SOUL.md ("You are Hermes Agent…") LATER — after the seed has
 * already run — so the seed no-ops against a not-yet-seedable file and the
 * factory default survives (verified live 2026-07-07 on a Bea box provisioned on
 * #475 code: SOUL.md mtime was ~10min into provisioning, well after the seed
 * window). #475 also hoped the daily redeploy + recovery redrives would
 * organically reconcile via applyLiveUpdate, but that path has the same in-band
 * timing exposure and only runs daily — a fresh box that lost the race stays on
 * the factory default until then.
 *
 * THE FIX: a cheap, idempotent, guard-protected reconcile that runs AFTER the
 * box is fully up (out of band from provisioning) and re-seeds the intended soul
 * when — and only when — SOUL.md still holds no authored identity. It self-heals
 * every already-broken factory-default box too, not just future provisions.
 *
 * REUSE, DON'T FORK. The read/write transport and the "safe to overwrite?"
 * classification are the exact shared, production-proven helpers the profile
 * system-prompt writer uses (readWebUIProfileSystemPrompt /
 * writeWebUIProfileSystemPrompt / isFactoryOrRitualSoul in soul-guard.ts). The
 * guarded writer re-checks the head pattern on the box, so re-seeds stay
 * idempotent and can NEVER clobber a real agent-authored identity — even if the
 * box became authored between our read and our write (a concurrent redrive).
 */

const LOG_SOURCE = "soul-seed-reconcile";

// SSH read timeout per box. A read is one round-trip to resolve the live agent
// container + cat SOUL.md; 8s matches the profile-read path.
const DEFAULT_READ_TIMEOUT_MS = 8_000;

// How many boxes to reconcile concurrently. Each box is 1 cheap SSH read
// (already-correct boxes stop there) + at most 1 guarded write, so this can run
// well above the per-VM cost of the heavier redeploy sweep. 8 keeps peak SSH
// fan-out modest while clearing a ~150-box fleet inside the maxDuration ceiling.
const DEFAULT_CONCURRENCY = 8;

// Hard cap on boxes scanned per run. Set comfortably above the live fleet so a
// single tick reconciles everything; if it is ever hit we surface it (see
// `capped`) rather than silently dropping the tail.
const DEFAULT_FLEET_LIMIT = 500;

// resolveInstanceIpv4 + the guarded read/write need these columns; config
// carries proxmox routing + agentSettings.systemPrompt (persona resolution).
const SOUL_RECONCILE_INSTANCE_SELECT = [
  "id",
  "user_id",
  "name",
  "status",
  "lifecycle_state",
  "backend",
  "provider",
  "subdomain",
  "hetzner_server_id",
  "gateway_url",
  "api_key_encrypted",
  "config",
  "host_id",
  "ipv4_address",
  "infrastructure_provider",
  "proxmox_node",
  "proxmox_vmid",
].join(", ");

export type SoulReconcileInstanceRow = InstanceRowForOrchestration & {
  name?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  infrastructure_provider?: string | null;
  proxmox_vmid?: number | null;
};

type SoulReconcileAction =
  /** Box was on the factory default / stale ritual; re-seeded the hired persona soul. */
  | "reseeded_persona"
  /** Box was on the factory default / empty; re-seeded the who-am-I onboarding ritual. */
  | "reseeded_ritual"
  /** SOUL.md already holds an authored identity (persona soul or agent-rewritten) — left untouched. */
  | "skipped_authored"
  /** SOUL.md already IS the intended soul (e.g. an un-run ritual on a no-persona box) — no write needed. */
  | "skipped_already_seeded"
  /** Could not resolve an IP or read SOUL.md (box unreachable / container not up / not a Hermes box). */
  | "skipped_unreachable"
  /** Not a webfree Hermes-lane box. */
  | "skipped_not_webfree"
  /** Operator OS box — its autonomy SOUL is owned by the image; never touch it. */
  | "skipped_operatoros"
  /** Intentionally paused (idle/capacity/dormant park) — powered off, don't SSH. */
  | "skipped_paused"
  /** Unexpected failure during read/write. */
  | "error";

export interface SoulReconcileInstanceResult {
  id: string;
  name: string | null;
  action: SoulReconcileAction;
  /** The persona id we would/did seed, when the box carries a hired persona. */
  personaId?: string | null;
  error?: string;
}

/**
 * The soul a box SHOULD carry, derived purely from its stored config — no box
 * round-trip. A welcome-persona deploy stores the authored soul as the base of
 * agentSettings.systemPrompt (resolvePersonaSoulFromSystemPrompt recognizes it);
 * every other deploy (custom / no-persona) falls through to the first-run
 * onboarding ritual. Mirrors the provision seeder + applyLiveUpdate precedence.
 *
 * Returns null for an Operator OS box: its SOUL.md is the autonomy SOUL that
 * ships inside the operatoros-agent image, so a persona soul (or the ritual)
 * must never be written over it — the reconcile skips the box entirely. Note
 * that the image does NOT install that soul itself on a webfree box (its s6
 * cont-init enforcer never runs — the compose sets `entrypoint: []`); the
 * provision/update seeder in webui-instance-builder.ts extracts it from the
 * image and writes it, so an Operator OS box that somehow lacks its autonomy
 * SOUL is reconciled by its next redeploy/redrive, not by this pass.
 */
export function resolveIntendedSoul(config: Record<string, unknown> | undefined): {
  soul: string;
  isPersona: boolean;
  personaId: string | null;
} | null {
  // Flavor is persisted on create as config.agentFlavor; a stored
  // webuiAgentImage carrying the operatoros marker also counts. Shared with the
  // provision + orchestrator gates via operatoros-flavor.ts so the detection
  // can't drift between the path that seeds and the path that reconciles.
  if (isOperatorosFlavorConfig(config)) {
    return null;
  }
  const settings = getRuntimeAgentSettings(config);
  const persona = resolvePersonaSoulFromSystemPrompt(settings.systemPrompt);
  if (persona) {
    return { soul: persona.soulPrompt, isPersona: true, personaId: persona.id };
  }
  return { soul: ONBOARDING_RITUAL, isPersona: false, personaId: null };
}

/**
 * Reconcile one instance's SOUL.md. Read-first so we can classify precisely and
 * skip a redundant write on the common already-correct box (one cheap SSH read),
 * only paying for a second round-trip when a box genuinely needs re-seeding. The
 * guarded write is still the authoritative safety: it re-checks the head pattern
 * on the box, so a box that became authored between our read and our write is
 * preserved (reported skipped_authored).
 */
export async function reconcileInstanceSoulSeed(
  instance: SoulReconcileInstanceRow,
  db: SupabaseClient,
  opts: { readTimeoutMs?: number } = {},
): Promise<SoulReconcileInstanceResult> {
  const name = instance.name ?? null;

  if (!isWebfreeBackend(instance.backend)) {
    return { id: instance.id, name, action: "skipped_not_webfree" };
  }

  // Intentionally-paused boxes (idle/capacity/dormant/ram-cap parks) are powered
  // off via `qm shutdown`; SSHing one always fails and would raise a false
  // "unreachable" for a box that is EXPECTED to be off. lifecycle_state='paused'
  // is the authoritative off-marker (status can drift back to 'running').
  if (isPausedLifecycleState(instance.lifecycle_state)) {
    return { id: instance.id, name, action: "skipped_paused" };
  }

  // Operator OS boxes own their SOUL.md (the autonomy SOUL shipped on the
  // operatoros-agent image) — nothing to reconcile, and no SSH spent. Resolved
  // before the IP/read round-trips so the skip costs nothing.
  const intended = resolveIntendedSoul(instance.config);
  if (!intended) {
    return { id: instance.id, name, action: "skipped_operatoros" };
  }

  let ipv4 = "";
  try {
    ipv4 = await resolveInstanceIpv4(instance, db);
  } catch {
    return {
      id: instance.id,
      name,
      action: "skipped_unreachable",
      error: "ip_resolution_failed",
    };
  }
  if (!ipv4) {
    return {
      id: instance.id,
      name,
      action: "skipped_unreachable",
      error: "no_reachable_ip",
    };
  }

  // The guest IP alone names a VM on every host that shares the private
  // prefix, so reads and writes go to this instance's host and VMID.
  const guestTarget = getHermesGuestSshTarget(instance);

  // Read the box's current default-profile SOUL.md. A null read means the box /
  // container isn't in a readable state (unreachable, container not up, or no
  // /home/hermes/.hermes/SOUL.md — e.g. a non-Hermes box). Skip; a later tick
  // (or the next fleet sweep) retries once it's up. Never guess.
  let current: string | null;
  try {
    current = await readWebUIProfileSystemPrompt({
      instanceId: instance.id,
      hostIp: ipv4,
      profileName: "default",
      timeoutMs: opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
      guestTarget,
    });
  } catch (err) {
    return {
      id: instance.id,
      name,
      action: "error",
      error: redactSensitiveCommandOutput(
        err instanceof Error ? err.message : String(err),
        300,
      ),
    };
  }
  if (current === null) {
    return {
      id: instance.id,
      name,
      action: "skipped_unreachable",
      error: "soul_read_failed",
    };
  }

  // Authored identity (a hired persona soul or a soul the agent rewrote for
  // itself after the ritual) — NEVER touch it. isFactoryOrRitualSoul is the
  // shared single source of truth for "carries no authored identity".
  if (!isFactoryOrRitualSoul(current)) {
    return {
      id: instance.id,
      name,
      action: "skipped_authored",
      personaId: intended.personaId,
    };
  }

  // Already exactly the intended soul (e.g. an un-run onboarding ritual on a
  // no-persona box) — nothing to fix, avoid a pointless write every tick.
  if (current.trim() === intended.soul.trim()) {
    return {
      id: instance.id,
      name,
      action: "skipped_already_seeded",
      personaId: intended.personaId,
    };
  }

  // Factory-default / stale ritual that differs from the intended soul → re-seed
  // through the shared guarded writer. overwriteExistingIdentity=false means the
  // box re-checks the head pattern: a concurrent redrive that authored the soul
  // between our read and here is preserved (status skipped_existing_identity).
  let writeStatus: "written" | "skipped_existing_identity";
  try {
    const res = await writeWebUIProfileSystemPrompt({
      instanceId: instance.id,
      hostIp: ipv4,
      guestTarget,
      profileName: "default",
      systemPrompt: intended.soul,
      overwriteExistingIdentity: false,
    });
    writeStatus = res.status;
  } catch (err) {
    return {
      id: instance.id,
      name,
      action: "error",
      error: redactSensitiveCommandOutput(
        err instanceof Error ? err.message : String(err),
        300,
      ),
    };
  }

  if (writeStatus === "skipped_existing_identity") {
    return {
      id: instance.id,
      name,
      action: "skipped_authored",
      personaId: intended.personaId,
    };
  }

  return {
    id: instance.id,
    name,
    action: intended.isPersona ? "reseeded_persona" : "reseeded_ritual",
    personaId: intended.personaId,
  };
}

export interface SoulSeedReconcileSummary {
  scanned: number;
  reseededPersona: number;
  reseededRitual: number;
  skippedAuthored: number;
  skippedAlreadySeeded: number;
  skippedUnreachable: number;
  skippedOther: number;
  errored: number;
  /** True when the fleet exceeded the per-run limit and the tail was not scanned this tick. */
  capped: boolean;
  results: SoulReconcileInstanceResult[];
}

function tally(
  results: SoulReconcileInstanceResult[],
  capped: boolean,
): SoulSeedReconcileSummary {
  const count = (action: SoulReconcileAction) =>
    results.filter((r) => r.action === action).length;
  return {
    scanned: results.length,
    reseededPersona: count("reseeded_persona"),
    reseededRitual: count("reseeded_ritual"),
    skippedAuthored: count("skipped_authored"),
    skippedAlreadySeeded: count("skipped_already_seeded"),
    skippedUnreachable: count("skipped_unreachable"),
    skippedOther:
      count("skipped_not_webfree") + count("skipped_paused") + count("skipped_operatoros"),
    errored: count("error"),
    capped,
    results,
  };
}

/**
 * Fleet sweep: reconcile the SOUL.md of every RUNNING webfree Hermes-lane box.
 *
 * Selection: status='running' + backend in WEBFREE_BACKENDS (paused boxes are
 * excluded per-row via isPausedLifecycleState, since a paused box can keep
 * status='running' while lifecycle_state='paused'). Processed in concurrent
 * waves and capped per run; already-correct boxes cost one cheap SSH read.
 *
 * Pass `instanceIds` to reconcile a specific set (the targeted / one-time pass);
 * omit it for the scheduled whole-fleet sweep.
 */
export async function runSoulSeedReconcile(
  options: {
    db?: SupabaseClient | null;
    instanceIds?: string[] | null;
    concurrency?: number;
    limit?: number;
    readTimeoutMs?: number;
  } = {},
): Promise<SoulSeedReconcileSummary> {
  const db = options.db ?? supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const limit = Math.max(1, options.limit ?? DEFAULT_FLEET_LIMIT);
  const targeted =
    Array.isArray(options.instanceIds) && options.instanceIds.length > 0
      ? options.instanceIds
      : null;

  let query = db
    .from("hermes_instances")
    .select(SOUL_RECONCILE_INSTANCE_SELECT)
    .in("backend", WEBFREE_BACKENDS)
    .eq("status", "running");

  if (targeted) {
    query = query.in("id", targeted);
  }

  // Fetch one past the limit so we can honestly report whether the fleet spilled
  // the per-run cap rather than silently dropping the tail.
  const { data, error } = await query
    .order("id", { ascending: true })
    .limit(limit + 1);

  if (error) {
    throw new Error(error.message || "Failed to query instances for soul reconcile");
  }

  const allRows = (data ?? []) as unknown as SoulReconcileInstanceRow[];
  const capped = allRows.length > limit;
  const rows = capped ? allRows.slice(0, limit) : allRows;

  const results: SoulReconcileInstanceResult[] = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const wave = rows.slice(i, i + concurrency);
    const waveResults = await Promise.all(
      wave.map((row) =>
        reconcileInstanceSoulSeed(row, db, {
          ...(options.readTimeoutMs !== undefined
            ? { readTimeoutMs: options.readTimeoutMs }
            : {}),
        }).catch((err) => ({
          id: row.id,
          name: row.name ?? null,
          action: "error" as const,
          error: redactSensitiveCommandOutput(
            err instanceof Error ? err.message : String(err),
            300,
          ),
        })),
      ),
    );
    results.push(...waveResults);
  }

  const summary = tally(results, capped);

  log.info("soul-seed reconcile sweep completed", {
    source: LOG_SOURCE,
    mode: targeted ? "targeted" : "fleet",
    scanned: summary.scanned,
    reseededPersona: summary.reseededPersona,
    reseededRitual: summary.reseededRitual,
    skippedAuthored: summary.skippedAuthored,
    skippedAlreadySeeded: summary.skippedAlreadySeeded,
    skippedUnreachable: summary.skippedUnreachable,
    skippedOther: summary.skippedOther,
    errored: summary.errored,
    capped: summary.capped,
  });

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-READY targeted reconcile — the deterministic close of the auto-seed race.
//
// The provision-time seed runs INSIDE the bootstrap health-wait, but the agent
// container writes its factory-default SOUL.md when IT initializes — later than
// the seed window on slow provisions — so in-band seeding structurally cannot
// win that ordering (verified live 2026-07-07, box fixturecase25 on #475 code). The
// only write proven to stick is one made AFTER the box is fully up: exactly
// what the manual seed did and what this module's cron sweep does — but the
// cron alone leaves a fresh box factory-default for up to a full 20-min tick,
// which on the persona lane is precisely the user's first conversation.
//
// These helpers hang that guaranteed-late write off the moment the dashboard
// OBSERVES readiness: every site that promotes a webfree instance to
// status='running' — the /api/instances/[id] poll, the /api/instances list
// sync, the /api/instances/[id]/health gateway probe (the /wake auto-wake page,
// and any future surface that observes readiness through /health before the
// poll runs), the recover-stuck-instances sweep (slow provisions nobody is
// polling), and recover-orphan-provisioning adoption (redrives) — fires a
// targeted reconcile for that one box. Readiness-observation happens strictly
// after the agent container answered its health probe, i.e. after its
// default-write, so the guarded re-seed deterministically wins.
//
// WIRE EVERY PROMOTION SITE. Whoever OBSERVES readiness first owns the seed:
// each site's seed branch is guarded on the provisioning→running transition, so
// once any one of them flips the row, none of the others can ever fire for that
// box. A promote that copies the flip but not the reconcile therefore silently
// strands the box on the factory default (the /health gap, fixed here). The
// 20-min cron sweep remains the backstop for the narrow residue (a box whose
// SOUL.md hasn't materialized at first read → skipped_unreachable, or a
// promotion path not wired here).
// ─────────────────────────────────────────────────────────────────────────────

/** Where a post-ready reconcile was triggered from (log/traceability only). */
export type SoulSeedReconcileReadyTrigger =
  | "poll_provision_promote"
  | "poll_error_recovery_promote"
  | "poll_redeploy_complete"
  | "list_provision_promote"
  | "recover_stuck_promote"
  | "recover_orphan_adopt"
  | "health_probe_promote";

/**
 * Reconcile one just-promoted instance's SOUL.md, best-effort. NEVER throws —
 * a deploy/recovery must not be failable by soul seeding (a box without a soul
 * is degraded; a failed promotion is churn). Fetches a FRESH row (promotion
 * call sites rarely hold every reconcile column, and config may have moved)
 * and re-asserts status='running' so a box that was deleted/paused between the
 * promotion and this call is left alone. All safety beyond that lives in
 * reconcileInstanceSoulSeed: webfree/paused gating, the isFactoryOrRitualSoul
 * classification, and the on-box guarded write that can never clobber an
 * authored identity.
 */
export async function reconcileSoulSeedAfterReady(params: {
  instanceId: string;
  trigger: SoulSeedReconcileReadyTrigger;
  db?: SupabaseClient | null;
}): Promise<SoulReconcileInstanceResult | null> {
  try {
    const db = params.db ?? supabaseAdmin;
    if (!db) {
      log.warn("post-ready soul-seed reconcile skipped: no database client", {
        source: LOG_SOURCE,
        trigger: params.trigger,
        instanceId: params.instanceId,
      });
      return null;
    }

    const { data, error } = await db
      .from("hermes_instances")
      .select(SOUL_RECONCILE_INSTANCE_SELECT)
      .eq("id", params.instanceId)
      .eq("status", "running")
      .maybeSingle();

    if (error) {
      log.warn("post-ready soul-seed reconcile skipped: row fetch failed", {
        source: LOG_SOURCE,
        trigger: params.trigger,
        instanceId: params.instanceId,
        errorMessage: error.message,
      });
      return null;
    }
    // Row gone or no longer running (deleted / paused / demoted between the
    // promotion and now) — nothing to seed; the cron sweep owns the long tail.
    if (!data) {
      return null;
    }

    const result = await reconcileInstanceSoulSeed(
      data as unknown as SoulReconcileInstanceRow,
      db,
    );

    const logMeta = {
      source: LOG_SOURCE,
      mode: "post-ready",
      trigger: params.trigger,
      instanceId: params.instanceId,
      action: result.action,
      personaId: result.personaId ?? null,
      ...(result.error ? { errorMessage: result.error } : {}),
    };
    if (result.action === "error") {
      log.warn("post-ready soul-seed reconcile errored (cron sweep will retry)", logMeta);
    } else {
      log.info("post-ready soul-seed reconcile completed", logMeta);
    }
    return result;
  } catch (err) {
    log.warn("post-ready soul-seed reconcile crashed (cron sweep will retry)", {
      source: LOG_SOURCE,
      trigger: params.trigger,
      instanceId: params.instanceId,
      errorMessage: redactSensitiveCommandOutput(
        err instanceof Error ? err.message : String(err),
        300,
      ),
    });
    return null;
  }
}

/**
 * Route-handler variant: defer the targeted reconcile until AFTER the response
 * has been sent (`next/server` after()), so the poll that discovers "running"
 * never waits on an SSH round-trip. Mirrors the reserve-route house pattern:
 * after() throws outside a request scope (unit tests, non-request contexts) —
 * swallow it, because the 20-min cron sweep still heals the box either way.
 */
export function scheduleSoulSeedReconcileAfterResponse(params: {
  instanceId: string;
  trigger: SoulSeedReconcileReadyTrigger;
  db?: SupabaseClient | null;
}): void {
  try {
    after(() => reconcileSoulSeedAfterReady(params));
  } catch (err) {
    log.warn("post-ready soul-seed reconcile not scheduled (after() unavailable); cron sweep will heal", {
      source: LOG_SOURCE,
      trigger: params.trigger,
      instanceId: params.instanceId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}
