import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { mediaModelField, mediaPricingFieldError, planMediaRequest } from "@/lib/venice/media-request-fields";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-image-edit | Jeremiah 18:6 | Verse: As the clay is in the potter's hand, so are ye in mine hand.
const VENICE_IMAGES_EDIT_URL = "https://api.venice.ai/api/v1/image/edit";
const ENDPOINT_LABEL = "/api/v1/image/edit";

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

  // The model and tier Venice runs must be the ones priced: one value per
  // pricing field, and `modelId` (Venice's deprecated alias) can't disagree
  // with `model`.
  const fieldError = mediaPricingFieldError(formData);
  if (fieldError) return apiError(fieldError, 400);
  const model = mediaModelField(formData) ?? "firered-image-edit";
  const promptField = formData.get("prompt");
  if (typeof promptField !== "string" || !promptField.trim()) {
    return apiError("prompt is required.", 400);
  }
  if (!formData.get("image")) {
    return apiError("image is required.", 400);
  }
  // Only documented fields go to Venice, the resolution is sent as the tier
  // that is charged, and options Venice bills extra for are refused.
  const plan = planMediaRequest({
    endpoint: ENDPOINT_LABEL,
    model,
    fields: formData,
    source: "managed-venice-image-edit",
  });
  if (!plan.ok) return apiError(plan.error, 400);
  const forward = plan.fields;

  const referenceId = randomUUID();
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model,
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
      model,
      metadata: {
        aspectRatio: forward.get("aspect_ratio")?.toString() ?? null,
        resolution: forward.get("resolution")?.toString() ?? null,
        outputFormat: forward.get("output_format")?.toString() ?? null,
      },
    },
    referenceId,
    source: "managed-venice-image-edit",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "stream",
    fetchFailureType: "managed_venice_image_edit_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_IMAGES_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverKey}` },
        body: forward,
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-image-edit",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_image_edit_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: model,
    });
  }

  const contentType = sent.upstream.headers.get("content-type") || "image/png";
  return new Response(sent.upstream.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
