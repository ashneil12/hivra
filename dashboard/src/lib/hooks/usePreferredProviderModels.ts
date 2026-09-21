import { useEffect, useMemo, useState } from "react";
import type { ProviderModelOption } from "@/lib/provider-models";
import { supportsLiveModelDiscovery, supportsPublicLiveModelDiscovery } from "@/lib/provider-models";

interface UsePreferredProviderModelsParams {
  provider: string;
  staticModels: ProviderModelOption[];
  apiKey?: string;
  vaultKeyId?: string;
  instanceId?: string;
}

function dedupeModelOptions(models: ProviderModelOption[]): ProviderModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = model.value.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function orderLiveModelsByStaticPreference(
  liveModels: ProviderModelOption[],
  staticModels: ProviderModelOption[]
): ProviderModelOption[] {
  const liveByValue = new Map<string, ProviderModelOption>();
  for (const liveModel of liveModels) {
    const value = liveModel.value.trim();
    if (value && !liveByValue.has(value)) {
      liveByValue.set(value, liveModel);
    }
  }

  const ordered: ProviderModelOption[] = [];
  for (const staticModel of staticModels) {
    const value = staticModel.value.trim();
    if (!value || !liveByValue.has(value)) continue;
    ordered.push({
      ...liveByValue.get(value)!,
      label: staticModel.label || liveByValue.get(value)!.label,
    });
    liveByValue.delete(value);
  }

  return dedupeModelOptions([...ordered, ...liveByValue.values()]);
}

export function usePreferredProviderModels({
  provider,
  staticModels,
  apiKey,
  vaultKeyId,
  instanceId,
}: UsePreferredProviderModelsParams) {
  const [liveModels, setLiveModels] = useState<ProviderModelOption[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const trimmedApiKey = apiKey?.trim() || "";
    const canUsePublicCatalog = supportsPublicLiveModelDiscovery(provider);
    const canFetchLive =
      Boolean(provider) &&
      supportsLiveModelDiscovery(provider) &&
      Boolean(trimmedApiKey || vaultKeyId || instanceId || canUsePublicCatalog);

    if (!canFetchLive) {
      setLiveModels(null);
      setIsLoading(false);
      setError("");
      return;
    }

    let cancelled = false;
    const delayMs = trimmedApiKey ? 450 : 0;

    const timeout = window.setTimeout(async () => {
      setIsLoading(true);
      setError("");

      try {
        const response = await fetch("/api/models/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
            ...(vaultKeyId ? { vaultKeyId } : {}),
            ...(instanceId ? { instanceId } : {}),
          }),
        });

        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.error || "Failed to fetch live models");
        }

        const models = Array.isArray(json.data?.models) ? json.data.models : [];
        if (!cancelled) {
          const uniqueModels = dedupeModelOptions(models);
          setLiveModels(uniqueModels.length > 0 ? uniqueModels : null);
        }
      } catch (err) {
        if (!cancelled) {
          setLiveModels(null);
          setError(err instanceof Error ? err.message : "Failed to fetch live models");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [apiKey, instanceId, provider, vaultKeyId]);

  const modelOptions = useMemo(
    () =>
      dedupeModelOptions(
        liveModels && liveModels.length > 0
          ? orderLiveModelsByStaticPreference(liveModels, staticModels)
          : staticModels
      ),
    [liveModels, staticModels]
  );

  return {
    modelOptions,
    hasLiveModels: Boolean(liveModels && liveModels.length > 0),
    isLoading,
    error,
  };
}
