import "server-only";

import { createHmac, randomBytes } from "node:crypto";

// HMAC scheme — must match services/browser-sidecar/src/auth/signed-url.ts
// byte-for-byte so the sidecar's /internal/verify-novnc-url accepts URLs
// minted here.
//
//   sig = HMAC-SHA256(secret, `${path}|${ts}|${nonce}|${scope}`).hex
//   ts    = unix-ms
//   nonce = 16 random bytes hex (replay-protection — the sidecar's
//           NonceStore consumes (scope, nonce) on first verify and
//           rejects subsequent verifies of the same pair)
//   ttl   = lifetime in ms (server-side capped at NOVNC_TTL_MS)
//   scope = "novnc:<identity>"
//
// One mint = one connection. Reloading the noVNC viewer page in the user's
// browser triggers a fresh dashboard route call which mints a new nonce.
// Click the Live Browser Stream button = new mint. Navigate-away then
// navigate-back = new mint. The user never sees the replay protection;
// only an attacker who tries to replay a leaked URL does.

export const NOVNC_TTL_MS = 10 * 60 * 1000;

export interface MintedSignedUrl {
  url: string;
  websocketUrl: string;
  ttlMs: number;
  scope: string;
}

export function mintBrowserSidecarNovncUrl(opts: {
  /** Public base of the user's VM, e.g. "https://agent.example.com". */
  publicBase: string;
  /** Persistent context identity. Defaults to "vex". */
  identity?: string;
  /** Per-instance signing secret (the sidecar's SIGNING_SECRET, == webuiPassword). */
  secret: string;
  /** Override the default TTL. Capped at NOVNC_TTL_MS server-side regardless. */
  ttlMs?: number;
}): MintedSignedUrl {
  const identity = (opts.identity ?? "vex").trim() || "vex";
  const ttlMs = Math.min(opts.ttlMs ?? NOVNC_TTL_MS, NOVNC_TTL_MS);
  const ts = Date.now();
  const scope = `novnc:${identity}`;

  const baseTrim = opts.publicBase.replace(/\/$/, "");

  const htmlPath = "/browser-sidecar/novnc/vnc.html";
  const wsPath = "/browser-sidecar/novnc/websockify";

  // The HTML page and the WebSocket are SEPARATE one-shot URLs — each
  // gets its own nonce, so the page-load and the websocket-upgrade both
  // consume their own slots in the sidecar's NonceStore. Reusing one
  // shared nonce would mean opening the page (page-load consumes nonce)
  // breaks the WebSocket upgrade (already-consumed). Two different
  // nonces, one signed-URL each.
  const nonceHtml = randomBytes(16).toString("hex");
  const nonceWs = randomBytes(16).toString("hex");
  const sigHtml = sign(htmlPath, ts, nonceHtml, scope, opts.secret);
  const sigWs = sign(wsPath, ts, nonceWs, scope, opts.secret);

  const params = (sig: string, nonce: string) =>
    `ts=${ts}&nonce=${nonce}&sig=${sig}&scope=${encodeURIComponent(scope)}&ttl=${ttlMs}`;

  const httpsBase = baseTrim.replace(/^http:\/\//, "https://");
  const wssBase = httpsBase.replace(/^https?:\/\//, "wss://");

  return {
    url: `${httpsBase}${htmlPath}?${params(sigHtml, nonceHtml)}`,
    websocketUrl: `${wssBase}${wsPath}?${params(sigWs, nonceWs)}`,
    ttlMs,
    scope,
  };
}

function sign(path: string, ts: number, nonce: string, scope: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${path}|${ts}|${nonce}|${scope}`)
    .digest("hex");
}
