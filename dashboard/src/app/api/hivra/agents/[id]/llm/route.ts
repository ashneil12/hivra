// Owner-only model settings. The server delivers credentials directly to the
// original computer; responses contain summaries and operation status only.
export const runtime = "nodejs";
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { createModelKeyCoordinator, ModelKeyError, type ModelKeyProblem } from "@/lib/hivra/model-key-coordinator";
import { ModelKeyStoreError } from "@/lib/hivra/model-key-store";
import { createLaunchModelCoordinator } from "@/lib/hivra/launch-model-coordinator";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const Request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), llm: z.unknown() }).strict(),
  z.object({ action: z.literal("resume"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("continue_launch"), requestId: z.string().uuid(), automatic: z.boolean() }).strict(),
  z.object({ action: z.literal("cancel_launch"), requestId: z.string().uuid() }).strict(),
]).refine(value => value.action !== "apply" || Object.prototype.hasOwnProperty.call(value, "llm"));
const STATUS: Record<ModelKeyProblem, number> = {
  invalid_request: 400, not_found: 404, computer_not_ready: 409, unsupported_runtime: 409,
  guest_upgrade_required: 409, guest_unavailable: 503, operation_conflict: 409, pending_change: 409,
  stored_setting_unavailable: 503, save_unconfirmed: 503, configuration_unavailable: 503,
};
const noStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "no-store"); return response;
};
const error = (message: string, status: number, code?: string) => noStore(apiError(message, status,
  code ? { failureType: code } : undefined, code ? { code } : undefined));
function failure(cause: unknown) {
  if (cause instanceof ModelKeyError) return error(cause.message, STATUS[cause.code], cause.code);
  if (cause instanceof ModelKeyStoreError) return error(cause.message, 503, "storage_unavailable");
  // Do not forward or log raw exceptions from encryption, storage or transport.
  return error("Model settings could not be confirmed. Refresh the saved state before trying again.", 503, "settings_unavailable");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return error("Not found", 404);
    const { userId } = await auth();
    if (!userId) return error("Unauthorized", 401);
    const { id } = await params;
    // Custody moves monotonically from precursor to journal to saved setting.
    // Read in that order so a concurrent promotion/settlement cannot disappear
    // between snapshots. Later pending/active evidence supersedes an earlier
    // waiting precursor; neither metadata read dispatches a model operation.
    const launch = await createLaunchModelCoordinator().summary(userId, id);
    const settings = await createModelKeyCoordinator().summary(userId, id);
    return noStore(apiSuccess({ ...settings, launch: settings.pending || settings.llm ? null : launch }));
  } catch (cause) { return failure(cause); }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return error("Not found", 404);
    const { userId } = await auth();
    if (!userId) return error("Unauthorized", 401);
    if (!isSameOriginMutationRequest(req)) return error("Open model settings from this dashboard to make a change.", 403);
    if (!hasStrictJsonContentType(req)) return error("Send model settings as JSON.", 415);
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_model_settings", userId, ...RATE_LIMIT_PRESETS.secretWrite });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(req, 4096, 5000);
    if (!body.ok) return error("Send a complete model-settings request of at most 4 KB.", body.reason === "too_large" ? 413 : 400);
    const parsed = Request.safeParse(body.body);
    if (!parsed.success) return error("Include a request ID and explicit model settings, or resume an existing change.", 400, "invalid_request");
    const { id } = await params, coordinator = createModelKeyCoordinator(), input = parsed.data;
    const launches = createLaunchModelCoordinator();
    if (input.action === "continue_launch") {
      const outcome = await launches.continue(userId, id, input.requestId, input.automatic);
      return noStore(apiSuccess(outcome, outcome.status === "applied" ? 200 : 202));
    }
    if (input.action === "cancel_launch") return noStore(apiSuccess(await launches.cancel(userId, id, input.requestId)));
    if (input.action === "apply") await launches.assertNoPendingLaunch(userId, id);
    const outcome = input.action === "resume"
      ? await coordinator.resume(userId, id, input.operationId)
      : await coordinator.start(userId, id, input.operationId, input.llm);
    return noStore(apiSuccess(outcome, outcome.status === "pending" ? 202 : 200));
  } catch (cause) { return failure(cause); }
}
