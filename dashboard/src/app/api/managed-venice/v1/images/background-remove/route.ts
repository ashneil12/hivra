import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

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
  // Venice accepts either JSON `{ image_url }` or multipart with `image`.
  // Pass either through to upstream verbatim.
  const contentTypeIn = req.headers.get("content-type") || "";
  const isMultipart = contentTypeIn.toLowerCase().includes("multipart/form-data");
  const isJson = contentTypeIn.toLowerCase().includes("application/json");
  let upstreamBody: string | FormData;
  if (isJson) {
    upstreamBody = await req.text();
  } else if (isMultipart) {
    const formData = await req.formData();
    if (!formData.get("image")) {
      return apiError("image is required.", 400);
    }
    upstreamBody = formData;
  } else {
    return apiError("Expected application/json or multipart/form-data.", 415);
  }

  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: "venice-bg-remover",
      metadata: { inputShape: isJson ? "json" : "multipart" },
    },
    referenceId,
    source: "managed-venice-bg-remove",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "stream",
    fetchFailureType: "managed_venice_bg_remove_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_BG_REMOVE_URL, {
        method: "POST",
        headers: isJson
          ? { Authorization: `Bearer ${serverKey}`, "Content-Type": "application/json" }
          : { Authorization: `Bearer ${serverKey}` },
        body: upstreamBody,
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-bg-remove",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_bg_remove_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: "venice-bg-remover",
    });
  }

  const contentType = sent.upstream.headers.get("content-type") || "image/png";
  return new Response(sent.upstream.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
