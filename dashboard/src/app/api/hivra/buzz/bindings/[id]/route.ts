export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { createBuzzCoordinator } from "@/lib/hivra/buzz-coordinator";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { buzzFailure, MAX_BUZZ_RUNTIME_BODY_BYTES, noStore, readBuzzMutation } from "../../route-utils";

const Id = z.string().uuid();
const RuntimeInstall = z.discriminatedUnion("provider", [
  z.object({
    action: z.literal("runtime_install"),
    operationId: z.string().uuid(),
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/),
    apiKey: z.string().min(1).max(8_192).regex(/^[\x21-\x7e]+$/),
    ownerPublicKey: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    action: z.literal("runtime_install"),
    operationId: z.string().uuid(),
    provider: z.literal("venice"),
    model: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/),
    ownerPublicKey: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
const Action = z.union([
  z.object({ action: z.enum(["resume", "health", "runtime_resume", "runtime_health", "runtime_remove"]) }).strict(),
  RuntimeInstall,
]);
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const id = Id.safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Invalid Buzz binding.", 400));
    const mutation = await readBuzzMutation(
      request,
      userId,
      "hivra_buzz_binding_action",
      MAX_BUZZ_RUNTIME_BODY_BYTES,
    );
    if (!mutation.ok) return mutation.response;
    const action = Action.safeParse(mutation.body);
    if (!action.success) return noStore(apiError("Invalid Buzz action.", 400));
    const coordinator = createBuzzCoordinator();
    const result = action.data.action === "health" ? await coordinator.health(userId, id.data)
      : action.data.action === "resume" ? await coordinator.resume(userId, id.data)
      : action.data.action === "runtime_install" ? await coordinator.activateRuntime(userId, id.data, action.data)
      : action.data.action === "runtime_resume" ? await coordinator.resumeRuntime(userId, id.data)
      : action.data.action === "runtime_health" ? await coordinator.runtimeHealth(userId, id.data)
      : await coordinator.removeRuntime(userId, id.data);
    return noStore(apiSuccess(result));
  } catch (error) {
    return buzzFailure(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const id = Id.safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Invalid Buzz binding.", 400));
    const mutation = await readBuzzMutation(request, userId, "hivra_buzz_disconnect");
    if (!mutation.ok) return mutation.response;
    if (typeof mutation.body !== "object" || mutation.body === null || Object.keys(mutation.body).length !== 0) {
      return noStore(apiError("Invalid Buzz disconnect request.", 400));
    }
    return noStore(apiSuccess(await createBuzzCoordinator().disconnect(userId, id.data)));
  } catch (error) {
    return buzzFailure(error);
  }
}
