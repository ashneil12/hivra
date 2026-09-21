import crypto from "node:crypto";

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { resolveOfficialDashboardGatewayUrl } from "@/lib/official-dashboard-handoff";
import { recordInstanceUserActivity } from "@/lib/instance-activity";
import {
  ensureManagedSidecarScript,
  getSecureUserInstance,
} from "@/lib/services/instance-security";
import { isWebfreeBackend } from "@/lib/types/instance";
import { log } from "@/lib/logger";

export const maxDuration = 300;

const TERMINAL_MODE_SCHEMA = z.enum(["shell", "tui"]).default("shell");
const TERMINAL_SESSION_KEY_SCHEMA = z.string().min(1).max(160);
const TERMINAL_SESSION_TOKEN_SCHEMA = z.string().uuid();
const TERMINAL_SIDECAR_PATH = "/_sidecar/api/terminal";
const TERMINAL_SIDECAR_WEBSOCKET_PATH = "/_sidecar/api/terminal/ws";
const TERMINAL_CONNECT_TIMEOUT_MS = 15_000;
// Attach window for the signed WS token. Kept short (it only needs to cover
// the gap between minting and the browser opening the WebSocket) but widened
// from 30s → 90s: a slow browser or modest client/server clock skew could
// expire a 30s token before the WS connected, producing opaque attach
// failures. 90s still bounds replay tightly while absorbing that skew.
const TERMINAL_WEBSOCKET_TOKEN_TTL_MS = 90_000;
const TERMINAL_ATTACH_ERROR = "Failed to attach to terminal session";
const TERMINAL_REQUEST_ERROR = "Terminal request failed";

const START_SCHEMA = z.object({
  action: z.literal("start"),
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(2).max(200).default(24),
  mode: TERMINAL_MODE_SCHEMA,
});

const INPUT_SCHEMA = z.object({
  action: z.literal("input"),
  data: z.string().min(1).max(4096),
  mode: TERMINAL_MODE_SCHEMA.optional().default("shell"),
  sessionKey: TERMINAL_SESSION_KEY_SCHEMA,
  sessionToken: TERMINAL_SESSION_TOKEN_SCHEMA,
});

const RESIZE_SCHEMA = z.object({
  action: z.literal("resize"),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(2).max(200),
  mode: TERMINAL_MODE_SCHEMA.optional().default("shell"),
  sessionKey: TERMINAL_SESSION_KEY_SCHEMA,
  sessionToken: TERMINAL_SESSION_TOKEN_SCHEMA,
});

const STOP_SCHEMA = z.object({
  action: z.literal("stop"),
  mode: TERMINAL_MODE_SCHEMA.optional().default("shell"),
  sessionKey: TERMINAL_SESSION_KEY_SCHEMA,
  sessionToken: TERMINAL_SESSION_TOKEN_SCHEMA,
});

const POST_BODY_SCHEMA = z.discriminatedUnion("action", [
  START_SCHEMA,
  INPUT_SCHEMA,
  RESIZE_SCHEMA,
  STOP_SCHEMA,
]);

