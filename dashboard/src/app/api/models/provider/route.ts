import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { fetchLiveProviderModels, supportsPublicLiveModelDiscovery } from "@/lib/provider-models";
import { readCachedProviderModels } from "@/lib/services/provider-model-sync";

const BodySchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().optional(),
  vaultKeyId: z.string().optional(),
  instanceId: z.string().optional(),
});

async function resolveApiKeyForUser(
  userId: string,
  body: z.infer<typeof BodySchema>
): Promise<string | null> {
  if (body.apiKey?.trim()) {
    return body.apiKey.trim();
  }

  if (body.vaultKeyId) {
    if (!supabaseAdmin) {
      throw new Error("Database not configured");
    }

    const { data, error } = await supabaseAdmin
      .from("user_api_keys")
      .select("encrypted_key")
      .eq("id", body.vaultKeyId)
      .eq("user_id", userId)
      .single();

    if (error || !data?.encrypted_key) {
      throw new Error("Vault key not found");
    }

    return decryptApiKey(data.encrypted_key);
  }

  if (body.instanceId) {
    if (!supabaseAdmin) {
      throw new Error("Database not configured");
    }

    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("api_key_encrypted")
      .eq("id", body.instanceId)
      .eq("user_id", userId)
      .single();

    if (error || !data?.api_key_encrypted) {
      throw new Error("Instance API key not found");
    }

    return decryptApiKey(data.api_key_encrypted);
  }

  if (supportsPublicLiveModelDiscovery(body.provider)) {
    return null;
  }

  throw new Error("No provider API key available");
}

function buildSafeProviderDiscoveryError(err: unknown): {
  message: string;
  details: Record<string, unknown>;
} {
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (
    rawMessage === "Vault key not found" ||
    rawMessage === "Instance API key not found" ||
    rawMessage === "No provider API key available"
  ) {
    return {
      message: rawMessage,
      details: {
        failureType: "provider_model_lookup_expected_error",
        errorName: err instanceof Error ? err.name : typeof err,
      },
    };
  }

  return {
    message: "Unable to discover provider models.",
    details: {
      failureType: "provider_model_lookup_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    },
  };
}

export async function POST(request: NextRequest) {
  let requestedProvider = "";

  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const json = await request.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return apiError(parsed.error.issues[0]?.message || "Invalid payload", 400);

    requestedProvider = parsed.data.provider;
    const apiKey = await resolveApiKeyForUser(userId, parsed.data);
    const models = await fetchLiveProviderModels(parsed.data.provider, apiKey);

    return apiSuccess({ models, source: "live" });
  } catch (err) {
    if (requestedProvider) {
      const cachedModels = await readCachedProviderModels(requestedProvider);
      if (cachedModels) {
        return apiSuccess({ models: cachedModels, source: "cache" });
      }
    }

    const safeError = buildSafeProviderDiscoveryError(err);
    return apiError(safeError.message, 400, safeError.details);
  }
}
