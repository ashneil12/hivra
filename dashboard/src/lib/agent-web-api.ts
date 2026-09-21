/**
 * agentWebApi — reusable proxy helper for the upstream Hermes web_server.py
 * management API (port 9119, routed via Caddy at /web-api/*).
 *
 * Usage:
 *   const api = await agentWebApi(instanceId, userId);
 *   const res = await api.get("/api/sessions");
 *   const data = await res.json();
 */
import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { extractHermesSessionToken } from "@/lib/hermes-web";

export interface AgentWebApiClient {
  /** Make a GET request to the management API */
  get(path: string, options?: { timeout?: number }): Promise<Response>;
  /** Make a POST request to the management API */
  post(path: string, body?: unknown, options?: { timeout?: number }): Promise<Response>;
  /** Make a PUT request to the management API */
  put(path: string, body?: unknown, options?: { timeout?: number }): Promise<Response>;
  /** Make a DELETE request to the management API */
  del(path: string, options?: { timeout?: number }): Promise<Response>;
  /** The resolved base URL (gatewayUrl + /web-api) */
  baseUrl: string;
}

async function fetchSessionToken(
  baseUrl: string,
  apiServerKey: string,
  instanceIpv4?: string,
): Promise<string> {
  const htmlTimestamp = Date.now().toString();
  const htmlSignature = crypto
    .createHmac("sha256", apiServerKey)
    .update(htmlTimestamp)
    .digest("hex");
  const htmlHeaders = {
    Accept: "text/html",
    Connection: "close",
    "X-Hermes-Timestamp": htmlTimestamp,
    "X-Hermes-Signature": htmlSignature,
  };

  const { response: htmlResponse } = await fetchFirstReachableGatewayResponse({
    baseUrl,
    pathname: "/",
    instanceIpv4,
    method: "GET",
    headers: htmlHeaders,
    timeoutMs: 15_000,
  });

  if (htmlResponse.ok) {
    const html = await htmlResponse.text();
    const injectedToken = extractHermesSessionToken(html);
    if (injectedToken) {
      return injectedToken;
    }
  }

  // Backward-compatible fallback for older fork builds that exposed the token
  // through a small JSON endpoint instead of HTML injection.
  const { response: jsonResponse } = await fetchFirstReachableGatewayResponse({
    baseUrl,
    pathname: "/api/auth/session-token",
    instanceIpv4,
    method: "GET",
    headers: {
      Accept: "application/json",
      Connection: "close",
      "X-Hermes-Timestamp": htmlTimestamp,
      "X-Hermes-Signature": htmlSignature,
    },
    timeoutMs: 15_000,
  });

  if (!jsonResponse.ok) {
    throw new Error(
      `Hermes web dashboard auth bootstrap failed (HTTP ${jsonResponse.status})`,
    );
  }

  const payload = (await jsonResponse.json().catch(() => null)) as
    | { token?: string }
    | null;
  if (payload?.token?.trim()) {
    return payload.token.trim();
  }

  throw new Error("Hermes web dashboard session token not found");
}

/**
 * Create an authenticated proxy client for an instance's web_server.py
 * management API. Validates user ownership and decrypts the API key.
 *
 * @throws Error if instance not found, not running, or gateway URL missing
 */
export async function agentWebApi(
  instanceId: string,
  userId: string
): Promise<AgentWebApiClient> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, gateway_url, status, host_id, hetzner_server_id, api_server_key_encrypted")
    .eq("id", instanceId)
    .eq("user_id", userId)
    .single();

  if (error || !instance) throw new Error("Instance not found");
  if (!instance.gateway_url) throw new Error("Gateway URL not configured");
  if (instance.status !== "running") throw new Error("Instance is not running");
  if (!instance.api_server_key_encrypted) {
    throw new Error("Instance API server key not configured");
  }

  const gatewayUrl = (instance.gateway_url as string).replace(/\/$/, "");
  const baseUrl = `${gatewayUrl}/web-api`;
  const instanceIpv4 = await resolveInstanceIpv4(instance as unknown as import('@/app/api/instances/[id]/route').HermesInstanceRow);
  const apiServerKey = decryptApiKey(instance.api_server_key_encrypted);
  const sessionToken = await fetchSessionToken(baseUrl, apiServerKey, instanceIpv4);

  const baseHeaders: Record<string, string> = {
    Accept: "application/json",
    Connection: "close",
    Authorization: `Bearer ${sessionToken}`,
  };

  function buildSignedHeaders(body?: string, extraHeaders?: Record<string, string>) {
    const timestamp = Date.now().toString();
    const signedPayload = body ? `${timestamp}.${body}` : timestamp;
    const signature = crypto
      .createHmac("sha256", apiServerKey)
      .update(signedPayload)
      .digest("hex");

    return {
      ...baseHeaders,
      ...extraHeaders,
      "X-Hermes-Timestamp": timestamp,
      "X-Hermes-Signature": signature,
    };
  }

  return {
    baseUrl,

    async get(path: string, options?: { timeout?: number }) {
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl,
        pathname: path,
        instanceIpv4,
        method: "GET",
        headers: buildSignedHeaders(),
        timeoutMs: options?.timeout ?? 15_000,
      });
      return response;
    },

    async post(path: string, body?: unknown, options?: { timeout?: number }) {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl,
        pathname: path,
        instanceIpv4,
        method: "POST",
        headers: buildSignedHeaders(payload, { "Content-Type": "application/json" }),
        body: payload,
        timeoutMs: options?.timeout ?? 15_000,
      });
      return response;
    },

    async put(path: string, body?: unknown, options?: { timeout?: number }) {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl,
        pathname: path,
        instanceIpv4,
        method: "PUT",
        headers: buildSignedHeaders(payload, { "Content-Type": "application/json" }),
        body: payload,
        timeoutMs: options?.timeout ?? 15_000,
      });
      return response;
    },

    async del(path: string, options?: { timeout?: number }) {
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl,
        pathname: path,
        instanceIpv4,
        method: "DELETE",
        headers: buildSignedHeaders(),
        timeoutMs: options?.timeout ?? 15_000,
      });
      return response;
    },
  };
}
