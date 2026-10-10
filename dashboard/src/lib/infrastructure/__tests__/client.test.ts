/** @jest-environment jsdom */

import {
  InfrastructureApiError,
  checkGvisorConnection,
  connectHetznerCloudProject,
  parseRetryAfterSeconds,
  prepareGvisorConnection,
  createInfrastructureConnection,
  discoverInfrastructureHost,
  forceForgetHetznerCloudConnection,
  getHetznerCloudCapacitySlot,
  getHetznerCloudInventory,
  getHetznerCloudOfferCatalog,
  listInfrastructureTargets,
  listProviderComputerSetupEvidence,
  listProviderComputerSetups,
  prepareInfrastructureConnection,
  preflightInfrastructureConnection,
  refreshHetznerCloudInventory,
  replaceHetznerCloudToken,
} from "../client";
import {
  HETZNER_CLOUD_BILLING_SEMANTICS,
  HETZNER_CLOUD_CONNECTION_CAPABILITIES,
  HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
  HETZNER_CLOUD_SIMPLE_MODE_POLICY,
} from "../contracts";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";
const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(96),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const connection = {
  id: CONNECTION_ID,
  name: "Home Proxmox",
  provider: "proxmox" as const,
  operatingMode: "self-managed" as const,
  setupMode: "simple" as const,
  status: "pending" as const,
  endpoint: {
    sshHost: "pve.example.com",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: null,
  credentialsConfigured: true,
  lastCheckedAt: null,
  lastErrorCode: null,
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

const target = {
  id: TARGET_ID,
  connectionId: CONNECTION_ID,
  evidenceConnectionRevision: 3,
  externalId: "pve-01",
  displayName: "Home Proxmox / pve-01",
  status: "unavailable" as const,
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: 0.25 },
    memoryBytes: { total: 32_000, available: 24_000 },
    storageBytes: { total: 20_000, available: 15_000 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: false,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr0"],
    selectedBridge: "vmbr0",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: null,
    provisioner: null,
    runtimeCompatibility: null,
    vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
    issues: [{
      code: "PROVISIONER_UNAVAILABLE" as const,
      message: "No prepared assets were configured",
    }],
  },
  supportedIsolationDrivers: ["proxmox-kvm" as const],
  isolationClass: "hardware-vm" as const,
  lastPreflightAt: CHECKED_AT,
  lastErrorCode: "PROVISIONER_UNAVAILABLE" as const,
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response);
}

