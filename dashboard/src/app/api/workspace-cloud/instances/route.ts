export const runtime = "nodejs";

// Proxmox provisioning runs inline (clone → start → SSH bootstrap), same as
// the main /api/instances route — give it the Vercel Pro max.
export const maxDuration = 300;

import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { checkProvisioningGate } from "@/lib/abuse/gate";
import { getPublicInstanceConfig } from "@/lib/instance-settings";
import { resolveWorkspaceCloudEntitlement } from "@/lib/billing/instance-entitlement";
import { provisionWorkspaceCloudAgent } from "@/lib/services/workspace-cloud-provisioner";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(60).default("Workspace Cloud Agent"),
  fingerprintRequestId: z.string().optional(),
});

const ROUTE = "/api/workspace-cloud/instances";

/**
 * Hermes Workspace cloud lane — instance list/create.
 *
 * Parallel to /api/instances but scoped to product_surface='workspace_cloud':
 * GET lists only the caller's lane instances; POST always provisions into the
 * lane (forced surface) so callers can never use this route to create a
 * Hivra instance.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select(
        "id, name, status, provider, subdomain, gateway_url, api_key_preview, config, cpu_limit, ram_limit, created_at, updated_at, backend"
      )
      .eq("user_id", userId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    if (error) {
      return apiError("Failed to load instances", 500, { code: error.code }, undefined, { route: ROUTE });
    }

    return apiSuccess(
      (data ?? []).map((inst) => ({
        ...inst,
        config: getPublicInstanceConfig(inst.config),
      }))
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`workspace_cloud_create_${ip}`, {
      limit: 10,
      windowMs: 60 * 1000,
    });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });

    const json = await request.json();
    const fingerprintRequestId =
      typeof json?.fingerprintRequestId === "string" ? json.fingerprintRequestId : null;

    const user = await currentUser();
    const email =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null;

    const gate = await checkProvisioningGate({ userId, ip, email, fingerprintRequestId });
    if (!gate.allow) {
      return apiError(
        gate.message,
        gate.status,
        { failureType: `abuse_gate_${gate.reason}` },
        { reason: gate.reason },
        { route: ROUTE }
      );
    }

    const parsed = CreateSchema.safeParse(json ?? {});
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    // Lane entitlement (separate Stripe lane). Null = no active Workspace Cloud
    // subscription → caller must subscribe first.
    const sub = await resolveWorkspaceCloudEntitlement(userId);
    if (!sub) {
      return apiError(
        "An active Workspace Cloud subscription is required.",
        402,
        undefined,
        { reason: "subscription_required" },
        { route: ROUTE }
      );
    }

    // Enforce the lane's own instance limit (scoped to this surface).
    if (supabaseAdmin) {
      const { count } = await supabaseAdmin
        .from("hermes_instances")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("product_surface", "workspace_cloud")
        .neq("status", "deleted");
      if ((count ?? 0) >= sub.instance_limit) {
        return apiError(
          `Workspace Cloud agent limit reached (${sub.instance_limit}).`,
          403,
          undefined,
          undefined,
          { route: ROUTE }
        );
      }
    }

    // Provision a fresh UPSTREAM Hermes agent on the dedicated wrk1 lane.
    const result = await provisionWorkspaceCloudAgent({ userId, name: parsed.data.name });
    if (!result.ok) {
      return apiError(result.error, result.status, undefined, undefined, { route: ROUTE });
    }

    return apiSuccess(result.instance);
  } catch (err) {
    return handleApiError(err);
  }
}
