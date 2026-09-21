import {
  detectAndRepairApiServerKeyDrift,
  probeSignedHandoffSignature,
  shouldAttemptApiServerKeyResync,
  __resetApiServerKeyResyncTrackerForTests,
} from "@/lib/webui-handoff-key-resync";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { recoverAndPersistApiServerKeyFromManagedHost } from "@/lib/services/instance-security";

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  recoverAndPersistApiServerKeyFromManagedHost: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockGatewayFetch = fetchFirstReachableGatewayResponse as jest.Mock;
const mockRecover = recoverAndPersistApiServerKeyFromManagedHost as jest.Mock;

const STORED_KEY = "a".repeat(64);
const RECOVERED_KEY = "b".repeat(64);

function gatewayResponse(status: number) {
  return {
    response: { status, body: { cancel: jest.fn().mockResolvedValue(undefined) } },
    url: "https://agent.example.com/_sidecar/webui-login",
  };
}

function baseInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst_1",
    gateway_url: "https://agent.example.com",
    ipv4_address: "10.250.20.60",
    backend: "webui" as const,
    ...overrides,
  };
}

function driftArgs(overrides: Record<string, unknown> = {}) {
  return {
    instance: baseInstance(),
    apiServerKey: STORED_KEY,
    baseUrl: "https://agent.example.com",
    instanceIpv4: "10.250.20.60",
    isWebuiBackend: true,
    userId: "user_1",
    now: 1_000_000,
    ...overrides,
  };
}

describe("probeSignedHandoffSignature", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports drift on a 403 from the sidecar", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    await expect(
      probeSignedHandoffSignature({
        baseUrl: "https://agent.example.com",
        instanceIpv4: "10.250.20.60",
        apiServerKey: STORED_KEY,
        isWebuiBackend: true,
      }),
    ).resolves.toBe(true);
  });

  it("reports no drift on a successful handoff (opaqueredirect / status 0)", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(0));
    await expect(
      probeSignedHandoffSignature({
        baseUrl: "https://agent.example.com",
        instanceIpv4: "10.250.20.60",
        apiServerKey: STORED_KEY,
        isWebuiBackend: true,
      }),
    ).resolves.toBe(false);
  });

  it("treats a network error as inconclusive (never drift)", async () => {
    mockGatewayFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      probeSignedHandoffSignature({
        baseUrl: "https://agent.example.com",
        instanceIpv4: "10.250.20.60",
        apiServerKey: STORED_KEY,
        isWebuiBackend: true,
      }),
    ).resolves.toBe(false);
  });

  it("probes the webui-login sidecar path with redirect:manual for webui-backend", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(0));
    await probeSignedHandoffSignature({
      baseUrl: "https://agent.example.com",
      instanceIpv4: "10.250.20.60",
      apiServerKey: STORED_KEY,
      isWebuiBackend: true,
    });
    const call = mockGatewayFetch.mock.calls[0][0];
    expect(call.pathname).toContain("/_sidecar/webui-login?");
    expect(call.redirect).toBe("manual");
    expect(call.method).toBe("GET");
  });

  it("probes the dashboard-login sidecar path for a non-webui backend", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(0));
    await probeSignedHandoffSignature({
      baseUrl: "https://agent.example.com",
      instanceIpv4: "10.250.20.60",
      apiServerKey: STORED_KEY,
      isWebuiBackend: false,
    });
    const call = mockGatewayFetch.mock.calls[0][0];
    expect(call.pathname).toContain("/_sidecar/dashboard-login?");
  });
});

describe("detectAndRepairApiServerKeyDrift", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetApiServerKeyResyncTrackerForTests();
  });

  it("recovers and returns the live VM key when a healthy sidecar 403s the signed handoff", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    mockRecover.mockResolvedValue({ apiServerKey: RECOVERED_KEY, instanceIpv4: "10.250.20.60" });

    const result = await detectAndRepairApiServerKeyDrift(driftArgs());

    expect(result).toEqual({ apiServerKey: RECOVERED_KEY });
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst_1" }),
      { ignoreApiServerKey: STORED_KEY },
    );
  });

  it("forwards the instance config so the recovery can route through the managing pve host", async () => {
    const proxmoxConfig = {
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode10",
        vmid: 1000,
        hostSlug: "fixturenode10",
        hostEnvPrefix: "PROXMOX_FIXTURENODE10_",
        privateIpv4: "10.250.20.50",
        gatewayHost: "agent.example.com",
      },
    };
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    mockRecover.mockResolvedValue({ apiServerKey: RECOVERED_KEY, instanceIpv4: "10.250.20.60" });

    const result = await detectAndRepairApiServerKeyDrift(
      driftArgs({ instance: baseInstance({ config: proxmoxConfig }) }),
    );

    expect(result).toEqual({ apiServerKey: RECOVERED_KEY });
    expect(mockRecover).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst_1", config: proxmoxConfig }),
      { ignoreApiServerKey: STORED_KEY },
    );
  });

  it("keeps the stored key and never SSHes when the handoff verifies (no drift)", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(0));

    const result = await detectAndRepairApiServerKeyDrift(driftArgs());

    expect(result).toEqual({ apiServerKey: STORED_KEY });
    expect(mockGatewayFetch).toHaveBeenCalledTimes(1);
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it("keeps the stored key when drift is detected but no fresh VM key is recoverable", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    mockRecover.mockResolvedValue(null);

    const result = await detectAndRepairApiServerKeyDrift(driftArgs());

    expect(result).toEqual({ apiServerKey: STORED_KEY });
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  it("does not probe or recover for a missing instance IP", async () => {
    const result = await detectAndRepairApiServerKeyDrift(driftArgs({ instanceIpv4: "" }));

    expect(result).toEqual({ apiServerKey: STORED_KEY });
    expect(mockGatewayFetch).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
    // A skipped (no-IP) call must NOT burn the cooldown slot.
    expect(shouldAttemptApiServerKeyResync("inst_1", 1_000_000)).toBe(true);
  });

  it("enforces a per-instance cooldown so it can't SSH-storm on a persistently broken box", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    mockRecover.mockResolvedValue(null);

    // First open: probes + attempts recovery, sets the cooldown.
    await detectAndRepairApiServerKeyDrift(driftArgs({ now: 1_000_000 }));
    // Second open shortly after: gated — no second probe, no second SSH.
    const second = await detectAndRepairApiServerKeyDrift(driftArgs({ now: 1_030_000 }));

    expect(second).toEqual({ apiServerKey: STORED_KEY });
    expect(mockGatewayFetch).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  it("re-attempts after the cooldown window elapses", async () => {
    mockGatewayFetch.mockResolvedValue(gatewayResponse(403));
    mockRecover.mockResolvedValue(null);

    await detectAndRepairApiServerKeyDrift(driftArgs({ now: 1_000_000 }));
    // 6 minutes later — past the 5-minute cooldown.
    await detectAndRepairApiServerKeyDrift(driftArgs({ now: 1_000_000 + 6 * 60 * 1000 }));

    expect(mockGatewayFetch).toHaveBeenCalledTimes(2);
    expect(mockRecover).toHaveBeenCalledTimes(2);
  });
});
