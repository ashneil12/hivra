import { auth } from '@clerk/nextjs/server';
import { apiError, apiSuccess } from '@/lib/api-response';
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from '@/lib/authenticated-rate-limit';
import {
  ALLOWED_AVATAR_EXTENSIONS,
  ALLOWED_AVATAR_MIME_TYPES,
  detectImageType,
} from '@/lib/image-magic-bytes';
import { extractCompletedAssistantContent } from '@/lib/response-text';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const ROUTE_PATH = '/api/avatar-crop-suggestion';
// We only forward this image to OpenAI at `detail: 'low'`, which downsamples
// to 512px on the longest edge. 1MB is more than enough for that — anything
// larger just burns budget on a key shared across all users.
const MAX_AVATAR_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_AVATAR_CROP_MODEL =
  process.env.AVATAR_CROP_OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
const AVATAR_CROP_OPENAI_API_KEY_ENV = 'AVATAR_CROP_OPENAI_API_KEY';

interface AvatarCropSuggestion {
  centerX: number;
  centerY: number;
  size: number;
  source: 'model' | 'default';
}

const DEFAULT_AVATAR_CROP_SUGGESTION: AvatarCropSuggestion = {
  centerX: 0.5,
  centerY: 0.5,
  size: 1,
  source: 'default',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveAvatarCropApiKey(): string | null {
  const scopedApiKey = process.env[AVATAR_CROP_OPENAI_API_KEY_ENV]?.trim();
  if (scopedApiKey) {
    return scopedApiKey;
  }

  const fallbackApiKey = process.env.OPENAI_API_KEY?.trim();
  return fallbackApiKey || null;
}

type AvatarValidationOk = {
  ok: true;
  buffer: Buffer;
  mimeType: string;
};
type AvatarValidationErr = {
  ok: false;
  response: ReturnType<typeof apiError>;
};
type AvatarValidationResult = AvatarValidationOk | AvatarValidationErr;

async function validateAvatarFile(file: File): Promise<AvatarValidationResult> {
  if (file.size > MAX_AVATAR_SIZE_BYTES) {
    return { ok: false, response: apiError('Avatar file is too large', 413) };
  }

  const fileExt = file.name.split('.').pop()?.toLowerCase() || '';
  if (!ALLOWED_AVATAR_EXTENSIONS.has(fileExt)) {
    return { ok: false, response: apiError('Unsupported avatar file extension', 400) };
  }

  if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
    return { ok: false, response: apiError('Unsupported avatar file type', 400) };
  }

  // Filename and Content-Type can both be forged. Sniff the magic bytes so
  // we don't forward arbitrary attacker-supplied bytes to OpenAI under a
  // false image MIME claim; downstream we also use the sniffed type when
  // building the data URL so the OpenAI request matches what we actually
  // verified.
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectImageType(buffer);
  if (!detected) {
    return { ok: false, response: apiError('Unsupported avatar file type', 400) };
  }

  return { ok: true, buffer, mimeType: detected.mimeType };
}

function sanitizeSuggestion(value: unknown): AvatarCropSuggestion | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<Record<'centerX' | 'centerY' | 'size', unknown>>;
  if (
    typeof candidate.centerX !== 'number' ||
    !Number.isFinite(candidate.centerX) ||
    typeof candidate.centerY !== 'number' ||
    !Number.isFinite(candidate.centerY) ||
    typeof candidate.size !== 'number' ||
    !Number.isFinite(candidate.size)
  ) {
    return null;
  }

  const size = clamp(candidate.size, 0.1, 1);
  const halfSize = size / 2;

  return {
    centerX: clamp(candidate.centerX, halfSize, 1 - halfSize),
    centerY: clamp(candidate.centerY, halfSize, 1 - halfSize),
    size,
    source: 'model',
  };
}

function buildOpenAiFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'OpenAI rejected the avatar crop request. Check the configured API key.';
  }

  if (status === 429) {
    return 'OpenAI rate limited the avatar crop request. Please try again.';
  }

  return 'OpenAI avatar crop suggestion failed.';
}

async function requestModelCropSuggestion(
  buffer: Buffer,
  mimeType: string,
): Promise<AvatarCropSuggestion | null> {
  const apiKey = resolveAvatarCropApiKey();
  if (!apiKey) {
    return null;
  }

  // mimeType is the magic-byte-sniffed type, not the client-supplied one.
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_AVATAR_CROP_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You suggest square crops for avatar/profile photos. Choose a square crop that keeps the main face or subject centered, avoids awkward forehead and chin cuts, and feels good as a circular profile image. Return only JSON that matches the schema.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Analyze this image and return the best square crop suggestion. centerX and centerY are normalized 0-1 coordinates for the crop center within the original image. size is the square crop size relative to the shorter image edge.',
            },
            {
              type: 'input_image',
              image_url: dataUrl,
              detail: 'low',
            },
          ],
        },
      ],
      max_output_tokens: 120,
      text: {
        format: {
          type: 'json_schema',
          name: 'avatar_crop_suggestion',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              centerX: { type: 'number' },
              centerY: { type: 'number' },
              size: { type: 'number' },
            },
            required: ['centerX', 'centerY', 'size'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(buildOpenAiFailureMessage(response.status));
  }

  const payload = await response.json();
  const outputText =
    typeof payload?.output_text === 'string'
      ? payload.output_text
      : extractCompletedAssistantContent(payload);

  if (!outputText) {
    return null;
  }

  try {
    return sanitizeSuggestion(JSON.parse(outputText));
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return apiError('Unauthorized', 401);
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: 'avatar_crop_suggestion_post',
      userId,
      ...RATE_LIMIT_PRESETS.uploadWrite,
    });
    if (rateLimitError) {
      return rateLimitError;
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return apiError('No file provided', 400);
    }

    const validation = await validateAvatarFile(file);
    if (!validation.ok) {
      return validation.response;
    }

    try {
      const suggestion = await requestModelCropSuggestion(
        validation.buffer,
        validation.mimeType,
      );
      if (suggestion) {
        return apiSuccess(suggestion);
      }
    } catch (error: unknown) {
      log.warn("falling back to centered crop", {
        source: "avatar-crop-suggestion",
        route: ROUTE_PATH,
        method: "POST",
        failureType: "avatar_crop_suggestion_fallback",
      }, error);
    }

    return apiSuccess(DEFAULT_AVATAR_CROP_SUGGESTION);
  } catch (error: unknown) {
    return apiError(
      'Failed to suggest avatar crop',
      500,
      {
        failureType: 'avatar_crop_suggestion_failed',
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        route: ROUTE_PATH,
        source: 'avatar-crop-suggestion',
      }
    );
  }
}
