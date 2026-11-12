// The owner's side of the local bridge: see requests, approve or deny them,
// enroll a computer, revoke it. Clerk-authenticated and same-origin. Off unless
// HIVRA_LOCAL_BRIDGE_ENABLED=true; canary hosts only.
export const runtime = "nodejs";
export const maxDuration = 150;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { loadOwnedRows } from "@/lib/agent-links/store";
import { allowanceActive, decideRequest, dispatchRequest, enrollComputer, expireStale, publicRequest, readResultForOwner, revokeAllowance, revokeComputer, withoutOldResult } from "@/lib/local-bridge/service";
import { listAllowances, listRequests, loadComputers, purgeOldResults } from "@/lib/local-bridge/store";
import { noStore } from "@/app/api/hivra/managed-sessions/route-support";

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enroll"), label: z.string().trim().min(1).max(80).optional(), computerId: Uuid.optional() }).strict(),
  z.object({ action: z.literal("decide"), requestId: Uuid, decision: z.enum(["approve", "deny", "allow_hour"]) }).strict(),
  z.object({ action: z.literal("revoke"), computerId: Uuid }).strict(),
  z.object({ action: z.literal("end_allowance"), agentId: Uuid, computerId: Uuid }).strict(),
]);
const failure = (method: string, failureType: string) => ({ route: "/api/hivra/bridge", method, failureType });

export async function GET(req: NextRequest) {
  try {
    if (!isLocalBridgeEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:bridge:read", userId, limit: 120, windowMs: 60_000 });
    if (limited) return noStore(limited);
    // One request's output, on demand (the list below never carries output).
    const wanted = req.nextUrl.searchParams.get("request");
    if (wanted !== null) {
      if (!Uuid.safeParse(wanted).success) return noStore(apiError("Not found.", 404));
      const read = await readResultForOwner(userId, wanted);
      if (!read.ok) return noStore(apiError(read.message, read.status));
      return noStore(apiSuccess(read.value));
    }
    // Output older than 7 days is cleared from the table, and never shown.
    await purgeOldResults(userId).catch(() => undefined);
    const [computers, listed, allowances, owned] = await Promise.all([loadComputers(userId), listRequests(userId), listAllowances(userId), loadOwnedRows(userId)]);
    const now = Date.now();
    const requests = await expireStale(listed, now);
    return noStore(apiSuccess({
      computers: computers.map((row) => ({ id: row.id, name: row.label, revoked: Boolean(row.revoked_at) })),
      agents: owned.map((row) => ({ id: row.id, name: String(row.name ?? "Agent") })),
      requests: requests.map((row) => publicRequest(withoutOldResult(row, now), false)),
      allowances: allowances.filter((row) => allowanceActive(row, now))
        .map((row) => ({ agentId: row.agent_id, computerId: row.computer_id, expiresAt: row.expires_at })),
    }));
  } catch {
    return noStore(apiError("Couldn't load the bridge.", 503, undefined, undefined, failure("GET", "bridge_unavailable")));
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isLocalBridgeEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req) || !hasStrictJsonContentType(req)) return noStore(apiError("Forbidden", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:bridge:write", userId, limit: 30, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const read = await readBoundedJson(req, 2_048, 5_000);
    const parsed = read.ok ? Body.safeParse(read.body) : null;
    if (!parsed?.success) return noStore(apiError("The request could not be read.", 400));
    const body = parsed.data;

    if (body.action === "decide") {
      const decided = await decideRequest(userId, body.requestId, body.decision);
      if (!decided.ok) return noStore(apiError(decided.message, decided.status));
      if (decided.value.dispatchNow) {
        runAfterResponse(() => dispatchRequest(userId, body.requestId), { source: "api/hivra/bridge", failureType: "bridge_dispatch_skipped", userId });
      }
      return noStore(apiSuccess({ request: publicRequest(decided.value.request, false) }));
    }
    if (body.action === "enroll") {
      const enrolled = await enrollComputer(userId, body.label ?? "My computer", body.computerId);
      if (!enrolled.ok) return noStore(apiError(enrolled.message, enrolled.status));
      // The configuration holds this computer's secrets: shown to the owner once, never logged.
      return noStore(apiSuccess({ computer: { id: enrolled.value.computer.id, name: enrolled.value.computer.label }, config: enrolled.value.config }));
    }
    if (body.action === "revoke") {
      const revoked = await revokeComputer(userId, body.computerId);
      if (!revoked.ok) return noStore(apiError(revoked.message, revoked.status));
      return noStore(apiSuccess({ revoked: true }));
    }
    await revokeAllowance(userId, body.agentId, body.computerId);
    return noStore(apiSuccess({ ended: true }));
  } catch {
    return noStore(apiError("The bridge couldn't do that right now.", 503, undefined, undefined, failure("POST", "bridge_action_unavailable")));
  }
}
