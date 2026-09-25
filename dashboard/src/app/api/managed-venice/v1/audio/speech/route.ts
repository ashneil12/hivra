import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { mediaPricingFieldError, planMediaRequest } from "@/lib/venice/media-request-fields";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-speech | Isaiah 50:4 | Verse: The Lord God hath given me the tongue of the learned, that I should know how to speak a word in season to him that is weary.
const VENICE_AUDIO_SPEECH_URL = "https://api.venice.ai/api/v1/audio/speech";

const ENDPOINT_LABEL = "/api/v1/audio/speech";

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
    return apiError("Model is required.", 400);
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return apiError("input is required.", 400);
  }
  // Only the fields Venice documents for TTS are forwarded.
  const plan = planMediaRequest({ endpoint: ENDPOINT_LABEL, model: body.model, fields: body, source: "managed-venice-speech" });
  if (!plan.ok) return apiError(plan.error, 400);
  const forward = plan.fields;
  const input = body.input;

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/audio/speech",
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
        voice: typeof body.voice === "string" ? body.voice : null,
        responseFormat: typeof body.response_format === "string" ? body.response_format : null,
        inputLength: input.length,
        speed: typeof body.speed === "number" ? body.speed : null,
        streaming: body.streaming === true,
      },
    },
    source: "managed-venice-speech",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "stream",
    fetchFailureType: "managed_venice_speech_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_AUDIO_SPEECH_URL, {
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
      source: "managed-venice-speech",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_speech_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
    });
  }

  // TTS returns binary audio (or text/event-stream when streaming=true).
  // Pass the body through verbatim with the upstream content-type.
  const contentType = sent.upstream.headers.get("content-type") || "application/octet-stream";
  return new Response(sent.upstream.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
