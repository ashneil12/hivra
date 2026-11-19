// Setup from a coding agent: the signed-in person continues a setup request.
// Ties the request to them (first person wins) and answers with the Launch
// link, agent and model access preselected. Same-origin browser call with the
// Clerk session. 404 unless HIVRA_AGENT_SETUP_HANDSHAKE is on.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { SETUP_AGENT_IDS, parseSetupCode, setupLaunchPath, type SetupAgentId } from "@/lib/agent-setup/core";
import { agentSetupHandshakeEnabled } from "@/lib/agent-setup/flag";
import { claimSetupRequest } from "@/lib/agent-setup/store";

const ROUTE = "/api/agent-setup/claim";
const Body = z.object({ code: z.string().max(20) }).strict();

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const refuse = (message: string, status: number, failureType: string, userId?: string, cause?: unknown) =>
  noStore(apiError(message, status, undefined, undefined, { source: "agent-setup", route: ROUTE, failureType, userId, cause, logLevel: status >= 500 ? "error" : "warn" }));

const isSetupAgent = (value: string | null): value is SetupAgentId => (SETUP_AGENT_IDS as readonly string[]).includes(value ?? "");

export async function POST(req: NextRequest) {
  if (!agentSetupHandshakeEnabled()) return refuse("Not found", 404, "agent_setup_off");
  const { userId } = await auth();
  if (!userId) return refuse("Unauthorized", 401, "agent_setup_claim_signed_out");
  const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "agent-setup:claim", userId, limit: 20, windowMs: 60_000 });
  if (limited) return noStore(limited);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  const code = parsed.success ? parseSetupCode(parsed.data.code) : null;
  if (!code) return refuse("That setup code isn't valid.", 400, "agent_setup_claim_bad_code", userId);

  try {
    const row = await claimSetupRequest(code, userId);
    if (!row) {
      return refuse("This setup link has expired or belongs to someone else. Ask your coding agent for a new one.", 410, "agent_setup_claim_refused", userId);
    }
    const agent = isSetupAgent(row.agent) ? row.agent : null;
    const inference = row.inference === "venice" || row.inference === "venice-key" ? row.inference : null;
    return noStore(apiSuccess({ launchPath: setupLaunchPath(agent, inference) }));
  } catch (err) {
    return refuse("Hivra couldn't continue this setup right now. Try again in a moment.", 503, "agent_setup_claim_failed", userId, err);
  }
}
