import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { log } from "@/lib/logger";
import type { MemorySystemConfig } from "@/lib/instance-settings";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const AGENT_TIMEOUT_MS = 5_000;
const ENDPOINT_PROBE_TIMEOUT_MS = 4_000;
const ROUTE_PATH = "/api/instances/[id]/memory/status";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { id } = await params;

  const { data: instance, error: instanceError } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, gateway_url, api_server_key_encrypted, config")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (instanceError || !instance) return apiError("Instance not found", 404);

  const config = (instance.config ?? {}) as { memorySystem?: MemorySystemConfig };
  const memSys = config.memorySystem;
  const dbProvider = memSys?.provider ?? null;

  let agentProvider: string | null = null;
  let agentReachable = false;
  let agentError: string | undefined;

  if (instance.gateway_url && instance.api_server_key_encrypted) {
    try {
      const apiKey = decryptApiKey(instance.api_server_key_encrypted);
      const url = new URL(instance.gateway_url);
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl: `${url.protocol}//${url.host}`,
        pathname: "/api/config",
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Connection: "close",
        },
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      if (response.ok) {
        const cfg = (await response.json()) as { memory?: { provider?: string } };
        agentProvider = cfg?.memory?.provider ?? null;
        agentReachable = true;
      } else {
        agentError = `Agent /api/config returned HTTP ${response.status}`;
      }
    } catch (err) {
      agentError = err instanceof Error ? err.message : "Agent unreachable";
    }
  } else {
    agentError = "Agent has not been deployed yet";
  }

  let endpointHealthy: boolean | undefined;
  let endpointError: string | undefined;
  let endpointLatencyMs: number | undefined;

  if (dbProvider === "openviking" && memSys?.openVikingEndpoint) {
    const probeResult = await probeOpenVikingEndpoint(memSys.openVikingEndpoint, {
      userId,
      instanceId: id,
    });
    endpointHealthy = probeResult.ok;
    endpointError = probeResult.error;
    endpointLatencyMs = probeResult.latencyMs;
  }

  // F100: a plain boolean conflated "the agent confirmed no drift" with "we
  // couldn't tell because the agent was unreachable / reported no provider".
  // Compute a tri-state so the UI can show "unknown" distinctly from a
  // confirmed "in sync". `drift` is kept as a boolean for backward compat
  // (only true on a CONFIRMED mismatch); `driftStatus` carries the nuance.
  let driftStatus: "drift" | "no_drift" | "unknown";
  if (!dbProvider) {
    // No provider configured in the DB → nothing to compare against.
    driftStatus = "no_drift";
  } else if (!agentReachable || !agentProvider) {
    // We have a configured provider but the live agent didn't tell us what
    // it's actually running — we genuinely don't know if it drifted.
    driftStatus = "unknown";
  } else if (agentProvider !== dbProvider) {
    driftStatus = "drift";
  } else {
    driftStatus = "no_drift";
  }

  const drift = driftStatus === "drift";

  return apiSuccess({
    dbProvider,
    agentProvider,
    agentReachable,
    drift,
    driftStatus,
    ...(endpointHealthy !== undefined ? { endpointHealthy } : {}),
    ...(endpointError ? { endpointError } : {}),
    ...(endpointLatencyMs !== undefined ? { endpointLatencyMs } : {}),
    ...(agentError ? { agentError } : {}),
  });
}

function unsafeEndpointResult(params: {
  userId: string;
  instanceId: string;
  target: "endpoint" | "probe";
  reason: string;
}): { ok: false; error: string } {
  log.warn("blocked unsafe saved memory endpoint probe", {
    source: "memory-status",
    route: ROUTE_PATH,
    method: "GET",
    userId: params.userId,
    instanceId: params.instanceId,
    failureType: "unsafe_saved_memory_endpoint",
    target: params.target,
    reason: params.reason,
  });

  return { ok: false, error: "Endpoint is not allowed from this dashboard host." };
}

async function probeOpenVikingEndpoint(endpoint: string, context: {
  userId: string;
  instanceId: string;
}): Promise<{
  ok: boolean;
  error?: string;
  latencyMs?: number;
}> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: "Saved endpoint is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Unsupported scheme: ${url.protocol}` };
  }
  const endpointSafety = checkOutboundUrlSafety(endpoint);
  if (!endpointSafety.ok) {
    return unsafeEndpointResult({
      ...context,
      target: "endpoint",
      reason: endpointSafety.reason,
    });
  }

  const probeUrl = new URL("/health", url).toString();
  const probeSafety = checkOutboundUrlSafety(probeUrl);
  if (!probeSafety.ok) {
    return unsafeEndpointResult({
      ...context,
      target: "probe",
      reason: probeSafety.reason,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await ssrfSafeFetch(probeUrl, {
      method: "GET",
      headers: { Accept: "*/*" },
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) return { ok: true, latencyMs };
    return { ok: false, error: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      latencyMs,
      error: aborted
        ? `No response within ${ENDPOINT_PROBE_TIMEOUT_MS}ms`
        : "Endpoint did not respond",
    };
  } finally {
    clearTimeout(timer);
  }
}
