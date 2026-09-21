// GET /api/instances/[id]/daily-brief
//
// The agent-written "Today's brief": the latest run of the box's "Daily brief"
// scheduled job (seeded by /api/cron/seed-daily-brief). Returns { text } or
// { text: null } — null whenever the box has no brief job/run yet or the agent
// image doesn't expose the runs endpoint, so the panel keeps its heuristic brief.

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { fetchBriefRunText } from "@/lib/daily-brief";
import { getSecureUserInstance } from "@/lib/services/instance-security";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const { id } = await params;
  const result = await getSecureUserInstance({ id, userId, requireRunning: true });
  // Any ownership/reachability miss → null (the panel falls back to its heuristic).
  if (result.error !== null || !result.instance) return apiSuccess({ text: null });

  const text = await fetchBriefRunText(result);
  return apiSuccess({ text });
}
