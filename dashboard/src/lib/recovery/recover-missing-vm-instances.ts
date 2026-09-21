/**
 * Recover-missing-vm-instances sweeper.
 *
 * Closes the gap that left a paying instance dead for 2 days (fixturecase13,
 * 2026-05-18→20): when a provision's post-provision metadata write hits an
 * unclearable VMID conflict, the inline recovery strips + releases the row's
 * Proxmox handle (config.infrastructureReleased). The row is now *recreatable*
 * — but nothing recreates it automatically:
 *   - recover-orphan-provisioning only reconciles rows to a VM that still
 *     EXISTS; there's no VM here.
 *   - recover-stuck-instances only touches rows with a gateway_url + VM handle.
 *   - recreate-missing-proxmox-instance can recreate it, but is manual (?id=).
 * So a released row falls through every sweep and waits for a support ticket.
 *
 * This sweep finds entitled, released, no-VM, non-deleted rows and drives the
 * shared recreate (provision a fresh VM on a healthy host). Guardrails:
 *   - entitlement_state='ok' only — never auto-spend on unpaid/suspended rows.
 *   - attempt cap (config.missingVmRecreate.attempts) + cooldown so a row that
 *     fails every time can't loop-clone-and-rollback forever.
 *   - grace window so we don't race a fresh in-flight provision.
 *   - per-run cap to stay under the Vercel cron ceiling.
 *   - ops alert (log.error) when a row exhausts its attempts so a human picks
 *     up the customer auto-recovery couldn't save.
 *
 * Schedule: every 10 min via vercel.json.
 */

