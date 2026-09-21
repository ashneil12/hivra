import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { verifySignedUrl } from "../auth/signed-url.js";
import { NonceStore } from "../auth/nonce-store.js";
import { NOVNC_TTL_MS } from "../config.js";

// SCRIPTURE_ANCHOR: verify-gate | Psalm 118:20 | Verse: This is the gate of Yahweh; the righteous will enter into it.
// Caddy's forward_auth target. Returns 200 if the signed URL on
// X-Original-URI is valid, 401 otherwise. Never 5xx — Caddy treats anything
// except 2xx as a denial, but we still want to keep this clean.
//
// Scope is derived from the URL path: /browser-sidecar/novnc/<identity>/...
// or, if a single shared seed scope is used, from the ?scope= query param.
//
// Replay protection: every successful verify consumes the URL's nonce in
// the in-memory NonceStore. A second verify with the same nonce within TTL
// returns 401 reason="replay_detected".
//
// Audit logging: every verify (success + failure) is logged with the
// requesting client IP, scope, and reason. Operators can grep for replay
// attempts or scope mismatches in the supervisor's stdout.
export function registerNovncVerifyRoute(
  app: FastifyInstance,
  deps: { config: Config; logger: Logger },
): void {
  const store = new NonceStore(deps.logger);
  store.startPruner();

  app.get("/internal/verify-novnc-url", async (req, reply) => {
    const original = (req.headers["x-original-uri"] as string | undefined) ?? "";
    const peer = req.headers["x-forwarded-for"] || req.ip;

    const denyAndLog = (reason: string) => {
      deps.logger.warn(
        { event: "novnc_verify_denied", reason, peer, original_uri_len: original.length },
        "noVNC verify denied",
      );
      return reply.code(401).send({ ok: false, reason });
    };

    if (!original) return denyAndLog("no_original_uri");

    const url = new URL(original, "http://placeholder");
    const scope = url.searchParams.get("scope");
    if (!scope || !scope.startsWith("novnc:")) return denyAndLog("scope_missing_or_wrong_kind");

    const verified = verifySignedUrl({
      path: url.pathname,
      query: {
        ts: url.searchParams.get("ts") ?? undefined,
        nonce: url.searchParams.get("nonce") ?? undefined,
        sig: url.searchParams.get("sig") ?? undefined,
        scope: url.searchParams.get("scope") ?? undefined,
        ttl: url.searchParams.get("ttl") ?? undefined,
      },
      expectedScope: scope as `novnc:${string}`,
      secret: deps.config.SIGNING_SECRET,
      maxTtlMs: NOVNC_TTL_MS,
      consumeNonce: (key, expiresAt) => store.consume(key, expiresAt),
    });
    if (!verified.ok) return denyAndLog(verified.reason ?? "unknown");

    deps.logger.info(
      { event: "novnc_verify_ok", scope, peer, path: url.pathname },
      "noVNC verify ok",
    );
    return { ok: true };
  });
}
