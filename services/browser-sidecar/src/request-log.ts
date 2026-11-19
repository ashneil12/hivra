import type { FastifyInstance } from "fastify";
import { redactArgs, routeLabel, type Logger } from "./logger.js";

// Single observability hook: every request emits one structured log line on completion.
// Kept apart from server.ts so tests can attach it to a Fastify app and read what it logs.
export function attachRequestLog(app: FastifyInstance, logger: Logger): void {
  app.addHook("onResponse", async (req, reply) => {
    const args =
      req.method === "POST" && typeof req.body === "object" && req.body !== null
        ? redactArgs(req.body)
        : undefined;
    logger.info(
      {
        tool: routeLabel(req),
        method: req.method,
        status: reply.statusCode,
        duration_ms: reply.elapsedTime,
        identity: (req.body as { identity?: string } | undefined)?.identity,
        session_id: (req.body as { session_id?: string } | undefined)?.session_id,
        args,
      },
      "request",
    );
  });
}
