// Setup from a coding agent: the poll. The coding agent that opened the request
// sends its poll secret in the x-hivra-setup-token header (not Authorization,
// which the proxy would hand to Clerk) and learns whether its person opened the
// link, pressed Launch, and whether the agent is running, with its link.
// Answers 404 unless HIVRA_AGENT_SETUP_HANDSHAKE is on, and 404 for a wrong id or
// secret, so a guess learns nothing.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { SETUP_TOKEN_HEADER, resolveSetupStatus } from "@/lib/agent-setup/core";
import { agentSetupHandshakeEnabled } from "@/lib/agent-setup/flag";
import { findLaunchedAgent, findSetupBySecret } from "@/lib/agent-setup/store";

const ROUTE = "/api/agent-setup/[id]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const refuse = (message: string, status: number, failureType: string, cause?: unknown) =>
  noStore(apiError(message, status, undefined, undefined, { source: "agent-setup", route: ROUTE, failureType, cause, logLevel: status >= 500 ? "error" : "warn" }));

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!agentSetupHandshakeEnabled()) return refuse("Not found", 404, "agent_setup_off");
  const limited = enforceRateLimit(`agent-setup:poll:${getIP(req)}`, { limit: 120, windowMs: 60_000 });
  if (!limited.success) return refuse("Polling too fast. Wait a few seconds between polls.", 429, "agent_setup_poll_rate_limited");

  const { id } = await context.params;
  const secret = req.headers.get(SETUP_TOKEN_HEADER)?.trim() ?? "";
  if (!UUID.test(id) || !secret || secret.length > 200) return refuse("Not found", 404, "agent_setup_unknown");

  try {
    const row = await findSetupBySecret(id, secret);
    if (!row) return refuse("Not found", 404, "agent_setup_unknown");
    const agent = await findLaunchedAgent(row);
    return noStore(apiSuccess(resolveSetupStatus(row, agent, req.nextUrl.origin)));
  } catch (err) {
    return refuse("Hivra couldn't check this setup right now. Poll again in a few seconds.", 503, "agent_setup_poll_failed", err);
  }
}
