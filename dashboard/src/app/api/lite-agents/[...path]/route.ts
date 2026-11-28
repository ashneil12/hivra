export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A model reply can take a while; the Worker itself gives up after 60 s per model.
export const maxDuration = 120;

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { readCanaryLiteQaConfig } from "@/lib/lite-agents/canary-qa";
import { callLiteWorker, liteWorkerConfig } from "@/lib/lite-agents/client";
import { isFreeCloudAgentEnabled } from "@/lib/lite-agents/flag";
import { log } from "@/lib/logger";

/**
 * The browser's only way to the Lite agent Worker. It signs each allow-listed
 * call as the signed-in user, so the Worker never sees a browser and one
 * account can never name another. Access is gated before forwarding.
 */
const MAX_BODY_BYTES = 32 * 1024;

type Context = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: Context, method: "GET" | "POST" | "PATCH" | "DELETE") {
  const canary = isCanonicalGitCanaryDeployment();
  const enabled = !canary && isFreeCloudAgentEnabled();
  const hidden = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!enabled && !canary) return hidden();

  const { userId } = await auth();
  if (!userId) return enabled ? NextResponse.json({ error: "unauthorized" }, { status: 401 }) : hidden();

  const config = canary ? await readCanaryLiteQaConfig(userId) : liteWorkerConfig();
  if (!config) return enabled ? NextResponse.json({ error: "not_configured" }, { status: 503 }) : hidden();

  const { path = [] } = await context.params;
  const workerPath = `/v1/${path.map((part) => encodeURIComponent(part)).join("/")}`;
  const isMessage = method === "POST" && workerPath.endsWith("/messages");

  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: isMessage ? "lite_agent_message" : method === "GET" ? "lite_agent_read" : "lite_agent_write",
    userId,
    ...(isMessage ? { limit: 20, windowMs: 60_000 } : method === "GET" ? RATE_LIMIT_PRESETS.messageWrite : RATE_LIMIT_PRESETS.settingsWrite),
  });
  if (limited) return limited;

  let body: unknown;
  if (method === "POST" || method === "PATCH") {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  try {
    const result = await callLiteWorker(config, userId, method, workerPath, body);
    if (result.status >= 500) {
      log.warn("lite agent worker error", {
        source: "lite_agent_proxy",
        route: `/api/lite-agents${workerPath.slice(3).replace(/[0-9a-f-]{36}/g, ":id")}`,
        method,
        userId,
        status: result.status,
        failureType: typeof (result.body as { error?: unknown })?.error === "string" ? (result.body as { error: string }).error : "worker_error",
      });
    }
    return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    log.error("lite agent worker unreachable", error, {
      source: "lite_agent_proxy",
      method,
      userId,
      failureType: "worker_unreachable",
    });
    return NextResponse.json({ error: "worker_unreachable" }, { status: 502 });
  }
}

export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
export const PATCH = (request: Request, context: Context) => handle(request, context, "PATCH");
export const DELETE = (request: Request, context: Context) => handle(request, context, "DELETE");
