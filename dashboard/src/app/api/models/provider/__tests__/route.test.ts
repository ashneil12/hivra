import { POST } from "../route";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { fetchLiveProviderModels, supportsPublicLiveModelDiscovery } from "@/lib/provider-models";
import { readCachedProviderModels } from "@/lib/services/provider-model-sync";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/provider-models", () => ({
  fetchLiveProviderModels: jest.fn(),
  supportsPublicLiveModelDiscovery: jest.fn(),
}));

jest.mock("@/lib/services/provider-model-sync", () => ({
  readCachedProviderModels: jest.fn(),
}));

describe("POST /api/models/provider", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (supportsPublicLiveModelDiscovery as jest.Mock).mockImplementation(
      (provider: string) =>
        provider === "venice" || provider === "openrouter" || provider === "crof" || provider === "nous" || provider === "cometapi"
    );
    (readCachedProviderModels as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const makeRequest = (body: Record<string, unknown>) =>
    new Request("http://localhost:3000/api/models/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest;

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(makeRequest({ provider: "openrouter", apiKey: "sk-or-test" }));

    expect(response.status).toBe(401);
  });

  it("uses an explicitly supplied api key for live discovery", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" },
    ]);

    const response = await POST(makeRequest({ provider: "openrouter", apiKey: "sk-or-test" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("openrouter", "sk-or-test");
    expect(json.data.models).toEqual([{ value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" }]);
    expect(json.data.source).toBe("live");
  });

  it("allows public live discovery without an API key when the provider supports it", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "kimi-k2-6", label: "Kimi K2.6" },
    ]);

    const response = await POST(makeRequest({ provider: "venice" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("venice", null);
    expect(json.data.models).toEqual([{ value: "kimi-k2-6", label: "Kimi K2.6" }]);
  });

  it("allows Nous Portal model discovery without an API key when the provider exposes a public catalog", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" },
    ]);

    const response = await POST(makeRequest({ provider: "nous" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("nous", null);
    expect(json.data.models).toEqual([{ value: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" }]);
  });

  it("allows CometAPI model discovery without an API key when the provider exposes a public text catalog", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "claude-opus-4-7", label: "Anthropic · Claude Opus 4.7" },
      { value: "gpt-5.4", label: "OpenAI · GPT-5.4" },
    ]);

    const response = await POST(makeRequest({ provider: "cometapi" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("cometapi", null);
    expect(json.data.models).toEqual([
      { value: "claude-opus-4-7", label: "Anthropic · Claude Opus 4.7" },
      { value: "gpt-5.4", label: "OpenAI · GPT-5.4" },
    ]);
  });

  it("resolves a vault key before live discovery", async () => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { encrypted_key: "encrypted-value" },
      error: null,
    });
    ((supabaseAdmin as NonNullable<typeof supabaseAdmin>).from as jest.Mock).mockReturnValue(query);

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (decryptApiKey as jest.Mock).mockReturnValue("resolved-from-vault");
    (fetchLiveProviderModels as jest.Mock).mockResolvedValue([
      { value: "venice-uncensored", label: "Venice Uncensored" },
    ]);

    const response = await POST(makeRequest({ provider: "venice", vaultKeyId: "vk_123" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect((supabaseAdmin as NonNullable<typeof supabaseAdmin>).from).toHaveBeenCalledWith("user_api_keys");
    expect(decryptApiKey).toHaveBeenCalledWith("encrypted-value");
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("venice", "resolved-from-vault");
    expect(json.data.models).toEqual([{ value: "venice-uncensored", label: "Venice Uncensored" }]);
  });

  it("still requires an API key for providers without public model discovery", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });

    const response = await POST(makeRequest({ provider: "moonshot" }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("No provider API key available");
    expect(fetchLiveProviderModels).not.toHaveBeenCalled();
  });

  it("returns the nightly cached catalog when live discovery cannot run without a key", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (readCachedProviderModels as jest.Mock).mockResolvedValue([
      { value: "gpt-5.5", label: "GPT-5.5" },
    ]);

    const response = await POST(makeRequest({ provider: "openai" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).not.toHaveBeenCalled();
    expect(readCachedProviderModels).toHaveBeenCalledWith("openai");
    expect(json.data).toEqual({
      models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
      source: "cache",
    });
  });

  it("falls back to the nightly cached catalog when a live provider lookup fails", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockRejectedValueOnce(new Error("Provider returned HTTP 500"));
    (readCachedProviderModels as jest.Mock).mockResolvedValue([
      { value: "kimi-k2-6", label: "Kimi K2.6" },
    ]);

    const response = await POST(makeRequest({ provider: "venice" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchLiveProviderModels).toHaveBeenCalledWith("venice", null);
    expect(json.data).toEqual({
      models: [{ value: "kimi-k2-6", label: "Kimi K2.6" }],
      source: "cache",
    });
  });

  it("also requires an API key for Bankr's authenticated model catalog", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });

    const response = await POST(makeRequest({ provider: "bankr" }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("No provider API key available");
    expect(fetchLiveProviderModels).not.toHaveBeenCalled();
  });

  it("does not leak unexpected provider discovery failures", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (fetchLiveProviderModels as jest.Mock).mockRejectedValueOnce(
      new Error("provider-secret-leak")
    );

    const response = await POST(makeRequest({ provider: "openrouter", apiKey: "sk-or-test" }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Unable to discover provider models.");
    expect(JSON.stringify(json)).not.toContain("provider-secret-leak");
    expect(getConsoleOutput()).not.toContain("provider-secret-leak");
  });
});
