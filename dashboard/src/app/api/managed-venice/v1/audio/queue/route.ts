import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-audio-queue | Psalm 96:1 | Verse: O sing unto the Lord a new song.
const VENICE_AUDIO_QUEUE_URL = "https://api.venice.ai/api/v1/audio/queue";
const ENDPOINT_LABEL = "/api/v1/audio/queue";

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

  if (typeof body.model !== "string" || !body.model.trim()) {
    return apiError("Model is required.", 400);
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return apiError("prompt is required.", 400);
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: typeof body.model === "string" ? body.model : null,
    endpoint: "/api/v1/audio/queue",
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
    upstreamResponse = await fetch(VENICE_AUDIO_QUEUE_URL, {
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
      { failureType: "managed_venice_audio_queue_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();

  if (upstreamResponse.ok) {
    try {
      const upstreamJson = JSON.parse(upstreamText) as Record<string, unknown>;
      const queueId = typeof upstreamJson?.queue_id === "string" ? upstreamJson.queue_id : null;
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model: body.model,
        upstreamStatus: upstreamResponse.status,
        upstreamRequestId: queueId,
        metadata: {
          durationSeconds: typeof body.duration_seconds === "number"
            ? body.duration_seconds
            : null,
          forceInstrumental: body.force_instrumental === true,
          hasLyricsPrompt: typeof body.lyrics_prompt === "string" && body.lyrics_prompt.length > 0,
          languageCode: typeof body.language_code === "string" ? body.language_code : null,
        },
      });
    } catch (error) {
      log.error("Managed Venice audio-queue usage record failed", error, {
        source: "managed-venice-audio-queue",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_audio_queue_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        model: body.model,
        referenceId,
      });
    }
  }

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
