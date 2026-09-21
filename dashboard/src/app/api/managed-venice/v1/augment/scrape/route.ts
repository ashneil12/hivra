import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-scrape | Proverbs 18:15 | Verse: The heart of the prudent getteth knowledge; and the ear of the wise seeketh knowledge.
const VENICE_AUGMENT_SCRAPE_URL = "https://api.venice.ai/api/v1/augment/scrape";
const ENDPOINT_LABEL = "/api/v1/augment/scrape";

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

  if (typeof body.url !== "string" || !body.url.trim()) {
    return apiError("url is required.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/augment/scrape",
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
    upstreamResponse = await fetch(VENICE_AUGMENT_SCRAPE_URL, {
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
      { failureType: "managed_venice_scrape_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();

  if (upstreamResponse.ok) {
    try {
      const targetUrl = body.url as string;
      const host = (() => {
        try {
          return new URL(targetUrl).host;
        } catch {
          return null;
        }
      })();
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model: "venice-scrape",
        upstreamStatus: upstreamResponse.status,
        metadata: { host, urlLength: targetUrl.length },
      });
    } catch (error) {
      log.error("Managed Venice scrape usage record failed", error, {
        source: "managed-venice-scrape",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_scrape_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        referenceId,
      });
    }
  }

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
