export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { createBuzzCoordinator } from "@/lib/hivra/buzz-coordinator";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { buzzFailure, noStore, readBuzzMutation } from "./route-utils";

const ConnectSchema = z.object({ relayUrl: z.string().trim().min(1).max(2_048) }).strict();

export async function GET(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    return noStore(apiSuccess(await createBuzzCoordinator().summary(userId)));
  } catch (error) {
    return buzzFailure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const mutation = await readBuzzMutation(request, userId, "hivra_buzz_connect");
    if (!mutation.ok) return mutation.response;
    const parsed = ConnectSchema.safeParse(mutation.body);
    if (!parsed.success) return noStore(apiError("Enter a valid Buzz relay URL.", 400));
    return noStore(apiSuccess({ connection: await createBuzzCoordinator().connect(userId, parsed.data.relayUrl) }, 201));
  } catch (error) {
    return buzzFailure(error);
  }
}
