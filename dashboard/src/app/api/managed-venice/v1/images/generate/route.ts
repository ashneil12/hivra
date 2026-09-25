import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { mediaPricingFieldError } from "@/lib/venice/media-request-fields";
import {
  holdManagedVeniceMediaSpend,
  readNumericField,
  sendManagedVeniceMediaRequest,
} from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-image | Genesis 1:27 | Verse: So God created mankind in his own image, in the image of God he created them.
const VENICE_IMAGE_GENERATE_URL = "https://api.venice.ai/api/v1/image/generate";

// Wallet funds are held from the in-code price catalog BEFORE Venice is called
// (lib/venice/media-spend-gate.ts); a model with no known price is refused.
const ENDPOINT_LABEL = "/api/v1/image/generate";

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

  // One plain value per pricing field, and no `modelId` naming another model.
  const fieldError = mediaPricingFieldError(body);
  if (fieldError) return apiError(fieldError, 400);

  if (typeof body.model !== "string" || !body.model.trim()) {
    return apiError("Model is required.", 400);
  }
  const model = body.model;

  const serverKey = resolveManagedVeniceUpstreamKey({
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
        aspectRatio: typeof body.aspect_ratio === "string" ? body.aspect_ratio : null,
        resolution: typeof body.resolution === "string" ? body.resolution : null,
        width: typeof body.width === "number" ? body.width : null,
        height: typeof body.height === "number" ? body.height : null,
        variants: readNumericField(body.variants),
        format: typeof body.format === "string" ? body.format : null,
      },
    },
    source: "managed-venice-image",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_image_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_IMAGE_GENERATE_URL, {
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
    log.warn("Managed Venice image upstream returned non-2xx", {
      source: "managed-venice-image",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_image_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model,
    });
  }

  return new Response(sent.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
