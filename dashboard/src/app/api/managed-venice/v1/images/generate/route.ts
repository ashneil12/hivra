import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-image | Genesis 1:27 | Verse: So God created mankind in his own image, in the image of God he created them.
const VENICE_IMAGE_GENERATE_URL = "https://api.venice.ai/api/v1/image/generate";

// Settled per-call via offline reconciliation against Venice's invoice
// (see lib/venice/proxy-settlement.ts:recordManagedVeniceMultimodalUsage).
// Image pricing varies by model, resolution, and variant count — too much
// surface to maintain a per-model catalog inline. The reconciliation cron
// reads `managed_venice_usage_events` with status='reconciliation_required'
// and applies Venice's actual cost from the daily invoice.
const ENDPOINT_LABEL = "/api/v1/image/generate";

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

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
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

  if (typeof body.model !== "string" || !body.model.trim()) {
    return apiError("Model is required.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/image/generate",
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  const referenceId = randomUUID();
  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(VENICE_IMAGE_GENERATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_image_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();
  const upstreamJson = safeJsonParse(upstreamText);
  const upstreamRequestId =
    typeof upstreamJson?.id === "string"
      ? upstreamJson.id
      : typeof upstreamJson?.request_id === "string"
        ? upstreamJson.request_id
        : null;

  // Only meter successful generations. 4xx/5xx upstream errors are
  // surfaced to the caller as-is; the user shouldn't be on the hook
  // for a failed Venice call.
  if (upstreamResponse.ok) {
    try {
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model: body.model,
        upstreamStatus: upstreamResponse.status,
        upstreamRequestId,
        metadata: {
          aspectRatio: typeof body.aspect_ratio === "string" ? body.aspect_ratio : null,
          resolution: typeof body.resolution === "string" ? body.resolution : null,
          width: typeof body.width === "number" ? body.width : null,
          height: typeof body.height === "number" ? body.height : null,
          variants: typeof body.variants === "number" ? body.variants : null,
          format: typeof body.format === "string" ? body.format : null,
        },
      });
    } catch (error) {
      // Don't fail the user-visible request if our audit insert fails —
      // log loud so ops sees the gap. Better to under-bill one request
      // than to drop a successful generation we already paid Venice for.
      log.error("Managed Venice image usage record failed", error, {
        source: "managed-venice-image",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_image_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        model: body.model,
        referenceId,
      });
    }

    log.info("Managed Venice image generation served (unmetered)", {
      source: "managed-venice-image",
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      model: body.model,
      referenceId,
      upstreamStatus: upstreamResponse.status,
      upstreamRequestId,
    });
  } else {
    log.warn("Managed Venice image upstream returned non-2xx", {
      source: "managed-venice-image",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_image_upstream_non_2xx",
      upstreamStatus: upstreamResponse.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
    });
  }

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
