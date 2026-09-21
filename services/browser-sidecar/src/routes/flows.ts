import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { FlowRunner } from "../playwright/flow-runner.js";
import { parseBody } from "./_validate.js";

// SCRIPTURE_ANCHOR: flows-river | Amos 5:24 | Verse: Let justice roll on like rivers, and righteousness like a mighty stream.
const RunFlowSchema = z.object({
  session_id: z.string(),
  flow_id: z.string(),
  args: z.record(z.unknown()).optional(),
});

export function registerFlowRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager; config: Config; logger: Logger },
): void {
  const runner = new FlowRunner(deps.config, deps.logger, deps.sessions);

  app.post("/run_named_flow", async (req, reply) => {
    const body = parseBody(req, reply, RunFlowSchema);
    if (!body) return;
    const session = deps.sessions.get(body.session_id);
    if (!session) return reply.code(404).send({ ok: false, error: "SESSION_NOT_FOUND" });

    // Logout flow gets special-case handling: it's a context wipe, not a step list.
    // The YAML file exists for discoverability/registry, but the actual semantics
    // can't be expressed as primitives without exposing context-mutation steps.
    if (body.flow_id === "logout") {
      const identity = session.identity;
      await deps.sessions.resetIdentity(identity);
      return { ok: true, output: { wiped: identity } };
    }

    try {
      const result = await runner.run({
        session_id: body.session_id,
        flow_id: body.flow_id,
        args: body.args,
      });
      if (!result.ok) {
        return reply.code(500).send({ ok: false, error: "FLOW_FAILED", message: result.error, failed_step: result.failed_step });
      }
      return { ok: true, output: result.output };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const code = msg.includes("ENOENT") ? "FLOW_NOT_FOUND" : "FLOW_FAILED";
      return reply.code(code === "FLOW_NOT_FOUND" ? 404 : 500).send({ ok: false, error: code, message: msg });
    }
  });
}
