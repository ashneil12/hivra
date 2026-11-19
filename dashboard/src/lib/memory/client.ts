import "server-only";

import { isAllowedMemoryRoute, memorySignatureHeaders } from "./signing";

const MIN_SECRET_LENGTH = 32;
const TIMEOUT_MS = 20_000;

export interface MemoryWorkerConfig {
  url: string;
  secret: string;
}

/** The memory Worker's address and signing secret, or null when this deployment has none. */
export function memoryWorkerConfig(env: NodeJS.ProcessEnv = process.env): MemoryWorkerConfig | null {
  const url = env.HIVRA_MEMORY_URL?.trim().replace(/\/+$/, "");
  const secret = env.HIVRA_MEMORY_SECRET?.trim();
  if (!url || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  try {
    if (new URL(url).protocol !== "https:" && process.env.NODE_ENV === "production") return null;
  } catch {
    return null;
  }
  return { url, secret };
}

/**
 * Calls the memory Worker as `account`. The Worker trusts the signed account
 * id, so callers must pass the signed-in user's id and nothing else.
 */
export async function callMemoryWorker(
  config: MemoryWorkerConfig,
  account: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!isAllowedMemoryRoute(method, path)) return { status: 404, body: { error: "not_found" } };
  const text = body === undefined || method === "GET" ? "" : JSON.stringify(body);
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      ...(text ? { "content-type": "application/json" } : {}),
      ...memorySignatureHeaders(config.secret, method, path, account, text),
    },
    ...(text ? { body: text } : {}),
    cache: "no-store",
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
