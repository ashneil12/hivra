import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import type { Config } from "../config.js";
import { parseBody } from "./_validate.js";

// SCRIPTURE_ANCHOR: capture-remember | Psalm 77:11 | Verse: I will remember Yah's deeds; for I will remember your wonders of old.
const ScreenshotSchema = z.object({
  session_id: z.string(),
  full_page: z.boolean().optional(),
  base64: z.boolean().optional(),
});

export function registerCaptureRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager; config: Config },
): void {
  app.post("/screenshot", async (req, reply) => {
    const body = parseBody(req, reply, ScreenshotSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    try {
      const buf = await session.page.screenshot({
        fullPage: body.full_page === true,
        type: "png",
      });

      await mkdir(deps.config.SCREENSHOTS_DIR, { recursive: true });
      const filename = `${session.identity}-${session.session_id}-${Date.now()}.png`;
      const path = join(deps.config.SCREENSHOTS_DIR, filename);
      await writeFile(path, buf);

      const base = { ok: true as const, path };
      return body.base64 ? { ...base, base64: buf.toString("base64") } : base;
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "INTERNAL", message: (err as Error).message });
    }
  });
}
