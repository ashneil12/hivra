import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NOVNC_TTL_MS } from "../config.js";

// HMAC-signed URL scheme:
//   ?ts=<unix-ms>&nonce=<hex16>&scope=<scope>&sig=<hex hmac-sha256>&ttl=<ms>
//
//   sig = HMAC-SHA256(secret, `${path}|${ts}|${nonce}|${scope}`).hex
//
// `nonce` makes every minted URL unique (so two Browser-button clicks within
// TTL produce different sigs even with identical path+ts+scope). The verify
// endpoint records consumed nonces in an in-memory store; replay returns 401.
//
// `scope` is "novnc:<identity>" — keeps a stolen URL pinned to one identity.
// `ts` must be within ttlMs of "now" to defeat replay across a long window.

// SCRIPTURE_ANCHOR: signed-seal | Daniel 6:17 | Verse: A stone was brought and laid on the mouth of the den, and the king sealed it.

export type SignedUrlScope = `novnc:${string}` | `seed:${string}` | "internal";

export interface SignedUrlVerifyResult {
  ok: boolean;
  reason?:
    | "missing_params"
    | "expired"
    | "bad_signature"
    | "scope_mismatch"
    | "replay_detected";
}

export function mintSignedUrl(opts: {
  baseUrl: string;
  path: string;
  scope: SignedUrlScope;
  secret: string;
  ttlMs?: number;
}): string {
  const ttlMs = opts.ttlMs ?? NOVNC_TTL_MS;
  const ts = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const sig = sign(opts.path, ts, nonce, opts.scope, opts.secret);
  const url = new URL(opts.path, opts.baseUrl);
  url.searchParams.set("ts", String(ts));
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("sig", sig);
  url.searchParams.set("ttl", String(ttlMs));
  return url.toString();
}

export function verifySignedUrl(opts: {
  path: string;
  query: { ts?: string; nonce?: string; sig?: string; scope?: string; ttl?: string };
  expectedScope: SignedUrlScope;
  secret: string;
  maxTtlMs?: number;
  /**
   * Optional replay-store hook. When present, the verifier consumes the
   * (scope, nonce) pair atomically — first call returns ok, subsequent
   * calls within TTL return ok=false reason="replay_detected".
   *
   * Returning false from consume() means "this nonce was already used".
   * If consume throws, verification fails closed (better to deny a real
   * user than silently allow replay during a transient store outage).
   */
  consumeNonce?: (key: string, expiresAtMs: number) => boolean;
}): SignedUrlVerifyResult {
  const { ts, sig, scope, ttl, nonce } = opts.query;
  if (!ts || !sig || !scope || !nonce) return { ok: false, reason: "missing_params" };
  if (scope !== opts.expectedScope) return { ok: false, reason: "scope_mismatch" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "missing_params" };

  const requestedTtl = Number(ttl);
  const effectiveTtl = Math.min(
    Number.isFinite(requestedTtl) ? requestedTtl : NOVNC_TTL_MS,
    opts.maxTtlMs ?? NOVNC_TTL_MS,
  );
  if (Date.now() - tsNum > effectiveTtl) return { ok: false, reason: "expired" };

  const expected = sign(opts.path, tsNum, nonce, opts.expectedScope, opts.secret);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (opts.consumeNonce) {
    const expiresAt = tsNum + effectiveTtl;
    let consumed: boolean;
    try {
      consumed = opts.consumeNonce(`${opts.expectedScope}:${nonce}`, expiresAt);
    } catch {
      return { ok: false, reason: "replay_detected" };
    }
    if (!consumed) return { ok: false, reason: "replay_detected" };
  }

  return { ok: true };
}

function sign(path: string, ts: number, nonce: string, scope: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${path}|${ts}|${nonce}|${scope}`)
    .digest("hex");
}
