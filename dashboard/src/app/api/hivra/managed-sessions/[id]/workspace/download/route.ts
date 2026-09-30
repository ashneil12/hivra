export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { downloadManagedSessionWorkspace } from "@/lib/hivra/do-managed-sessions";
import { hivraApiUnavailable, managedSessionFailure, noStore, UUID } from "../../../route-support";

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Download a workspace file, or a folder as a tar. Always an attachment and
 * never rendered on Hivra's origin, whatever the file contains.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_download", userId, limit: 30, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  try {
    const params = request.nextUrl.searchParams;
    const download = await downloadManagedSessionWorkspace(userId, id.toLowerCase(), params.get("path") ?? "", {
      archive: params.get("archive") === "1",
      signal: request.signal,
    });
    return new Response(download.body, {
      status: 200,
      headers: {
        "Content-Type": download.isArchive ? "application/x-tar" : "application/octet-stream",
        "Content-Disposition": contentDisposition(download.fileName),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/workspace/download");
  }
}
