jest.mock("server-only", () => ({}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
  recoverAndPersistApiServerKeyFromManagedHost: jest.fn(),
}));

import {
  getSecureUserInstance,
  recoverAndPersistApiServerKeyFromManagedHost,
} from "@/lib/services/instance-security";
import { resolveWebUIInstanceClient } from "../instance";

describe("resolveWebUIInstanceClient", () => {
  const originalFetch = global.fetch;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedRecoverApiServerKey =
    recoverAndPersistApiServerKeyFromManagedHost as jest.MockedFunction<typeof recoverAndPersistApiServerKeyFromManagedHost>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("builds shared WebUI clients that recover stale managed-host bearers", async () => {
    const instance = {
      id: "inst-123",
      gateway_url: "https://webui.example.com",
      api_server_key_encrypted: "encrypted-key",
      user_id: "user-123",
      status: "running",
      backend: "webui" as const,
      host_id: "host-123",
      hetzner_server_id: 456,
      ipv4_address: "203.0.113.10",
    };
    mockedGetSecureUserInstance.mockResolvedValue({
      instance,
      error: null,
      apiServerKey: "stale-key",
      instanceIpv4: "203.0.113.10",
    });
    mockedRecoverApiServerKey.mockResolvedValue({
      apiServerKey: "fresh-key",
      instanceIpv4: "203.0.113.10",
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://webui.example.com/api/memory") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer fresh-key") {
          return Response.json({ memory: "remember this", user: "Ash" });
        }
        return new Response("auth 401", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const resolved = await resolveWebUIInstanceClient({
      instanceId: "inst-123",
      userId: "user-123",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected resolver success");

    await expect(resolved.client.memory()).resolves.toEqual({
      memory: "remember this",
      user: "Ash",
    });

    expect(mockedRecoverApiServerKey).toHaveBeenCalledWith(instance, {
      ignoreApiServerKey: "stale-key",
    });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer stale-key");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer fresh-key");
  });
});
