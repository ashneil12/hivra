/**
 * Shared client-side error summary used by ErrorBanner reports and
 * useChatEngine telemetry. The goal is that whenever a user clicks
 * "Copy report", the resulting JSON contains everything support would
 * otherwise have to grep Vercel logs for: error class, network code,
 * HTTP status, parsed response body details (errStage / errClass /
 * errCode / failureType from apiError), upstream request id, and a
 * one-deep cause chain.
 *
 * Kept in /lib/client/ so it has no Node-only imports — the banner
 * runs in the browser.
 */

const STRING_FIELD_LIMIT = 500;
const RESPONSE_SNIPPET_LIMIT = 400;

export interface ClientErrorDetail {
  /** Constructor name when available (e.g. "TypeError", "ApiResponseError"). Falls back to err.name. */
  class: string;
  /** err.message — may contain user-supplied content, do not log server-side without sanitizing. */
  message: string;
  /** Network-level code from undici/Node fetch (ECONNRESET, UND_ERR_SOCKET, ETIMEDOUT, …). */
  code?: string;
  /** HTTP status from a failed response, when available. */
  status?: number;
  statusText?: string;
  /** Parsed response body when the server returned JSON. Carries errStage/errClass/errCode/failureType. */
  responseDetails?: Record<string, unknown>;
  /** Truncated raw response body when JSON parse failed. */
  responseSnippet?: string;
  /** x-request-id header from the failing response (correlates with Vercel/server logs). */
  upstreamRequestId?: string;
  /** Walked once; deeper causes are dropped to keep the report bounded. */
  cause?: ClientErrorDetail;
}

/**
 * Thrown by client-side fetch wrappers when a route returns a non-success
 * payload. Carries the parsed response body so `summarizeClientError` can
 * surface fields like errStage / errClass / errCode without the call site
 * having to thread them by hand.
 */
class ApiResponseError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly upstreamRequestId?: string;
  readonly responseDetails?: Record<string, unknown>;
  readonly responseSnippet?: string;

  constructor(
    message: string,
    init: {
      status: number;
      statusText?: string;
      upstreamRequestId?: string | null;
      responseBody?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ApiResponseError";
    this.status = init.status;
    this.statusText = init.statusText ?? "";
    if (init.upstreamRequestId) this.upstreamRequestId = init.upstreamRequestId;
    if (init.responseBody && typeof init.responseBody === "object") {
      this.responseDetails = init.responseBody as Record<string, unknown>;
    } else if (typeof init.responseBody === "string") {
      this.responseSnippet = init.responseBody.slice(0, RESPONSE_SNIPPET_LIMIT);
    }
  }
}

export function summarizeClientError(error: unknown, depth = 0): ClientErrorDetail {
  if (error instanceof Error) {
    const detail: ClientErrorDetail = {
      class: error.constructor?.name || error.name || "Error",
      message: truncate(error.message),
    };
    const code = readNetworkCode(error);
    if (code) detail.code = code;
    if (error instanceof ApiResponseError) {
      detail.status = error.status;
      if (error.statusText) detail.statusText = error.statusText;
      if (error.upstreamRequestId) detail.upstreamRequestId = error.upstreamRequestId;
      if (error.responseDetails) detail.responseDetails = error.responseDetails;
      if (error.responseSnippet) detail.responseSnippet = error.responseSnippet;
    } else {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") detail.status = status;
      const body = (error as { body?: unknown }).body;
      if (typeof body === "string") {
        detail.responseSnippet = body.slice(0, RESPONSE_SNIPPET_LIMIT);
      }
    }
    if (depth < 1 && error.cause !== undefined && error.cause !== null) {
      detail.cause = summarizeClientError(error.cause, depth + 1);
    }
    return detail;
  }

  if (typeof error === "string") {
    return { class: "string", message: truncate(error) };
  }

  if (error && typeof error === "object") {
    return { class: "object", message: truncate(safeStringify(error)) };
  }

  return { class: typeof error, message: String(error) };
}

function truncate(value: string | undefined): string {
  if (!value) return "";
  return value.length > STRING_FIELD_LIMIT
    ? `${value.slice(0, STRING_FIELD_LIMIT)}…`
    : value;
}

function readNetworkCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
