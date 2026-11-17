// Request signing for the memory Worker (services/memory-worker). Restated
// from the Worker's `verifyAdmin` on purpose: the two sides deploy separately.

import crypto from "node:crypto";

export const MEMORY_SIGNATURE_VERSION = "memory|v1";

export function memorySignedMessage(method: string, path: string, account: string, timestamp: string, body: string): string {
  const bodySha256 = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return `${MEMORY_SIGNATURE_VERSION}|${method.toUpperCase()}|${path}|${account}|${timestamp}|${bodySha256}`;
}

export function memorySignatureHeaders(
  secret: string,
  method: string,
  path: string,
  account: string,
  body: string,
  nowMs: number = Date.now(),
): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(memorySignedMessage(method, path, account, timestamp, body))
    .digest("hex");
  return { "x-hivra-account": account, "x-hivra-timestamp": timestamp, "x-hivra-signature": signature };
}

/**
 * The Worker's owner routes a browser may reach through Hivra. Anything else is
 * refused before it is signed. Reading and writing memories is not here: agents
 * do that straight against the Worker with a memory key.
 */
const ALLOWED: ReadonlyArray<readonly [method: string, path: string]> = [
  ["GET", "/admin/keys"],
  ["POST", "/admin/keys"],
  ["DELETE", "/admin/keys"],
  ["GET", "/admin/stats"],
  ["DELETE", "/admin/account"],
];

export function isAllowedMemoryRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return ALLOWED.some(([m, p]) => m === upper && p === path);
}
