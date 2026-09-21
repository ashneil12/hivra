import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-bg-remove | Psalm 51:7 | Verse: Wash me, and I shall be whiter than snow.
const VENICE_BG_REMOVE_URL = "https://api.venice.ai/api/v1/image/background-remove";
const ENDPOINT_LABEL = "/api/v1/image/background-remove";

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

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    endpoint: "/api/v1/image/background-remove",
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  const referenceId = randomUUID();
  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  // Venice accepts either JSON `{ image_url }` or multipart with `image`.
  // Pass either through to upstream verbatim.
  const contentTypeIn = req.headers.get("content-type") || "";
  const isMultipart = contentTypeIn.toLowerCase().includes("multipart/form-data");
  const isJson = contentTypeIn.toLowerCase().includes("application/json");

  let upstreamResponse: Response;
  try {
    if (isJson) {
      const bodyText = await req.text();
      upstreamResponse = await fetch(VENICE_BG_REMOVE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverKey}`,
          "Content-Type": "application/json",
        },
        body: bodyText,
      });
    } else if (isMultipart) {
      const formData = await req.formData();
      if (!formData.get("image")) {
        return apiError("image is required.", 400);
      }
      upstreamResponse = await fetch(VENICE_BG_REMOVE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverKey}` },
        body: formData,
      });
    } else {
      return apiError("Expected application/json or multipart/form-data.", 415);
    }
  } catch (error) {
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_bg_remove_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  if (upstreamResponse.ok) {
    try {
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model: "venice-bg-remover",
        upstreamStatus: upstreamResponse.status,
        metadata: { inputShape: isJson ? "json" : "multipart" },
      });
    } catch (error) {
      log.error("Managed Venice bg-remove usage record failed", error, {
        source: "managed-venice-bg-remove",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_bg_remove_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        referenceId,
      });
    }
  }

  const contentType = upstreamResponse.headers.get("content-type") || "image/png";
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: { "Content-Type": contentType },
  });
}
