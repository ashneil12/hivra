import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

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

  if (typeof body.model !== "string" || !body.model.trim()) {
    return apiError("Model is required.", 400);
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return apiError("input is required.", 400);
  }

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

  const referenceId = randomUUID();
  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(VENICE_AUDIO_SPEECH_URL, {
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
      { failureType: "managed_venice_speech_upstream_fetch_failed" },
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
        model: body.model,
        upstreamStatus: upstreamResponse.status,
        metadata: {
          voice: typeof body.voice === "string" ? body.voice : null,
          responseFormat: typeof body.response_format === "string" ? body.response_format : null,
          inputLength: typeof body.input === "string" ? body.input.length : null,
          speed: typeof body.speed === "number" ? body.speed : null,
          streaming: body.streaming === true,
        },
      });
    } catch (error) {
      log.error("Managed Venice speech usage record failed", error, {
        source: "managed-venice-speech",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_speech_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        model: body.model,
        referenceId,
      });
    }

    log.info("Managed Venice TTS served (unmetered)", {
      source: "managed-venice-speech",
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      model: body.model,
      referenceId,
      upstreamStatus: upstreamResponse.status,
    });
  } else {
    log.warn("Managed Venice speech upstream non-2xx", {
      source: "managed-venice-speech",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_speech_upstream_non_2xx",
      upstreamStatus: upstreamResponse.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
    });
  }

  // TTS returns binary audio (or text/event-stream when streaming=true).
  // Pass the body through verbatim with the upstream content-type.
  const contentType = upstreamResponse.headers.get("content-type") || "application/octet-stream";
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: { "Content-Type": contentType },
  });
}
