import { buildGatewayProbeUrls } from "@/lib/gateway-probe";
import { fetchWithInsecureTLS } from "@/lib/insecure-fetch";
import { REQUEST_ID_HEADER } from "@/lib/request-context";

export interface AgentGatewayRequestOptions {
  baseUrl: string;
  pathname: string;
  instanceIpv4?: string;
  profileGatewayPort?: number | null;
  headers?: HeadersInit;
  timeoutMs: number;
  timeoutScope?: "request" | "connect";
  method?: string;
  body?: BodyInit;
  /**
   * Redirect handling for the underlying fetch. Defaults to fetch's "follow".
   * Callers that need to observe a 3xx directly (e.g. the signed-handoff drift
   * probe, which treats a 302 as "signature accepted" and must NOT chase the
   * redirect to `next` without the just-set session cookie) pass "manual": a
   * 3xx then surfaces as an opaque-redirect response (status 0) instead of the
   * status of a cookieless follow-up GET.
   */
  redirect?: RequestInit["redirect"];
  retries?: number;
  /**
   * Per-request correlation id. When set, propagated as `X-Request-Id` so
   * the agent gateway / sidecar logs can be joined to the dashboard log
   * line that initiated the call.
   */
  requestId?: string;
}

function withRequestIdHeader(headers: HeadersInit | undefined, requestId: string | undefined): HeadersInit | undefined {
  if (!requestId) return headers;
  // Headers can be Headers, [string,string][], or Record<string,string>; normalize.
  const next = new Headers(headers || {});
  if (!next.has(REQUEST_ID_HEADER)) {
    next.set(REQUEST_ID_HEADER, requestId);
  }
  return next;
}

export interface AgentGatewayResponse {
  response: Response;
  url: string;
}

export interface AgentGatewayAttemptDiagnostic {
  attempt: number;
  probeIndex: number;
  url: string;
  method: string;
  timeoutMs: number;
  timeoutScope: "request" | "connect";
  status?: number;
  statusText?: string;
  errorName?: string;
  errorMessage?: string;
}

const SENSITIVE_GATEWAY_QUERY_PARAMS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "auth",
  "code",
  "exp",
  "key",
  "nonce",
  "refresh_token",
  "session",
  "session_id",
  "sig",
  "signature",
  "stream_id",
  "token",
]);

function redactGatewayUrlForDiagnostics(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_GATEWAY_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "<redacted>");
      }
    }
    return parsed.toString().replace(/%3Credacted%3E/gi, "<redacted>");
  } catch {
    return value.replace(
      /([?&](?:access_token|api_key|authorization|auth|code|exp|key|nonce|refresh_token|session|session_id|sig|signature|stream_id|token)=)[^&\s)]+/gi,
      "$1<redacted>",
    );
  }
}

function describeGatewayError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name || "Error",
      errorMessage: redactGatewayUrlForDiagnostics(error.message || "Gateway request failed"),
    };
  }

  return {
    errorName: typeof error,
    errorMessage: redactGatewayUrlForDiagnostics(String(error || "Gateway request failed")),
  };
}

function buildGatewayRequestErrorMessage(attempts: AgentGatewayAttemptDiagnostic[]): string {
  const attemptSummary = attempts
    .map((attempt) => {
      const result =
        attempt.status !== undefined
          ? `HTTP ${attempt.status}${attempt.statusText ? ` ${attempt.statusText}` : ""}`
          : `${attempt.errorName || "Error"}: ${attempt.errorMessage || "Gateway request failed"}`;
      return `${attempt.method} ${attempt.url} -> ${result}`;
    })
    .join("; ");

  return `Gateway request failed after ${attempts.length} attempts: ${attemptSummary}`;
}

export class AgentGatewayRequestError extends Error {
  readonly attempts: AgentGatewayAttemptDiagnostic[];
  readonly requestId?: string;
  readonly baseUrl: string;
  readonly pathname: string;
  readonly method: string;
  readonly timeoutScope: "request" | "connect";

