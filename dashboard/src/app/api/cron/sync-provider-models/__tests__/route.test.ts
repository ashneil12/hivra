import { NextRequest } from "next/server";

import { GET } from "../route";
import { syncProviderModelCatalogs } from "@/lib/services/provider-model-sync";

jest.mock("@/lib/services/provider-model-sync", () => ({
  syncProviderModelCatalogs: jest.fn(),
}));

describe("GET /api/cron/sync-provider-models", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string) =>
    new Request("http://localhost/api/cron/sync-provider-models", {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("rejects requests without the cron secret", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(syncProviderModelCatalogs).not.toHaveBeenCalled();
  });

  it("runs the provider model sync and returns a compact summary", async () => {
    (syncProviderModelCatalogs as jest.Mock).mockResolvedValue([
      {
        provider: "venice",
        checked: true,
        changed: true,
        modelCount: 2,
        addedModels: ["gpt-5.5"],
        removedModels: [],
      },
      {
        provider: "openrouter",
        checked: false,
        changed: false,
        modelCount: 0,
        addedModels: [],
        removedModels: [],
        error: "Provider returned HTTP 500",
      },
    ]);

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(syncProviderModelCatalogs).toHaveBeenCalledTimes(1);
    expect(json.data).toEqual({
      checked: 2,
      changed: 1,
      failed: 1,
      changedProviders: ["venice"],
      failedProviders: ["openrouter"],
      results: [
        {
          provider: "venice",
          checked: true,
          changed: true,
          modelCount: 2,
          addedModels: ["gpt-5.5"],
          removedModels: [],
        },
        {
          provider: "openrouter",
          checked: false,
          changed: false,
          modelCount: 0,
          addedModels: [],
          removedModels: [],
          error: "Provider returned HTTP 500",
        },
      ],
    });
  });
});
