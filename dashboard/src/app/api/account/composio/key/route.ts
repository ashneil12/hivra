// /api/account/composio/key
//
// BYO Composio key management. POST validates + stores the user's Composio
// project API key (user_api_keys, provider='composio'); GET reports whether a key
// is set; DELETE removes it (boxes de-register the composio MCP entry on their
// next connectors-sync, since getUserComposioKey then returns null).

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { encryptApiKey, formatKeyPreview } from "@/lib/crypto";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { COMPOSIO_PROVIDER, isComposioConnectFlagOn } from "@/lib/composio/config";
import { validateComposioKey } from "@/lib/composio/connect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const BodySchema = z.object({ key: z.string().trim().min(8).max(400) });

export async function GET() {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) return apiSuccess({ enabled: false, hasKey: false, keyPreview: null });
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { data } = await supabaseAdmin
    .from("user_api_keys")
    .select("key_preview")
    .eq("user_id", userId)
    .eq("provider", COMPOSIO_PROVIDER)
    .maybeSingle();

  const response = apiSuccess({
    enabled: true,
    hasKey: Boolean(data?.key_preview) || false,
    keyPreview: data?.key_preview ?? null,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) {
    return apiError("Composio Connect is not enabled.", 501, { failureType: "composio_disabled" }, { enabled: false });
  }

  const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "composio_key_post",
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (rateLimitError) return rateLimitError;

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return apiError("A Composio API key is required.", 400);
  const key = parsed.data.key;

  // Verify the key live before storing (surfaces the distinct IP-allowlist case).
  const check = await validateComposioKey(key);
  if (!check.ok) {
    return apiError(check.message, 400, { failureType: `composio_key_${check.reason}` });
  }

  if (!supabaseAdmin) return apiError("Database not configured", 500);
  const { error } = await supabaseAdmin
    .from("user_api_keys")
    .upsert(
      {
        user_id: userId,
        name: "Composio",
        provider: COMPOSIO_PROVIDER,
        encrypted_key: encryptApiKey(key),
        key_preview: formatKeyPreview(key),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    );

  if (error) {
    return apiError("Failed to save your Composio key.", 500, { failureType: "composio_key_save_failed" });
  }

  const response = apiSuccess({ enabled: true, hasKey: true, keyPreview: formatKeyPreview(key) });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { error } = await supabaseAdmin
    .from("user_api_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", COMPOSIO_PROVIDER);

  if (error) return apiError("Failed to remove your Composio key.", 500, { failureType: "composio_key_delete_failed" });
  return apiSuccess({ enabled: true, hasKey: false, keyPreview: null });
}
