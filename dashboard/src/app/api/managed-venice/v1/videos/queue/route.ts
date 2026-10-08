import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { mediaPricingFieldError } from "@/lib/venice/media-request-fields";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-video | Habakkuk 2:2 | Verse: Write the vision, and make it plain upon tables, that he may run that readeth it.
const VENICE_VIDEOS_QUEUE_URL = "https://api.venice.ai/api/v1/video/queue";

// Settled per-call via offline reconciliation against Venice's invoice.
// Video pricing is duration- and resolution-dependent; reconciliation
// cron applies actual cost from Venice's invoice.
const ENDPOINT_LABEL = "/api/v1/video/queue";

function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

export async function POST(req: NextRequest) {
  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return apiError("Unauthorized", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON body.", 400);
  }

  const fieldError = mediaPricingFieldError(body);
  if (fieldError) return apiError(fieldError, 400);

  if (typeof body.model !== "string" || !body.model.trim()) {
    return apiError("Model is required.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/video/queue",
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  // Video has no list price in the catalog (Venice prices it per resolution x
  // duration through its quote API), so the gate refuses it until one lands.
  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: body.model,
      metadata: {
        duration: typeof body.duration === "string" ? body.duration : null,
        aspectRatio: typeof body.aspect_ratio === "string" ? body.aspect_ratio : null,
        resolution: typeof body.resolution === "string" ? body.resolution : null,
        hasImage: typeof body.image_url === "string" && body.image_url.length > 0,
        referenceImagesCount: Array.isArray(body.reference_image_urls)
          ? body.reference_image_urls.length
          : 0,
      },
    },
    source: "managed-venice-video",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_video_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_VIDEOS_QUEUE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-video",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_video_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
    });
  }

  return new Response(sent.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