import { log } from "@/lib/logger";
import { recreateMissingProxmoxInstanceById } from "@/lib/recreate-missing-proxmox-instance";
import { getReleasedProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "recover-missing-vm-instances";

// Don't race a fresh provision still in flight (recover-orphan / recover-stuck
// own the first few minutes). Released-and-abandoned rows are typically hours
// to days old, so a generous grace costs nothing.
const RECREATE_GRACE_MS = 10 * 60 * 1000;
// Cap auto-recreate attempts per row. Mirrors recover-stuck-instances'
// MAX_AUTO_RESTART_ATTEMPTS — a row that fails to provision on every try
// (bad provider key, no host capacity) must stop and page a human, not loop.
const MAX_RECREATE_ATTEMPTS = 3;
// Space attempts out: a provision takes minutes and a transient host problem
// wants time to clear before the next clone.
const RECREATE_COOLDOWN_MS = 30 * 60 * 1000;
// Each recreate runs provision Phase 1 synchronously (~30-60s). Keep the run
// comfortably under the Vercel cron 300s ceiling.
const MAX_RECREATES_PER_RUN = 3;

// Only auto-recreate rows released by a PROVISION FAILURE. The release marker
// reason discriminates: `dormant_reclaim` (instances intentionally torn down
// for inactivity) and `legacy_backfill` (old undeletable rows) must NOT be
// resurrected — auto-recreating those would undo a deliberate teardown and
// burn fleet capacity. Manual recreate (the route) has no such restriction.
const AUTO_RECREATE_REASONS = new Set<string>([
  "vm_missing_across_fleet",
  "post_provision_stale_conflict",
  "post_provision_rollback",
]);

type CandidateRow = {
  id: string;
  user_id: string;
  config: Record<string, unknown> | null;
  status: string | null;
  lifecycle_state: string | null;
  entitlement_state: string | null;
  resource_tier: string | null;
  created_at: string;
};

type MissingVmRecreateState = { attempts: number; lastAttemptAt: string | null };

export interface RecoverMissingVmInstancesSummary {
  candidates: number;
  recreated: number;
  failed: number;
  skippedCooldown: number;
  skippedExhausted: number;
  errors: number;
}

export function readRecreateState(
  config: Record<string, unknown> | null | undefined,
): MissingVmRecreateState {
  const raw =
    config && typeof config === "object"
      ? (config as Record<string, unknown>).missingVmRecreate
      : null;
  if (!raw || typeof raw !== "object") return { attempts: 0, lastAttemptAt: null };
  const data = raw as Record<string, unknown>;
  const attempts =
    typeof data.attempts === "number" && Number.isFinite(data.attempts) ? data.attempts : 0;
  const lastAttemptAt = typeof data.lastAttemptAt === "string" ? data.lastAttemptAt : null;
  return { attempts, lastAttemptAt };
}

function withRecreateState(
  config: Record<string, unknown> | null | undefined,
  state: MissingVmRecreateState,
): Record<string, unknown> {
  const next =
    config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  next.missingVmRecreate = state;
  return next;
}

/**
 * Pure eligibility helper (exported for tests): is this row due for an
 * auto-recreate attempt right now?
 */
export function shouldAttemptRecreate(
  state: MissingVmRecreateState,
  now: number,
): { eligible: boolean; reason?: "exhausted" | "cooldown" } {
  if (state.attempts >= MAX_RECREATE_ATTEMPTS) return { eligible: false, reason: "exhausted" };
  if (state.lastAttemptAt) {
    const last = Date.parse(state.lastAttemptAt);
    if (Number.isFinite(last) && now - last < RECREATE_COOLDOWN_MS) {
      return { eligible: false, reason: "cooldown" };
    }
  }
  return { eligible: true };
}

export async function runRecoverMissingVmInstancesSweep(): Promise<RecoverMissingVmInstancesSummary> {
  const db = supabaseAdmin;
  const summary: RecoverMissingVmInstancesSummary = {
    candidates: 0,
    recreated: 0,
    failed: 0,
    skippedCooldown: 0,
    skippedExhausted: 0,
    errors: 0,
  };
  if (!db) {
    log.error("recover-missing-vm: supabaseAdmin not configured", new Error("Database not configured"), {
      source: SOURCE,
      failureType: "recover_missing_vm_db_not_configured",
    });
    summary.errors = 1;
    return summary;
  }

  const now = Date.now();
  const cutoffIso = new Date(now - RECREATE_GRACE_MS).toISOString();

  const { data, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, config, status, lifecycle_state, entitlement_state, resource_tier, created_at",
    )
    .eq("infrastructure_provider", "proxmox")
    .is("deleted_at", null)
    .is("scheduled_deletion_at", null)
    .is("archived_at", null)
    .is("proxmox_vmid", null)
    .eq("entitlement_state", "ok")
    .not("api_key_encrypted", "is", null)
    .lt("created_at", cutoffIso)
    .not("status", "in", "(deleted,running,provisioning,redeploying)")
    .limit(MAX_RECREATES_PER_RUN * 6);

  if (error) {
    log.error("recover-missing-vm: candidate query failed", new Error("supabase_query_failed"), {
      source: SOURCE,
      failureType: "recover_missing_vm_query_failed",
      errorMessage: error.message,
    });
    summary.errors = 1;
    return summary;
  }

  // Keep only rows released by a provision FAILURE (see AUTO_RECREATE_REASONS).
  // A release marker alone isn't enough — dormant-reclaimed / legacy-backfilled
  // rows also carry one and must not be resurrected. This also filters out rows
  // the recreate fn would 409 on (no marker = can't prove the VM is missing).
  const rows = (data ?? []) as CandidateRow[];
  const candidates = rows.filter((row) => {
    const marker = getReleasedProxmoxInfrastructure(row.config);
    return marker !== null && AUTO_RECREATE_REASONS.has(marker.reason);
  });
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  let processed = 0;
  for (const row of candidates) {
    if (processed >= MAX_RECREATES_PER_RUN) break;

    const state = readRecreateState(row.config);
    const gate = shouldAttemptRecreate(state, now);
    if (!gate.eligible) {
      if (gate.reason === "exhausted") summary.skippedExhausted += 1;
      else summary.skippedCooldown += 1;
      continue;
    }

    processed += 1;
    const nextAttempt = state.attempts + 1;

    // Persist the bumped counter BEFORE attempting so a crash mid-provision
    // still counts against the cap. recreate re-fetches the row, so it sees
    // (and preserves through its own config writes) this counter.
    const { error: bumpError } = await db
      .from("hermes_instances")
      .update({
        config: withRecreateState(row.config, {
          attempts: nextAttempt,
          lastAttemptAt: new Date().toISOString(),
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (bumpError) {
      summary.errors += 1;
      log.error("recover-missing-vm: attempt-counter bump failed", new Error("counter_bump_failed"), {
        source: SOURCE,
        failureType: "recover_missing_vm_counter_bump_failed",
        instanceId: row.id,
        userId: row.user_id,
        errorMessage: bumpError.message,
      });
      continue;
    }

    try {
      const result = await recreateMissingProxmoxInstanceById(row.id);
      if (result.ok) {
        summary.recreated += 1;
        log.info("recover-missing-vm: instance recreated", {
          source: SOURCE,
          instanceId: row.id,
          userId: row.user_id,
          attempt: nextAttempt,
          proxmoxNode: result.proxmoxNode,
          proxmoxVmid: result.proxmoxVmid,
          resourceTier: row.resource_tier,
        });
        continue;
      }

      summary.failed += 1;
      if (nextAttempt >= MAX_RECREATE_ATTEMPTS) {
        // Ops alert (log.error → ops_events feed): auto-recovery exhausted its
        // attempts. A paying customer is still down and needs a human.
        log.error(
          "recover-missing-vm: gave up after max attempts — manual recreate needed",
          new Error(result.message),
          {
            source: SOURCE,
            failureType: "recover_missing_vm_recreate_exhausted",
            instanceId: row.id,
            userId: row.user_id,
            attempt: nextAttempt,
            maxAttempts: MAX_RECREATE_ATTEMPTS,
            httpStatus: result.httpStatus,
            recreateFailureType: result.failureType,
            message: result.message,
            resourceTier: row.resource_tier,
          },
        );
      } else {
        log.warn("recover-missing-vm: recreate attempt failed; will retry", {
          source: SOURCE,
          failureType: "recover_missing_vm_recreate_failed",
          instanceId: row.id,
          userId: row.user_id,
          attempt: nextAttempt,
          maxAttempts: MAX_RECREATE_ATTEMPTS,
          httpStatus: result.httpStatus,
          recreateFailureType: result.failureType,
          message: result.message,
          resourceTier: row.resource_tier,
        });
      }
    } catch (err) {
      summary.errors += 1;
      log.error("recover-missing-vm: recreate threw", err, {
        source: SOURCE,
        failureType: "recover_missing_vm_recreate_threw",
        instanceId: row.id,
        userId: row.user_id,
        attempt: nextAttempt,
      });
    }
  }

  if (summary.candidates > 0) {
    log.info("recover-missing-vm sweep summary", { source: SOURCE, ...summary });
  }
  return summary;
}
