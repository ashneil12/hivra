import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { isOpsAdminUser } from "@/lib/ops-access";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getReleasedProxmoxInfrastructure,
  isProxmoxReleaseSafeForDbOnlyDelete,
  isProxmoxBackedInstanceRow,
  resolveProxmoxLifecycleTarget,
} from "@/lib/services/proxmox-infrastructure";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";
import {
  deriveDnsDomainFromGatewayUrl,
  removeInstanceDnsBestEffort,
} from "@/lib/services/cloudflare-dns";

/**
 * POST /api/ops/instances/[id]/force-delete
 *
 * Admin kill switch — destroys the underlying VM (Proxmox `qm destroy`,
 * Hetzner `deleteServer`) and flips the row to `lifecycle_state = 'deleted'`.
 * Idempotent: provider calls are wrapped so we never throw on "already
 * gone" responses, and the lifecycle write is unconditional. A row already
 * marked deleted is re-marked with the new actor in the audit trail.
 *
 * Gated by `isOpsAdminUser` — non-admins get 403, unauthenticated 401.
 *
 * Logs an `ops_events` row with `source='admin.force_delete'`,
 * `user_id=<instance owner>`, and `metadata.actor_user_id=<admin clerk id>`,
 * `metadata.instance_id=<id>`. (The `ops_events` table has no `kind` or
 * `actor_user_id` columns, so we encode the action in `source` and the
 * actor in `metadata`.)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    // Explicit-intent override for the active-subscription guard below. The
    // kill switch stays usable on a paying customer, but only when the caller
    // deliberately opts in — preventing the destructive-billing incident class
    // (deleting a live paying tenant) on an accidental/blind force-delete.
    let overrideActiveSubscription = false;
    try {
      const body = (await request.json().catch(() => null)) as
        | { overrideActiveSubscription?: unknown; force?: unknown }
        | null;
      overrideActiveSubscription =
        body?.overrideActiveSubscription === true || body?.force === true;
    } catch {
      overrideActiveSubscription = false;
    }

    const user = await currentUser();
    const adminEmail =
      user?.primaryEmailAddress?.emailAddress ||
      user?.emailAddresses?.[0]?.emailAddress ||
      null;

    if (!isOpsAdminUser({ userId, email: adminEmail })) {
      return apiError("Forbidden", 403);
    }

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { id } = await params;

    const { data: instance, error: fetchError } = await supabaseAdmin
      .from("hermes_instances")
      .select(
        "id, user_id, hetzner_server_id, host_id, config, status, lifecycle_state, infrastructure_provider, proxmox_node, proxmox_vmid, ipv4_address, gateway_url, subdomain"
      )
      .eq("id", id)
      .maybeSingle();

    if (fetchError) {
      return apiError("Failed to load instance", 500, {
        failureType: "force_delete_fetch_failed",
      });
    }
    if (!instance) {
      return apiError("Instance not found", 404);
    }

    // Active-subscription guard (destructive-billing safety): cross-check the
    // owner's subscription before destroying. If the owner has plan access
    // (active/trialing/past_due), REFUSE unless the caller passed an explicit
    // override flag. Matches the purge-expired allow-list pattern
    // (hermes_subscriptions + hasPlanAccessStatus). FAILS CLOSED: a lookup
    // error blocks the destroy too (can't prove the owner doesn't pay), still
    // overridable with explicit intent.
    if (!overrideActiveSubscription && instance.user_id) {
      const { data: ownerSubs, error: ownerSubsError } = await supabaseAdmin
        .from("hermes_subscriptions")
        .select("status")
        .eq("user_id", instance.user_id);

      const ownerHasPlanAccess =
        !ownerSubsError &&
        ownerSubs != null &&
        (ownerSubs as Array<{ status?: string | null }>).some((sub) =>
          hasPlanAccessStatus(sub.status),
        );

      if (ownerSubsError || ownerSubs == null || ownerHasPlanAccess) {
        const reason = ownerHasPlanAccess
          ? "owner_has_active_subscription"
          : "subscription_lookup_failed";
        await reportOpsEvent({
          source: "admin.force_delete_blocked",
          severity: "warn",
          title: "Admin force-delete blocked: active subscription",
          message:
            `Admin ${userId} attempted force-delete for instance ${id} but it was ` +
            `refused (${reason}). Re-submit with { "overrideActiveSubscription": true } ` +
            `to destroy a live paying tenant deliberately.`,
          route: "/api/ops/instances/[id]/force-delete",
          userId: instance.user_id,
          instanceId: id,
          metadata: {
            actor_user_id: userId,
            actor_email: adminEmail,
            instance_id: id,
            block_reason: reason,
          },
        });
        return apiError(
          ownerHasPlanAccess
            ? "Owner has an active subscription; pass overrideActiveSubscription:true to force-delete"
            : "Could not verify owner subscription; pass overrideActiveSubscription:true to force-delete",
          409,
          { failureType: "force_delete_blocked_active_subscription" },
        );
      }
    }

    // Resolve from config first, then DB columns. See proxmox-infrastructure.ts
    // for why the column fallback exists (zombie-prevention).
    const proxmoxInfra = resolveProxmoxLifecycleTarget(instance);
    const proxmoxBacked = isProxmoxBackedInstanceRow(instance);
    const proxmoxReleased = getReleasedProxmoxInfrastructure(instance.config);
    const proxmoxReleaseSafeForDbOnlyDelete =
      isProxmoxReleaseSafeForDbOnlyDelete(proxmoxReleased);
    let providerError: string | null = null;

    if (proxmoxBacked && !proxmoxInfra && !proxmoxReleaseSafeForDbOnlyDelete) {
      providerError =
        `Proxmox-backed row missing infrastructure handle and authoritative teardown receipt (release=${proxmoxReleased?.reason ?? "none"})`;
    } else if (proxmoxInfra) {
      try {
        const { deleteProxmoxInstance } = await import(
          "@/lib/services/proxmox-instance-service"
        );
        const result = await deleteProxmoxInstance(proxmoxInfra, {
          hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, { host_id: instance.host_id ?? null }),
          expectedInstanceId: id,
        });
        if (!result.ok) {
          providerError =
            result.error || result.stderr || "Proxmox destroy failed";
        }
      } catch (err) {
        providerError = err instanceof Error ? err.message : String(err);
      }
    } else if (instance.hetzner_server_id) {
      try {
        await deleteHetznerServer(instance.hetzner_server_id);
      } catch (err) {
        providerError = err instanceof Error ? err.message : String(err);
      }
    }

    if (providerError) {
      await reportOpsEvent({
        source: "admin.force_delete_failed",
        severity: "error",
        title: "Admin force-delete provider deletion failed",
        message: `Admin ${userId} attempted force-delete for instance ${id}, but provider deletion failed`,
        route: "/api/ops/instances/[id]/force-delete",
        userId: instance.user_id,
        instanceId: id,
        metadata: {
          actor_user_id: userId,
          actor_email: adminEmail,
          instance_id: id,
          previous_lifecycle_state: instance.lifecycle_state || null,
          previous_status: instance.status || null,
          provider_delete_failed: true,
        },
      });

      return apiError("Provider deletion failed; instance was not marked deleted", 502, {
        failureType: "force_delete_provider_failed",
      });
    }

    const persistedDnsDomain = deriveDnsDomainFromGatewayUrl(
      instance.gateway_url,
      instance.subdomain,
    );
    const dnsCleanupContext = {
      source: "ops.force_delete",
      route: "/api/ops/instances/[id]/force-delete",
      instanceId: id,
      userId: instance.user_id,
    };
    if (persistedDnsDomain) {
      await removeInstanceDnsBestEffort(
        instance.subdomain,
        dnsCleanupContext,
        { dnsDomain: persistedDnsDomain },
      );
    } else {
      await removeInstanceDnsBestEffort(instance.subdomain, dnsCleanupContext);
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
        deleted_at: now,
        last_lifecycle_transition_at: now,
        updated_at: now,
      })
      .eq("id", id);

    if (updateError) {
      return apiError("Failed to record deleted state", 500, {
        failureType: "force_delete_update_failed",
      });
    }

    // Best-effort success audit. The destroy + lifecycle write already
    // committed above, so an audit-transport hiccup must NOT surface as a 500
    // (that would falsely signal the force-delete failed and invite a retry).
    try {
      await reportOpsEvent({
        source: "admin.force_delete",
        severity: "warn",
        title: "Admin force-delete",
        message: `Admin ${userId} force-deleted instance ${id}`,
        route: "/api/ops/instances/[id]/force-delete",
        userId: instance.user_id,
        instanceId: id,
        metadata: {
          actor_user_id: userId,
          actor_email: adminEmail,
          instance_id: id,
          previous_lifecycle_state: instance.lifecycle_state || null,
          previous_status: instance.status || null,
          provider_error: null,
          override_active_subscription: overrideActiveSubscription,
        },
      });
    } catch {
      // swallow — destroy already succeeded; do not turn audit failure into 500
    }

    return apiSuccess({
      instance_id: id,
      action: "force_delete",
      lifecycle_state: "deleted",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
