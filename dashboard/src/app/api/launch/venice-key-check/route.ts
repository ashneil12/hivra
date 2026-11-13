import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { parseVenicePrivacy, type VenicePrivacy } from "@/lib/venice/model-privacy";

const VENICE_TEXT_MODELS_URL = "https://api.venice.ai/api/v1/models?type=text";
const TIMEOUT_MS = 5_000;

const BodySchema = z.object({ key: z.string().trim().regex(/^[\x21-\x7e]{8,256}$/) }).strict();

export type VeniceKeyCheckResult =
  | { ok: true; models: { id: string; name: string; privacy: VenicePrivacy }[] }
  | { ok: false; reason: "invalid_key" | "unreachable" };

function reply(result: VeniceKeyCheckResult) {
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Checks a Venice API key the owner pasted in Launch by listing Venice's text
 * models with it. The key is used for this one request: it is never logged,
 * stored or echoed back. An error from Venice is reported by reason only.
 */
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "launch_venice_key_check",
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (rateLimitError) return rateLimitError;

  const json = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  // A key that can't be one never needs a trip to Venice.
  if (!parsed.success) return reply({ ok: false, reason: "invalid_key" });

  let upstream: Response;
  try {
    upstream = await fetch(VENICE_TEXT_MODELS_URL, {
      headers: { Authorization: `Bearer ${parsed.data.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return reply({ ok: false, reason: "unreachable" });
  }

  if (upstream.status === 401 || upstream.status === 403) return reply({ ok: false, reason: "invalid_key" });
  if (!upstream.ok) return reply({ ok: false, reason: "unreachable" });

  const body = await upstream.json().catch(() => null) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) return reply({ ok: false, reason: "unreachable" });

  const models: { id: string; name: string; privacy: VenicePrivacy }[] = [];
  for (const entry of body.data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; model_spec?: { name?: unknown; privacy?: unknown } };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    // Plain model IDs only: the same rule the launch applies before sending one.
    if (!/^[A-Za-z0-9._:/[\]-]{1,64}$/.test(id)) continue;
    const name = typeof record.model_spec?.name === "string" && record.model_spec.name.trim()
      ? record.model_spec.name.trim()
      : id;
    models.push({ id, name, privacy: parseVenicePrivacy(record.model_spec?.privacy, id) });
  }
  return reply({ ok: true, models });
}