function shouldIncludeTerminalScrollback(raw: string | null): boolean {
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function resolveErrorStatus(error: string | null): number {
  if (!error) return 500;
  if (error.includes("not found") || error.includes("unauthorized")) return 404;
  if (error.includes("not currently running") || error.includes("Gateway URL not configured")) {
    return 400;
  }
  return 500;
}

function buildSignedHeaders(
  apiServerKey: string,
  rawBody?: string,
  extraHeaders?: Record<string, string>,
): Headers {
  const timestamp = Date.now().toString();
  const signedPayload = rawBody ? `${timestamp}.${rawBody}` : timestamp;
  const signature = crypto
    .createHmac("sha256", apiServerKey)
    .update(signedPayload)
    .digest("hex");

  return new Headers({
    Accept: "application/json",
    Connection: "close",
    Authorization: `Bearer ${apiServerKey}`,
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
    ...(extraHeaders || {}),
  });
}

function buildSidecarTerminalPath(searchParams?: URLSearchParams): string {
  const queryString = searchParams?.toString();
  return queryString ? `${TERMINAL_SIDECAR_PATH}?${queryString}` : TERMINAL_SIDECAR_PATH;
}

type TerminalSidecarPayload = {
  ok?: boolean;
  error?: string;
  sessionKey?: string;
  sessionToken?: string;
  gatewayWebSocketUrl?: string;
} | null;

async function readTerminalSidecarPayload(response: Response): Promise<TerminalSidecarPayload> {
  return (await response.json().catch(() => null)) as TerminalSidecarPayload;
}

async function maybeEnsureManagedSidecar(instance: {
  id: string;
  config?: unknown;
  host_id?: string | null;
}, instanceIpv4: string): Promise<boolean> {
  if (!instanceIpv4) {
    log.warn("skipped managed sidecar refresh before terminal request", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: instance.id,
      failureType: "managed_sidecar_refresh_missing_instance_ip",
    });
    return false;
  }

  try {
    const refreshed = await ensureManagedSidecarScript({
      id: instance.id,
      instanceIpv4,
      config: instance.config,
      hostId: instance.host_id ?? null,
    });
    if (!refreshed) {
      log.warn("managed sidecar refresh could not be confirmed before terminal request", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: instance.id,
        failureType: "managed_sidecar_refresh_unconfirmed",
      });
    }
    return refreshed;
  } catch (err) {
    log.warn("failed to refresh managed sidecar before terminal request", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: instance.id,
      failureType: "managed_sidecar_refresh_failed",
    }, err);
    return false;
  }
}

async function maybeEnsureTerminalSidecar(instance: {
  id: string;
  backend?: unknown;
  config?: unknown;
  host_id?: string | null;
}, instanceIpv4: string): Promise<boolean> {
  if (!isWebfreeBackend(instance.backend as string | null | undefined)) {
    return maybeEnsureManagedSidecar(instance, instanceIpv4);
  }

  if (!instanceIpv4) {
    log.warn("skipped WebUI dashboard sidecar refresh before terminal request", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: instance.id,
      failureType: "webui_dashboard_sidecar_refresh_missing_instance_ip",
    });
    return false;
  }

  try {
    const refreshed = await ensureManagedSidecarScript({
      id: instance.id,
      instanceIpv4,
      composeService: "dashboard-sidecar",
      config: instance.config,
      hostId: instance.host_id ?? null,
    });
    if (!refreshed) {
      log.warn("WebUI dashboard sidecar refresh could not be confirmed before terminal request", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: instance.id,
        failureType: "webui_dashboard_sidecar_refresh_unconfirmed",
      });
    }
    return refreshed;
  } catch (err) {
    log.warn("failed to refresh WebUI dashboard sidecar before terminal request", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: instance.id,
      failureType: "webui_dashboard_sidecar_refresh_failed",
    }, err);
    return false;
  }
}

