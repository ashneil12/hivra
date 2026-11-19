export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/hivra/agents/[id]/prompts/[promptId]/answer — the owner answers an
 * approval from Needs you. The computer's hivra-inbox plugin picks the answer up
 * within a few seconds and hands it to Hermes.
 *
 * Body: { "choice": "once" | "session" | "always" | "deny", "text"?: string }
 * (text only with deny: the reason Hermes passes to the agent).
 */

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { APPROVAL_CHOICES, answerPrompt, inboxAnswersEnabled } from "@/lib/agent-inbox/prompts";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const Body = z.object({ choice: z.enum(APPROVAL_CHOICES), text: z.string().max(500).optional() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; promptId: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!inboxAnswersEnabled()) return apiError("Not available", 404);
    const { id, promptId } = await context.params;
    if (!UUID.test(id) || !PROMPT_ID.test(promptId)) return apiError("This request is no longer waiting.", 404);
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_agent_prompt_answer", userId, limit: 30, windowMs: 60_000 });
    if (limited) return limited;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Choose an answer.", 400);
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiError("Choose an answer.", 400);
    const result = await answerPrompt(userId, id.toLowerCase(), promptId, parsed.data);
    if (!result.ok) return apiError(result.message, result.status);
    return apiSuccess({ prompt: result.prompt }, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
