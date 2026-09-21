import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";

// SCRIPTURE_ANCHOR: health-days | Psalm 90:12 | Verse: So teach us to count our days, that we may gain a heart of wisdom.

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager; startedAt: number; tierOk: boolean },
): void {
  app.get("/health", async () => ({
    ok: true,
    contexts_active: deps.sessions.contextCount(),
    sessions_active: deps.sessions.activeCount(),
    uptime_s: Math.floor((Date.now() - deps.startedAt) / 1000),
    tier_ok: deps.tierOk,
  }));
}
