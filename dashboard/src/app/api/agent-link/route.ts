// The agent API: what an agent's own `hivra-computers` CLI calls. The bearer
// key is the only authority (no Clerk session, no cookie; the proxy leaves
// this exact path to the route). It names one agent; that agent may use only
// the computers its owner linked to it, read fresh on every request, so a
// removed link or a deleted agent stops working at once.
//
// GET  lists the agent's computers.
// POST {computer, command, stdinBase64?, timeoutSeconds?} runs one command on
//      one of them as that computer's own user and returns its output.
// Design: docs/superpowers/specs/2026-10-19-agent-computer-links.md. Canary only.
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { log } from "@/lib/logger";
import { isAgentLinksEnabled } from "@/lib/agent-links/flag";
import { computerKindLabel, linkLabel } from "@/lib/agent-links/eligibility";
import { execRefusalCopy, runLinkedCommand } from "@/lib/agent-links/exec";
import { LINK_EXEC_COMMAND_MAX, LINK_EXEC_STDIN_MAX, LINK_EXEC_TIMEOUT_MAX_SECONDS } from "@/lib/agent-links/exec-program";
import { findAgentByKey, loadLinks, loadOwnedRow, loadOwnedRows, targetState, touchLink, type OwnedRow } from "@/lib/agent-links/store";

const ROUTE = "/api/agent-link";
const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const refuse = (message: string, status: number, failureType: string) =>
  noStore(apiError(message, status, undefined, undefined, { source: "agent-link", route: ROUTE, failureType, logLevel: status >= 500 ? "error" : "warn" }));
const Body = z.object({
  computer: z.string().trim().min(1).max(100),
  command: z.string().min(1).max(LINK_EXEC_COMMAND_MAX),
  stdinBase64: z.string().max(Math.ceil(LINK_EXEC_STDIN_MAX / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
  timeoutSeconds: z.number().int().min(1).max(LINK_EXEC_TIMEOUT_MAX_SECONDS).optional(),
}).strict();
const BODY_LIMIT = 800 * 1024;

type Caller = { agent: OwnedRow; userId: string };

async function caller(req: NextRequest): Promise<Caller | Response> {
  if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentLinksEnabled()) return noStore(apiError("Not found", 404));
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  const found = match ? await findAgentByKey(match[1]) : null;
  if (!found) return refuse("Unauthorized", 401, "invalid_agent_link_key");
  const agent = await loadOwnedRow(found.userId, found.agentId);
  if (!agent) return refuse("Unauthorized", 401, "agent_link_key_orphaned");
  return { agent, userId: found.userId };
}

async function linkedComputers(userId: string, agentId: string) {
  const [links, rows] = await Promise.all([loadLinks(userId, { agentId }), loadOwnedRows(userId)]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return links.flatMap((link) => {
    const row = byId.get(link.computer_id);
    return row ? [{ link, row }] : [];
  });
}

export async function GET(req: NextRequest) {
  try {
    const who = await caller(req);
    if (who instanceof Response) return who;
    const limit = enforceRateLimit(`agent-link:read:${who.agent.id}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return refuse("Too many requests. Wait a minute.", 429, "agent_link_rate_limited");
    const computers = (await linkedComputers(who.userId, who.agent.id)).map(({ row }) => ({
      id: row.id, name: linkLabel(row.name), kind: computerKindLabel(row), status: String(row.status ?? "unknown"), ...targetState(row),
    }));
    return noStore(apiSuccess({ agent: { id: who.agent.id, name: linkLabel(who.agent.name, "Agent") }, computers }));
  } catch {
    return refuse("Hivra couldn't list your computers right now.", 503, "agent_link_list_unavailable");
  }
}

export async function POST(req: NextRequest) {
  try {
    const who = await caller(req);
    if (who instanceof Response) return who;
    const limit = enforceRateLimit(`agent-link:run:${who.agent.id}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return refuse("Too many commands. Wait a minute.", 429, "agent_link_rate_limited");
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > BODY_LIMIT) return refuse("The request is too large.", 413, "agent_link_body_too_large");
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof Body>>;
    try {
      const text = await req.text();
      if (Buffer.byteLength(text) > BODY_LIMIT) return refuse("The request is too large.", 413, "agent_link_body_too_large");
      parsed = Body.safeParse(JSON.parse(text));
    } catch {
      return refuse("The request could not be read.", 400, "agent_link_body_invalid");
    }
    if (!parsed.success) return refuse("The request could not be read.", 400, "agent_link_body_invalid");
    const body = parsed.data;

    const computers = await linkedComputers(who.userId, who.agent.id);
    const wanted = body.computer.toLowerCase();
    const byId = computers.filter(({ row }) => row.id === wanted);
    const byName = computers.filter(({ row }) => linkLabel(row.name).toLowerCase() === wanted);
    const matches = byId.length ? byId : byName;
    if (matches.length === 0) return refuse(`No computer called "${linkLabel(body.computer)}" is linked to you. Run hivra-computers list.`, 404, "agent_link_unknown_computer");
    if (matches.length > 1) return refuse("More than one linked computer has that name. Use its id from hivra-computers list.", 409, "agent_link_ambiguous_computer");
    const { link, row } = matches[0];

    const outcome = await runLinkedCommand(who.userId, row, {
      command: body.command,
      stdin: body.stdinBase64 ? Buffer.from(body.stdinBase64, "base64") : undefined,
      timeoutSeconds: body.timeoutSeconds ?? 60,
    });
    // Content-free audit: who ran something where, never the command or its output.
    log.info("agent link command", { source: "agent-link", userId: who.userId, agentId: who.agent.id, computerId: row.id,
      commandBytes: Buffer.byteLength(body.command), outcome: outcome.status === "ran" ? `exit_${outcome.exitCode}` : outcome.reason });
    if (outcome.status === "refused") {
      const status = outcome.reason === "computer_not_running" ? 409 : outcome.reason === "not_supported" ? 409
        : outcome.reason === "request_invalid" || outcome.reason === "stdin_too_large" ? 400 : 502;
      return refuse(execRefusalCopy(outcome.reason), status, `agent_link_${outcome.reason}`);
    }
    await touchLink(link.id).catch(() => undefined);
    return noStore(apiSuccess({
      computer: { id: row.id, name: linkLabel(row.name) },
      exitCode: outcome.exitCode,
      stdoutBase64: outcome.stdout.toString("base64"),
      stderrBase64: outcome.stderr.toString("base64"),
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
    }));
  } catch {
    return refuse("Hivra couldn't run that command right now.", 503, "agent_link_run_unavailable");
  }
}
