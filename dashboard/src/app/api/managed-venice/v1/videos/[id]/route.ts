import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";

// SCRIPTURE_ANCHOR: venice-video-retrieve | Habakkuk 2:3 | Verse: For the vision is yet for an appointed time… though it tarry, wait for it.
const VENICE_VIDEOS_BASE_URL = "https://api.venice.ai/api/v1/video";

function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function jsonResponseFromText(text: string, status: number) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Polling endpoint — the agent's video plugin calls this every 5s until
// the job finishes. No metering here; the queue route already recorded
// the usage event. Reconciliation matches it to Venice's invoice via
// the upstream_request_id (queue_id).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return apiError("Unauthorized", 401);

  const { id } = await params;
  const queueId = (id || "").trim();
  if (!queueId) {
    return apiError("Missing video id.", 400);
  }
  // Defensive: don't let path-traversal escape the videos collection.
  if (queueId.includes("/") || queueId.includes("..")) {
    return apiError("Invalid video id.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    endpoint: "/api/v1/video",
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(
      `${VENICE_VIDEOS_BASE_URL}/${encodeURIComponent(queueId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${serverKey}` },
      }
    );
  } catch (error) {
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_video_retrieve_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    log.warn("Managed Venice video retrieve non-2xx", {
      source: "managed-venice-video",
      route: "/api/v1/video/[id]",
      method: "GET",
      failureType: "managed_venice_video_retrieve_non_2xx",
      upstreamStatus: upstreamResponse.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      queueId,
    });
  }

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
