import {
  getProvidersForModelSync,
  hashProviderModels,
  syncProviderModelCatalogs,
  type ProviderModelCatalogStore,
} from "../provider-model-sync";
import { fetchLiveProviderModels, type ProviderModelOption } from "@/lib/provider-models";

jest.mock("@/lib/provider-models", () => {
  const actual = jest.requireActual("@/lib/provider-models");
  return {
    ...actual,
    fetchLiveProviderModels: jest.fn(),
  };
});

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

class MemoryStore implements ProviderModelCatalogStore {
  records = new Map<
    string,
    {
      provider: string;
      model_hash: string | null;
      models: ProviderModelOption[] | null;
      added_models?: string[];
      removed_models?: string[];
      checked_at?: string;
      last_error?: string | null;
    }
  >();
  errors = new Map<string, string>();

  async read(provider: string) {
    return this.records.get(provider) ?? null;
  }

  async write(input: {
    provider: string;
    models: ProviderModelOption[];
    modelHash: string;
    addedModels: string[];
    removedModels: string[];
    checkedAt: string;
    error: string | null;
  }) {
    this.records.set(input.provider, {
      provider: input.provider,
      model_hash: input.modelHash,
      models: input.models,
      added_models: input.addedModels,
      removed_models: input.removedModels,
      checked_at: input.checkedAt,
      last_error: input.error,
    });
  }

  async markError(provider: string, _checkedAt: string, error: string) {
    this.errors.set(provider, error);
  }
}

describe("provider model sync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_SYNC_OPENAI_API_KEY;
    delete process.env.BANKR_API_KEY;
    delete process.env.MODEL_SYNC_BANKR_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MODEL_SYNC_GEMINI_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("syncs model catalogs and records added/removed models when a provider changes", async () => {
    const store = new MemoryStore();
    const previousModels = [{ value: "old-model", label: "Old Model" }];
    store.records.set("venice", {
      provider: "venice",
      model_hash: hashProviderModels(previousModels),
      models: previousModels,
    });

    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "new-model", label: "New Model" },
    ]);

    const results = await syncProviderModelCatalogs({
      store,
      providers: ["venice"],
      now: new Date("2026-04-24T22:00:00.000Z"),
    });

    expect(fetchLiveProviderModels).toHaveBeenCalledWith("venice", null);
    expect(results).toEqual([
      {
        provider: "venice",
        checked: true,
        changed: true,
        modelCount: 1,
        addedModels: ["new-model"],
        removedModels: ["old-model"],
      },
    ]);
    expect(store.records.get("venice")?.models).toEqual([
      { value: "new-model", label: "New Model" },
    ]);
  });

  it("passes configured server keys for authenticated-only providers", async () => {
    process.env.MODEL_SYNC_OPENAI_API_KEY = "sync-openai-key";
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "gpt-5.5", label: "gpt-5.5" },
    ]);

    await syncProviderModelCatalogs({
      store: new MemoryStore(),
      providers: ["openai"],
    });

    expect(fetchLiveProviderModels).toHaveBeenCalledWith("openai", "sync-openai-key");
  });

  it("uses the Gemini model-sync key when refreshing cached Gemini catalogs", async () => {
    process.env.MODEL_SYNC_GEMINI_API_KEY = "sync-gemini-key";
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    ]);

    await syncProviderModelCatalogs({
      store: new MemoryStore(),
      providers: ["gemini"],
    });

    expect(fetchLiveProviderModels).toHaveBeenCalledWith("gemini", "sync-gemini-key");
  });

  it("records provider sync failures without stopping the whole nightly run", async () => {
    const store = new MemoryStore();
    (fetchLiveProviderModels as jest.Mock)
      .mockRejectedValueOnce(new Error("Provider returned HTTP 500"))
      .mockResolvedValueOnce([{ value: "kimi-k2-6", label: "Kimi K2.6" }]);

    const results = await syncProviderModelCatalogs({
      store,
      providers: ["venice", "crof"],
    });

    expect(results[0]).toEqual({
      provider: "venice",
      checked: false,
      changed: false,
      modelCount: 0,
      addedModels: [],
      removedModels: [],
      error: "Provider returned HTTP 500",
    });
    expect(results[1]).toEqual(
      expect.objectContaining({
        provider: "crof",
        checked: true,
      })
    );
    expect(store.errors.get("venice")).toBe("Provider returned HTTP 500");
  });

  it("includes public providers by default and private providers only when a server key exists", () => {
    expect(getProvidersForModelSync()).toEqual(
      expect.arrayContaining(["cometapi", "crof", "nous", "openrouter", "venice"])
    );
    expect(getProvidersForModelSync()).not.toContain("openai");
    expect(getProvidersForModelSync()).not.toContain("gemini");

    process.env.OPENAI_API_KEY = "openai-key";
    expect(getProvidersForModelSync()).toContain("openai");

    process.env.GEMINI_API_KEY = "gemini-key";
    expect(getProvidersForModelSync()).toContain("gemini");
  });
});
