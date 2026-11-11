// The agent API for the local bridge: an agent on a Hivra computer asks to run one
// command (an argument list, no shell) on its owner's own computer, then polls for
// the result. Authenticated exactly like /api/agent-link: the agent's link key is
// the only authority and names one agent. Nothing runs until the owner approves
// the request in the dashboard (or has allowed this agent for the hour).
//
// GET            lists the owner's bridge computers (id, name).
// GET ?id=<id>   reads one of this agent's requests.
// POST {computer, argv, cwd?, timeoutSeconds?, maxOutputBytes?} files a request.
// Off unless HIVRA_LOCAL_BRIDGE_ENABLED=true; canary hosts only.
export const runtime = "nodejs";
export const maxDuration = 150;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { findAgentByKey, loadOwnedRow } from "@/lib/agent-links/store";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { LIMITS, dispatchRequest, publicRequest, readRequestForAgent, submitRequest } from "@/lib/local-bridge/service";
import { loadComputers } from "@/lib/local-bridge/store";

const ROUTE = "/api/agent-bridge";
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** No NUL and no lone surrogate (which is not valid UTF-8 and would hash differently on each side). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const cleanText = (value: string) => !value.includes("\0") && !LONE_SURROGATE.test(value);
const Body = z.object({
  computer: Uuid,
  argv: z.array(z.string().max(LIMITS.argLength).refine(cleanText)).min(1).max(LIMITS.argvItems).refine((argv) => (argv[0] ?? "x").length > 0),
  cwd: z.string().min(1).max(4096).refine(cleanText).optional(),
  timeoutSeconds: z.number().int().min(1).max(LIMITS.timeoutMax).optional(),
  maxOutputBytes: z.number().int().min(1).max(LIMITS.outputMax).optional(),
}).strict();
const BODY_LIMIT = 64 * 1024;

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const refuse = (message: string, status: number, failureType: string) =>
  noStore(apiError(message, status, undefined, undefined, { source: "agent-bridge", route: ROUTE, failureType, logLevel: status >= 500 ? "error" : "warn" }));

async function caller(req: NextRequest): Promise<{ agentId: string; userId: string } | Response> {
  if (!isHivraApiAllowed(req.headers.get("host")) || !isLocalBridgeEnabled()) return noStore(apiError("Not found", 404));
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  const found = match ? await findAgentByKey(match[1]) : null;
  if (!found) return refuse("Unauthorized", 401, "invalid_agent_link_key");
  const agent = await loadOwnedRow(found.userId, found.agentId);
  if (!agent) return refuse("Unauthorized", 401, "agent_link_key_orphaned");
  return { agentId: agent.id, userId: found.userId };
}

export async function GET(req: NextRequest) {
  try {
    const who = await caller(req);
    if (who instanceof Response) return who;
    const limit = enforceRateLimit(`agent-bridge:read:${who.agentId}`, { limit: 120, windowMs: 60_000 });
    if (!limit.success) return refuse("Too many requests. Wait a minute.", 429, "agent_bridge_rate_limited");
    const id = req.nextUrl.searchParams.get("id");
    if (id !== null) {
      if (!Uuid.safeParse(id).success) return refuse("Not found.", 404, "agent_bridge_not_found");
      const read = await readRequestForAgent(who.userId, who.agentId, id);
      if (!read.ok) return refuse(read.message, read.status, "agent_bridge_not_found");
      return noStore(apiSuccess({ request: publicRequest(read.value) }));
    }
    const computers = (await loadComputers(who.userId)).map((row) => ({ id: row.id, name: row.label }));
    return noStore(apiSuccess({ computers }));
  } catch {
    return refuse("Hivra couldn't read the bridge right now.", 503, "agent_bridge_read_unavailable");
  }
}

export async function POST(req: NextRequest) {
  try {
    const who = await caller(req);
    if (who instanceof Response) return who;
    const limit = enforceRateLimit(`agent-bridge:submit:${who.agentId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return refuse("Too many requests. Wait a minute.", 429, "agent_bridge_rate_limited");
    const text = await req.text();
    if (text.length > BODY_LIMIT) return refuse("The request is too large.", 413, "agent_bridge_too_large");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refuse("The request could not be read.", 400, "agent_bridge_invalid");
    }
    const body = Body.safeParse(json);
    if (!body.success) return refuse("The request could not be read. Send {computer, argv: string[]}.", 400, "agent_bridge_invalid");
    const submitted = await submitRequest(who.userId, who.agentId, body.data.computer, body.data);
    if (!submitted.ok) return refuse(submitted.message, submitted.status, "agent_bridge_refused");
    const { request, dispatchNow } = submitted.value;
    if (dispatchNow) {
      runAfterResponse(() => dispatchRequest(who.userId, request.id), { source: "agent-bridge", failureType: "bridge_dispatch_skipped", agentId: who.agentId });
    }
    return noStore(apiSuccess({ request: publicRequest(request, false) }, 202));
  } catch {
    return refuse("Hivra couldn't file that request right now.", 503, "agent_bridge_submit_unavailable");
  }
}
