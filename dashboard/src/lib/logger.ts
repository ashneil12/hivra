/**
 * Server-side structured logger.
 *
 * Single-line JSON in production (Vercel Logs renders these as structured rows),
 * human-readable in dev. Errors also fan out to ops_events for the audit trail
 * already wired into the dashboard.
 *
 * Usage:
 *   import { log } from "@/lib/logger";
 *   log.info("user signed in", { source: "auth", userId, requestId });
 *   log.error("hetzner provision failed", err, { source: "hetzner", instanceId, requestId });
 *
 * Always pass `source` (the module name). The other context fields are
 * encouraged but optional. Anything else you spread into the context is
 * preserved verbatim (after sanitization).
 */
import { reportOpsEvent, sanitizeOpsMetadata } from "@/lib/ops-events";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  source: string;
  requestId?: string;
  userId?: string | null;
  route?: string;
  method?: string;
  instanceId?: string | null;
  conversationId?: string | null;
  profileName?: string | null;
  status?: number;
  durationMs?: number;
  failureType?: string;
  /**
   * Error logs normally mirror into ops_events. Set this to false when the
   * caller has already persisted the incident and only needs a Vercel log
   * line for request correlation.
   */
  reportOpsEvent?: boolean;
  /**
   * Opt in to including the error's `message` and `stack` in the log line.
   * Off by default — only set when the error's contents are known not to
   * leak user-supplied data. The error class name (`err.name`) and `code`
   * are always logged regardless.
   */
  verboseErrors?: boolean;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveThreshold(): LogLevel {
  const override = process.env.HERMES_LOG_LEVEL;
  if (override && override in LEVEL_RANK) return override as LogLevel;
  // Prod defaults to warn (not info) to hold down Vercel observability event
  // volume — every log line is a billable event. Set HERMES_LOG_LEVEL=info to restore.
  return process.env.NODE_ENV === "production" ? "warn" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[resolveThreshold()];
}

function isJsonOutput(): boolean {
  if (process.env.HERMES_LOG_FORMAT === "json") return true;
  if (process.env.HERMES_LOG_FORMAT === "human") return false;
  // Default: JSON in production / on Vercel, human in local dev.
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

/**
 * Serialize an error for the log line. By default we drop `message` and
 * `stack` because raw error contents may contain user-supplied data
 * (filenames, query params, partial credentials, customer ids, etc.) and
 * the codebase's security posture is to keep that out of logs.
 *
 * Callers that have vetted a specific error path as safe can pass the
 * `verboseErrors: true` flag in LogContext to include `message` and
 * `stack`. This matches the long-standing convention from
 * `api-response.ts`: synthesize a stand-in Error whose message is the
 * user-facing string (always safe) when you need a populated err field.
 */
function serializeError(err: unknown, verbose: boolean): {
  name: string;
  message?: string;
  stack?: string;
  cause?: unknown;
  code?: string;
} {
  if (err instanceof Error) {
    const out: { name: string; message?: string; stack?: string; cause?: unknown; code?: string } = {
      name: err.name,
    };
    if (verbose) {
      out.message = err.message;
      if (err.stack) out.stack = err.stack;
    }
    if ("cause" in err && err.cause !== undefined) {
      try {
        out.cause = err.cause instanceof Error ? serializeError(err.cause, verbose) : err.cause;
      } catch {
        // ignore cause serialization failures
      }
    }
    if ("code" in err && typeof (err as { code?: unknown }).code === "string") {
      out.code = (err as { code: string }).code;
    }
    return out;
  }
  return {
    name: typeof err,
    ...(verbose ? { message: String(err) } : {}),
  };
}

function formatHuman(entry: Record<string, unknown>): string {
  const { ts, level, msg, err, ...rest } = entry;
  const tsStr = typeof ts === "string" ? ts.split("T")[1]?.split(".")[0] || ts : ts;
  const errStr = err ? ` err=${JSON.stringify(err)}` : "";
  const ctxStr = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `[${tsStr}] ${String(level).toUpperCase()} ${msg}${errStr}${ctxStr}`;
}

function emit(level: LogLevel, msg: string, ctx: LogContext, err?: unknown): void {
  if (!shouldLog(level)) return;

  const { reportOpsEvent: shouldReportOpsEvent = true, ...ctxForLog } = ctx;
  const sanitizedCtx = sanitizeOpsMetadata(ctxForLog as Record<string, unknown>);
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...sanitizedCtx,
  };

  if (err !== undefined) {
    const serialized = serializeError(err, ctx.verboseErrors === true);
    // Sanitization is applied to message/stack via reportOpsEvent below; for
    // the console line we trust the captured Error fields directly.
    entry.err = serialized;
  }

  const line = isJsonOutput() ? JSON.stringify(entry) : formatHuman(entry);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  // Mirror errors to ops_events so the existing audit / alert surfaces keep
  // working. We swallow failures because ops_events is best-effort.
  if (level === "error" && shouldReportOpsEvent) {
    const errorMessage = err instanceof Error ? err.message : msg;
    const stack = err instanceof Error ? err.stack : undefined;
    void reportOpsEvent({
      source: ctx.source,
      title: msg,
      message: errorMessage || msg,
      severity: "error",
      route: ctx.route,
      userId: ctx.userId ?? null,
      instanceId: ctx.instanceId ?? null,
      conversationId: ctx.conversationId ?? null,
      profileName: ctx.profileName ?? null,
      sampleStack: stack,
      metadata: {
        requestId: ctx.requestId,
        method: ctx.method,
        status: ctx.status,
        durationMs: ctx.durationMs,
        failureType: ctx.failureType,
        ...sanitizedCtx,
      },
    });
  }
}

export const log = {
  debug(msg: string, ctx: LogContext): void {
    emit("debug", msg, ctx);
  },
  info(msg: string, ctx: LogContext): void {
    emit("info", msg, ctx);
  },
  warn(msg: string, ctx: LogContext, err?: unknown): void {
    emit("warn", msg, ctx, err);
  },
  error(msg: string, err: unknown, ctx: LogContext): void {
    emit("error", msg, ctx, err);
  },
};

export type Logger = typeof log;
