// Request signing for the Lite agent Worker (services/lite-agent-worker).
// Restated from the Worker's `signedMessage` on purpose: the two sides are
// deployed separately and the Worker's tests sign with the same formula.

import crypto from "node:crypto";

export const LITE_SIGNATURE_VERSION = "lite|v1";
export const LITE_MANAGED_QA_SIGNATURE_VERSION = "lite-managed-qa|v1";
export const LITE_MANAGED_QA_CALLBACK_PATH = "/api/internal/lite-managed-qa";
export const LITE_MANAGED_QA_MAX_PROMPT = 1_000;

export function liteSignedMessage(
  method: string,
  path: string,
  account: string,
  timestamp: string,
  body: string,
  version = LITE_SIGNATURE_VERSION,
): string {
  const bodySha256 = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return `${version}|${method.toUpperCase()}|${path}|${account}|${timestamp}|${bodySha256}`;
}

export function liteSignatureHeaders(
  secret: string,
  method: string,
  path: string,
  account: string,
  body: string,
  nowMs: number = Date.now(),
  version = LITE_SIGNATURE_VERSION,
): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(liteSignedMessage(method, path, account, timestamp, body, version))
    .digest("hex");
  return {
    "x-hivra-account": account,
    "x-hivra-timestamp": timestamp,
    "x-hivra-signature": signature,
  };
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * The Worker routes a browser may reach through Hivra, by method. Anything else
 * is refused before it is signed, so the proxy can never be pointed elsewhere.
 */
const ALLOWED: Array<[method: string, pattern: RegExp]> = [
  ["GET", /^\/v1\/me$/],
  ["POST", /^\/v1\/agents$/],
  ["GET", new RegExp(`^/v1/agents/${ID}$`)],
  ["PATCH", new RegExp(`^/v1/agents/${ID}$`)],
  ["DELETE", new RegExp(`^/v1/agents/${ID}$`)],
  ["POST", new RegExp(`^/v1/agents/${ID}/sessions$`)],
  ["GET", new RegExp(`^/v1/agents/${ID}/sessions/${ID}$`)],
  ["DELETE", new RegExp(`^/v1/agents/${ID}/sessions/${ID}$`)],
  ["POST", new RegExp(`^/v1/agents/${ID}/sessions/${ID}/(?:(?:managed|own-key)-)?messages$`)],
];

export function isAllowedLiteRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return ALLOWED.some(([m, pattern]) => m === upper && pattern.test(path));
}
