import { createHash } from "node:crypto";

import { PROVIDERS } from "@/lib/models";
import {
  fetchLiveProviderModels,
  getLiveModelDiscoveryProviders,
  supportsPublicLiveModelDiscovery,
  type ProviderModelOption,
} from "@/lib/provider-models";
import { supabaseAdmin } from "@/lib/supabase";

export interface ProviderModelSyncResult {
  provider: string;
  checked: boolean;
  changed: boolean;
  modelCount: number;
  addedModels: string[];
  removedModels: string[];
  error?: string;
}

interface StoredProviderModelCatalog {
  provider: string;
  model_hash: string | null;
  models: ProviderModelOption[] | null;
}

export interface ProviderModelCatalogStore {
  read(provider: string): Promise<StoredProviderModelCatalog | null>;
  write(input: {
    provider: string;
    models: ProviderModelOption[];
    modelHash: string;
    addedModels: string[];
    removedModels: string[];
    changed: boolean;
    checkedAt: string;
    error: string | null;
  }): Promise<void>;
  markError(provider: string, checkedAt: string, error: string): Promise<void>;
}

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  openai: ["MODEL_SYNC_OPENAI_API_KEY", "OPENAI_API_KEY"],
  bankr: ["MODEL_SYNC_BANKR_API_KEY", "BANKR_API_KEY"],
  gemini: ["MODEL_SYNC_GEMINI_API_KEY", "GEMINI_API_KEY"],
  moonshot: ["MODEL_SYNC_MOONSHOT_API_KEY", "KIMI_API_KEY"],
};

function getProviderApiKey(provider: string): string | null {
  for (const envKey of PROVIDER_ENV_KEYS[provider] ?? []) {
    const value = process.env[envKey]?.trim();
    if (value) return value;
  }

  return null;
}

function normalizeModelsForHash(models: ProviderModelOption[]): ProviderModelOption[] {
  return [...models]
    .map((model) => ({ value: model.value, label: model.label }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

export function hashProviderModels(models: ProviderModelOption[]): string {
  return createHash("sha256").update(JSON.stringify(normalizeModelsForHash(models))).digest("hex");
}

function diffModelValues(previous: ProviderModelOption[] | null, next: ProviderModelOption[]) {
  const previousValues = new Set((previous ?? []).map((model) => model.value));
  const nextValues = new Set(next.map((model) => model.value));

  return {
    addedModels: [...nextValues].filter((value) => !previousValues.has(value)).sort(),
    removedModels: [...previousValues].filter((value) => !nextValues.has(value)).sort(),
  };
}

class SupabaseProviderModelCatalogStore implements ProviderModelCatalogStore {
  async read(provider: string): Promise<StoredProviderModelCatalog | null> {
    if (!supabaseAdmin) return null;

    const { data, error } = await supabaseAdmin
      .from("provider_model_catalogs")
      .select("provider, model_hash, models")
      .eq("provider", provider)
      .maybeSingle();

    if (error || !data) return null;
    return data as StoredProviderModelCatalog;
  }

  async write(input: {
    provider: string;
    models: ProviderModelOption[];
    modelHash: string;
    addedModels: string[];
    removedModels: string[];
    changed: boolean;
    checkedAt: string;
    error: string | null;
  }): Promise<void> {
    if (!supabaseAdmin) return;

    await supabaseAdmin
      .from("provider_model_catalogs")
      .upsert(
        {
          provider: input.provider,
          models: input.models,
          model_count: input.models.length,
          model_hash: input.modelHash,
          added_models: input.addedModels,
          removed_models: input.removedModels,
          last_error: input.error,
          checked_at: input.checkedAt,
          last_changed_at: input.changed ? input.checkedAt : undefined,
          updated_at: input.checkedAt,
        },
        { onConflict: "provider" }
      );
  }

  async markError(provider: string, checkedAt: string, error: string): Promise<void> {
    if (!supabaseAdmin) return;

    await supabaseAdmin
      .from("provider_model_catalogs")
      .upsert(
        {
          provider,
          last_error: error,
          checked_at: checkedAt,
          updated_at: checkedAt,
        },
        { onConflict: "provider" }
      );
  }
}

function isProviderModelOption(value: unknown): value is ProviderModelOption {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.value === "string" && typeof record.label === "string";
}

function dedupeProviderModels(models: ProviderModelOption[]): ProviderModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = model.value.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function readCachedProviderModels(provider: string): Promise<ProviderModelOption[] | null> {
  const store = new SupabaseProviderModelCatalogStore();
  const cached = await store.read(provider.trim().toLowerCase());
  if (!cached?.models || !Array.isArray(cached.models)) return null;

  const models = dedupeProviderModels(cached.models.filter(isProviderModelOption));
  return models.length > 0 ? models : null;
}

export function getProvidersForModelSync(): string[] {
  const configuredProviderIds = new Set(PROVIDERS.map((provider) => provider.id));

  return getLiveModelDiscoveryProviders()
    .filter((provider) => configuredProviderIds.has(provider))
    .filter((provider) => supportsPublicLiveModelDiscovery(provider) || Boolean(getProviderApiKey(provider)))
    .sort();
}

export async function syncProviderModelCatalogs(options: {
  store?: ProviderModelCatalogStore;
  providers?: string[];
  now?: Date;
} = {}): Promise<ProviderModelSyncResult[]> {
  const store = options.store ?? new SupabaseProviderModelCatalogStore();
  const providers = options.providers ?? getProvidersForModelSync();
  const checkedAt = (options.now ?? new Date()).toISOString();
  const results: ProviderModelSyncResult[] = [];

  for (const provider of providers) {
    try {
      const apiKey = getProviderApiKey(provider);
      const models = await fetchLiveProviderModels(provider, apiKey);
      const previous = await store.read(provider);
      const modelHash = hashProviderModels(models);
      const changed = previous?.model_hash !== modelHash;
      const { addedModels, removedModels } = diffModelValues(previous?.models ?? null, models);

      await store.write({
        provider,
        models,
        modelHash,
        addedModels,
        removedModels,
        changed,
        checkedAt,
        error: null,
      });

      results.push({
        provider,
        checked: true,
        changed,
        modelCount: models.length,
        addedModels,
        removedModels,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown provider model sync error";
      await store.markError(provider, checkedAt, message);
      results.push({
        provider,
        checked: false,
        changed: false,
        modelCount: 0,
        addedModels: [],
        removedModels: [],
        error: message,
      });
    }
  }

  return results;
}
