import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildBearerAuthPreHandler } from "./auth/bearer.js";
import { loadConfig } from "./config.js";
import { buildLogger, redactArgs } from "./logger.js";
import { revalidateTierOrExit } from "./tier/revalidate.js";
import { hasSufficientMemory, totalRamMb, MIN_VM_RAM_BYTES } from "./preflight/memory.js";
import { SessionManager } from "./playwright/session-manager.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerNavigationRoutes } from "./routes/navigation.js";
import { registerInteractionRoutes } from "./routes/interaction.js";
import { registerAssertionRoutes } from "./routes/assertion.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerFlowRoutes } from "./routes/flows.js";
import { registerCookieRoutes } from "./routes/cookies.js";
import { registerNovncVerifyRoute } from "./routes/novnc-verify.js";

// SCRIPTURE_ANCHOR: server-watch | Habakkuk 2:1 | Verse: I will stand at my watch, and set myself on the ramparts.

async function main() {
  const config = loadConfig();
  const logger = buildLogger(config);

  // Memory pre-flight: never launch Chromium on a VM too small to host it.
  // The dashboard-side ram_limit gate can drift from the live VM allocation,
  // so we re-check the VM's ACTUAL total RAM and bail cleanly if undersized —
  // otherwise Chromium would thrash the OOM-killer and risk sibling containers.
  if (!hasSufficientMemory()) {
    logger.error(
      { total_ram_mb: totalRamMb(), min_ram_mb: MIN_VM_RAM_BYTES / 1024 / 1024 },
      "insufficient VM RAM for browser sidecar; exiting 0 (watchdog will stop restarts)",
    );
    process.exit(0);
  }

  // Layer 2 tier gate: revalidate on container start.
  const tierResult = await revalidateTierOrExit(config, logger);
  if (!tierResult.ok) {
    logger.error({ result: tierResult }, "tier revalidation failed; exiting 0 (watchdog will stop restarts)");
    process.exit(0);
  }

  const sessions = new SessionManager(config, logger);
  const startedAt = Date.now();

  // Fastify's own logger is disabled — we emit our own structured log line per
  // request via the onResponse hook below. Keeping the pino instance separate
  // also keeps route handler types simple (FastifyInstance with default generics).
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 16 * 1024 * 1024,
  });
  await app.register(sensible);

  // Gate every tool route on the Bearer token (or warn-only mode when
  // SIDECAR_AUTH_TOKEN isn't configured yet). /health and the noVNC
  // verify-url endpoint are explicitly exempt — see auth/bearer.ts.
  app.addHook("onRequest", buildBearerAuthPreHandler(config, logger));

  // Single observability hook: every request emits one structured log line on completion.
  app.addHook("onResponse", async (req, reply) => {
    const args =
      req.method === "POST" && typeof req.body === "object" && req.body !== null
        ? redactArgs(req.body)
        : undefined;
    logger.info(
      {
        tool: req.routeOptions.url ?? req.url,
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

  registerHealthRoutes(app, { sessions, startedAt, tierOk: tierResult.ok });
  registerSessionRoutes(app, { sessions });
  registerNavigationRoutes(app, { sessions });
  registerInteractionRoutes(app, { sessions });
  registerAssertionRoutes(app, { sessions });
  registerCaptureRoutes(app, { sessions, config });
  registerFlowRoutes(app, { sessions, config, logger });
  registerCookieRoutes(app, { sessions });
  registerNovncVerifyRoute(app, { config, logger });

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    try {
      await app.close();
      await sessions.shutdown();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, "browser-sidecar listening");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
