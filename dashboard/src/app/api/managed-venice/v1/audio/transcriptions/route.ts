import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";

// SCRIPTURE_ANCHOR: venice-transcribe | Job 33:32 | Verse: If thou hast anything to say, answer me: speak, for I desire to justify thee.
const VENICE_AUDIO_TRANSCRIPTIONS_URL =
  "https://api.venice.ai/api/v1/audio/transcriptions";

const ENDPOINT_LABEL = "/api/v1/audio/transcriptions";

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

  // Transcription endpoints are multipart/form-data. Don't parse — stream
  // the original body through to Venice. Pull `model` for accounting from
  // the form before forwarding (FormData is consumable once).
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError("Expected multipart/form-data body.", 400);
  }

  const modelField = formData.get("model");
  const model = typeof modelField === "string" && modelField.trim()
    ? modelField.trim()
    : "whisper-1";

  const referenceId = randomUUID();
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model,
    endpoint: ENDPOINT_LABEL,
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  const language = formData.get("language");
  const responseFormat = formData.get("response_format");
  const fileField = formData.get("file");
  const fileSize =
    fileField && typeof fileField === "object" && "size" in fileField
      ? (fileField as { size: number }).size
      : null;
  // STT is priced per audio second and the duration isn't known up front, so
  // the gate refuses it until the catalog can price it.
  const gate = await holdManagedVeniceMediaSpend({
    key: verifiedKey,
    operation: {
      endpoint: ENDPOINT_LABEL,
      model,
      metadata: {
        language: typeof language === "string" ? language : null,
        responseFormat: typeof responseFormat === "string" ? responseFormat : null,
        fileSizeBytes: fileSize,
      },
    },
    referenceId,
    source: "managed-venice-transcribe",
  });
  if (!gate.ok) return gate.response;

  const sent = await sendManagedVeniceMediaRequest({
    hold: gate.hold,
    mode: "buffer",
    fetchFailureType: "managed_venice_transcribe_upstream_fetch_failed",
    send: () =>
      fetch(VENICE_AUDIO_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverKey}` },
        body: formData,
      }),
  });
  if (!sent.ok) return sent.response;

  if (!sent.upstream.ok) {
    log.warn("Managed Venice upstream returned non-2xx", {
      source: "managed-venice-transcribe",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_transcribe_upstream_non_2xx",
      upstreamStatus: sent.upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: model,
    });
  }

  const contentType = sent.upstream.headers.get("content-type") || "application/json";
  return new Response(sent.body, {
    status: sent.upstream.status,
    headers: { "Content-Type": contentType },
  });
}
