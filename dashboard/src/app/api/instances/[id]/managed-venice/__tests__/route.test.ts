import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { DELETE, POST } from "../route";
import {
  disableManagedVeniceForWebUIInstance,
  enableManagedVeniceForWebUIInstance,
  ManagedVeniceEnableError,
} from "@/lib/venice/managed-webui-enable";
import { makeJsonRequest } from "@/test-utils";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: {
    secretWrite: { limit: 10, windowMs: 60_000 },
  },
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
}));

jest.mock("@/lib/instance-settings", () => ({
  getPublicInstanceConfig: jest.fn((config: Record<string, unknown>) => config),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

jest.mock("@/lib/venice/managed-webui-enable", () => {
  const actual = jest.requireActual("@/lib/venice/managed-webui-enable");
  return {
    ...actual,
    enableManagedVeniceForWebUIInstance: jest.fn(),
    disableManagedVeniceForWebUIInstance: jest.fn(),
  };
});

describe("POST /api/instances/[id]/managed-venice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    process.env.NEXT_PUBLIC_APP_URL = "https://app.hermesos.test";
  });

  it("enables managed Venice with the selected wallet and model", async () => {
    (enableManagedVeniceForWebUIInstance as jest.Mock).mockResolvedValue({
      applied: true,
      applyError: null,
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
        model: "glm-5.1",
        proxyBaseUrl: "https://app.hermesos.test/api/managed-venice/v1",
        keyPrefix: "hven_live_new_",
      },
      instance: {
        id: "inst_123",
        provider: "venice",
        api_key_encrypted: "encrypted",
        api_key_preview: "hven_live_new_...",
        config: { managedVenice: { enabled: true } },
      },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/managed-venice", {
        method: "POST",
        body: JSON.stringify({
          walletType: "hermesos",
          model: "glm-5.1",
        }),
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(enableManagedVeniceForWebUIInstance).toHaveBeenCalledWith(
      {
        instanceId: "inst_123",
        userId: "user_123",
        walletType: "hermesos",
        model: "glm-5.1",
        apply: true,
      },
      {
        dashboardEnableUrl:
          "https://app.hermesos.test/dashboard/billing?managedVenice=deposit&wallet=hermesos",
      }
    );
    expect(payload.data).toMatchObject({
      applied: true,
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
      },
      instance: {
        id: "inst_123",
        api_key_preview: "hven_live_new_...",
      },
    });
    expect(payload.data.instance.api_key_encrypted).toBeUndefined();
  });

  it("returns the enablement error status without leaking internals", async () => {
    (enableManagedVeniceForWebUIInstance as jest.Mock).mockRejectedValue(
      new ManagedVeniceEnableError("Managed Venice can be enabled from the dashboard for WebUI agents only.", {
        status: 400,
        failureType: "managed_venice_requires_webui",
      })
    );

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst_123/managed-venice", { walletType: "card" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      error: "Managed Venice can be enabled from the dashboard for WebUI agents only.",
    });
  });
});

describe("DELETE /api/instances/[id]/managed-venice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    process.env.NEXT_PUBLIC_APP_URL = "https://app.hermesos.test";
  });

  it("hands the BYOK switch to the lib function and returns the public instance", async () => {
    (disableManagedVeniceForWebUIInstance as jest.Mock).mockResolvedValue({
      applied: true,
      applyError: null,
      byokVenice: {
        enabled: true,
        model: "deepseek-v4-pro",
        keyPrefix: "vk_live_user_",
        previouslyManagedProxyKeyId: "key_existing",
      },
      instance: {
        id: "inst_123",
        provider: "venice",
        api_key_encrypted: "encrypted-byok",
        api_key_preview: "vk_live_user_...",
        config: { model: "deepseek-v4-pro" },
      },
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst_123/managed-venice", {
        method: "DELETE",
        body: JSON.stringify({
          apiKey: "vk_live_user_byok",
          model: "deepseek-v4-pro",
        }),
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(disableManagedVeniceForWebUIInstance).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      apiKey: "vk_live_user_byok",
      model: "deepseek-v4-pro",
      apply: true,
    });
    expect(payload.data).toMatchObject({
      applied: true,
      byokVenice: {
        enabled: true,
        previouslyManagedProxyKeyId: "key_existing",
      },
      instance: {
        id: "inst_123",
        api_key_preview: "vk_live_user_...",
      },
    });
    expect(payload.data.instance.api_key_encrypted).toBeUndefined();
  });

  it("rejects an empty apiKey before reaching the lib function", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst_123/managed-venice", {
        method: "DELETE",
        body: JSON.stringify({ apiKey: "   " }),
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(disableManagedVeniceForWebUIInstance).not.toHaveBeenCalled();
    expect(payload.error).toMatch(/venice api key is required/i);
  });

  it("surfaces the lib error status when the proxy key is passed as BYOK", async () => {
    (disableManagedVeniceForWebUIInstance as jest.Mock).mockRejectedValue(
      new ManagedVeniceEnableError(
        "That looks like a Hivra managed proxy key, not a Venice API key. Get your real key from venice.ai/settings/api.",
        { status: 400, failureType: "managed_venice_byok_key_invalid_shape" }
      )
    );

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst_123/managed-venice", {
        method: "DELETE",
        body: JSON.stringify({ apiKey: "hven_live_user_thought_this_was_their_key" }),
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/managed proxy key/i);
  });
});
