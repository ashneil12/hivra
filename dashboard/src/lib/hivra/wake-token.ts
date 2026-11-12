import crypto from "node:crypto";

/**
 * Short-lived pre-wake token, scoped to one agent.
 *
 * The dashboard signs it into the agent page. The page sends it with the
 * pre-wake beacon, so the host edge can tell a real owner's page from a random
 * request. Format: base64url(JSON {a: agentId, e: expiry in epoch seconds}) +
 * "." + base64url(HMAC-SHA256 of that first part). The secret is
 * HIVRA_WAKE_TOKEN_SECRET; without it nothing is signed and nothing verifies.
 */

export const DEFAULT_WAKE_TOKEN_TTL_SECONDS = 10 * 60;
export const MAX_WAKE_TOKEN_TTL_SECONDS = 60 * 60;
const MAX_TOKEN_LENGTH = 512;

interface WakeTokenOptions {
  /** Epoch ms or a Date; defaults to now. */
  now?: Date | number;
  /** Defaults to HIVRA_WAKE_TOKEN_SECRET. */
  secret?: string | null;
}

function secretFrom(options: WakeTokenOptions): string | null {
  const secret = options.secret === undefined ? process.env.HIVRA_WAKE_TOKEN_SECRET : options.secret;
  return secret && secret.trim() ? secret : null;
}

function nowSeconds(now: Date | number | undefined): number {
  const ms = now === undefined ? Date.now() : typeof now === "number" ? now : now.getTime();
  return Math.floor(ms / 1000);
}

function sign(body: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(body).digest();
}

/** Returns null when no secret is configured or the input is unusable. */
export function signWakeToken(
  agentId: string,
  options: WakeTokenOptions & { ttlSeconds?: number } = {},
): string | null {
  const secret = secretFrom(options);
  if (!secret || !agentId) return null;
  const ttl = Math.min(
    Math.max(1, Math.floor(options.ttlSeconds ?? DEFAULT_WAKE_TOKEN_TTL_SECONDS)),
    MAX_WAKE_TOKEN_TTL_SECONDS,
  );
  const payload = { a: agentId, e: nowSeconds(options.now) + ttl };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/** True only for an untampered, unexpired token issued for exactly this agent. */
export function verifyWakeToken(
  token: string | null | undefined,
  agentId: string,
  options: WakeTokenOptions = {},
): boolean {
  const secret = secretFrom(options);
  if (!secret || !agentId || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [body, signature] = parts;

  const given = Buffer.from(signature, "base64url");
  const expected = sign(body, secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return false;
    const { a, e } = payload as { a?: unknown; e?: unknown };
    return a === agentId && typeof e === "number" && Number.isFinite(e) && nowSeconds(options.now) < e;
  } catch {
    return false;
  }
}
