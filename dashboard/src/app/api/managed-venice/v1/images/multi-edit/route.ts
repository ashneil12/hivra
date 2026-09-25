import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-image-compose | Ecclesiastes 4:12 | Verse: A threefold cord is not quickly broken.
const VENICE_IMAGES_MULTI_EDIT_URL = "https://api.venice.ai/api/v1/image/multi-edit";
const ENDPOINT_LABEL = "/api/v1/image/multi-edit";

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

  const modelId = typeof body.modelId === "string" && body.modelId.trim()
    ? body.modelId.trim()
    : "firered-image-edit";
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return apiError("prompt is required.", 400);
  }
  if (!Array.isArray(body.images) || body.images.length === 0 || body.images.length > 3) {
    return apiError("images must be an array of 1-3 entries.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/image/multi-edit",
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  const referenceId = randomUUID();
  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: modelId,
      metadata: {
        imageCount: (body.images as unknown[]).length,
        aspectRatio: typeof body.aspect_ratio === "string" ? body.aspect_ratio : null,
        resolution: typeof body.resolution === "string" ? body.resolution : null,
        outputFormat: typeof body.output_format === "string" ? body.output_format : null,
      },
    },
    referenceId,
    source: "managed-venice-multi-edit",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "stream",
    fetchFailureType: "managed_venice_multi_edit_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_IMAGES_MULTI_EDIT_URL, {
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
      source: "managed-venice-multi-edit",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_multi_edit_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: modelId,
    });
  }

  const contentType = sent.upstream.headers.get("content-type") || "image/png";
  return new Response(sent.upstream.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
