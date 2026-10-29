import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import { routeLabel, type Logger } from "../logger.js";

// SCRIPTURE_ANCHOR: bearer-watch | Proverbs 4:23 | Verse: Keep your heart with all vigilance, for from it flow the springs of life.

// Routes that intentionally bypass the bearer check.
//   /health — used by the docker healthcheck inside the same container; no
//             tenant data is exposed.
//   /internal/verify-novnc-url — has its own HMAC signed-URL contract so
//             the noVNC Caddy forward-auth flow works without a bearer.
const PUBLIC_PATHS = new Set<string>(["/health", "/internal/verify-novnc-url"]);

function readBearerToken(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Build the Fastify `onRequest` preHandler that gates every tool route on
 * SIDECAR_AUTH_TOKEN.
 *
 * Three modes, controlled by config.SIDECAR_AUTH_TOKEN and
 * config.SIDECAR_ALLOW_UNAUTHENTICATED:
 *
 *  - **Strict** (token configured) — every request to a non-public path
 *    must carry `Authorization: Bearer <token>`. Wrong / missing token
 *    returns 401 + a fail-closed warn log.
 *
 *  - **Explicit warn-only** (token unset AND
 *    SIDECAR_ALLOW_UNAUTHENTICATED=1) — every request is allowed through,
 *    but each one logs `auth_disabled: true` so operators can see during
 *    the rollout whether any sibling container is still talking to the
 *    sidecar without a bearer. Dev / migration escape hatch only.
 *
 *  - **Fail-closed** (token unset, no opt-in) — gated routes return 503
 *    `AUTH_NOT_CONFIGURED`. An unauthenticated tool API is never the
 *    silent default: a box missing the seeded token degrades loudly
 *    instead of serving /goto, /screenshot and /cookies to any peer on
 *    the docker network.
 */
export function buildBearerAuthPreHandler(config: Config, logger: Logger) {
  const token = config.SIDECAR_AUTH_TOKEN ?? null;
  const allowUnauthenticated = config.SIDECAR_ALLOW_UNAUTHENTICATED === true;
  return async function bearerAuthPreHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const url = req.routeOptions.url ?? req.url;
    if (PUBLIC_PATHS.has(url)) return;
    const tool = routeLabel(req);

    const presented = readBearerToken(req);

    if (!token) {
      if (allowUnauthenticated) {
        // Warn-only mode. Do not log the token itself.
        logger.warn(
          {
            tool,
            method: req.method,
            auth_disabled: true,
            bearer_present: presented !== null,
          },
          "sidecar bearer auth not configured; allowing request (explicit SIDECAR_ALLOW_UNAUTHENTICATED opt-in)",
        );
        return;
      }
      logger.error(
        {
          tool,
          method: req.method,
          auth_disabled: true,
        },
        "sidecar bearer auth not configured; refusing request (set SIDECAR_AUTH_TOKEN, or SIDECAR_ALLOW_UNAUTHENTICATED=1 to opt in to warn-only mode)",
      );
      await reply
        .code(503)
        .send({ ok: false, error: "AUTH_NOT_CONFIGURED" });
      return;
    }

    if (!presented || !constantTimeEqual(presented, token)) {
      logger.warn(
        {
          tool,
          method: req.method,
          bearer_present: presented !== null,
        },
        "sidecar bearer auth rejected; returning 401",
      );
      await reply.code(401).send({ ok: false, error: "UNAUTHORIZED" });
    }
  };
}
