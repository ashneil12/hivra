import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  buildInstanceActivityDigest,
  type ActivityDigestInstance,
} from "@/lib/command-center/activity";
import { log } from "@/lib/logger";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { resolveWebUIInstanceClient } from "@/lib/webui/instance";
import type { WebUISession, WebUIStatusResponse } from "@/lib/webui/types";
import type { WebUIHealthSummary } from "@/lib/command-center/activity";
import { isWebfreeBackend } from "@/lib/types/instance";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function secureInstanceErrorStatus(error: string) {
  if (error === "Instance not found or unauthorized") return 404;
  if (error === "Instance is not currently running") return 400;
  return 503;
}

function activityInstanceFrom(instance: {
  id: string;
  status: string;
  backend?: string | null;
  name?: unknown;
}): ActivityDigestInstance {
  return {
    id: instance.id,
    name: typeof instance.name === "string" ? instance.name : null,
    status: instance.status,
    backend: instance.backend ?? null,
  };
}

// Adapt the agent dashboard's /api/status payload to the digest's health
// shape. `active_streams` (hermes-webui's "responding" signal) maps to the
// agent's `active_agents` — the count of agents producing output right now.
function healthSummaryFromStatus(status: WebUIStatusResponse): WebUIHealthSummary {
  return {
    status: typeof status.gateway_state === "string" ? status.gateway_state : undefined,
    sessions: typeof status.active_sessions === "number" ? status.active_sessions : undefined,
    active_streams: typeof status.active_agents === "number" ? status.active_agents : undefined,
  };
}

async function readRecentSessions(client: {
  listSessions: () => Promise<WebUISession[]>;
}) {
  try {
    return await client.listSessions();
  } catch (error) {
    log.warn("failed to read WebUI sessions for activity digest", {
      source: "command-center-activity",
      route: "/api/instances/[id]/activity",
      method: "GET",
      failureType: "webui_activity_sessions_failed",
    }, error);
    return [];
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { userId } = await auth();
  if (!userId) {
    return apiError("Unauthorized", 401, undefined, undefined, {
      source: "command-center-activity",
      route: "/api/instances/[id]/activity",
      method: "GET",
      failureType: "unauthorized",
    });
  }

  const { id } = await params;
  const secureInstance = await getSecureUserInstance({
    id,
    userId,
    requireRunning: false,
  });

  if (secureInstance.error || !secureInstance.instance) {
    return apiError(secureInstance.error || "Instance not found or unauthorized", secureInstanceErrorStatus(secureInstance.error || ""), undefined, undefined, {
      source: "command-center-activity",
      route: "/api/instances/[id]/activity",
      method: "GET",
      instanceId: id,
      userId,
      failureType: "instance_access_failed",
    });
  }

  const activityInstance = activityInstanceFrom(secureInstance.instance);
  if (activityInstance.status.toLowerCase() !== "running" || !isWebfreeBackend(activityInstance.backend)) {
    return apiSuccess(buildInstanceActivityDigest({
      instance: activityInstance,
      health: null,
      sessions: [],
    }));
  }

  const resolved = await resolveWebUIInstanceClient({
    instanceId: id,
    userId,
    requireRunning: true,
  });

  if (!resolved.ok) {
    return apiSuccess(buildInstanceActivityDigest({
      instance: activityInstance,
      health: null,
      sessions: [],
      unreachable: true,
    }));
  }

  try {
    const [status, sessions] = await Promise.all([
      resolved.client.status(),
      readRecentSessions(resolved.client),
    ]);

    return apiSuccess(buildInstanceActivityDigest({
      instance: activityInstance,
      health: healthSummaryFromStatus(status),
      sessions,
    }));
  } catch (error) {
    log.warn("failed to build WebUI activity digest", {
      source: "command-center-activity",
      route: "/api/instances/[id]/activity",
      method: "GET",
      instanceId: id,
      userId,
      failureType: "webui_activity_digest_failed",
    }, error);

    return apiSuccess(buildInstanceActivityDigest({
      instance: activityInstance,
      health: null,
      sessions: [],
      unreachable: true,
    }));
  }
}
