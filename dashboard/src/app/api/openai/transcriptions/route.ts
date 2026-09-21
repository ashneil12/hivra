import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const TRANSCRIPTION_OPENAI_API_KEY_ENV = "VOICE_TRANSCRIPTION_OPENAI_API_KEY";
// Internal sentinel — `resolveRequestError` matches on this exact string to
// translate the thrown error into a 400 response. The public-facing message
// (returned to the client) deliberately avoids naming env vars or other
// platform-internal config so we don't hint at our deployment shape.
const MISSING_TRANSCRIPTION_API_KEY_ERROR =
  "Voice transcription is not configured for this instance.";
const SUPPORTED_TRANSCRIPTION_MODELS = new Set([
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
]);
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg3",
  "audio/mpga",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);
const ALLOWED_AUDIO_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "wav",
  "webm",
]);
const ROUTE_PATH = "/api/openai/transcriptions";

function getFileExtension(fileName: string): string {
  const extension = fileName.split(".").pop()?.trim().toLowerCase();
  return extension || "";
}

function isAudioFileSupported(file: File): boolean {
  return (
    ALLOWED_AUDIO_MIME_TYPES.has(file.type) ||
    ALLOWED_AUDIO_EXTENSIONS.has(getFileExtension(file.name))
  );
}

function resolveRequestError(error: Error): { message: string; status: number } | null {
  switch (error.message) {
    case "Database not configured":
      return { message: "Database not configured", status: 500 };
    case "Instance not found":
      return { message: "Instance not found", status: 404 };
    case MISSING_TRANSCRIPTION_API_KEY_ERROR:
      return { message: error.message, status: 400 };
    default:
      return null;
  }
}

function resolveFallbackOpenAiApiKey(): string | null {
  const apiKey = process.env[TRANSCRIPTION_OPENAI_API_KEY_ENV]?.trim();
  return apiKey || null;
}

async function resolveTranscriptionOpenAiApiKey(
  userId: string,
  instanceId: string
): Promise<string> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("provider, api_key_encrypted")
    .eq("id", instanceId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Instance not found");
  }

  const fallbackApiKey = resolveFallbackOpenAiApiKey();
  if (fallbackApiKey) {
    return fallbackApiKey;
  }

  if (data.provider === "openai" && data.api_key_encrypted) {
    return decryptApiKey(data.api_key_encrypted);
  }

  throw new Error(MISSING_TRANSCRIPTION_API_KEY_ERROR);
}

function buildOpenAiFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "OpenAI rejected the transcription request. Check the configured OpenAI API key.";
  }

  if (status === 413) {
    return "The recorded audio is too large for OpenAI transcription.";
  }

  if (status === 429) {
    return "OpenAI rate limited the transcription request. Please try again in a moment.";
  }

  return "OpenAI transcription failed.";
}

async function readTranscriptionText(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => null)) as
      | { text?: unknown }
      | null;
    return typeof payload?.text === "string" ? payload.text.trim() : "";
  }

  return (await response.text().catch(() => "")).trim();
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return apiError("Unauthorized", 401);
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "openai_transcriptions_post",
      userId,
      ...RATE_LIMIT_PRESETS.uploadWrite,
    });
    if (rateLimitError) {
      return rateLimitError;
    }

    const formData = await request.formData();
    const instanceIdValue = formData.get("instanceId");
    const fileValue = formData.get("file");
    const promptValue = formData.get("prompt");
    const modelValue = formData.get("model");

    const instanceId =
      typeof instanceIdValue === "string" ? instanceIdValue.trim() : "";
    if (!instanceId) {
      return apiError("Missing instanceId", 400);
    }

    if (!(fileValue instanceof File)) {
      return apiError("No audio file provided", 400);
    }

    if (fileValue.size === 0) {
      return apiError("Audio file is empty", 400);
    }

    if (fileValue.size > MAX_AUDIO_SIZE_BYTES) {
      return apiError("Audio file is too large", 413);
    }

    if (!isAudioFileSupported(fileValue)) {
      return apiError("Unsupported audio file type", 400);
    }

    const model =
      typeof modelValue === "string" && SUPPORTED_TRANSCRIPTION_MODELS.has(modelValue)
        ? modelValue
        : DEFAULT_TRANSCRIPTION_MODEL;

    const openAiApiKey = await resolveTranscriptionOpenAiApiKey(userId, instanceId);
    const upstreamFormData = new FormData();
    upstreamFormData.set("file", fileValue, fileValue.name || "recording.webm");
    upstreamFormData.set("model", model);
    upstreamFormData.set("response_format", "text");

    if (typeof promptValue === "string" && promptValue.trim()) {
      upstreamFormData.set("prompt", promptValue.trim());
    }

    const upstreamResponse = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: upstreamFormData,
      }
    );

    if (!upstreamResponse.ok) {
      return apiError(
        buildOpenAiFailureMessage(upstreamResponse.status),
        502,
        {
          failureType: "openai_transcription_upstream_error",
          upstreamStatus: upstreamResponse.status,
        },
        undefined,
        {
          route: ROUTE_PATH,
          source: "openai-transcriptions",
          metadata: { upstreamStatus: upstreamResponse.status },
        }
      );
    }

    const text = await readTranscriptionText(upstreamResponse);
    if (!text) {
      return apiError(
        "OpenAI returned an empty transcription.",
        502,
        {
          failureType: "openai_transcription_empty",
        },
        undefined,
        {
          route: ROUTE_PATH,
          source: "openai-transcriptions",
        }
      );
    }

    return apiSuccess({
      model,
      text,
    });
  } catch (error) {
    if (error instanceof Error) {
      const resolvedError = resolveRequestError(error);
      if (resolvedError) {
        return apiError(resolvedError.message, resolvedError.status);
      }
    }

    return apiError(
      "Failed to transcribe audio",
      500,
      {
        failureType: "openai_transcription_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        route: ROUTE_PATH,
        source: "openai-transcriptions",
      }
    );
  }
}
