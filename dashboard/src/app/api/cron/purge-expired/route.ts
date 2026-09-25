import { NextRequest } from "next/server";
import { isPlatformAccountId } from "@/lib/account-owner-id";
import { apiSuccess, apiError } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { getRequestContext } from "@/lib/request-context";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxBackedInstanceRow,
  resolveProxmoxLifecycleTarget,
} from "@/lib/services/proxmox-infrastructure";

const PURGE_INSTANCE_FAILURE_MESSAGE = "Failed to purge instance";
const SOURCE = "cron/purge-expired";
const PURGE_INSTANCE_SELECT =
  "id, user_id, name, hetzner_server_id, host_id, config, infrastructure_provider, proxmox_node, proxmox_vmid, ipv4_address, gateway_url, subdomain, status, lifecycle_state, resource_tier, cpu_limit, ram_limit, disk_size_gb, created_at, last_lifecycle_transition_at, scheduled_deletion_at, entitlement_state";
const ARCHIVE_TTL_DAYS = 30;

type PurgeCandidate = {
  id: string;
  user_id: string;
  name: string;
  hetzner_server_id: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  infrastructure_provider: "hetzner" | "proxmox" | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  ipv4_address: string | null;
  gateway_url: string | null;
  subdomain: string | null;
  status: string | null;
  lifecycle_state: string | null;
  resource_tier: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  disk_size_gb: number | null;
  created_at: string | null;
  last_lifecycle_transition_at: string | null;
  scheduled_deletion_at: string | null;
  entitlement_state: string | null;
};

/**
 * Snapshot the meaningful fields of a row right before destroy. Read by
 * support/ops on user request to restore profile config + names when a
 * user re-signs up after auto-deletion. See migration
 * 20260509080000_instance_deletion_archives for the table.
 */
function buildArchivePayload(instance: PurgeCandidate): Record<string, unknown> {
  return {
    name: instance.name,
    subdomain: instance.subdomain,
    gateway_url: instance.gateway_url,
    infrastructure_provider: instance.infrastructure_provider,
    proxmox_node: instance.proxmox_node,
    proxmox_vmid: instance.proxmox_vmid,
    host_id: instance.host_id,
    hetzner_server_id: instance.hetzner_server_id,
    ipv4_address: instance.ipv4_address,
    config: instance.config,
    resource_tier: instance.resource_tier,
    cpu_limit: instance.cpu_limit,
    ram_limit: instance.ram_limit,
    disk_size_gb: instance.disk_size_gb,
    created_at: instance.created_at,
    last_lifecycle_transition_at: instance.last_lifecycle_transition_at,
    scheduled_deletion_at: instance.scheduled_deletion_at,
    status_at_deletion: instance.status,
    lifecycle_state_at_deletion: instance.lifecycle_state,
    entitlement_state_at_deletion: instance.entitlement_state,
  };
}

/**
 * Inferred deletion reason for the audit trail. The purge-expired cron
 * handles two intake paths: scheduled_for_deletion (which the
 * stale-suspended sweeper sets via the auto-idle policy) and the legacy
 * stranded-deleted repair branch.
 */
function inferDeletionReason(instance: PurgeCandidate): string {
  if (instance.status === "deleted") return "stranded_deleted_repair";
  if (instance.lifecycle_state === "suspended") {
    return instance.entitlement_state === "ok"
      ? "auto_idle_unexpected_paying_ok"
      : "auto_idle_suspended";
  }
  if (instance.status === "scheduled_for_deletion") return "scheduled_for_deletion";
  return "unknown";
}

/**
 * GET /api/cron/purge-expired
 *
 * Invoked daily at midnight by Vercel Cron (see vercel.json).
 * Finds all instances that are:
 *   - status = "scheduled_for_deletion"
 *   - scheduled_deletion_at <= now
 * Then permanently destroys the Hetzner server and marks the
 * Supabase record as "deleted". Rows whose user_id is not an account id the
 * app issues are refused and reported instead (see isPlatformAccountId).
 *
 * Protected by CRON_SECRET — Vercel automatically sends this in the
 * Authorization header when invoking cron routes.
 */
