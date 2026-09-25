import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-upscale | Isaiah 40:31 | Verse: They shall mount up with wings as eagles; they shall run, and not be weary.
const VENICE_IMAGES_UPSCALE_URL = "https://api.venice.ai/api/v1/image/upscale";
const ENDPOINT_LABEL = "/api/v1/image/upscale";

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

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError("Expected multipart/form-data body.", 400);
  }

  if (!formData.get("image")) {
    return apiError("image is required.", 400);
  }

  const referenceId = randomUUID();
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model: "venice-upscaler",
    endpoint: ENDPOINT_LABEL,
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: "venice-upscaler",
      metadata: {
        scale: formData.get("scale")?.toString() ?? null,
        enhance: formData.get("enhance")?.toString() ?? null,
      },
    },
    referenceId,
    source: "managed-venice-upscale",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "stream",
    fetchFailureType: "managed_venice_upscale_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_IMAGES_UPSCALE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverKey}` },
        body: formData,
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-upscale",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_upscale_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: "venice-upscaler",
    });
  }

  const contentType = sent.upstream.headers.get("content-type") || "image/png";
  return new Response(sent.upstream.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
