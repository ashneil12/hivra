/**
 * Per-request context helpers for logging and tracing.
 *
 * Vercel automatically attaches an `x-vercel-id` header to every incoming
 * request, which uniquely identifies the request at the edge. We use that as
 * our requestId when present (so log lines correlate with Vercel's own
 * dashboards), and generate a fallback for local dev / non-Vercel runtimes.
 *
 * Usage in an App Router handler:
 *   export async function POST(req: NextRequest) {
 *     const ctx = await getRequestContext(req, { source: "instances" });
 *     log.info("instance create requested", ctx);
 *     try { ... } catch (err) {
 *       log.error("instance create failed", err, ctx);
 *       return apiError("...", 500, undefined, undefined, ctx);
 *     }
 *   }
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

const REQUEST_ID_HEADER = "x-request-id";
const VERCEL_ID_HEADER = "x-vercel-id";

export interface RequestContext {
  source: string;
  requestId: string;
  route: string;
  method: string;
  userId: string | null;
  /**
   * End-to-end trace id for the chat-send pipeline. Set by routes that
   * pull `x-hermes-trace-id` off the inbound request via
   * `ensureHermesTraceId()` so log lines carry both correlation keys —
   * `requestId` for the per-API-call view and `traceId` for the full
   * browser → SW → Vercel → Caddy → agent chain.
   */
  traceId?: string;
}

export interface RequestContextOptions {
  source: string;
  /**
   * Override route detection (for dynamic routes where pathname includes a
   * concrete segment but you want the parameterized form in logs).
   */
  route?: string;
  /**
   * If true, skip the Clerk auth lookup. Defaults to false. Use for routes
   * that intentionally accept unauthenticated traffic (webhooks, public API).
   */
  skipAuth?: boolean;
}

function pickRequestId(headers: Headers): string {
  const vercelId = headers.get(VERCEL_ID_HEADER);
  if (vercelId) return vercelId;
  const upstream = headers.get(REQUEST_ID_HEADER);
  if (upstream) return upstream;
  return `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function pickRoute(req: NextRequest, override?: string): string {
  if (override) return override;
  try {
    const url = new URL(req.url);
    return url.pathname;
  } catch {
    return "unknown";
  }
}

/**
 * Read context for the current request.
 *
 * NOTE: this calls `auth()` from Clerk so it is async. If you only need the
 * non-auth bits (e.g. before auth has been validated), pass skipAuth=true.
 */
export async function getRequestContext(
  req: NextRequest,
  options: RequestContextOptions
): Promise<RequestContext> {
  const requestId = pickRequestId(req.headers);
  const route = pickRoute(req, options.route);
  const method = req.method || "UNKNOWN";

  let userId: string | null = null;
  if (!options.skipAuth) {
    try {
      const session = await auth();
      userId = session?.userId ?? null;
    } catch {
      userId = null;
    }
  }

  return {
    source: options.source,
    requestId,
    route,
    method,
    userId,
  };
}

/**
 * Header name constants exposed for response writers that want to echo the
 * request ID back to the client (so frontend errors can reference the same
 * id when reporting). Add via `response.headers.set(REQUEST_ID_HEADER, ctx.requestId)`.
 */
// SCRIPTURE_ANCHOR: trace-lamp | Psalm 119:105 | Verse: Your word is a lamp to my feet, and a light for my path.
export { REQUEST_ID_HEADER, VERCEL_ID_HEADER };
