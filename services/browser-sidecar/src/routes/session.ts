import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import { parseBody } from "./_validate.js";

const StartSchema = z.object({ identity: z.string() });
const EndSchema = z.object({ session_id: z.string() });

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager },
): void {
  app.post("/session/start", async (req, reply) => {
    const body = parseBody(req, reply, StartSchema);
    if (!body) return;
    try {
      const { session_id } = await deps.sessions.start(body.identity);
      return { ok: true, session_id };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "INTERNAL", message: (err as Error).message });
    }
  });

  app.post("/session/end", async (req, reply) => {
    const body = parseBody(req, reply, EndSchema);
    if (!body) return;
    try {
      await deps.sessions.end(body.session_id);
      return { ok: true };
    } catch (err) {
      // end() throws when page close fails; report it so the caller knows the
      // session may not be cleanly torn down (mirrors /session/start).
      return reply.code(500).send({ ok: false, error: "INTERNAL", message: (err as Error).message });
    }
  });
}
