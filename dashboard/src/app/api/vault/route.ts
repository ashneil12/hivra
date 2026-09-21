import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { encryptApiKey, formatKeyPreview } from "@/lib/crypto";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { validateProviderKeyShape } from "@/lib/provider-key-shape";

import { ApiKeySchema } from "./schema";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: keys, error } = await supabaseAdmin
      .from("user_api_keys")
      .select("id, name, provider, key_preview, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      return apiError("Failed to fetch API keys", 500, {
        failureType: "vault_keys_fetch_failed",
      });
    }

    const keysMapped = keys?.map(k => ({
      ...k,
      name: k.name || k.provider // Map name for UI, fallback to provider
    }));

    return apiSuccess(keysMapped || []);
  } catch (err) {
    return apiError("Internal Server Error", 500, {
      failureType: "vault_get_unexpected_error",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "vault_post",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    const json = await request.json();
    const parsed = ApiKeySchema.safeParse(json);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const { id, name, provider, key } = parsed.data;

    if (!id && !key) {
      return apiError("A key is required when creating a new entry", 400);
    }

    const resolvedProvider = (provider || name || "").trim();
    if (!resolvedProvider) {
      return apiError("Provider is required", 400);
    }

    if (key) {
      const keyShapeError = validateProviderKeyShape(resolvedProvider, key);
      if (keyShapeError) return apiError(keyShapeError.message, 400, {
        failureType: keyShapeError.failureType,
        provider: keyShapeError.provider,
      });
    }

    interface VaultUpsertPayload {
      user_id: string;
      name: string;
      provider: string;
      updated_at: string;
      encrypted_key?: string;
      key_preview?: string;
    }

    const payload: VaultUpsertPayload = {
      user_id: userId,
      name: name || resolvedProvider, // Require a name field mapping
      provider: resolvedProvider, // fallback to name
      updated_at: new Date().toISOString(),
    };

    // Only update key if securely provided.
    if (key) {
      payload.encrypted_key = encryptApiKey(key);
      payload.key_preview = formatKeyPreview(key);
    }

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Upsert on (user_id, provider) so a repeat save for the same
    // provider rotates the existing row rather than inserting a new
    // one. The UNIQUE (user_id, provider) constraint added in migration
    // 20260502120200 enforces this at the DB level — the explicit
    // `onConflict` here makes the route's intent obvious and surfaces
    // the right `name`/`encrypted_key`/`key_preview` updates.
    let dbResult;
    if (id) {
      // Existing row → update by id (still scoped to the caller's user_id).
      dbResult = await supabaseAdmin
        .from("user_api_keys")
        .update(payload)
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();
    } else {
      dbResult = await supabaseAdmin
        .from("user_api_keys")
        .upsert(payload, { onConflict: "user_id,provider" })
        .select()
        .single();
    }

    if (dbResult.error) {
      return apiError("Failed to save API key", 500, {
        failureType: "vault_key_save_failed",
        operation: id ? "update" : "upsert",
      });
    }

    return apiSuccess({ id: dbResult.data.id });
  } catch (err) {
    return apiError("Internal Server Error", 500, {
      failureType: "vault_post_unexpected_error",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "vault_delete",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    
    if (!id) return apiError("Key ID is required", 400);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { error } = await supabaseAdmin
      .from("user_api_keys")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      return apiError("Failed to delete API key", 500, {
        failureType: "vault_key_delete_failed",
      });
    }

    return apiSuccess({ success: true });
  } catch (err) {
    return apiError("Internal Server Error", 500, {
      failureType: "vault_delete_unexpected_error",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}
