import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runAgentActivitySampling } from "@/lib/hivra/agent-activity-sampler";

/**
 * Reads how much each running agent is being used from its computer's
 * connection service (every 10 minutes, vercel.json) and stores it for the
 * usage report: counts and times only, never content
 * (lib/hivra/agent-activity-sampler.ts).
 *
 * Ships dark: unless HIVRA_AGENT_ACTIVITY_SAMPLING=1 this is a no-op that
 * reads nothing.
 */
export const dynamic = "force-dynamic";

// Must equal ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS, which the sampler's read
// budget is set under (a literal here, as Next.js reads it statically).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "sample-agent-activity",
      route: "/api/cron/sample-agent-activity",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    return apiSuccess(await runAgentActivitySampling());
  } catch (error) {
    log.error("sample-agent-activity failed", error instanceof Error ? error : new Error(String(error)), {
      source: "sample-agent-activity",
      failureType: "agent_activity_sampling_failed",
    });
    return apiError("Agent activity sampling failed", 500);
  }
}
