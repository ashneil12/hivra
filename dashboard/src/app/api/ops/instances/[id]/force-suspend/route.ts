import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isOpsAdminUser } from "@/lib/ops-access";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import { shutdownServer } from "@/lib/hetzner/client";

/**
 * POST /api/ops/instances/[id]/force-suspend
 *
 * Admin kill switch — pauses the underlying VM (Proxmox via `qm shutdown`,
 * Hetzner via `shutdownServer`) and flips the row to `lifecycle_state =
 * 'suspended'`. Idempotent: safe to call on an already-paused row, in which
 * case the underlying suspend helper is still invoked (Proxmox's
 * `shutdownProxmoxInstance` short-circuits when the VM is already stopped)
 * and the lifecycle write is replayed.
 *
 * The lifecycle write only happens when the provider shutdown SUCCEEDS. If the
 * provider call errors (VM still up), the row is left untouched, an error
 * ops event is emitted, and the route returns 502 — we never claim a tenant is
 * suspended while its VM may still be running and consuming host resources.
 *
 * Gated by `isOpsAdminUser` — non-admins get 403, unauthenticated 401.
 *
 * Logs an `ops_events` row with `source='admin.force_suspend'`,
 * `user_id=<instance owner>`, and `metadata.actor_user_id=<admin clerk id>`,
 * `metadata.instance_id=<id>`. The `ops_events` schema has no `kind` /
 * `actor_user_id` columns (see migrations 20260411133000_ops_events.sql), so
 * the action label lives in `source` and the actor lives in `metadata`.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

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
        "id, user_id, hetzner_server_id, host_id, config, status, lifecycle_state"
      )
      .eq("id", id)
      .maybeSingle();

    if (fetchError) {
      return apiError("Failed to load instance", 500, {
        failureType: "force_suspend_fetch_failed",
      });
    }
    if (!instance) {
      return apiError("Instance not found", 404);
    }

    const proxmoxInfra = getProxmoxInfrastructure(instance.config);
    let suspendError: string | null = null;

    if (proxmoxInfra) {
      const { shutdownProxmoxInstance } = await import(
        "@/lib/services/proxmox-instance-service"
      );
      const result = await shutdownProxmoxInstance(proxmoxInfra, {
        hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, { host_id: instance.host_id ?? null }),
      });
      if (!result.ok) {
        suspendError = result.error || result.stderr || "Proxmox shutdown failed";
      }
    } else if (instance.hetzner_server_id) {
      try {
        await shutdownServer(instance.hetzner_server_id);
      } catch (err) {
        suspendError = err instanceof Error ? err.message : String(err);
      }
    }

    // If the provider shutdown errored, do NOT claim the tenant is suspended:
    // flipping the row to stopped/suspended while the VM may still be RUNNING
    // creates a billing/dashboard-vs-reality divergence (the row reads
    // "suspended" but the host keeps burning CPU/RAM) that nothing reconciles.
    // Surface the failure as an error ops event and return 502 so the operator
    // retries instead of silently trusting a false "suspended" state. Mirrors
    // the force-delete (F198) provider-failure path.
    if (suspendError) {
      await reportOpsEvent({
        source: "admin.force_suspend_failed",
        severity: "error",
        title: "Admin force-suspend provider shutdown failed",
        message: `Admin ${userId} attempted force-suspend for instance ${id}, but provider shutdown failed`,
        route: "/api/ops/instances/[id]/force-suspend",
        userId: instance.user_id,
        instanceId: id,
        metadata: {
          actor_user_id: userId,
          actor_email: adminEmail,
          instance_id: id,
          previous_lifecycle_state: instance.lifecycle_state || null,
          previous_status: instance.status || null,
          provider_error: suspendError,
          provider_shutdown_failed: true,
        },
      });

      return apiError(
        "Provider shutdown failed; instance was not marked suspended",
        502,
        { failureType: "force_suspend_provider_failed" }
      );
    }

    // Provider shutdown succeeded (or the VM was already stopped) — flip the
    // lifecycle row so the dashboard surfaces "suspended" and the warden /
    // billing engine treats this user as paused.
    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        status: "stopped",
        lifecycle_state: "suspended",
        last_lifecycle_transition_at: now,
        updated_at: now,
      })
      .eq("id", id);

    if (updateError) {
      return apiError("Failed to record suspended state", 500, {
        failureType: "force_suspend_update_failed",
      });
    }

    await reportOpsEvent({
      source: "admin.force_suspend",
      severity: "warn",
      title: "Admin force-suspend",
      message: `Admin ${userId} force-suspended instance ${id}`,
      route: "/api/ops/instances/[id]/force-suspend",
      userId: instance.user_id,
      instanceId: id,
      metadata: {
        actor_user_id: userId,
        actor_email: adminEmail,
        instance_id: id,
        previous_lifecycle_state: instance.lifecycle_state || null,
        previous_status: instance.status || null,
        provider_error: suspendError,
      },
    });

    return apiSuccess({
      instance_id: id,
      action: "force_suspend",
      lifecycle_state: "suspended",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
