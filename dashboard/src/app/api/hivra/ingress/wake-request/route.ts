// POST /api/hivra/ingress/wake-request: a host asks Hivra to wake one of its
// computers, one the host cannot resume itself (a hibernated computer) or
// whose wake needs the server (a channel arm to take down). Signed with the
// host credential (lib/hivra/ingress/host-credential.ts); 404 while
// HIVRA_INGRESS_HOST_CREDENTIAL is off. Answers at once; the wake runs after
// the answer, and the host shows a "waking" page meanwhile.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The wake runs after the answer; its worst case is a hibernated agent's restore.
export const maxDuration = 300;

import { after, type NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { WAKE_REQUEST_PATH } from "@/lib/hivra/ingress/host-credential";
import { hostCallJson, verifiedHostCall } from "@/lib/hivra/ingress/host-call-http";
import { handleWakeRequest } from "@/lib/hivra/ingress/host-calls";

export async function POST(req: NextRequest) {
  try {
    const call = await verifiedHostCall(req, WAKE_REQUEST_PATH);
    if (!call.ok) return call.response;
    const answer = await handleWakeRequest(call.hostId, call.body, {
      onBackground: (work) => after(() => work),
    });
    return hostCallJson(answer.status, answer.body);
  } catch (error) {
    log.error("host wake request failed", error instanceof Error ? error : new Error(String(error)), {
      source: "ingress-wake-request",
      failureType: "ingress_wake_request_failed",
    });
    return hostCallJson(503, { ok: false, error: "unavailable" }, { "Retry-After": "5" });
  }
}