describe("infrastructure browser client", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("loads strict persisted target evidence with an optional owner-scoped filter", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { targets: [target] },
    })) as typeof fetch;

    await expect(listInfrastructureTargets(CONNECTION_ID)).resolves.toEqual([target]);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/infrastructure/targets?connectionId=${CONNECTION_ID}`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("keeps Simple create payloads strict and never invents configuration", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { connection },
    }, 201)) as typeof fetch;

    await createInfrastructureConnection({
      name: "Home Proxmox",
      provider: "proxmox",
      operatingMode: "self-managed",
      setupMode: "simple",
      endpoint: connection.endpoint,
      credentials: { sshPrivateKey: PRIVATE_KEY },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(String(request.body));
    expect(sent).not.toHaveProperty("configuration");
    expect(sent.credentials.sshPrivateKey).toBe(PRIVATE_KEY);
  });

  it("sends a host-first connection without guessing an isolation driver", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { connection: { ...connection, name: "My host", provider: "host" } },
    }, 201)) as typeof fetch;

    await createInfrastructureConnection({
      name: "My host",
      provider: "host",
      operatingMode: "self-managed",
      setupMode: "simple",
      endpoint: connection.endpoint,
      credentials: { sshPrivateKey: PRIVATE_KEY },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(String(request.body));
    expect(sent.provider).toBe("host");
    expect(sent).not.toHaveProperty("configuration");
    expect(sent).not.toHaveProperty("isolationDriver");
  });

  it("connects a Hetzner project through the provider-specific response contract", async () => {
    const hetznerConnection = {
      ...connection,
      name: "My Hetzner",
      provider: "hetzner-cloud" as const,
      status: "ready" as const,
      endpoint: null,
      configuration: null,
      capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
      lastCheckedAt: CHECKED_AT,
    };
    const inventory = [{
      id: "33333333-3333-4333-8333-333333333333",
      connectionId: CONNECTION_ID,
      providerResourceId: "42",
      name: "ash-dev-box",
      status: "running" as const,
      serverType: {
        name: "cpx22",
        description: "CPX 22",
        cores: 2,
        memoryGb: 4,
        diskGb: 80,
        cpuType: "shared" as const,
        architecture: "x86" as const,
      },
      location: { name: "fsn1", city: "Falkenstein", country: "DE" },
      publicNetwork: { ipv4: "203.0.113.10", ipv6: "2001:db8::10" },
      providerCreatedAt: CHECKED_AT,
      discoveredAt: CHECKED_AT,
      createdAt: CHECKED_AT,
      updatedAt: CHECKED_AT,
      launchReady: false as const,
      launchBlockedReason: "Provider VM bootstrap and launch authority are not implemented yet.",
    }];
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { connection: hetznerConnection, inventory, writeCheck: { strayKeyName: null } },
    }, 201)) as typeof fetch;

    await expect(connectHetznerCloudProject({
      name: "My Hetzner",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken: "project-scoped-owner-token-value" },
    })).resolves.toEqual({ connection: hetznerConnection, inventory, writeCheck: { strayKeyName: null } });

    // A response without the write-check result is not a connected project.
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { connection: hetznerConnection, inventory },
    }, 201)) as typeof fetch;
    await expect(connectHetznerCloudProject({
      name: "My Hetzner",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken: "project-scoped-owner-token-value" },
    })).rejects.toThrow(/unexpected response/);
  });

  it("replaces a Hetzner token through its own endpoint and surfaces a stray test key", async () => {
    const hetznerConnection = {
      ...connection,
      name: "My Hetzner",
      provider: "hetzner-cloud" as const,
      status: "ready" as const,
      endpoint: null,
      configuration: null,
      capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
      lastCheckedAt: CHECKED_AT,
    };
    const fetchMock = jest.fn(() => jsonResponse({
      success: true,
      data: {
        connection: hetznerConnection, inventory: null,
        writeCheck: { strayKeyName: "hivra-check-0123456789ab" }, projectCheck: "unconfirmed",
      },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    // A saved token without a saved server list, and an unconfirmed project, both reach the page.
    await expect(replaceHetznerCloudToken(CONNECTION_ID, "new-project-scoped-token-value")).resolves.toEqual({
      connection: hetznerConnection, inventory: null,
      writeCheck: { strayKeyName: "hivra-check-0123456789ab" }, projectCheck: "unconfirmed",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/hetzner-cloud/token`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ apiToken: "new-project-scoped-token-value" }) }),
    );
    await expect(replaceHetznerCloudToken("not-a-connection", "new-project-scoped-token-value")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A result that doesn't say how the project was checked is not a replaced token.
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { connection: hetznerConnection, inventory: [], writeCheck: { strayKeyName: null } },
    })) as typeof fetch;
    await expect(replaceHetznerCloudToken(CONNECTION_ID, "new-project-scoped-token-value")).rejects.toThrow(/unexpected response/);
  });

  it("reads setup evidence with Hivra's created-server records", async () => {
    const createdServers = [{ orderId: TARGET_ID, serverName: "hivra-a1b2c3d4", providerServerId: null, status: "ambiguous" }];
    global.fetch = jest.fn(() => jsonResponse({ success: true, data: { computers: [], createdServers } })) as typeof fetch;
    await expect(listProviderComputerSetupEvidence(CONNECTION_ID)).resolves.toEqual({ computers: [], createdServers });
    await expect(listProviderComputerSetups(CONNECTION_ID)).resolves.toEqual([]);
    // Without the created-server records the card can't label anything.
    global.fetch = jest.fn(() => jsonResponse({ success: true, data: { computers: [] } })) as typeof fetch;
    await expect(listProviderComputerSetupEvidence(CONNECTION_ID)).rejects.toThrow(/unexpected response/);
  });

  it("reads the account's Hetzner server slot", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { slot: { held: true, serverName: "hivra-a1b2c3d4", connectionId: CONNECTION_ID, status: "created_off" } },
    })) as typeof fetch;
    await expect(getHetznerCloudCapacitySlot()).resolves.toEqual({
      held: true, serverName: "hivra-a1b2c3d4", connectionId: CONNECTION_ID, status: "created_off",
    });
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { slot: { held: false, serverName: "leaked", connectionId: null, status: null } },
    })) as typeof fetch;
    await expect(getHetznerCloudCapacitySlot()).rejects.toThrow(/unexpected response/);
  });

  it("loads, refreshes, and validates a Hetzner offer catalog with location availability", async () => {
    const inventoryResponse = { success: true, data: { inventory: [] } };
    const catalog = {
      fetchedAt: CHECKED_AT,
      currency: "EUR",
      vatRate: "19.00",
      serverTypes: [{
        id: 104,
        name: "cpx22",
        description: "CPX 22",
        cores: 2,
        memoryGb: 4,
        diskGb: 80,
        cpuType: "shared" as const,
        architecture: "x86" as const,
        deprecated: false,
        locations: [{ name: "fsn1", available: true, recommended: true, deprecated: false }],
        prices: [{
          location: "fsn1",
          monthly: { currency: "EUR", net: "5.00", gross: "5.95" },
          hourly: { currency: "EUR", net: "0.01", gross: "0.0119" },
          includedTrafficBytes: 21990232555520,
          additionalTrafficPerTb: {
            currency: "EUR",
            net: "1.00",
            gross: "1.19",
          },
        }],
      }],
      locations: [{
        id: 1,
        name: "fsn1",
        city: "Falkenstein",
        country: "DE",
        networkZone: "eu-central",
      }],
      primaryIpPrices: [{
        location: "fsn1",
        ipv4: {
          hourly: { net: "0.001", gross: "0.00119" },
          monthly: { net: "0.50", gross: "0.595" },
        },
        ipv6: {
          hourly: { net: "0", gross: "0" },
          monthly: { net: "0", gross: "0" },
        },
      }],
      images: [{
        id: 100,
        type: "system" as const,
        name: "ubuntu-24.04",
        description: "Ubuntu 24.04",
        architecture: "x86" as const,
        osFlavor: "ubuntu",
        osVersion: "24.04",
        deprecated: false,
      }],
      simpleModePolicy: HETZNER_CLOUD_SIMPLE_MODE_POLICY,
      billing: HETZNER_CLOUD_BILLING_SEMANTICS,
      capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
    };
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => jsonResponse(inventoryResponse))
      .mockImplementationOnce(() => jsonResponse(inventoryResponse))
      .mockImplementationOnce(() => jsonResponse({ success: true, data: { catalog } })) as typeof fetch;

    await expect(getHetznerCloudInventory(CONNECTION_ID)).resolves.toEqual([]);
    await expect(refreshHetznerCloudInventory(CONNECTION_ID)).resolves.toEqual([]);
    await expect(getHetznerCloudOfferCatalog(CONNECTION_ID)).resolves.toEqual(catalog);
    expect((global.fetch as jest.Mock).mock.calls.map((call) => call[1].method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("sends only the exact force-forget confirmation and validates the cleanup truth", async () => {
    const result = {
      connectionDeleted: true as const,
      localCredentialsWiped: true as const,
      providerCleanupPerformed: false as const,
      canarySlotHeld: true as const,
    };
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: result,
    })) as typeof fetch;

    await expect(forceForgetHetznerCloudConnection(CONNECTION_ID, {
      confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
    })).resolves.toEqual(result);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/hetzner-cloud/capacity/force-forget`,
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
        }),
      }),
    );
  });

  it("returns a successful HTTP preflight whose domain result is not ready", async () => {
    const failure = {
      ok: false as const,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      error: {
        code: "KVM_UNAVAILABLE" as const,
        message: "KVM is unavailable on this host.",
        remediation: "Enable virtualization support, then check again.",
      },
      unmetRequirements: [{
        code: "KVM_UNAVAILABLE" as const,
        message: "Hardware virtualization is required.",
      }],
    };
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { preflight: failure },
    })) as typeof fetch;

    await expect(preflightInfrastructureConnection(CONNECTION_ID)).resolves.toEqual(failure);
  });

  it("returns sanitized read-only host discovery evidence", async () => {
    const observedAt = "2026-08-26T12:00:00.000Z";
    const discovery = {
      ok: true as const,
      snapshot: {
        discoveryId: "33333333-3333-4333-8333-333333333333",
        connectionId: CONNECTION_ID,
        connectionRevision: 1,
        connectionProvider: "host" as const,
        contractVersion: 1 as const,
        observedAt,
        expiresAt: "2026-08-26T12:15:00.000Z",
        hostIdentityDigest: "a".repeat(64),
        host: {
          os: { family: "linux" as const, id: "ubuntu", versionId: "24.04" },
          kernel: { release: "6.8.0", architecture: "amd64" as const },
          environment: {
            effectivePrivilege: "root" as const,
            virtualization: "virtual-machine" as const,
            cgroupVersion: 2 as const,
            packageManagers: ["apt" as const],
          },
          capacity: {
            cpu: { logicalCores: 4 },
            memoryBytes: { total: 8_000, available: 6_000 },
            rootStorageBytes: { total: 50_000, available: 40_000 },
          },
          kvm: { devicePresent: false, cpuVirtualization: false },
        },
        engines: [
          {
            id: "proxmox-kvm" as const,
            availability: "unavailable" as const,
            supported: false,
            detectedVersion: null,
            unmetRequirements: ["KVM_REQUIRED" as const, "ENGINE_NOT_INSTALLED" as const],
          },
          ...(["qemu-kvm", "gvisor", "docker", "containerd", "podman", "oci-runc", "oci-crun", "lxc"] as const).map((id) => ({
            id,
            availability: "installable" as const,
            supported: false,
            detectedVersion: null,
            unmetRequirements: ["ENGINE_NOT_INSTALLED" as const, "RUNTIME_ADAPTER_UNAVAILABLE" as const],
          })),
        ],
      },
    };
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { discovery },
    })) as typeof fetch;

    await expect(discoverInfrastructureHost(CONNECTION_ID)).resolves.toEqual(discovery);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/discover`,
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
  });

  it("prepares a host with an empty POST and validates the versioned receipt", async () => {
    const preflight = {
      ok: false as const,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      error: {
        code: "TEMPLATE_UNAVAILABLE" as const,
        message: "The template is not ready.",
      },
      unmetRequirements: [{
        code: "TEMPLATE_UNAVAILABLE" as const,
        message: "The template is not ready.",
      }],
    };
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: {
        preparation: {
          ok: true,
          connectionId: CONNECTION_ID,
          provisionerVersion: "2026.08.26.3",
          preflight,
        },
      },
    })) as typeof fetch;

    await expect(prepareInfrastructureConnection(CONNECTION_ID)).resolves.toEqual({
      ok: true,
      connectionId: CONNECTION_ID,
      provisionerVersion: "2026.08.26.3",
      preflight,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/prepare`,
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("preserves a stable preparation error code for recovery UI", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: false,
      error: "Simple mode is required.",
      code: "SIMPLE_MODE_REQUIRED",
    }, 409)) as typeof fetch;

    await expect(prepareInfrastructureConnection(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        status: 409,
        code: "SIMPLE_MODE_REQUIRED",
        message: "Simple mode is required.",
      }),
    );
  });

  it("uses a safe message when the service response is not a valid contract", async () => {
    global.fetch = jest.fn(() => jsonResponse({ success: true, data: {} })) as typeof fetch;

    await expect(listInfrastructureTargets()).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        name: "InfrastructureApiError",
        status: 200,
        message: "The infrastructure service returned an unexpected response. Refresh and try again.",
      }),
    );
  });

  it("carries Retry-After and the failure cause from a refused preparation", async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "690" }),
      json: jest.fn().mockResolvedValue({
        success: false,
        error: "This server was set up in the last 15 minutes. You can try again in 12 minutes.",
        code: "PREPARATION_RATE_LIMITED",
      }),
    } as unknown as Response)) as typeof fetch;

    await expect(prepareInfrastructureConnection(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        status: 429,
        code: "PREPARATION_RATE_LIMITED",
        retryAfterSeconds: 690,
      }),
    );

    global.fetch = jest.fn(() => jsonResponse({
      success: false,
      error: "Setup couldn't find active Proxmox storage for virtual machines.",
      code: "PREPARATION_FAILED",
      cause: "storage_unavailable",
    }, 502)) as typeof fetch;
    await expect(prepareInfrastructureConnection(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        retryAfterSeconds: null,
        detail: { cause: "storage_unavailable", stage: undefined },
      }),
    );
  });

  it("replaces a bare Too Many Requests with when to try again", async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "42" }),
      json: jest.fn().mockResolvedValue({ success: false, error: "Too Many Requests" }),
    } as unknown as Response)) as typeof fetch;

    await expect(discoverInfrastructureHost(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        status: 429,
        message: "Too many tries in a row. You can try again in 1 minute.",
        retryAfterSeconds: 42,
      }),
    );

    global.fetch = jest.fn(() => jsonResponse({ success: false, error: "Too Many Requests" }, 429)) as typeof fetch;
    await expect(discoverInfrastructureHost(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        message: "Too many tries in a row. Wait a minute, then try again.",
        retryAfterSeconds: null,
      }),
    );
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfterSeconds("120")).toBe(120);
    expect(parseRetryAfterSeconds("Wed, 24 Sep 2026 12:10:30 GMT", Date.parse("2026-09-24T12:00:00Z"))).toBe(630);
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("soon")).toBeNull();
  });

  it("reads back only the target a Linux Sandbox check or setup saved", async () => {
    global.fetch = jest.fn(() => jsonResponse({
      success: true,
      data: { target: { id: TARGET_ID.toUpperCase(), status: "ready", capabilities: { kind: "gvisor" } } },
    })) as typeof fetch;

    await expect(checkGvisorConnection(CONNECTION_ID)).resolves.toEqual({ targetId: TARGET_ID, ready: true });
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/gvisor/preflight`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );

    global.fetch = jest.fn(() => jsonResponse({
      success: false,
      error: "The pinned gVisor bundle could not be downloaded or verified.",
      code: "remote_failed",
      stage: "bundle-download",
    }, 502)) as typeof fetch;
    await expect(prepareGvisorConnection(CONNECTION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<InfrastructureApiError>>({
        code: "remote_failed",
        detail: { cause: undefined, stage: "bundle-download" },
      }),
    );
  });
});
