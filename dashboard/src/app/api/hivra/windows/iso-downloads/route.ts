export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  getWindowsIsoDownloadStatus,
  startWindowsIsoDownload,
  WindowsByoIsoError,
} from "@/lib/infrastructure/windows-byo-iso";

function noStore(response: Response) { response.headers.set("Cache-Control", "no-store"); return response; }

function errorResponse(error: WindowsByoIsoError) {
  const status = error.code === "invalid_request" ? 400
    : error.code === "download_conflict" ? 409
      : error.code === "target_unavailable" ? 409 : 422;
  return noStore(apiError(error.message, status, undefined, { code: error.code }));
}

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return noStore(apiError("Open the ISO download guide from this dashboard.", 403));
  if (!hasStrictJsonContentType(request)) return noStore(apiError("Send ISO download settings as JSON.", 415));
  const parsedBody = await readBoundedJson(request, 8 * 1024, 5000);
  if (!parsedBody.ok) return noStore(apiError("Send complete ISO download settings of at most 8 KB.", parsedBody.reason === "too_large" ? 413 : 400));
  try {
    return noStore(apiSuccess(await startWindowsIsoDownload(userId, parsedBody.body), 202));
  } catch (error) {
    if (error instanceof WindowsByoIsoError) return errorResponse(error);
    return noStore(apiError("The Windows ISO download could not be started.", 500));
  }
}

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const allowed = ["connectionId", "targetId", "expectedConnectionRevision", "taskId"];
  for (const key of allowed) {
    if (request.nextUrl.searchParams.getAll(key).length !== 1) return noStore(apiError("Choose one exact ISO download task.", 400));
  }
  if ([...request.nextUrl.searchParams.keys()].some(key => !allowed.includes(key))) {
    return noStore(apiError("Unexpected ISO download status setting.", 400));
  }
  const values = Object.fromEntries(request.nextUrl.searchParams.entries());
  try {
    return noStore(apiSuccess(await getWindowsIsoDownloadStatus(userId, {
      connectionId: values.connectionId,
      targetId: values.targetId,
      expectedConnectionRevision: Number(values.expectedConnectionRevision),
      taskId: values.taskId,
    })));
  } catch (error) {
    if (error instanceof WindowsByoIsoError) return errorResponse(error);
    return noStore(apiError("The Windows ISO download status could not be loaded.", 500));
  }
}
