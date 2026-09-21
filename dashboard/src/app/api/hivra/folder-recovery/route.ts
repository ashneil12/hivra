export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { FolderRecoveryError, FOLDER_RECOVERY_MAX_ARTIFACT_BYTES } from "@/lib/hivra/folder-recovery-artifact";
import { exportComputerFolder, restoreComputerFolder } from "@/lib/hivra/folder-recovery-service";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isSameOriginMutationRequest(request)) return apiError("Use the same-origin recovery page.", 403);
  if (!hasStrictJsonContentType(request)) return apiError("Expected application/json.", 415);
  const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra-folder-recovery", userId, limit: 6, windowMs: 300_000 });
  if (limited) return limited;
  const parsed = await readBoundedJson(request, 4 * 1024 * 1024 + 4096, 15_000);
  if (!parsed.ok) return apiError("Recovery request is invalid or exceeds the encrypted-file limit.", 413);
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.passphrase !== "string" || body.passphrase.length < 12 || Buffer.byteLength(body.passphrase) > 1024) {
    return apiError("Use a recovery passphrase between 12 and 1024 bytes.", 400);
  }
  try {
    if (body.action === "export" && typeof body.sourceId === "string") {
      const artifact = await exportComputerFolder(userId, body.sourceId, body.passphrase);
      return new Response(new Uint8Array(artifact), { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="ubuntu-hivra-folder.hivra-folder"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    if (body.action === "restore" && typeof body.sourceId === "string" && typeof body.destinationId === "string" && typeof body.artifact === "string") {
      if (body.artifact.length > Math.ceil(FOLDER_RECOVERY_MAX_ARTIFACT_BYTES / 3) * 4
        || /[^A-Za-z0-9+/=]/.test(body.artifact)) {
        return apiError("Select an encrypted Hivra-folder file no larger than 3 MiB.", 400);
      }
      const artifact = Buffer.from(body.artifact, "base64");
      if (artifact.toString("base64") !== body.artifact) return apiError("Invalid encrypted file.", 400);
      return apiSuccess(await restoreComputerFolder({ userId, sourceId: body.sourceId, destinationId: body.destinationId,
        artifact, passphrase: body.passphrase, revokeSourceSessions: body.revokeSourceSessions === true }));
    }
    return apiError("Choose export or restore and an owned Ubuntu computer.", 400);
  } catch (error) {
    if (error instanceof FolderRecoveryError) return apiError(error.message, error.status);
    // Never attach the request, guest output, file names/bytes, or exception
    // objects here: all may contain sensitive user material.
    log.error("Hivra-folder recovery failed at an integration boundary", new Error("Folder recovery unverified"), {
      source: "hivra-folder-recovery", failureType: "folder_recovery_unverified",
    });
    return apiError("Folder recovery could not be verified. No success has been recorded; an in-progress restore must be verified with the same archive.", 503);
  }
}
