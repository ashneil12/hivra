import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { sweepAskHookUpdates } from "@/lib/agent-inbox/ask-first";
import { sweepInboxInstalls } from "@/lib/agent-inbox/install";

/**
 * Cron: put the Needs you add-on (hivra-inbox Hermes plugin) on running Hermes
 * computers that don't have the current version, a few per run. Does nothing
 * while HIVRA_INBOX_ANSWERS is off. Also refreshes Claude Code's "Ask me first"
 * hook on computers where the owner turned it on, when the hook changed. Schedule: every 10 minutes (vercel.json).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "agent-inbox-install",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  try {
    const hermes = await sweepInboxInstalls();
    const askFirst = await sweepAskHookUpdates();
    return apiSuccess({ ...hermes, askFirst });
  } catch (err) {
    log.error("agent-inbox-install failed", err, { source: "agent-inbox-install", failureType: "agent_inbox_install_failed" });
    return apiError("Failed to install the Needs you add-on", 500);
  }
}
