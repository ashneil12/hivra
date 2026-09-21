import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { agentWebApi } from "@/lib/agent-web-api";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import type { HermesWebDashboardPlugin } from "@/lib/hermes-web";
import { getInstanceBackend } from "@/lib/instance-backend";
import { isWebfreeBackend } from "@/lib/types/instance";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PLUGINS_UPSTREAM_ERROR = "Agent dashboard plugins request failed.";

function isGatewayTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "TimeoutError" || /timed out/i.test(err.message);
  }
  return err instanceof Error && (err.name === "TimeoutError" || /timed out|aborted due to timeout/i.test(err.message));
}

function isInvalidJsonError(err: unknown): boolean {
  return err instanceof SyntaxError || (err instanceof Error && /invalid json/i.test(err.message));
}

function mapGatewayError(err: unknown) {
  if (isGatewayTimeoutError(err)) {
    return apiError("Agent dashboard plugins request timed out. The agent may still be booting.", 504, {
      failureType: "dashboard_plugins_request_failed",
      retryable: true,
    });
  }
  if (isInvalidJsonError(err)) {
    return apiError("Agent returned invalid JSON", 502, {
      failureType: "dashboard_plugins_request_failed",
      retryable: false,
      reason: "invalid_json",
    });
  }
  return handleApiError(err);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const backend = await getInstanceBackend(id, userId);
    if (isWebfreeBackend(backend)) {
      return apiSuccess([]);
    }

    const api = await agentWebApi(id, userId);

    let pluginsRes: Response;
    try {
      pluginsRes = await api.get("/api/dashboard/plugins", { timeout: 15_000 });
    } catch (err) {
      return mapGatewayError(err);
    }

    if (!pluginsRes.ok) {
      await pluginsRes.text().catch(() => pluginsRes.statusText);
      return apiError(PLUGINS_UPSTREAM_ERROR, pluginsRes.status, {
        failureType: "dashboard_plugins_request_failed",
        retryable: false,
        upstreamStatus: pluginsRes.status,
      });
    }

    let pluginsData: unknown;
    try {
      pluginsData = await pluginsRes.json();
    } catch (err) {
      return mapGatewayError(err);
    }

    if (!Array.isArray(pluginsData)) {
      return apiError("Agent returned an unexpected dashboard plugins payload", 502);
    }

    return apiSuccess(pluginsData as HermesWebDashboardPlugin[]);
  } catch (err) {
    return handleApiError(err);
  }
}
