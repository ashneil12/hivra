import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { log } from "@/lib/logger";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";

const BodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
  healthPath: z.string().max(256).optional(),
  apiKey: z.string().max(2048).optional(),
});

const PROBE_TIMEOUT_MS = 4000;
const ROUTE_PATH = "/api/memory/test-connection";

function unsafeEndpointResponse(userId: string, target: "endpoint" | "probe", reason: string) {
  log.warn("blocked unsafe memory connection probe", {
    source: "memory-test-connection",
    route: ROUTE_PATH,
    method: "POST",
    userId,
    failureType: "unsafe_outbound_probe_url",
    target,
    reason,
  });

  return apiSuccess({
    ok: false,
    error: "Endpoint is not allowed from this dashboard host.",
  });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const limited = enforceAuthenticatedRouteRateLimit(req, {
    routeKey: "memory_test_connection",
    userId,
    ...RATE_LIMIT_PRESETS.settingsWrite,
  });
  if (limited) return limited;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return apiError("Invalid request body", 400);
  }

  let url: URL;
  try {
    url = new URL(body.endpoint);
  } catch {
    return apiSuccess({ ok: false, error: "Endpoint is not a valid URL." });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return apiSuccess({
      ok: false,
      error: `Unsupported scheme "${url.protocol}". Use http or https.`,
    });
  }
  const endpointSafety = checkOutboundUrlSafety(body.endpoint);
  if (!endpointSafety.ok) {
    return unsafeEndpointResponse(userId, "endpoint", endpointSafety.reason);
  }

  const healthPath = body.healthPath?.trim() || "/health";
  const probeUrl = new URL(healthPath, url).toString();
  const probeSafety = checkOutboundUrlSafety(probeUrl);
  if (!probeSafety.ok) {
    return unsafeEndpointResponse(userId, "probe", probeSafety.reason);
  }

  const headers: Record<string, string> = { Accept: "*/*" };
  if (body.apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${body.apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await ssrfSafeFetch(probeUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - startedAt;
    return apiSuccess({
      ok: res.ok,
      status: res.status,
      latencyMs,
      ...(res.ok ? {} : { error: `HTTP ${res.status} from ${probeUrl}` }),
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const aborted = err instanceof Error && err.name === "AbortError";
    return apiSuccess({
      ok: false,
      latencyMs,
      error: aborted
        ? `No response within ${PROBE_TIMEOUT_MS}ms — endpoint may be unreachable from this dashboard host.`
        : "Connection failed — endpoint did not respond.",
    });
  } finally {
    clearTimeout(timer);
  }
}
