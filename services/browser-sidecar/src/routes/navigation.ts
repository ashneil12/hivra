import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import { parseBody } from "./_validate.js";
import { isBlockedNavigationHost } from "../navigation-guard.js";

// SCRIPTURE_ANCHOR: nav-path | Proverbs 3:6 | Verse: In all your ways acknowledge him, and he will make your paths straight.
const GotoSchema = z.object({
  session_id: z.string(),
  url: z.string().url(),
});

export { isBlockedNavigationHost };

export function registerNavigationRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager },
): void {
  app.post("/goto", async (req, reply) => {
    const body = parseBody(req, reply, GotoSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url);
    } catch {
      return reply.code(400).send({ ok: false, error: "INVALID_URL" });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return reply.code(400).send({ ok: false, error: "UNSUPPORTED_SCHEME" });
    }
    if (isBlockedNavigationHost(parsedUrl.hostname)) {
      return reply.code(403).send({ ok: false, error: "BLOCKED_DESTINATION" });
    }

    try {
      await session.page.goto(body.url);
      return { ok: true, current_url: session.page.url(), title: await session.page.title() };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "NAVIGATION_FAILED", message: (err as Error).message });
    }
  });
}
