import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-audio-queue | Psalm 96:1 | Verse: O sing unto the Lord a new song.
const VENICE_AUDIO_QUEUE_URL = "https://api.venice.ai/api/v1/audio/queue";
const ENDPOINT_LABEL = "/api/v1/audio/queue";

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

  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model: body.model,
      metadata: {
        durationSeconds: typeof body.duration_seconds === "number"
          ? body.duration_seconds
          : null,
        forceInstrumental: body.force_instrumental === true,
        hasLyricsPrompt: typeof body.lyrics_prompt === "string" && body.lyrics_prompt.length > 0,
        languageCode: typeof body.language_code === "string" ? body.language_code : null,
      },
    },
    source: "managed-venice-audio-queue",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_audio_queue_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_AUDIO_QUEUE_URL, {
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
      source: "managed-venice-audio-queue",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_audio_queue_upstream_non_2xx",
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
