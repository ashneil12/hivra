export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/agent-prompts — the hivra-inbox Hermes plugin's one route.
 *
 *   prompt.pending   Hermes is waiting on its owner (an approval or a question).
 *   prompt.resolved  The wait ended (answered anywhere, timed out, or withdrawn).
 *   prompt.poll      Which of these prompts has the owner answered from Needs you?
 *
 * Auth: the computer's own box token (~/.hivra/api-token, hivra_agents.api_token)
 * as a bearer. No Clerk session: this comes from the owner's computer. Lives
 * outside the Clerk-protected paths in src/lib/protected-routes.ts.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  MAX_TTL_SECONDS,
  answersFor,
  computerForToken,
  inboxAnswersEnabled,
  recordPending,
  recordResolved,
} from "@/lib/agent-inbox/prompts";
import { enforceRateLimit } from "@/lib/rate-limit";

const ROUTE = "/api/internal/agent-prompts";
const SOURCE = "agent-prompts-ingest";
const PROMPT_ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const Payload = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("prompt.pending"),
    prompt_id: PROMPT_ID,
    kind: z.enum(["approval", "clarify"]),
    summary: z.string().max(1000).optional(),
    command: z.string().max(2000).optional(),
    command_complete: z.boolean().optional(),
    choices: z.array(z.string().max(16)).max(4).optional(),
    session_id: z.string().max(200).optional(),
    tool: z.string().max(40).optional(),
    ttl_seconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  }),
  z.object({
    event: z.literal("prompt.resolved"),
    prompt_id: PROMPT_ID,
    kind: z.enum(["approval", "clarify"]).optional(),
    outcome: z.string().max(32).optional(),
  }),
  z.object({
    event: z.literal("prompt.poll"),
    prompt_ids: z.array(PROMPT_ID).max(20),
  }),
]);

const meta = (failureType: string, logLevel: "warn" | "error" = "warn") => ({ route: ROUTE, method: "POST", source: SOURCE, failureType, logLevel });

export async function POST(request: NextRequest) {
  try {
    if (!inboxAnswersEnabled()) return apiError("Not available", 404, undefined, undefined, meta("inbox_off"));
    const computer = await computerForToken(request.headers.get("authorization"));
    if (!computer) return apiError("Unauthorized", 401, undefined, undefined, meta("unknown_computer"));
    const limited = enforceRateLimit(`agent-prompts:${computer.id}`, { limit: 120, windowMs: 60_000 });
    if (!limited.success) return apiError("Too many requests", 429, undefined, undefined, meta("rate_limited"));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid JSON body", 400, undefined, undefined, meta("invalid_json"));
    }
    const parsed = Payload.safeParse(body);
    if (!parsed.success) return apiError("Invalid payload", 400, undefined, undefined, meta("invalid_payload"));
    const payload = parsed.data;

    if (payload.event === "prompt.pending") {
      const answer = await recordPending(computer, {
        promptId: payload.prompt_id,
        kind: payload.kind,
        summary: payload.summary,
        command: payload.command,
        commandComplete: payload.command_complete,
        choices: payload.choices,
        sessionId: payload.session_id,
        ttlSeconds: payload.ttl_seconds,
        tool: payload.tool,
      });
      return apiSuccess(answer ? { recorded: true, answer } : { recorded: true });
    }
    if (payload.event === "prompt.resolved") {
      await recordResolved(computer, payload.prompt_id, payload.outcome ?? "resolved");
      return apiSuccess({ recorded: true });
    }
    return apiSuccess({ answers: await answersFor(computer, payload.prompt_ids) });
  } catch (error) {
    return handleApiError(error);
  }
}
