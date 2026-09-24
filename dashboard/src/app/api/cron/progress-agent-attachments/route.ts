import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";
import { progressAttachmentWork, type AttachmentWorkProgress } from "@/lib/agent-computers/attachment-worker";

/**
 * The attach worker (design 5.5): every minute, one pass over each open attach
 * step, oldest first: claim to staging to activation to "Chat is ready", and
 * each Change access and Remove. The database's compare-and-swaps make an
 * overlapping pass safe; a pass only observes what another already started.
 * Canary only: elsewhere it does nothing.
 *
 * Schedule: every minute via vercel.json.
 */
export const dynamic = "force-dynamic";

// An activation runs the enforcement probe and waits for Chat and the gateway;
// a Remove sweeps the disk. The pass has one deadline, 20 s inside the
// function's limit: each item starts a host step only if that step's own
// worst case fits before it, so a pass is never killed with a step half done.
export const maxDuration = 800;
const DEADLINE_MS = (maxDuration - 20) * 1000;
const MAX_ITEMS = 5;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "progress-agent-attachments", route: "/api/cron/progress-agent-attachments", method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!isAgentAttachEnabled()) return apiSuccess({ enabled: false, results: [] });
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const work = await createAttachmentLifecycleStore().listWork(MAX_ITEMS);
    const results: AttachmentWorkProgress[] = [];
    for (const item of work) results.push(await progressAttachmentWork(item, { deadline }));
    const held = results.filter((result) => result.state === "held");
    if (held.length) {
      log.warn("attached agent steps held", { source: "progress-agent-attachments", route: "/api/cron/progress-agent-attachments",
        failureType: "attachment_steps_held", held: held.map((result) => ({ kind: result.kind, id: result.id, reason: result.reason })) });
    }
    return apiSuccess({ enabled: true, open: work.length, results });
  } catch (error) {
    return apiError("Attach worker could not read its work", 503, undefined, undefined, {
      route: "/api/cron/progress-agent-attachments", method: "GET", failureType: "attachment_worker_unavailable",
      metadata: { errorName: error instanceof Error ? error.name : typeof error } });
  }
}
