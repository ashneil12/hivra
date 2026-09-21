import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

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

  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(VENICE_AUDIO_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${serverKey}` },
      body: formData,
    });
  } catch (error) {
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_transcribe_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamText = await upstreamResponse.text();

  if (upstreamResponse.ok) {
    try {
      const language = formData.get("language");
      const responseFormat = formData.get("response_format");
      const fileField = formData.get("file");
      const fileSize =
        fileField && typeof fileField === "object" && "size" in fileField
          ? (fileField as { size: number }).size
          : null;
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: ENDPOINT_LABEL,
        model,
        upstreamStatus: upstreamResponse.status,
        metadata: {
          language: typeof language === "string" ? language : null,
          responseFormat: typeof responseFormat === "string" ? responseFormat : null,
          fileSizeBytes: fileSize,
        },
      });
    } catch (error) {
      log.error("Managed Venice transcribe usage record failed", error, {
        source: "managed-venice-transcribe",
        route: ENDPOINT_LABEL,
        method: "POST",
        failureType: "managed_venice_transcribe_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        model,
        referenceId,
      });
    }

    log.info("Managed Venice STT served (unmetered)", {
      source: "managed-venice-transcribe",
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      model,
      referenceId,
      upstreamStatus: upstreamResponse.status,
    });
  } else {
    log.warn("Managed Venice transcribe upstream non-2xx", {
      source: "managed-venice-transcribe",
      route: ENDPOINT_LABEL,
      method: "POST",
      failureType: "managed_venice_transcribe_upstream_non_2xx",
      upstreamStatus: upstreamResponse.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model,
    });
  }

  const contentType = upstreamResponse.headers.get("content-type") || "application/json";
  return new Response(upstreamText, {
    status: upstreamResponse.status,
    headers: { "Content-Type": contentType },
  });
}
