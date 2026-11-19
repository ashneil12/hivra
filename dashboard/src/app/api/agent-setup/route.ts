// Setup from a coding agent: open a setup request (public, no session).
//
// A coding agent following /setup.md POSTs {agent?, inference?, client?} and
// gets a short code, a link for its person, a poll URL and a poll secret. The
// request grants nothing: the person still signs in and presses Launch. Answers
// 404 unless HIVRA_AGENT_SETUP_HANDSHAKE is on. Rate limited per address.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getIP, enforceRateLimit } from "@/lib/rate-limit";
import {
  SETUP_POLL_SECONDS,
  SETUP_TOKEN_HEADER,
  SetupRequestBody,
  displaySetupCode,
  setupApprovePath,
} from "@/lib/agent-setup/core";
import { agentSetupHandshakeEnabled } from "@/lib/agent-setup/flag";
import { createSetupRequest } from "@/lib/agent-setup/store";

const ROUTE = "/api/agent-setup";
const BODY_LIMIT = 4 * 1024;

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const refuse = (message: string, status: number, failureType: string, extra?: Record<string, unknown>, cause?: unknown) =>
  noStore(apiError(message, status, undefined, extra, { source: "agent-setup", route: ROUTE, failureType, cause, logLevel: status >= 500 ? "error" : "warn" }));

export async function POST(req: NextRequest) {
  if (!agentSetupHandshakeEnabled()) return refuse("Not found", 404, "agent_setup_off");
  const limited = enforceRateLimit(`agent-setup:create:${getIP(req)}`, { limit: 10, windowMs: 60 * 60_000 });
  if (!limited.success) return refuse("Too many setup requests from this address. Try again later.", 429, "agent_setup_rate_limited");

  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.length > BODY_LIMIT) return refuse("Request body too large", 413, "agent_setup_body_too_large");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return refuse("Send a JSON body, for example {\"agent\":\"hermes\"}.", 400, "agent_setup_bad_json");
  }
  const parsed = SetupRequestBody.safeParse(raw);
  if (!parsed.success) {
    return refuse("Unknown fields or values. See /setup.md for the accepted ones.", 400, "agent_setup_bad_body",
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  }

  try {
    const { row, secret } = await createSetupRequest(parsed.data);
    const origin = req.nextUrl.origin;
    return noStore(apiSuccess({
      id: row.id,
      code: displaySetupCode(row.code),
      approveUrl: `${origin}${setupApprovePath(row.code)}`,
      pollUrl: `${origin}${ROUTE}/${row.id}`,
      pollHeader: SETUP_TOKEN_HEADER,
      pollSecret: secret,
      pollEverySeconds: SETUP_POLL_SECONDS,
      expiresAt: row.expires_at,
    }, 201));
  } catch (err) {
    return refuse("Hivra couldn't start a setup request right now. Use the plain Launch link from /setup.md instead.", 503,
      "agent_setup_store_failed", undefined, err);
  }
}
