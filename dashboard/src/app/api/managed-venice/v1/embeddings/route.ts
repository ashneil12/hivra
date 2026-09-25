import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { mediaPricingFieldError } from "@/lib/venice/media-request-fields";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-embeddings | Psalm 139:23 | Verse: Search me, O God, and know my heart: try me, and know my thoughts.
const VENICE_EMBEDDINGS_URL = "https://api.venice.ai/api/v1/embeddings";
const ENDPOINT_LABEL = "/api/v1/embeddings";

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
    return apiError("model is required.", 400);
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return apiError("input must be a string or array.", 400);
  }
  if (Array.isArray(body.input) && body.input.length > 2048) {
    return apiError("input array exceeds 2048 entries.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/embeddings",
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
      model: body.model,
      metadata: {
        inputCount: Array.isArray(body.input) ? body.input.length : 1,
        encodingFormat: typeof body.encoding_format === "string" ? body.encoding_format : "float",
        dimensions: typeof body.dimensions === "number" ? body.dimensions : null,
      },
    },
    source: "managed-venice-embeddings",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_embeddings_upstream_fetch_failed",
    outcomeMetadata: (text) => {
      try {
        const usage = ((text ? JSON.parse(text) : null)?.usage ?? {}) as Record<string, unknown>;
        return {
          promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
          totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
        };
      } catch {
        return undefined;
      }
    },
    send: () =>
      fetch(VENICE_EMBEDDINGS_URL, {
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
      source: "managed-venice-embeddings",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_embeddings_upstream_non_2xx",
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
