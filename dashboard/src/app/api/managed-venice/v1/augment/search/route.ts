import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-search | Proverbs 25:2 | Verse: The honour of kings is to search out a matter.
const VENICE_AUGMENT_SEARCH_URL = "https://api.venice.ai/api/v1/augment/search";
const ENDPOINT_LABEL = "/api/v1/augment/search";

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

  if (typeof body.query !== "string" || !body.query.trim()) {
    return apiError("query is required.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/augment/search",
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
    upstreamResponse = await fetch(VENICE_AUGMENT_SEARCH_URL, {
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
      { failureType: "managed_venice_search_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();

  if (upstreamResponse.ok) {
    try {
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model: typeof body.search_provider === "string"
          ? `venice-search-${body.search_provider}`
          : "venice-search-brave",
        upstreamStatus: upstreamResponse.status,
        metadata: {
          queryLength: (body.query as string).length,
          limit: typeof body.limit === "number" ? body.limit : null,
          searchProvider: typeof body.search_provider === "string" ? body.search_provider : "brave",
        },
      });
    } catch (error) {
      log.error("Managed Venice search usage record failed", error, {
        source: "managed-venice-search",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_search_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        referenceId,
      });
    }
  }

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
