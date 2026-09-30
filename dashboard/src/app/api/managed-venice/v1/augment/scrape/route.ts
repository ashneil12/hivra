import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { planMediaRequest } from "@/lib/venice/media-request-fields";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-scrape | Proverbs 18:15 | Verse: The heart of the prudent getteth knowledge; and the ear of the wise seeketh knowledge.
const VENICE_AUGMENT_SCRAPE_URL = "https://api.venice.ai/api/v1/augment/scrape";
const ENDPOINT_LABEL = "/api/v1/augment/scrape";

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

  // Only the one url is forwarded: the catalog bills one URL per request.
  const plan = planMediaRequest({ endpoint: ENDPOINT_LABEL, model: "venice-scrape", fields: body, source: "managed-venice-scrape" });
  if (!plan.ok) return apiError(plan.error, 400);
  const forward = plan.fields;

  const referenceId = randomUUID();
  const targetUrl = body.url as string;
  const host = (() => {
    try {
      return new URL(targetUrl).host;
    } catch {
      return null;
    }
  })();
  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: "venice-scrape",
      metadata: { host, urlLength: targetUrl.length },
    },
    referenceId,
    source: "managed-venice-scrape",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_scrape_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_AUGMENT_SCRAPE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(forward),
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-scrape",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_scrape_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: "venice-scrape",
    });
  }

  return new Response(sent.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
