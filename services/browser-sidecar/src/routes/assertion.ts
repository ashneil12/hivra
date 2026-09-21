import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import { parseBody } from "./_validate.js";

// SCRIPTURE_ANCHOR: assert-true | Zechariah 8:16 | Verse: Speak every man the truth with his neighbor. Execute the judgment of truth and peace.
const WaitForSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
});

const AssertVisibleSchema = z
  .object({
    session_id: z.string(),
    selector: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((d) => !!d.selector || !!d.text, {
    message: "either selector or text is required",
  });

const GetTextSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
});

export function registerAssertionRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager },
): void {
  app.post("/wait_for", async (req, reply) => {
    const body = parseBody(req, reply, WaitForSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      await session.page.locator(body.selector).first().waitFor({
        state: "visible",
        timeout: body.timeout_ms,
      });
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "TIMEOUT", message: (err as Error).message });
    }
  });

  app.post("/assert_visible", async (req, reply) => {
    const body = parseBody(req, reply, AssertVisibleSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      const loc = body.selector
        ? session.page.locator(body.selector).first()
        : session.page.getByText(body.text!).first();
      const visible = await loc.isVisible();
      return { ok: true, visible };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "ELEMENT_NOT_FOUND", message: (err as Error).message });
    }
  });

  app.post("/get_text", async (req, reply) => {
    const body = parseBody(req, reply, GetTextSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      const text = await session.page.locator(body.selector).first().innerText();
      return { ok: true, text };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "ELEMENT_NOT_FOUND", message: (err as Error).message });
    }
  });
}
