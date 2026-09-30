export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getManagedSession } from "@/lib/hivra/do-managed-sessions";
import { loadCredentialExpiries } from "@/lib/infrastructure/credential-expiry-store";
import { managedSessionFailure, noStore, UUID, hivraApiUnavailable } from "../route-support";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  try {
    const reconcile = request.nextUrl.searchParams.get("reconcile") === "1";
    const session = await getManagedSession(userId, id.toLowerCase(), { reconcile });
    // The owner-declared token expiry of the connection this agent runs on, for the agent page's reminder.
    const credentialExpiry = session.connectionId
      ? (await loadCredentialExpiries(userId, [session.connectionId])).get(session.connectionId) ?? null
      : null;
    return noStore(apiSuccess({ session, credentialExpiry }));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]");
  }
}
