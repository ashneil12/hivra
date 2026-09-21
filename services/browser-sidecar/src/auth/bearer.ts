import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

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
 * Two modes, controlled by whether config.SIDECAR_AUTH_TOKEN is set:
 *
 *  - **Strict** (token configured) — every request to a non-public path
 *    must carry `Authorization: Bearer <token>`. Wrong / missing token
 *    returns 401 + a fail-closed warn log.
 *
 *  - **Migration / warn-only** (token unset) — every request is allowed
 *    through, but each one logs `auth_disabled: true` so operators can
 *    see during the rollout whether any sibling container is still
 *    talking to the sidecar without a bearer. The intent is for
 *    provisioning to seed SIDECAR_AUTH_TOKEN on new VMs and for the
 *    agent's sidecar client (a different repo) to be updated to send
 *    the bearer; once the fleet is migrated this branch can be
 *    deleted and the env var becomes required.
 */
export function buildBearerAuthPreHandler(config: Config, logger: Logger) {
  const token = config.SIDECAR_AUTH_TOKEN ?? null;
  return async function bearerAuthPreHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const url = req.routeOptions.url ?? req.url;
    if (PUBLIC_PATHS.has(url)) return;

    const presented = readBearerToken(req);

    if (!token) {
      // Warn-only mode. Do not log the token itself.
      logger.warn(
        {
          tool: url,
          method: req.method,
          auth_disabled: true,
          bearer_present: presented !== null,
        },
        "sidecar bearer auth not configured; allowing request (fleet-migration mode)",
      );
      return;
    }

    if (!presented || !constantTimeEqual(presented, token)) {
      logger.warn(
        {
          tool: url,
          method: req.method,
          bearer_present: presented !== null,
        },
        "sidecar bearer auth rejected; returning 401",
      );
      await reply.code(401).send({ ok: false, error: "UNAUTHORIZED" });
    }
  };
}
