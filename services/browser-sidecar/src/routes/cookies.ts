import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import { parseBody } from "./_validate.js";
import { parseCookies, CookieParseError } from "../cookies/parse.js";

// POST /cookies/import — load a user-exported cookie file into an identity's
// persistent context so the agent's browser (and the noVNC live view) is logged
// into their accounts. Accepts the raw exported file (Netscape cookies.txt,
// Cookie-Editor JSON, or Playwright storageState — see cookies/parse.ts); the
// sidecar owns parsing so the format logic lives in exactly one place.
//
// `dryRun` parses + reports the domains/count without importing, so the UI can
// show "import N cookies for example.com, …" and let the user confirm first.
const ImportSchema = z.object({
  identity: z.string().optional(),
  file: z.string().min(1).max(8 * 1024 * 1024),
  dryRun: z.boolean().optional(),
});

export function registerCookieRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager },
): void {
  app.post("/cookies/import", async (req, reply) => {
    const body = parseBody(req, reply, ImportSchema);
    if (!body) return;
    const identity = (body.identity ?? "vex").trim() || "vex";

    let parsed;
    try {
      parsed = parseCookies(body.file);
    } catch (err) {
      const message = err instanceof CookieParseError ? err.message : "could not parse cookie file";
      return reply.code(400).send({ ok: false, error: "INVALID_COOKIE_FILE", message });
    }

    if (body.dryRun) {
      return {
        ok: true,
        dryRun: true,
        count: parsed.cookies.length,
        format: parsed.format,
        domains: parsed.domains,
      };
    }

    try {
      const res = await deps.sessions.importCookies(identity, parsed.cookies);
      return {
        ok: true,
        imported: res.imported,
        skipped: res.skipped,
        format: parsed.format,
        domains: res.domains,
      };
    } catch (err) {
      return reply
        .code(500)
        .send({ ok: false, error: "INTERNAL", message: (err as Error).message });
    }
  });
}