export async function GET(req: NextRequest) {
  const ctx = await getRequestContext(req, { source: SOURCE, skipAuth: true });

  // Validate the cron secret so this endpoint can't be triggered publicly
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      ...ctx,
      failureType: "missing_cron_secret",
    });
    return apiError("Cron secret is not configured", 500, undefined, undefined, { ctx });
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401, undefined, undefined, { ctx });
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500, undefined, undefined, { ctx });
  }

  const now = new Date().toISOString();

  // Find all instances that have passed their deletion deadline.
  // `config` + `host_id` are pulled so we can branch by infra:
  //   - Proxmox VMs are torn down via deleteProxmoxInstance(config.infrastructure).
  //   - Shared-Hetzner-host rows (host_id set) leave the host alone — only the
  //     Supabase row gets soft-deleted; the shared server lives on for its
  //     other tenants.
  //   - Single-tenant Hetzner rows (hetzner_server_id, no host_id) get the
  //     server destroyed, the long-standing behaviour.
  const { data: expiredInstances, error: fetchError } = await supabaseAdmin
    .from("hermes_instances")
    .select(PURGE_INSTANCE_SELECT)
    .eq("status", "scheduled_for_deletion")
    .lte("scheduled_deletion_at", now);

  // Repair old split-brain deletion rows too. These have already been marked
  // status='deleted' by the app, but still carry lifecycle_state + a real VM
  // handle (proxmox_vmid OR hetzner_server_id), so they can leave a VM running
  // (and billing) forever. Provider-agnostic so legacy Hetzner zombies are
  // caught too — the active-subscription guard in the loop below ensures a live
  // customer wrongly marked deleted is skipped + alerted, never destroyed.
  const { data: strandedDeletedInstances, error: strandedFetchError } = await supabaseAdmin
    .from("hermes_instances")
    .select(PURGE_INSTANCE_SELECT)
    .eq("status", "deleted")
    .neq("lifecycle_state", "deleted")
    .or("proxmox_vmid.not.is.null,hetzner_server_id.not.is.null");

  if (fetchError || strandedFetchError) {
    // Only the error class name is logged — the raw `fetchError.message`
    // could include row data echoed back from Postgres.
    log.error("failed to fetch expired instances", new Error("supabase_query_failed"), {
      ...ctx,
      failureType: "supabase_query_failed",
      errorName: (() => {
        const queryError = fetchError || strandedFetchError;
        return queryError instanceof Error ? queryError.name : typeof queryError;
      })(),
    });
    return apiError("Failed to query instances", 500, undefined, undefined, { ctx });
  }

  const instancesById = new Map<string, PurgeCandidate>();
  for (const instance of (expiredInstances || []) as PurgeCandidate[]) {
    instancesById.set(instance.id, instance);
  }
  for (const instance of (strandedDeletedInstances || []) as PurgeCandidate[]) {
    instancesById.set(instance.id, instance);
  }
  const purgeCandidates = Array.from(instancesById.values());

  if (purgeCandidates.length === 0) {
    log.info("no expired instances to purge", { ...ctx });
    // An empty sweep is still a successful run — stamp the dead-man heartbeat
    // so a no-op night doesn't look like the cron going dark.
    await recordCronHeartbeat("purge-expired");
    return apiSuccess({ purged: 0 }, 200, ctx);
  }

  log.info("expired instances found", { ...ctx, count: purgeCandidates.length });

  const { deleteServer } = await import("@/lib/hetzner/client");

  const results: { id: string; name: string; success: boolean; error?: string }[] = [];

  // Safety invariant (regression guard for the 2026-05 Hetzner zombie incident,
  // where active trials/subs were marked deleted but left running): NEVER
  // auto-destroy a STRANDED-deleted instance whose owner still has an
  // active/trialing/past_due subscription. That combination means the 'deleted'
  // status is a lifecycle/billing mismatch, not a real teardown. Look the
  // owners up once (batched) so we can skip + alert those candidates below.
  // Deliberate scheduled_for_deletion rows are NOT guarded (those are real).
  const strandedOwnerIds = Array.from(
    new Set(
      purgeCandidates
        .filter((c) => c.status === "deleted" && c.user_id)
        .map((c) => c.user_id),
    ),
  );
  const ownersWithPlanAccess = new Set<string>();
  // FAIL CLOSED: if we can't establish the allow-list, we MUST NOT proceed to
  // destroy stranded-deleted rows with an empty (assume-nobody-pays) set — that
  // is exactly the 2026-05 customer-deletion incident. A null/errored lookup is
  // indistinguishable from "no paying owners" downstream, so a transient
  // hermes_subscriptions read failure would silently strip the guard and nuke
  // live customers. Track whether the lookup succeeded; if not, skip every
  // stranded-deleted candidate this run (the deliberate scheduled_for_deletion
  // rows are unaffected and proceed normally).
  let strandedAllowListResolved = true;
  if (strandedOwnerIds.length > 0) {
    const { data: ownerSubs, error: ownerSubsError } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("user_id, status")
      .in("user_id", strandedOwnerIds);
    if (ownerSubsError || ownerSubs == null) {
      strandedAllowListResolved = false;
      log.error(
        "subscription allow-list lookup failed; failing closed on stranded-deleted purge",
        new Error("stranded_owner_subscription_lookup_failed"),
        {
          ...ctx,
          failureType: "stranded_owner_subscription_lookup_failed",
          strandedOwnerCount: strandedOwnerIds.length,
          errorName: ownerSubsError ? ownerSubsError.name ?? typeof ownerSubsError : "null_result",
        },
      );
      await reportOpsEvent({
        source: "instance.purge_aborted_sub_lookup_failed",
        severity: "error",
        title: "Purge aborted: subscription allow-list lookup failed",
        message:
          `purge-expired could not load hermes_subscriptions for ${strandedOwnerIds.length} ` +
          `stranded-deleted owner(s), so it FAILED CLOSED and skipped all stranded-deleted ` +
          `destroys this run rather than risk nuking a live paying customer's VM. ` +
          `Scheduled-for-deletion purges still ran. Re-run once the DB is healthy.`,
        route: "/api/cron/purge-expired",
        metadata: {
          stranded_owner_count: strandedOwnerIds.length,
          failure_type: "stranded_owner_subscription_lookup_failed",
        },
      });
    } else {
      for (const sub of (ownerSubs ?? []) as { user_id?: string; status?: string | null }[]) {
        if (sub.user_id && hasPlanAccessStatus(sub.status)) {
          ownersWithPlanAccess.add(sub.user_id);
        }
      }
    }
  }

  for (const instance of purgeCandidates) {
    try {
      // Every application path writes user_id from a Clerk user id (or the
      // self-host operator). Any other owner means the row did not come from
      // the app (for example one written with a Supabase Auth JWT, whose `sub`
      // is a UUID), so the server or VM it names may belong to someone else.
      // Refuse before anything is archived, torn down or marked deleted.
      if (!isPlatformAccountId(instance.user_id)) {
        log.error(
          "refusing to purge instance: owner is not a platform account",
          new Error("purge_blocked_unknown_owner"),
          {
            ...ctx,
            instanceId: instance.id,
            failureType: "purge_blocked_unknown_owner",
          },
        );
        await reportOpsEvent({
          source: "instance.purge_blocked_unknown_owner",
          severity: "error",
          title: `Purge blocked: ${instance.name} has no known owner`,
          message:
            `purge-expired refused to tear down instance ${instance.id} because its user_id ` +
            `is not an account id the app issues. No application path writes such a row, so ` +
            `do not delete the server or VM it names until someone has checked who owns it.`,
          route: "/api/cron/purge-expired",
          instanceId: instance.id,
          metadata: {
            owner_user_id: instance.user_id,
            instance_status: instance.status,
            lifecycle_state: instance.lifecycle_state,
            hetzner_server_id: instance.hetzner_server_id,
            host_id: instance.host_id,
            proxmox_node: instance.proxmox_node,
            proxmox_vmid: instance.proxmox_vmid,
          },
        });
        results.push({
          id: instance.id,
          name: instance.name,
          success: false,
          error: "skipped: owner is not a known account",
        });
        continue;
      }

      // Fail-closed companion to the active-subscription guard: if the
      // subscription allow-list could not be resolved this run, refuse to
      // destroy ANY stranded-deleted row (we can't prove the owner doesn't pay).
      if (instance.status === "deleted" && !strandedAllowListResolved) {
        log.warn(
          "skipping stranded-deleted purge: subscription allow-list unresolved (failing closed)",
          {
            ...ctx,
            instanceId: instance.id,
            ownerUserId: instance.user_id,
            failureType: "purge_skipped_sub_lookup_failed",
          },
        );
        results.push({
          id: instance.id,
          name: instance.name,
          success: false,
          error: "skipped: subscription allow-list lookup failed (fail-closed)",
        });
        continue;
      }

      if (instance.status === "deleted" && ownersWithPlanAccess.has(instance.user_id)) {
        log.warn(
          "refusing to purge stranded-deleted instance: owner has an active subscription",
          {
            ...ctx,
            instanceId: instance.id,
            ownerUserId: instance.user_id,
            failureType: "purge_blocked_active_subscription",
          },
        );
        await reportOpsEvent({
          source: "instance.purge_blocked_active_sub",
          severity: "warn",
          title: `Purge blocked: ${instance.name} marked deleted but owner pays`,
          message:
            `purge-expired refused to destroy stranded instance ${instance.id} ` +
            `because owner ${instance.user_id} has an active subscription. The ` +
            `'deleted' status is a lifecycle/billing mismatch — reconcile (restore) ` +
            `the instance instead of deleting a live customer.`,
          route: "/api/cron/purge-expired",
          userId: instance.user_id,
          instanceId: instance.id,
          metadata: {
            instance_status: instance.status,
            hetzner_server_id: instance.hetzner_server_id,
            host_id: instance.host_id,
          },
        });
        results.push({
          id: instance.id,
          name: instance.name,
          success: false,
          error: "skipped: owner has active subscription",
        });
        continue;
      }

      // Cold-archived rows have NO live VM: archiveInstance qm-destroys the
      // source VM as its final step and nulls proxmox_node/proxmox_vmid/
      // ipv4_address — but leaves `config.infrastructure` behind, so
      // resolveProxmoxLifecycleTarget re-resolves the STALE handle and the
      // teardown below SSHes a host that may be decommissioned (nightly
      // purge_instance_failed on two fixturenodea rows, 2026-07) or, worse, a since-
      // recycled VMID owned by another tenant. The data now lives as a Storage
      // Box tarball owned by the cold-retention pipeline, so hand the row off:
      // flip lifecycle to pending_deletion (keeping the already-armed
      // scheduled_deletion_at) and reset status so this cron stops re-picking
      // it; cold-retention-sweep's purgeArchive does the tarball trash + final
      // deleted transition. NEVER mark the row deleted here — that would
      // strand the archive and kill the user's restore path.
      if (instance.lifecycle_state === "cold_archived") {
        const handoffAt = new Date().toISOString();
        const { error: handoffError } = await supabaseAdmin
          .from("hermes_instances")
          .update({
            status: "stopped",
            lifecycle_state: "pending_deletion",
            last_lifecycle_transition_at: handoffAt,
            updated_at: handoffAt,
          })
          .eq("id", instance.id)
          .eq("lifecycle_state", "cold_archived");
        if (handoffError) {
          throw new Error(
            `Failed to hand cold-archived row to cold-retention pipeline: ${handoffError.message || "unknown"}`
          );
        }
        log.info(
          "cold-archived instance handed off to cold-retention pipeline (no VM to tear down)",
          {
            ...ctx,
            instanceId: instance.id,
            instanceName: instance.name,
            ownerUserId: instance.user_id,
            scheduledDeletionAt: instance.scheduled_deletion_at,
          },
        );
        results.push({ id: instance.id, name: instance.name, success: true });
        continue;
      }

      const deletionReason = inferDeletionReason(instance);

      // Step 0: Snapshot the row into instance_deletion_archives BEFORE the
      // VM is destroyed. If the archive write fails we still proceed —
      // dropping the destroy because the audit table hiccupped would be
      // disproportionate. The archive is a recovery convenience, not a gate.
      const archiveExpiresAt = new Date(
        Date.now() + ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { error: archiveError } = await supabaseAdmin
        .from("instance_deletion_archives")
        .insert({
          original_instance_id: instance.id,
          user_id: instance.user_id,
          archive: buildArchivePayload(instance),
          deletion_reason: deletionReason,
          expires_at: archiveExpiresAt,
        });
      if (archiveError) {
        log.warn("failed to write deletion archive; continuing with purge", {
          ...ctx,
          instanceId: instance.id,
          failureType: "deletion_archive_write_failed",
          errorName: archiveError.name ?? typeof archiveError,
        });
      }

      // Step 1: Tear down the runtime, branching on infra type.
      // Use the column-aware resolver so legacy rows (config.infrastructure
      // null but proxmox_vmid + gateway_url set) still get their VM destroyed.
      const proxmoxInfra = resolveProxmoxLifecycleTarget(instance);
      const proxmoxBacked = isProxmoxBackedInstanceRow(instance);
      if (proxmoxBacked && !proxmoxInfra) {
        throw new Error(
          "proxmox-backed row missing infrastructure handle (no vmid + ipv4 + gateway_url); refusing to purge",
        );
      }
      if (proxmoxInfra) {
        const { deleteProxmoxInstance } = await import(
          "@/lib/services/proxmox-instance-service"
        );
        const result = await deleteProxmoxInstance(proxmoxInfra, {
          hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, { host_id: instance.host_id ?? null }),
          expectedInstanceId: instance.id,
        });
        if (!result.ok) {
          // Proxmox script errored — surface the failure so we don't mark the
          // Supabase row deleted while the VM is still alive.
          throw new Error(
            `proxmox delete failed: ${(result.error || result.stderr || "unknown").slice(0, 240)}`,
          );
        }
        log.info("proxmox vm deleted", {
          ...ctx,
          instanceId: instance.id,
          proxmoxVmid: proxmoxInfra.vmid,
        });

        // Audit trail: record the destroy on ops_events so support can answer
        // "when was VM X actually destroyed?" without grepping logs.
        await reportOpsEvent({
          source: "instance.purge_destroyed",
          severity: "warn",
          title: `Auto-purged Proxmox VM ${proxmoxInfra.vmid}`,
          message:
            `purge-expired cron destroyed Proxmox VMID ${proxmoxInfra.vmid} ` +
            `(reason=${deletionReason}) for instance ${instance.id}`,
          route: "/api/cron/purge-expired",
          userId: instance.user_id,
          instanceId: instance.id,
          metadata: {
            deletion_reason: deletionReason,
            proxmox_node: instance.proxmox_node,
            proxmox_vmid: proxmoxInfra.vmid,
            gateway_url: instance.gateway_url,
            scheduled_deletion_at: instance.scheduled_deletion_at,
            archive_expires_at: archiveExpiresAt,
          },
        });
      } else if (instance.host_id) {
        // Shared host — purge the row but leave the server alone for other tenants.
        log.info("shared-host instance purged from supabase only; server left running", {
          ...ctx,
          instanceId: instance.id,
          hostId: instance.host_id,
        });
      } else if (instance.hetzner_server_id) {
        try {
          await deleteServer(instance.hetzner_server_id);
          log.info("hetzner server deleted", {
            ...ctx,
            instanceId: instance.id,
            hetznerServerId: instance.hetzner_server_id,
          });
          await reportOpsEvent({
            source: "instance.purge_destroyed",
            severity: "warn",
            title: `Auto-purged Hetzner server ${instance.hetzner_server_id}`,
            message:
              `purge-expired cron destroyed Hetzner server ${instance.hetzner_server_id} ` +
              `(reason=${deletionReason}) for instance ${instance.id}`,
            route: "/api/cron/purge-expired",
            userId: instance.user_id,
            instanceId: instance.id,
            metadata: {
              deletion_reason: deletionReason,
              hetzner_server_id: instance.hetzner_server_id,
              gateway_url: instance.gateway_url,
              scheduled_deletion_at: instance.scheduled_deletion_at,
              archive_expires_at: archiveExpiresAt,
            },
          });
        } catch (hetznerErr) {
          const msg = hetznerErr instanceof Error ? hetznerErr.message : String(hetznerErr);
          // If Hetzner says 404, the server is already gone — treat as success
          if (!msg.includes("404")) {
            throw hetznerErr;
          }
          log.warn("hetzner server already deleted (404)", {
            ...ctx,
            instanceId: instance.id,
            hetznerServerId: instance.hetzner_server_id,
          });
        }
      }

      await removeInstanceDnsBestEffort(instance.subdomain, {
        ...ctx,
        instanceId: instance.id,
      });

      // Step 2: Mark the instance as deleted in Supabase, and release any
      // active Proxmox VMID claim so future provisions can reuse the slot.
      const deletedAt = new Date().toISOString();
      const { error: markDeletedError } = await supabaseAdmin
        .from("hermes_instances")
        .update({
          status: "deleted",
          lifecycle_state: "deleted",
          proxmox_vmid: null,
          scheduled_deletion_at: null,
          deleted_at: deletedAt,
          last_lifecycle_transition_at: deletedAt,
          updated_at: deletedAt,
        })
        .eq("id", instance.id);

      // The supabase-js client resolves with `{ error }` rather than
      // throwing. Without this check the VM/server gets destroyed (above)
      // and a failed DB write would be reported as a successful purge,
      // leaving an orphan row the next run won't re-pick. Throw so it's
      // recorded as a failure and re-attempted (teardown above is
      // idempotent: Hetzner 404s and the VMID release are safe to repeat).
      if (markDeletedError) {
        throw new Error(
          `Failed to mark instance deleted after teardown: ${markDeletedError.message || "unknown"}`
        );
      }

      log.info("instance fully purged", {
        ...ctx,
        instanceId: instance.id,
        instanceName: instance.name,
        ownerUserId: instance.user_id,
      });
      results.push({ id: instance.id, name: instance.name, success: true });
    } catch (err) {
      // Only error class name in logs — the original error may contain
      // Hetzner / SSH output with embedded credentials.
      log.error("failed to purge instance", new Error("purge_instance_failed"), {
        ...ctx,
        instanceId: instance.id,
        failureType: "purge_instance_failed",
        errorName: err instanceof Error ? err.name : typeof err,
      });
      results.push({
        id: instance.id,
        name: instance.name,
        success: false,
        error: PURGE_INSTANCE_FAILURE_MESSAGE,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  log.info("purge sweep complete", {
    ...ctx,
    successCount,
    failCount,
  });

  // Dead-man heartbeat: the sweep ran to completion (per-instance failures are
  // recorded in `results`, not a cron-level failure). Best-effort.
  await recordCronHeartbeat("purge-expired");

  return apiSuccess({
    purged: successCount,
    failed: failCount,
    results,
  }, 200, ctx);
}