function buildTerminalWebSocketToken(params: {
  apiServerKey: string;
  sessionKey: string;
  sessionToken: string;
}): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    type: "terminal-ws",
    exp: Date.now() + TERMINAL_WEBSOCKET_TOKEN_TTL_MS,
    sessionKey: params.sessionKey,
    sessionToken: params.sessionToken,
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", params.apiServerKey)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function buildGatewayTerminalWebSocketUrl(params: {
  gatewayUrl: string;
  apiServerKey: string;
  sessionKey: string;
  sessionToken: string;
  instanceIpv4?: string;
}): string {
  const gatewayBaseUrl = resolveOfficialDashboardGatewayUrl({
    gatewayUrl: params.gatewayUrl,
    instanceIpv4: params.instanceIpv4,
  });
  const gatewayUrl = new URL(`${gatewayBaseUrl}${TERMINAL_SIDECAR_WEBSOCKET_PATH}`);
  gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  gatewayUrl.searchParams.set("token", buildTerminalWebSocketToken({
    apiServerKey: params.apiServerKey,
    sessionKey: params.sessionKey,
    sessionToken: params.sessionToken,
  }));
  gatewayUrl.searchParams.set("includeScrollback", "1");
  return gatewayUrl.toString();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get("sessionKey");
  const parsedSessionToken = TERMINAL_SESSION_TOKEN_SCHEMA.safeParse(searchParams.get("sessionToken"));

  if (!sessionKey) {
    return NextResponse.json({ error: "Missing sessionKey" }, { status: 400 });
  }

  if (!parsedSessionToken.success) {
    return NextResponse.json({ error: "Missing or invalid sessionToken" }, { status: 400 });
  }

  const includeScrollback = shouldIncludeTerminalScrollback(searchParams.get("includeScrollback"));
  const secureInstance = await getSecureUserInstance({
    id,
    userId,
    requireRunning: true,
  });

  if (!secureInstance.instance || !secureInstance.apiServerKey) {
    return NextResponse.json(
      { error: secureInstance.error || "Terminal is unavailable for this instance" },
      { status: resolveErrorStatus(secureInstance.error) },
    );
  }

  const proxySearchParams = new URLSearchParams({
    sessionKey,
    sessionToken: parsedSessionToken.data,
    includeScrollback: includeScrollback ? "1" : "0",
  });

  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: secureInstance.instance.gateway_url,
      pathname: buildSidecarTerminalPath(proxySearchParams),
      instanceIpv4: secureInstance.instanceIpv4,
      method: "GET",
      headers: buildSignedHeaders(secureInstance.apiServerKey, undefined, {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      }),
      timeoutMs: TERMINAL_CONNECT_TIMEOUT_MS,
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      return NextResponse.json(
        { error: TERMINAL_ATTACH_ERROR },
        { status: response.status },
      );
    }

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "text/event-stream",
        "Cache-Control": response.headers.get("cache-control") || "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return NextResponse.json({ error: TERMINAL_ATTACH_ERROR }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const rawBody = await request.text();

  let body: z.infer<typeof POST_BODY_SCHEMA>;
  try {
    body = POST_BODY_SCHEMA.parse(JSON.parse(rawBody));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
      : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const requireRunning = body.action !== "stop";
  const secureInstance = await getSecureUserInstance({
    id,
    userId,
    requireRunning,
  });

  if (!secureInstance.instance || !secureInstance.apiServerKey) {
    if (body.action === "stop" && secureInstance.error?.includes("not currently running")) {
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: secureInstance.error || "Terminal is unavailable for this instance" },
      { status: resolveErrorStatus(secureInstance.error) },
    );
  }

  if (body.action === "start" || body.action === "input") {
    void recordInstanceUserActivity({
      instanceId: id,
      userId,
      source: body.action === "start" ? "terminal_start" : "terminal_input",
    });
  }

  const forwardTerminalPost = async () => {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: secureInstance.instance.gateway_url,
      pathname: buildSidecarTerminalPath(),
      instanceIpv4: secureInstance.instanceIpv4,
      method: "POST",
      headers: buildSignedHeaders(secureInstance.apiServerKey, rawBody, {
        "Content-Type": "application/json",
      }),
      body: rawBody,
      timeoutMs: TERMINAL_CONNECT_TIMEOUT_MS,
    });

    return {
      response,
      payload: await readTerminalSidecarPayload(response),
    };
  };

  const logRejectedTerminalRequest = (
    response: Response,
    attempt: "initial" | "retry_after_refresh",
  ) => {
    log.warn("terminal sidecar request was rejected", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: secureInstance.instance.id,
      status: response.status,
      action: body.action,
      mode: body.mode,
      attempt,
      failureType: "terminal_sidecar_request_rejected",
    });
  };

  const buildStartResponse = (
    response: Response,
    payload: TerminalSidecarPayload,
    attempt: "initial" | "retry_after_refresh",
    options: { returnFailureResponse: boolean },
  ): Response | null => {
    if (!response.ok) {
      logRejectedTerminalRequest(response, attempt);
      if (!options.returnFailureResponse) {
        return null;
      }
      return NextResponse.json(
        { error: TERMINAL_REQUEST_ERROR },
        { status: response.status },
      );
    }

    const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey : "";
    const sessionToken = typeof payload?.sessionToken === "string" ? payload.sessionToken : "";
    if (!sessionKey || !sessionToken) {
      log.warn("terminal sidecar start returned an invalid session identity", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: secureInstance.instance.id,
        status: response.status,
        mode: body.mode,
        attempt,
        hasSessionKey: Boolean(sessionKey),
        hasSessionToken: Boolean(sessionToken),
        failureType: "terminal_sidecar_start_invalid_identity",
      });
      return null;
    }

    return NextResponse.json(
      {
        ok: true,
        sessionKey,
        sessionToken,
        gatewayWebSocketUrl: buildGatewayTerminalWebSocketUrl({
          gatewayUrl: secureInstance.instance.gateway_url,
          apiServerKey: secureInstance.apiServerKey,
          sessionKey,
          sessionToken,
          instanceIpv4: secureInstance.instanceIpv4,
        }),
      },
      { status: response.status },
    );
  };

  if (body.action === "start") {
    let initialStatus = 502;

    try {
      const initial = await forwardTerminalPost();
      initialStatus = initial.response.status;
      const initialResponse = buildStartResponse(initial.response, initial.payload, "initial", {
        returnFailureResponse: false,
      });
      if (initialResponse) {
        return initialResponse;
      }
    } catch (err) {
      log.warn("terminal sidecar request failed", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: secureInstance.instance.id,
        action: body.action,
        mode: body.mode,
        attempt: "initial",
        failureType: "terminal_sidecar_request_failed",
      }, err);
    }

    const sidecarReady = await maybeEnsureTerminalSidecar(secureInstance.instance, secureInstance.instanceIpv4);
    if (!sidecarReady) {
      log.warn("terminal sidecar refresh could not be confirmed after failed start", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: secureInstance.instance.id,
        action: body.action,
        mode: body.mode,
        failureType: "terminal_sidecar_refresh_unconfirmed_after_start_failure",
      });
      return NextResponse.json(
        { error: TERMINAL_REQUEST_ERROR },
        { status: initialStatus },
      );
    }

    try {
      const retry = await forwardTerminalPost();
      const retryResponse = buildStartResponse(retry.response, retry.payload, "retry_after_refresh", {
        returnFailureResponse: true,
      });
      if (retryResponse) {
        return retryResponse;
      }

      return NextResponse.json(
        { error: "Terminal session did not return a valid session identity" },
        { status: 502 },
      );
    } catch (err) {
      log.warn("terminal sidecar request failed", {
        source: "terminal-interactive",
        route: "/api/instances/[id]/terminal/interactive",
        method: "POST",
        instanceId: secureInstance.instance.id,
        action: body.action,
        mode: body.mode,
        attempt: "retry_after_refresh",
        failureType: "terminal_sidecar_request_failed",
      }, err);
      return NextResponse.json({ error: TERMINAL_REQUEST_ERROR }, { status: 502 });
    }
  }

  try {
    const { response, payload } = await forwardTerminalPost();

    if (!response.ok) {
      logRejectedTerminalRequest(response, "initial");
      return NextResponse.json(
        { error: TERMINAL_REQUEST_ERROR },
        { status: response.status },
      );
    }

    return NextResponse.json(payload || { ok: true }, { status: response.status });
  } catch (err) {
    log.warn("terminal sidecar request failed", {
      source: "terminal-interactive",
      route: "/api/instances/[id]/terminal/interactive",
      method: "POST",
      instanceId: secureInstance.instance.id,
      action: body.action,
      mode: body.mode,
      attempt: "initial",
      failureType: "terminal_sidecar_request_failed",
    }, err);
    return NextResponse.json({ error: TERMINAL_REQUEST_ERROR }, { status: 502 });
  }
}
