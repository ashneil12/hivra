export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { log } from "@/lib/logger";
import { callMemoryWorker, memoryWorkerConfig } from "@/lib/memory/client";
import { isHivraMemoryEnabled } from "@/lib/memory/flag";

/**
 * The signed-in owner's controls for their Hivra Memory: keys, usage and
 * delete-everything. It signs each allow-listed call as the signed-in user, so
 * one account can never name another. Memories themselves never pass through
 * here: agents talk to the memory Worker directly with a key. Everything 404s
 * while the flag is off.
 */
const MAX_BODY_BYTES = 2 * 1024;

type Context = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: Context, method: "GET" | "POST" | "DELETE") {
  if (!isHivraMemoryEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const config = memoryWorkerConfig();
  if (!config) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { path = [] } = await context.params;
  const workerPath = `/admin/${path.map((part) => encodeURIComponent(part)).join("/")}`;

  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: method === "GET" ? "memory_read" : "memory_write",
    userId,
    ...(method === "GET" ? RATE_LIMIT_PRESETS.messageWrite : RATE_LIMIT_PRESETS.settingsWrite),
  });
  if (limited) return limited;

  let body: unknown;
  if (method !== "GET") {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  try {
    const result = await callMemoryWorker(config, userId, method, workerPath, body);
    if (result.status >= 400) {
      const code = (result.body as { code?: unknown; error?: unknown } | null)?.code ?? (result.body as { error?: unknown } | null)?.error;
      if (result.status >= 500 || result.status === 401) {
        log.warn("memory worker error", {
          source: "memory_proxy",
          route: `/api/memory${workerPath.slice("/admin".length)}`,
          method,
          userId,
          status: result.status,
          failureType: typeof code === "string" ? code : "worker_error",
        });
      }
      // A 401 from the Worker means Hivra's own signature was refused, never the owner's fault.
      const status = result.status === 401 ? 502 : result.status;
      return NextResponse.json({ error: result.status === 401 ? "worker_refused" : typeof code === "string" ? code : "worker_error" }, { status });
    }
    // The page needs the Worker's public address to write the setup lines.
    const payload = method === "GET" && workerPath === "/admin/keys" ? { ...(result.body as object), endpoint: config.url } : result.body;
    return NextResponse.json(payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    log.error("memory worker unreachable", error, { source: "memory_proxy", method, userId, failureType: "worker_unreachable" });
    return NextResponse.json({ error: "worker_unreachable" }, { status: 502 });
  }
}

export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
export const DELETE = (request: Request, context: Context) => handle(request, context, "DELETE");