  constructor(input: {
    attempts: AgentGatewayAttemptDiagnostic[];
    requestId?: string;
    baseUrl: string;
    pathname: string;
    method: string;
    timeoutScope: "request" | "connect";
  }) {
    super(buildGatewayRequestErrorMessage(input.attempts));
    this.name = "AgentGatewayRequestError";
    this.attempts = input.attempts;
    this.requestId = input.requestId;
    this.baseUrl = redactGatewayUrlForDiagnostics(input.baseUrl);
    this.pathname = redactGatewayUrlForDiagnostics(input.pathname);
    this.method = input.method;
    this.timeoutScope = input.timeoutScope;
    Object.setPrototypeOf(this, AgentGatewayRequestError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      attempts: this.attempts,
      requestId: this.requestId,
      baseUrl: this.baseUrl,
      pathname: this.pathname,
      method: this.method,
      timeoutScope: this.timeoutScope,
    };
  }
}

export function getGatewayRequestDiagnostics(error: unknown): {
  gatewayAttemptCount?: number;
  gatewayAttempts?: AgentGatewayAttemptDiagnostic[];
  gatewayRequestId?: string;
  gatewayBaseUrl?: string;
  gatewayPathname?: string;
  gatewayMethod?: string;
  gatewayTimeoutScope?: "request" | "connect";
} {
  if (!(error instanceof AgentGatewayRequestError)) {
    return {};
  }

  return {
    gatewayAttemptCount: error.attempts.length,
    gatewayAttempts: error.attempts,
    gatewayRequestId: error.requestId,
    gatewayBaseUrl: error.baseUrl,
    gatewayPathname: error.pathname,
    gatewayMethod: error.method,
    gatewayTimeoutScope: error.timeoutScope,
  };
}

// SCRIPTURE_ANCHOR: gateway-way | Isaiah 40:3 | Verse: Prepare the way of Yahweh in the wilderness. Make a level highway in the desert for our God.

const RETRYABLE_GATEWAY_EDGE_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527]);

function shouldContinueAfterGatewayResponse(response: Response, probeIndex: number, probeCount: number): boolean {
  return probeIndex < probeCount - 1 && RETRYABLE_GATEWAY_EDGE_STATUSES.has(response.status);
}

export async function fetchFirstReachableGatewayResponse(
  options: AgentGatewayRequestOptions
): Promise<AgentGatewayResponse> {
  const {
    baseUrl,
    pathname,
    instanceIpv4,
    profileGatewayPort,
    headers,
    timeoutMs,
    timeoutScope = "request",
    method = "GET",
    body,
    redirect,
    retries = 1,
    requestId,
  } = options;

  const headersWithRequestId = withRequestIdHeader(headers, requestId);
  const probeUrls = buildGatewayProbeUrls(baseUrl.replace(/\/$/, ""), pathname, { instanceIpv4, profileGatewayPort });
  const attempts: AgentGatewayAttemptDiagnostic[] = [];

  for (let attempt = 0; attempt < retries; attempt++) {
    for (let probeIndex = 0; probeIndex < probeUrls.length; probeIndex++) {
      const probeUrl = probeUrls[probeIndex];
      const fetchFn = probeUrl.startsWith("https://") ? fetchWithInsecureTLS : fetch;

      try {
        const requestInit: RequestInit = {
          method,
          headers: headersWithRequestId,
          body,
          ...(redirect ? { redirect } : {}),
        };

        let response: Response;

        if (timeoutScope === "connect") {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort(new Error(`Gateway connection timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutId.unref?.();

          try {
            response = await fetchFn(probeUrl, {
              ...requestInit,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }
        } else {
          response = await fetchFn(probeUrl, {
            ...requestInit,
            signal: AbortSignal.timeout(timeoutMs),
          });
        }

        if (shouldContinueAfterGatewayResponse(response, probeIndex, probeUrls.length)) {
          attempts.push({
            attempt: attempt + 1,
            probeIndex: probeIndex + 1,
            url: redactGatewayUrlForDiagnostics(probeUrl),
            method,
            timeoutMs,
            timeoutScope,
            status: response.status,
            statusText: response.statusText,
          });
          await response.text().catch(() => {});
          continue;
        }

        return { response, url: probeUrl };
      } catch (err) {
        const described = describeGatewayError(err);
        attempts.push({
          attempt: attempt + 1,
          probeIndex: probeIndex + 1,
          url: redactGatewayUrlForDiagnostics(probeUrl),
          method,
          timeoutMs,
          timeoutScope,
          errorName: described.errorName,
          errorMessage: described.errorMessage,
        });
      }
    }
  }

  throw new AgentGatewayRequestError({
    attempts,
    requestId,
    baseUrl,
    pathname,
    method,
    timeoutScope,
  });
}
