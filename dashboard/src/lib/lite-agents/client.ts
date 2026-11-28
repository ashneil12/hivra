import "server-only";

import { isAllowedLiteRoute, liteSignatureHeaders } from "./signing";

const MIN_SECRET_LENGTH = 32;
const TIMEOUT_MS = 90_000;

export interface LiteWorkerConfig {
  url: string;
  secret: string;
}

/** The Worker's address and signing secret, or null when this deployment has none. */
export function liteWorkerConfig(env: NodeJS.ProcessEnv = process.env): LiteWorkerConfig | null {
  const url = env.HIVRA_LITE_AGENT_URL?.trim().replace(/\/+$/, "");
  const secret = env.HIVRA_LITE_AGENT_SECRET?.trim();
  if (!url || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  try {
    if (new URL(url).protocol !== "https:" && process.env.NODE_ENV === "production") return null;
  } catch {
    return null;
  }
  return { url, secret };
}

/**
 * Calls the Lite agent Worker as `account`. Only allow-listed routes are sent;
 * the Worker trusts the signed account id, so callers must pass the signed-in
 * user's id and nothing else.
 */
export async function callLiteWorker(
  config: LiteWorkerConfig,
  account: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!isAllowedLiteRoute(method, path)) return { status: 404, body: { error: "not_found" } };
  const text = body === undefined || method === "GET" || method === "DELETE" ? "" : JSON.stringify(body);
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      ...(text ? { "content-type": "application/json" } : {}),
      ...liteSignatureHeaders(config.secret, method, path, account, text),
    },
    ...(text ? { body: text } : {}),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = { error: "bad_worker_response" };
  }
  return { status: response.status, body: parsed };
}
