export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { listWindowsIsoImages, WindowsByoIsoError } from "@/lib/infrastructure/windows-byo-iso";

function noStore(response: Response) { response.headers.set("Cache-Control", "no-store"); return response; }

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  for (const key of ["connectionId", "targetId", "expectedConnectionRevision"]) {
    if (request.nextUrl.searchParams.getAll(key).length !== 1) return noStore(apiError("Choose one exact connected Proxmox host.", 400));
  }
  if ([...request.nextUrl.searchParams.keys()].some(key => !["connectionId", "targetId", "expectedConnectionRevision"].includes(key))) {
    return noStore(apiError("Unexpected Windows ISO inventory setting.", 400));
  }
  const values = Object.fromEntries(request.nextUrl.searchParams.entries());
  try {
    const result = await listWindowsIsoImages(userId, {
      connectionId: values.connectionId,
      targetId: values.targetId,
      expectedConnectionRevision: Number(values.expectedConnectionRevision),
    });
    return noStore(apiSuccess(result));
  } catch (error) {
    if (error instanceof WindowsByoIsoError) {
      return noStore(apiError(error.message, error.code === "invalid_request" ? 400 : error.code === "target_unavailable" ? 409 : 422));
    }
    return noStore(apiError("The Windows ISO inventory could not be loaded.", 500));
  }
}
