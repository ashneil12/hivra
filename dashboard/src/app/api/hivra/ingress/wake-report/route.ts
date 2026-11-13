// POST /api/hivra/ingress/wake-report: a host's wake proxy says it resumed a
// napping computer. Signed with the host credential (lib/hivra/ingress/
// host-credential.ts); 404 while HIVRA_INGRESS_HOST_CREDENTIAL is off. Sets the
// record awake and takes every channel wake arm down at once, rather than
// waiting for the next sweep.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

import type { NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { WAKE_REPORT_PATH } from "@/lib/hivra/ingress/host-credential";
import { hostCallJson, verifiedHostCall } from "@/lib/hivra/ingress/host-call-http";
import { handleWakeReport } from "@/lib/hivra/ingress/host-calls";

export async function POST(req: NextRequest) {
  try {
    const call = await verifiedHostCall(req, WAKE_REPORT_PATH);
    if (!call.ok) return call.response;
    const answer = await handleWakeReport(call.hostId, call.body);
    return hostCallJson(answer.status, answer.body);
  } catch (error) {
    log.error("host wake report failed", error instanceof Error ? error : new Error(String(error)), {
      source: "ingress-wake-report",
      failureType: "ingress_wake_report_failed",
    });
    return hostCallJson(503, { ok: false, error: "unavailable" }, { "Retry-After": "5" });
  }
}
