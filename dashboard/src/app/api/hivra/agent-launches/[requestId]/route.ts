// Owner-only lookup after an interrupted launch response. This endpoint never
// repeats allocation, dispatches setup or requires the model key again.
export const runtime = "nodejs";
export const maxDuration = 15;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { createLaunchModelAdmissionService } from "@/lib/hivra/launch-model-admission";
import {
  createHivraLaunchOperationService,
  type HivraLaunchOperationReplay,
} from "@/lib/hivra/launch-operation-store";
import { sanitizeHivraAgentRow } from "@/lib/hivra/agent-llm";
import { findGvisorComputerByLaunchRequest } from "@/lib/hivra/gvisor-computer-service";

const noStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "no-store"); return response;
};

function genericReceiptResponse(saved: HivraLaunchOperationReplay) {
  if (saved.state === "accepted") {
    return apiSuccess({
      launchRequestId: saved.requestId,
      phase: saved.phase,
      agent: sanitizeHivraAgentRow(saved.agent),
    });
  }
  if (saved.state === "failed") {
    return apiError("The saved launch stopped before a computer was accepted.", saved.failureStatus, undefined, {
      code: saved.failureCode,
      launchRequestId: saved.requestId,
      launch: { state: "failed", phase: saved.phase },
    });
  }
  return apiSuccess({
    launchRequestId: saved.requestId,
    phase: saved.phase,
    launch: { state: "reconciling", phase: saved.phase },
  }, 202);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const { requestId } = await params;
    if (!z.string().uuid().safeParse(requestId).success) return noStore(apiError("Invalid launch request ID.", 400));
    const generic = await createHivraLaunchOperationService().original(userId, requestId);
    if (generic) return noStore(genericReceiptResponse(generic));
    const saved = await createLaunchModelAdmissionService().original(userId, requestId);
    if (saved) return noStore(apiSuccess({ launchRequestId: saved.requestId, phase: saved.phase,
      agent: sanitizeHivraAgentRow(saved.agent) }));
    const gvisor = await findGvisorComputerByLaunchRequest(userId, requestId);
    if (!gvisor) return noStore(apiError("No saved launch was found for this request.", 404));
    return noStore(apiSuccess({ launchRequestId: requestId, phase: "accepted",
      agent: sanitizeHivraAgentRow(gvisor) }));
  } catch {
    return noStore(apiError("The saved launch could not be checked. Keep this request ID and check again before launching another computer.", 503));
  }
}
