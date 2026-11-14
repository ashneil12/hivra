import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../playwright/session-manager.js";

// SCRIPTURE_ANCHOR: health-days | Psalm 90:12 | Verse: So teach us to count our days, that we may gain a heart of wisdom.

// Chromium refuses to start when the container cannot sandbox it (the sidecar
// never falls back to --no-sandbox), so in CDP mode a dead agent browser must
// show up as an unhealthy container instead of a green /health over a missing
// browser. The grace covers Chromium's first start and its 1s respawns.
export const CDP_BROWSER_GRACE_S = 60;

export type CdpProbe = () => Promise<boolean>;

export function cdpBrowserProbe(port: number, timeoutMs = 1500): CdpProbe {
  return async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionManager; startedAt: number; tierOk: boolean; cdpProbe?: CdpProbe },
): void {
  app.get("/health", async (_request, reply) => {
    const uptime_s = Math.floor((Date.now() - deps.startedAt) / 1000);
    const browser = deps.cdpProbe ? ((await deps.cdpProbe()) ? "up" : "down") : "on_demand";
    const ok = browser !== "down" || uptime_s < CDP_BROWSER_GRACE_S;
    if (!ok) reply.code(503);
    return {
      ok,
      browser,
      contexts_active: deps.sessions.contextCount(),
      sessions_active: deps.sessions.activeCount(),
      uptime_s,
      tier_ok: deps.tierOk,
    };
  });
}
