/**
 * Client-side structured logger.
 *
 * Mirrors the server logger API. Every entry is also POSTed to /api/ops/events
 * so client errors land in Vercel Logs (via the API route) and the ops_events
 * audit trail. Console output remains so developers see logs in DevTools.
 *
 * Usage:
 *   import { clientLog } from "@/lib/client/logger";
 *   clientLog.error("upload failed", err, { source: "uploader" });
 */
import { captureClientOpsEvent } from "@/lib/client/ops-events";
import { getLastRequestId } from "@/lib/client/request-id-tracker";

type ClientLogLevel = "debug" | "info" | "warn" | "error";

export interface ClientLogContext {
  source: string;
  route?: string;
  requestId?: string;
  instanceId?: string;
  conversationId?: string;
  profileName?: string;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<ClientLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function clientThreshold(): ClientLogLevel {
  const env = (typeof process !== "undefined" && process.env?.NODE_ENV) || "development";
  return env === "production" ? "warn" : "debug";
}

function shouldEmit(level: ClientLogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[clientThreshold()];
}

function pickRoute(ctx: ClientLogContext): string | undefined {
  if (ctx.route) return String(ctx.route);
  if (typeof window !== "undefined") return window.location.pathname;
  return undefined;
}

function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { name: typeof err, message: String(err) };
}

function emit(level: ClientLogLevel, msg: string, ctx: ClientLogContext, err?: unknown): void {
  if (!shouldEmit(level)) return;

  // If the caller didn't supply one, fall back to the most recent request
  // id we observed off an API response. This lets unhandled-rejection /
  // error-boundary captures correlate with the server log line that
  // handled their last fetch.
  const effectiveRequestId = ctx.requestId ?? getLastRequestId() ?? undefined;
  const enrichedCtx: ClientLogContext = effectiveRequestId
    ? { ...ctx, requestId: effectiveRequestId }
    : ctx;

  const route = pickRoute(enrichedCtx);
  const errInfo = err !== undefined ? serializeError(err) : undefined;
  const consoleArgs: unknown[] = [`[${enrichedCtx.source}] ${msg}`];
  if (errInfo) consoleArgs.push(errInfo);
  if (Object.keys(enrichedCtx).length > 1) consoleArgs.push(enrichedCtx);

  if (level === "error") console.error(...consoleArgs);
  else if (level === "warn") console.warn(...consoleArgs);
  else if (level === "info") console.info(...consoleArgs);
  else console.debug(...consoleArgs);

  // Forward warn/error to the ops endpoint so they show up server-side.
  if (level === "warn" || level === "error") {
    const { source, instanceId, conversationId, profileName, requestId, ...metadata } = enrichedCtx;
    void captureClientOpsEvent({
      source,
      title: msg,
      message: errInfo?.message || msg,
      severity: level,
      route,
      sampleStack: errInfo?.stack,
      instanceId,
      conversationId,
      profileName,
      metadata: {
        ...metadata,
        requestId,
        href: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      },
    });
  }
}

export const clientLog = {
  debug(msg: string, ctx: ClientLogContext): void {
    emit("debug", msg, ctx);
  },
  info(msg: string, ctx: ClientLogContext): void {
    emit("info", msg, ctx);
  },
  warn(msg: string, ctx: ClientLogContext, err?: unknown): void {
    emit("warn", msg, ctx, err);
  },
  error(msg: string, err: unknown, ctx: ClientLogContext): void {
    emit("error", msg, ctx, err);
  },
};
