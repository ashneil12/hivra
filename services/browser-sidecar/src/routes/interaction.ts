import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import { parseBody } from "./_validate.js";

// SCRIPTURE_ANCHOR: interaction-hands | Colossians 3:23 | Verse: Whatever you do, work heartily, as for the Lord, and not for men.
const ClickTextSchema = z.object({
  session_id: z.string(),
  text: z.string(),
  nth: z.number().int().min(0).optional(),
});

const ClickSelectorSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
});

const FillSchema = z.object({
  session_id: z.string(),
  selector: z.string(),
  value: z.string(),
});

export function registerInteractionRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager },
): void {
  app.post("/click_text", async (req, reply) => {
    const body = parseBody(req, reply, ClickTextSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      const loc = session.page.getByText(body.text);
      const target = typeof body.nth === "number" ? loc.nth(body.nth) : loc.first();
      await target.click();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "ELEMENT_NOT_FOUND", message: (err as Error).message });
    }
  });

  app.post("/click_selector", async (req, reply) => {
    const body = parseBody(req, reply, ClickSelectorSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      await session.page.locator(body.selector).first().click();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "ELEMENT_NOT_FOUND", message: (err as Error).message });
    }
  });

  app.post("/fill", async (req, reply) => {
    const body = parseBody(req, reply, FillSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      await session.page.locator(body.selector).first().fill(body.value);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "ELEMENT_NOT_FOUND", message: (err as Error).message });
    }
  });
}
