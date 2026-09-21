import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";

import { agentWebApi } from "@/lib/agent-web-api";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import type { HermesWebToolset } from "@/lib/hermes-web";
import { getInstanceBackend } from "@/lib/instance-backend";
import { isWebfreeBackend } from "@/lib/types/instance";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { sanitizeDockerName } from "@/lib/services/profile-service";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TOOLSETS_UPSTREAM_ERROR = "Agent toolsets request failed.";
const TOOLSET_TOGGLE_UPSTREAM_ERROR = "Agent toolset toggle request failed.";

const toolsetToggleSchema = z.object({
  name: z.string().trim().min(1, "Toolset name is required"),
  enabled: z.boolean(),
  platform: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i).optional().default("cli"),
});

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
    return apiError("Agent toolsets request timed out. The agent may still be booting.", 504, {
      failureType: "toolsets_request_failed",
      retryable: true,
    });
  }
  if (isInvalidJsonError(err)) {
    return apiError("Agent returned invalid JSON", 502, {
      failureType: "toolsets_request_failed",
      retryable: false,
      reason: "invalid_json",
    });
  }
  return handleApiError(err);
}

function applyToolsetToggleToConfig(params: {
  config: Record<string, unknown>;
  toolsets: HermesWebToolset[];
  name: string;
  enabled: boolean;
  platform: string;
}): Record<string, unknown> {
  const nextConfig = { ...params.config };
  const knownToolsetNames = new Set(params.toolsets.map((toolset) => toolset.name));
  const enabledToolsetNames = new Set(
    params.toolsets
      .filter((toolset) => toolset.enabled === true)
      .map((toolset) => toolset.name)
  );

  if (params.enabled) {
    enabledToolsetNames.add(params.name);
  } else {
    enabledToolsetNames.delete(params.name);
  }

  const platformToolsets =
    nextConfig.platform_toolsets &&
    typeof nextConfig.platform_toolsets === "object" &&
    !Array.isArray(nextConfig.platform_toolsets)
      ? nextConfig.platform_toolsets as Record<string, unknown>
      : {};

  const existingForPlatformRaw = platformToolsets[params.platform];
  const existingForPlatform = Array.isArray(existingForPlatformRaw)
    ? existingForPlatformRaw.filter((value: unknown): value is string => typeof value === "string")
    : [];

  const platformDefaultToolset = `hermes-${params.platform}`;
  const preservedEntries = existingForPlatform.filter((entry: string) =>
    !knownToolsetNames.has(entry) && entry !== platformDefaultToolset
  );

  nextConfig.platform_toolsets = {
    ...platformToolsets,
    [params.platform]: Array.from(new Set([...enabledToolsetNames, ...preservedEntries]))
      .sort((left, right) => left.localeCompare(right)),
  };

  return nextConfig;
}

async function fetchToolsets(api: Awaited<ReturnType<typeof agentWebApi>>): Promise<Response | HermesWebToolset[]> {
  let toolsetsRes: Response;
  try {
    toolsetsRes = await api.get("/api/tools/toolsets", { timeout: 15_000 });
  } catch (err) {
    return mapGatewayError(err);
  }

  if (!toolsetsRes.ok) {
    await toolsetsRes.text().catch(() => toolsetsRes.statusText);
    return apiError(TOOLSETS_UPSTREAM_ERROR, toolsetsRes.status, {
      failureType: "toolsets_request_failed",
      retryable: false,
      upstreamStatus: toolsetsRes.status,
    });
  }

  let toolsetsData: unknown;
  try {
    toolsetsData = await toolsetsRes.json();
  } catch (err) {
    return mapGatewayError(err);
  }

  if (!Array.isArray(toolsetsData)) {
    return apiError("Agent returned an unexpected toolsets payload", 502);
  }

  return toolsetsData as HermesWebToolset[];
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

    const toolsetsData = await fetchToolsets(api);
    if (toolsetsData instanceof Response) {
      return toolsetsData;
    }

    return apiSuccess(toolsetsData);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const body = toolsetToggleSchema.parse(await req.json());
    const { id } = await params;
    const backend = await getInstanceBackend(id, userId);
    if (isWebfreeBackend(backend)) {
      return apiError("This runtime does not expose dashboard toolset toggles yet.", 501, {
        failureType: "toolset_toggle_unsupported",
        retryable: false,
        name: body.name,
      });
    }

    const api = await agentWebApi(id, userId);

    const toolsets = await fetchToolsets(api);
    if (toolsets instanceof Response) {
      return toolsets;
    }
    if (!toolsets.some((toolset) => toolset.name === body.name)) {
      return apiError(`Toolset '${body.name}' not found`, 404);
    }

    if (!supabaseAdmin) {
      throw new Error("Database not configured");
    }

    const { data: instance, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !instance) {
      return apiError("Instance not found", 404);
    }

    const ip = await resolveInstanceIpv4(instance as HermesInstanceRow);
    if (!ip) {
      return apiError("Server has no public IPv4", 502);
    }

    const configRes = await api.get("/api/config", { timeout: 15_000 });
    if (!configRes.ok) {
      await configRes.text().catch(() => configRes.statusText);
      return apiError(TOOLSET_TOGGLE_UPSTREAM_ERROR, configRes.status, {
        failureType: "toolset_toggle_failed",
        retryable: false,
        upstreamStatus: configRes.status,
        reason: "config_fetch_failed",
      });
    }

    let currentConfig: unknown;
    try {
      currentConfig = await configRes.json();
    } catch (err) {
      return mapGatewayError(err);
    }

    if (!currentConfig || typeof currentConfig !== "object" || Array.isArray(currentConfig)) {
      return apiError("Agent returned an unexpected config payload", 502);
    }

    const nextConfig = applyToolsetToggleToConfig({
      config: currentConfig as Record<string, unknown>,
      toolsets,
      name: body.name,
      enabled: body.enabled,
      platform: body.platform,
    });

    await putHermesConfigWithBindMountFallback({
      api,
      config: nextConfig,
      containerName: `agent-${sanitizeDockerName(id)}`,
      hermesHomeDir: resolveHermesHomeDirFromConfig(
        instance.config as Record<string, unknown> | undefined
      ),
      ip,
      instanceId: id,
      userId,
    });

    return apiSuccess({
      ok: true,
      name: body.name,
      enabled: body.enabled,
      platform: body.platform,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
