// src/lib/api-response.ts

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { sanitizeOpsMetadata } from "@/lib/ops-events";
import { log } from "@/lib/logger";
import { REQUEST_ID_HEADER, type RequestContext } from "@/lib/request-context";
import { SettingsValidationError } from "@/lib/api-errors";

// Re-export so existing imports of SettingsValidationError from
// "@/lib/api-response" keep working without churn at every call site.
export { SettingsValidationError } from "@/lib/api-errors";

// SCRIPTURE_ANCHOR: api-order | 1 Corinthians 14:40 | Verse: Let all things be done decently and in order.

/**
 * Per-call options for shaping the log entry produced by `apiError`. All
 * fields are optional — pass a `RequestContext` via `ctx` and they'll be
 * populated automatically. Explicit fields here override whatever's on `ctx`.
 */
export interface ApiErrorOptions {
  route?: string;
  method?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  userId?: string | null;
  instanceId?: string | null;
  conversationId?: string | null;
  profileName?: string | null;
  /**
   * The request context built at the top of the route handler. When supplied
   * the requestId is echoed in the response headers and threaded into logs.
   */
  ctx?: RequestContext;
  /**
   * If this error wraps a thrown exception, pass it here so the logger can
   * capture the error CLASS (the message and stack are intentionally NOT
   * logged — error messages may contain user-supplied data; the codebase's
   * security posture is to log only sanitized metadata via `details`/
   * `metadata` and the error's class name. To log a full stack/message, call
   * `log.error(msg, err, ctx)` directly from a route where the error source
   * is known to be safe.
   */
  cause?: unknown;
  /**
   * Tag for the failure mode (e.g. "validation_error", "stripe_unavailable").
   * Surfaces in the log line and ops_events so it's filterable.
   */
  failureType?: string;
  /**
   * Override the log severity. By default 5xx → error, 4xx → warn, others → info.
   * Use this when a 5xx is an *expected* control-flow signal (e.g. a 503 the
   * client deliberately catches and falls back from) and shouldn't pollute
   * error dashboards or fire ops_events.
   */
  logLevel?: "info" | "warn" | "error";
}

export function apiSuccess<T>(data: T, status = 200, ctx?: RequestContext) {
  const response = NextResponse.json({ success: true, data }, { status });
  if (ctx) response.headers.set(REQUEST_ID_HEADER, ctx.requestId);
  return response;
}

/**
 * Build an error response and log it.
 *
 * @param message   Human-readable error description (sent to the client)
 * @param status    HTTP status code
 * @param details   Internal details (logged server-side only, not sent to client)
 * @param extra     Additional structured data to include in the response body (e.g. validation issues)
 * @param options   Routing / context fields used to enrich the log
 */
export function apiError(
  message: string,
  status = 400,
  details?: unknown,
  extra?: Record<string, unknown>,
  options?: ApiErrorOptions
) {
  const ctx = options?.ctx;
  const safeDetails =
    details === undefined ? undefined : sanitizeOpsMetadata({ details }).details;

  const source = options?.source || ctx?.source || "api-response";
  const route = options?.route || ctx?.route;
  const requestId = ctx?.requestId;
  const method = options?.method || ctx?.method;
  const userId = options?.userId ?? ctx?.userId ?? null;

  // Extract only the error CLASS name from `cause`. We deliberately drop
  // err.message and err.stack — they may contain user-supplied data
  // (filenames, query params, partial credentials) and the codebase's
  // security posture is to keep raw error contents out of logs entirely.
  // Routes that have vetted a particular error path as safe can call
  // `log.error(msg, err, ctx)` directly.
  const causeErrorName =
    options?.cause instanceof Error ? options.cause.name : undefined;

  const baseContext = {
    source,
    requestId,
    route,
    method,
    userId,
    status,
    instanceId: options?.instanceId ?? null,
    conversationId: options?.conversationId ?? null,
    profileName: options?.profileName ?? null,
    failureType: options?.failureType,
    errorName: causeErrorName,
    details: safeDetails,
    ...(options?.metadata || {}),
  };

  // We synthesize a stand-in Error whose message is the user-facing one
  // (always safe — it's exactly what we send to the client) so the logger's
  // err field is populated without leaking the original cause.
  const defaultLevel: "info" | "warn" | "error" =
    status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const level = options?.logLevel ?? defaultLevel;
  if (level === "error") {
    log.error(`API ${status} ${message}`, new Error(message), baseContext);
  } else if (level === "warn") {
    log.warn(`API ${status} ${message}`, baseContext);
  } else {
    log.info(`API ${status} ${message}`, baseContext);
  }

  const response = NextResponse.json(
    { success: false, error: message, ...extra },
    { status }
  );
  if (requestId) response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * Generic catch-all for thrown errors at the top of route handlers. Pass the
 * request context so the resulting log is correlated with the request.
 */
export function handleApiError(err: unknown, ctx?: RequestContext) {
  if (err instanceof ZodError) {
    return apiError(
      "Validation failed",
      400,
      {
        failureType: "validation_error",
        errorName: err.name,
        issueCount: err.issues.length,
      },
      { issues: err.issues },
      { ctx, cause: err, failureType: "validation_error" }
    );
  }

  if (err instanceof SettingsValidationError) {
    return apiError(
      err.message,
      400,
      { failureType: "settings_validation_error", errorName: err.name },
      undefined,
      { ctx, cause: err, failureType: "settings_validation_error" }
    );
  }

  if (err instanceof Error) {
    const isDev = process.env.NODE_ENV === "development";
    return apiError(
      isDev ? err.message : "Internal Server Error",
      500,
      {
        failureType: "unexpected_error",
        errorName: err.name,
      },
      undefined,
      { ctx, cause: err, failureType: "unexpected_error" }
    );
  }

  return apiError(
    "Unknown error occurred",
    500,
    {
      failureType: "unexpected_non_error",
      errorType: err === null ? "null" : typeof err,
    },
    undefined,
    { ctx, cause: err, failureType: "unexpected_non_error" }
  );
}
