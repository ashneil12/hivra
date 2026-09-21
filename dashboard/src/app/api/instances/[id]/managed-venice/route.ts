import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  RATE_LIMIT_PRESETS,
  enforceAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import { getPublicInstanceConfig } from "@/lib/instance-settings";
import { log } from "@/lib/logger";
import {
  disableManagedVeniceForWebUIInstance,
  enableManagedVeniceForWebUIInstance,
  ManagedVeniceEnableError,
} from "@/lib/venice/managed-webui-enable";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";

const EnableManagedVeniceSchema = z.object({
  walletType: z.enum(["hermesos", "card"]).optional().default("hermesos"),
  model: z.string().trim().max(255).optional(),
  apply: z.boolean().optional().default(true),
});

const DisableManagedVeniceSchema = z.object({
  apiKey: z.string().trim().min(1, "Venice API key is required").max(512),
  model: z.string().trim().max(255).optional(),
  apply: z.boolean().optional().default(true),
});

function dashboardEnableUrl(walletType: "hermesos" | "card") {
  return `${getDashboardOrigin()}/dashboard/billing?managedVenice=deposit&wallet=${encodeURIComponent(walletType)}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let userIdForLog: string | null = null;
  let instanceIdForLog: string | null = null;

  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "instances_managed_venice_post",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { id } = await params;
    instanceIdForLog = id;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const parsed = EnableManagedVeniceSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice enablement request.", 400, {
        failureType: "managed_venice_enable_invalid_request",
      });
    }

    const result = await enableManagedVeniceForWebUIInstance(
      {
        instanceId: id,
        userId,
        walletType: parsed.data.walletType,
        model: parsed.data.model,
        apply: parsed.data.apply,
      },
      {
        dashboardEnableUrl: dashboardEnableUrl(parsed.data.walletType),
      }
    );

    return apiSuccess({
      managedVenice: result.managedVenice,
      applied: result.applied,
      applyError: result.applyError,
      instance: {
        ...result.instance,
        config: getPublicInstanceConfig(result.instance.config ?? undefined),
        api_key_encrypted: undefined,
        api_key_preview: result.instance.api_key_preview,
      },
    });
  } catch (error) {
    if (error instanceof ManagedVeniceEnableError) {
      return apiError(error.message, error.status, {
        failureType: error.failureType,
      });
    }

    log.error("managed Venice enablement route failed", error, {
      source: "instances/[id]/managed-venice",
      route: "/api/instances/[id]/managed-venice",
      method: "POST",
      userId: userIdForLog,
      instanceId: instanceIdForLog,
      failureType: "managed_venice_enable_route_failed",
    });

    return apiError("Managed Venice could not be enabled for this agent.", 500, {
      failureType: "managed_venice_enable_route_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let userIdForLog: string | null = null;
  let instanceIdForLog: string | null = null;

  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "instances_managed_venice_delete",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { id } = await params;
    instanceIdForLog = id;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const parsed = DisableManagedVeniceSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400, {
        failureType: "managed_venice_disable_invalid_request",
      });
    }

    const result = await disableManagedVeniceForWebUIInstance({
      instanceId: id,
      userId,
      apiKey: parsed.data.apiKey,
      model: parsed.data.model,
      apply: parsed.data.apply,
    });

    return apiSuccess({
      byokVenice: result.byokVenice,
      applied: result.applied,
      applyError: result.applyError,
      instance: {
        ...result.instance,
        config: getPublicInstanceConfig(result.instance.config ?? undefined),
        api_key_encrypted: undefined,
        api_key_preview: result.instance.api_key_preview,
      },
    });
  } catch (error) {
    if (error instanceof ManagedVeniceEnableError) {
      return apiError(error.message, error.status, {
        failureType: error.failureType,
      });
    }

    log.error("managed Venice → BYOK route failed", error, {
      source: "instances/[id]/managed-venice",
      route: "/api/instances/[id]/managed-venice",
      method: "DELETE",
      userId: userIdForLog,
      instanceId: instanceIdForLog,
      failureType: "managed_venice_disable_route_failed",
    });

    return apiError("Managed Venice could not be switched to BYOK for this agent.", 500, {
      failureType: "managed_venice_disable_route_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
