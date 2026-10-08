/** @jest-environment node */

jest.mock("server-only", () => ({}));

import {
  InfrastructureConnectionStoreError,
  type LoadedInfrastructureConnection,
} from "../connection-store";
import type { ProxmoxPreflightReport } from "../proxmox-preflight";
import {
  preflightInfrastructureConnection,
} from "../connection-preflight";
import { InfrastructureNetworkError } from "../connection-runtime";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
  PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS,
  portableHivraRequiredAssetsForProvisionerDirectory,
} from "../portable-provisioner-contract";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001035";
const CHECKED_AT = new Date("2026-08-25T17:00:00.000Z");

function connection(
  overrides: Partial<LoadedInfrastructureConnection> = {},
): LoadedInfrastructureConnection {
  return {
    id: CONNECTION_ID,
    name: "Personal Proxmox",
    provider: "proxmox",
    operatingMode: "self-managed",
    setupMode: "simple",
    status: "pending",
    endpoint: {
      sshHost: "pve.example.test",
      sshPort: 22,
      sshUser: "root",
      sshHostFingerprintSha256: "ab".repeat(32),
    },
    configuration: null,
    revision: 1,
    pendingBindingRebindFromRevision: null,
    credentials: { sshPrivateKey: "private-key" },
    lastCheckedAt: null,
    lastErrorCode: null,
    createdAt: CHECKED_AT.toISOString(),
    updatedAt: CHECKED_AT.toISOString(),
    ...overrides,
  };
}

function report(overrides: Partial<ProxmoxPreflightReport> = {}): ProxmoxPreflightReport {
  return {
    protocolVersion: 1,
    provider: "proxmox",
    connectionReady: true,
    launchReady: false,
    node: { id: "pve-01", proxmoxVersion: "pve-manager/8.4.1" },
    capabilities: {
      directRootAccess: true,
      kvmDevice: true,
      cpuVirtualization: true,
      supportedIsolationDrivers: ["proxmox-kvm"],
      bridges: ["vmbr0"],
      selectedBridge: "vmbr0",
      storage: [{
        id: "local-lvm",
        type: "lvmthin",
        content: ["images"],
        active: true,
        enabled: true,
        shared: false,
      }],
      selectedStorage: "local-lvm",
      preparedTarget: {
        configured: false,
        ready: false,
        template: null,
        provisioner: null,
        assets: [],
      },
    },
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.25 },
      memory: {
        totalBytes: 32_000,
        reportedFreeBytes: 24_000,
        reservedGuestBytes: 6_000,
        hostReserveBytes: 2_000,
        availableBytes: 24_000,
      },
      storage: { id: "local-lvm", totalBytes: 20_000, availableBytes: 15_000 },
      vmids: { start: 200, end: 399, availableCount: 200, firstAvailable: 200 },
    },
    unmetRequirements: [{
      code: "PROXMOX_PREPARED_TARGET_UNSPECIFIED",
      message: "No prepared-target template or assets were configured",
    }],
    ...overrides,
  };
}

function preparedAssets(unavailableId: string | null = null) {
  return PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    available: asset.id !== unavailableId,
  }));
}

function dependencies(preflightReport = report()) {
  return {
    loadConnection: jest.fn().mockResolvedValue(connection()),
    beginPreflight: jest.fn().mockResolvedValue(true),
    completePreflight: jest.fn().mockResolvedValue(true),
    invalidatePreflight: jest.fn().mockResolvedValue(true),
    resolveDestination: jest.fn().mockResolvedValue({
      hostname: "pve.example.test",
      address: "203.0.113.10",
      family: 4,
    }),
    runPreflight: jest.fn().mockResolvedValue({ ok: true, report: preflightReport }),
    executeHostScript: jest.fn(),
    now: () => CHECKED_AT,
    newRunId: () => "00000000-0000-4000-8000-000000000001",
  };
}

describe("preflightInfrastructureConnection", () => {
  it("returns measured target evidence while keeping an unprepared Simple target launch-blocked", async () => {
    const deps = dependencies();

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        externalId: "pve-01",
        launchReady: false,
        capacity: { cpu: { totalCores: 8, utilizationRatio: 0.25 } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(deps.beginPreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      CHECKED_AT.toISOString(),
    );
    expect(deps.runPreflight).toHaveBeenCalledWith({
      node: null,
      bridge: "hivra0",
      storage: null,
      vmidRange: { start: 200, end: 399 },
      preparedTarget: {
        templateVmid: null,
        templateExpectedName: null,
        provisioner: {
          directory: "/opt/hivra/provisioner",
          expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
          compatibleVersions: [...PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS],
          manifestFile: "BUNDLE.sha256",
        },
        requiredAssets: PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS.map((asset) => ({ ...asset })),
      },
    }, expect.any(Function));
    expect(deps.completePreflight).toHaveBeenLastCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "ready",
        lastErrorCode: null,
        target: expect.objectContaining({
          status: "unavailable",
          supportedIsolationDrivers: ["proxmox-kvm"],
          isolationClass: "hardware-vm",
          capabilities: expect.objectContaining({
            proxmoxVersion: "pve-manager/8.4.1",
            selectedBridge: "vmbr0",
            selectedStorage: "local-lvm",
          }),
        }),
      }),
    );
  });

  it("persists unavailable node evidence when reported CPU capacity is nonpositive", async () => {
    const unavailableCapacityReport = report({
      capacity: {
        ...report().capacity,
        cpu: { totalCores: null, utilizationRatio: 0 },
      },
      unmetRequirements: [{
        code: "PROXMOX_CPU_CAPACITY_UNAVAILABLE",
        message: "CPU capacity could not be read",
      }],
    });
    const deps = dependencies(unavailableCapacityReport);

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CAPACITY_UNAVAILABLE" },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "error",
        lastErrorCode: "CAPACITY_UNAVAILABLE",
        target: expect.objectContaining({
          status: "unavailable",
          capacity: expect.objectContaining({
            cpu: { totalCores: null, utilizationRatio: 0 },
          }),
        }),
      }),
    );
  });

  it("marks a verified Advanced prepared target launch-ready", async () => {
    const prepared = report({
      launchReady: true,
      capabilities: {
        ...report().capabilities,
        preparedTarget: {
          configured: true,
          ready: true,
          template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true },
          provisioner: { configured: true, ready: true, version: "2026.08.25+1" },
          assets: [],
        },
      },
      unmetRequirements: [],
    });
    const deps = dependencies(prepared);
    deps.loadConnection.mockResolvedValue(connection({
      setupMode: "advanced",
      configuration: {
        node: "pve-01",
        bridge: "vmbr0",
        storage: "local-lvm",
        template: { vmid: 9000 },
        provisioner: {
          directory: "/opt/hivra/provisioner",
          expectedVersion: "2026.08.25+1",
        },
        vmidRange: { start: 200, end: 399 },
      },
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        launchReady: true,
        capabilities: { runtimeCompatibility: null },
      },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ target: expect.objectContaining({ status: "ready" }) }),
    );
  });

  it.each([
    {
      evidenceFailure: "an invalid bundle manifest",
      provisionerReady: false,
      unavailableAssetId: null,
      issue: {
        code: "PROXMOX_PROVISIONER_MANIFEST_INVALID" as const,
        message: "The installed provisioner bundle failed checksum verification",
      },
    },
    {
      evidenceFailure: "a missing critical asset",
      provisionerReady: true,
      unavailableAssetId: "target-contract",
      issue: {
        code: "PROXMOX_REQUIRED_ASSET_MISSING" as const,
        message: "Required file is unavailable",
        subject: "target-contract",
      },
    },
  ])(
    "keeps exact-version Advanced compatibility null for $evidenceFailure",
    async ({ provisionerReady, unavailableAssetId, issue }) => {
      const prepared = report({
        launchReady: false,
        capabilities: {
          ...report().capabilities,
          preparedTarget: {
            configured: true,
            ready: false,
            template: null,
            provisioner: {
              configured: true,
              ready: provisionerReady,
              version: PORTABLE_HIVRA_PROVISIONER_VERSION,
            },
            assets: preparedAssets(unavailableAssetId),
          },
        },
        unmetRequirements: [issue],
      });
      const deps = dependencies(prepared);
      deps.loadConnection.mockResolvedValue(connection({
        setupMode: "advanced",
        configuration: {
          provisioner: {
            directory: "/srv/hivra/provisioner/",
            expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
          },
        },
      }));

      const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

      expect(deps.runPreflight).toHaveBeenCalledWith({
        node: null,
        bridge: null,
        storage: null,
        vmidRange: { start: 200, end: 399 },
        preparedTarget: {
          templateVmid: null,
          templateExpectedName: null,
          provisioner: {
            directory: "/srv/hivra/provisioner/",
            expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
            manifestFile: "BUNDLE.sha256",
          },
          requiredAssets: portableHivraRequiredAssetsForProvisionerDirectory(
            "/srv/hivra/provisioner/",
          ),
        },
      }, expect.any(Function));
      expect(result).toMatchObject({
        ok: true,
        target: {
          launchReady: false,
          capabilities: { runtimeCompatibility: null },
        },
      });
      expect(deps.completePreflight).toHaveBeenCalledWith(
        "user_1",
        CONNECTION_ID,
        1,
        "00000000-0000-4000-8000-000000000001",
        expect.objectContaining({
          target: expect.objectContaining({
            status: "unavailable",
            capabilities: expect.objectContaining({ runtimeCompatibility: null }),
          }),
        }),
      );
    },
  );

  it("derives Advanced compatibility only from complete exact vendored evidence", async () => {
    const prepared = report({
      launchReady: true,
      capabilities: {
        ...report().capabilities,
        preparedTarget: {
          configured: true,
          ready: true,
          template: null,
          provisioner: {
            configured: true,
            ready: true,
            version: PORTABLE_HIVRA_PROVISIONER_VERSION,
          },
          assets: preparedAssets(),
        },
      },
      unmetRequirements: [],
    });
    const deps = dependencies(prepared);
    deps.loadConnection.mockResolvedValue(connection({
      setupMode: "advanced",
      configuration: {
        provisioner: {
          directory: "/srv/hivra/provisioner",
          expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
        },
      },
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        launchReady: true,
        capabilities: {
          runtimeCompatibility: PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
        },
      },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        target: expect.objectContaining({
          status: "ready",
          capabilities: expect.objectContaining({
            runtimeCompatibility: PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
          }),
        }),
      }),
    );
  });

  it("marks the exact prepared Simple runtime launch-ready", async () => {
    const prepared = report({
      launchReady: true,
      capabilities: {
        ...report().capabilities,
        bridges: ["hivra0", "vmbr0"],
        selectedBridge: "hivra0",
        preparedTarget: {
          configured: true,
          ready: true,
          template: null,
          provisioner: {
            configured: true,
            ready: true,
            version: PORTABLE_HIVRA_PROVISIONER_VERSION,
          },
          assets: preparedAssets(),
        },
      },
      unmetRequirements: [],
    });
    const deps = dependencies(prepared);

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        launchReady: true,
        capabilities: {
          provisioner: {
            ready: true,
            version: PORTABLE_HIVRA_PROVISIONER_VERSION,
          },
          runtimeCompatibility: PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
        },
      },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "ready",
        target: expect.objectContaining({
          status: "ready",
          capabilities: expect.objectContaining({
            selectedBridge: "hivra0",
            provisioner: expect.objectContaining({
              ready: true,
              version: PORTABLE_HIVRA_PROVISIONER_VERSION,
            }),
            runtimeCompatibility: PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
          }),
        }),
      }),
    );
  });

  it("blocks an expected provisioner version until that version is actually verified", async () => {
    const prepared = report({
      launchReady: true,
      capabilities: {
        ...report().capabilities,
        preparedTarget: {
          configured: true,
          ready: false,
          template: null,
          provisioner: { configured: true, ready: false, version: "2026.08.24+9" },
          assets: [],
        },
      },
      unmetRequirements: [],
    });
    const deps = dependencies(prepared);
    deps.loadConnection.mockResolvedValue(connection({
      setupMode: "advanced",
      configuration: {
        provisioner: {
          directory: "/opt/hivra/provisioner",
          expectedVersion: "2026.08.25+1",
        },
      },
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        launchReady: false,
        capabilities: { provisioner: { ready: false, version: "2026.08.24+9" } },
      },
    });
    if (result.ok) {
      expect(result.target.launchReady).toBe(false);
    }
  });

  it("passes every saved Advanced override into the portable preflight contract", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue(connection({
      setupMode: "advanced",
      configuration: {
        node: "n".repeat(64),
        bridge: "vmbr0",
        storage: "9storage",
        template: { vmid: 9000, expectedName: "hivra-base-v1" },
        provisioner: {
          directory: "/opt/hivra/provisioner/",
          expectedVersion: "2026.08.25+1",
        },
        vmidRange: { start: 1000, end: 1099 },
      },
    }));

    await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(deps.runPreflight).toHaveBeenCalledWith({
      node: "n".repeat(64),
      bridge: "vmbr0",
      storage: "9storage",
      vmidRange: { start: 1000, end: 1099 },
      preparedTarget: {
        templateVmid: 9000,
        templateExpectedName: "hivra-base-v1",
        provisioner: {
          directory: "/opt/hivra/provisioner/",
          expectedVersion: "2026.08.25+1",
        },
        requiredAssets: [],
      },
    }, expect.any(Function));
  });

  it("maps unsupported Proxmox evidence to the supported public error code", async () => {
    const deps = dependencies(report({
      connectionReady: false,
      launchReady: false,
      node: { id: "pve-01", proxmoxVersion: "pve-manager/1.0" },
      unmetRequirements: [{
        code: "PROXMOX_VERSION_UNSUPPORTED",
        message: "The detected Proxmox version is not supported",
      }],
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROXMOX_VERSION_UNSUPPORTED" },
    });
  });

  it("rejects an explicitly superseded caller revision before claiming a preflight run", async () => {
    const deps = dependencies();

    const result = await preflightInfrastructureConnection(
      "user_1",
      CONNECTION_ID,
      deps,
      99,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "PREFLIGHT_SUPERSEDED" } });
    expect(deps.beginPreflight).not.toHaveBeenCalled();
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.runPreflight).not.toHaveBeenCalled();
  });

  it("tells a non-root Proxmox login that launches need root while the sudo gate is off", async () => {
    const deps = dependencies(report({
      connectionReady: false,
      capabilities: { ...report().capabilities, directRootAccess: false },
      unmetRequirements: [{
        code: "PROXMOX_ROOT_PERMISSION_REQUIRED",
        message: "The SSH account must have effective UID 0 for direct Proxmox lifecycle commands",
      }],
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.remediation).toBe(
      "Proxmox launches need a root login for now. Edit the connection, set the SSH user to root, then check again.",
    );
  });

  it("refuses a sudo Proxmox connection before any SSH while the T43 gate is off", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue(connection({
      endpoint: { ...connection().endpoint!, sshUser: "hivra", sshPrivilege: "sudo" },
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PROXMOX_PERMISSION_UNAVAILABLE" } });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.remediation).toMatch(/^Proxmox launches need a root login for now\./);
    expect(deps.beginPreflight).not.toHaveBeenCalled();
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.runPreflight).not.toHaveBeenCalled();
  });

  it("maps a non-root SSH account to the stable permission error", async () => {
    const deps = dependencies(report({
      connectionReady: false,
      launchReady: false,
      capabilities: {
        ...report().capabilities,
        directRootAccess: false,
      },
      unmetRequirements: [{
        code: "PROXMOX_ROOT_PERMISSION_REQUIRED",
        message: "The SSH account must have effective UID 0 for direct Proxmox lifecycle commands",
      }],
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROXMOX_PERMISSION_UNAVAILABLE" },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "error",
        lastErrorCode: "PROXMOX_PERMISSION_UNAVAILABLE",
        target: expect.objectContaining({
          status: "unavailable",
          supportedIsolationDrivers: [],
          isolationClass: null,
          capabilities: expect.objectContaining({
            directRootAccess: false,
            kvmAvailable: true,
            launchReady: false,
          }),
        }),
      }),
    );
  });

  it("maps exhausted memory to capacity evidence instead of an internal error", async () => {
    const deps = dependencies(report({
      launchReady: false,
      capacity: {
        ...report().capacity,
        memory: {
          totalBytes: 32_000,
          reportedFreeBytes: 24_000,
          reservedGuestBytes: 32_000,
          hostReserveBytes: 2_000,
          availableBytes: 0,
        },
      },
      unmetRequirements: [{
        code: "PROXMOX_MEMORY_CAPACITY_EXHAUSTED",
        message: "No memory capacity is currently available",
      }],
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: true, target: { launchReady: false } });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        target: expect.objectContaining({ lastErrorCode: "CAPACITY_UNAVAILABLE" }),
      }),
    );
  });

  it("returns a stable blocked-address failure without attempting SSH", async () => {
    const deps = dependencies();
    deps.resolveDestination.mockRejectedValue(
      new InfrastructureNetworkError("ssh_host_forbidden", "raw destination detail"),
    );

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HOST_ADDRESS_BLOCKED" },
    });
    expect(deps.runPreflight).not.toHaveBeenCalled();
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "error",
        lastErrorCode: "HOST_ADDRESS_BLOCKED",
        target: null,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("raw destination detail");
  });

  it("maps raw SSH failures to stable public codes without leaking transport details", async () => {
    const deps = dependencies();
    deps.runPreflight.mockImplementation(async (_input, executor) => {
      await executor("read-only-script");
      return {
        ok: false,
        code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
        message: "safe failure",
      };
    });
    deps.executeHostScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "All configured authentication methods failed: SECRET_DETAIL",
    });

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SSH_AUTHENTICATION_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_DETAIL");
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        lastErrorCode: "SSH_AUTHENTICATION_FAILED",
        target: null,
      }),
    );
  });

  it("classifies a bounded-output termination as a command failure", async () => {
    const deps = dependencies();
    deps.runPreflight.mockImplementation(async (_input, executor) => {
      await executor("read-only-script");
      return {
        ok: false,
        code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
        message: "safe failure",
      };
    });
    deps.executeHostScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "Proxmox host script output exceeded 1310720 bytes",
    });

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SSH_COMMAND_FAILED" },
    });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ lastErrorCode: "SSH_COMMAND_FAILED", target: null }),
    );
  });

  it("does not run SSH when the loaded revision cannot claim the preflight lease", async () => {
    const deps = dependencies();
    deps.beginPreflight.mockResolvedValue(false);

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREFLIGHT_SUPERSEDED" } });
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.runPreflight).not.toHaveBeenCalled();
    expect(deps.completePreflight).not.toHaveBeenCalled();
  });

  it("rejects an older completion after PATCH or a newer preflight replaces its run lease", async () => {
    const deps = dependencies();
    deps.completePreflight.mockResolvedValue(false);

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREFLIGHT_SUPERSEDED" } });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.any(Object),
    );
  });

  it("invalidates prior target evidence when stored credentials cannot be decrypted", async () => {
    const deps = dependencies();
    deps.loadConnection.mockRejectedValue(
      new InfrastructureConnectionStoreError("credential_error", 9),
    );

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_CONNECTION" } });
    expect(deps.invalidatePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      9,
      CHECKED_AT.toISOString(),
      "INVALID_CONNECTION",
    );
    expect(deps.beginPreflight).not.toHaveBeenCalled();
  });

  it("persists validated unavailable evidence without claiming isolation when KVM proof fails", async () => {
    const failedKvm = report({
      connectionReady: false,
      launchReady: false,
      capabilities: {
        ...report().capabilities,
        kvmDevice: false,
        supportedIsolationDrivers: [],
      },
      unmetRequirements: [{
        code: "PROXMOX_KVM_UNAVAILABLE",
        message: "KVM is unavailable",
      }],
    });
    const deps = dependencies(failedKvm);

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "KVM_UNAVAILABLE" } });
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      1,
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        connectionStatus: "error",
        lastErrorCode: "KVM_UNAVAILABLE",
        target: expect.objectContaining({
          status: "unavailable",
          supportedIsolationDrivers: [],
          isolationClass: null,
          lastErrorCode: "KVM_UNAVAILABLE",
          capacity: {
            cpu: { totalCores: 8, utilizationRatio: 0.25 },
            memoryBytes: { total: 32_000, available: 24_000 },
            storageBytes: { total: 20_000, available: 15_000 },
          },
          capabilities: expect.objectContaining({
            proxmoxVersion: "pve-manager/8.4.1",
            kvmAvailable: false,
            launchReady: false,
            selectedBridge: "vmbr0",
            selectedStorage: "local-lvm",
          }),
        }),
      }),
    );
  });

  // INF-13: fix text used to send every owner to an "Advanced mode" that new
  // hosts can't open, and hosted owners to self-hosted server logs.
  it.each([
    ["BRIDGE_UNAVAILABLE", "PROXMOX_BRIDGE_NOT_FOUND", /Review setup/],
    ["STORAGE_UNAVAILABLE", "PROXMOX_STORAGE_NOT_VM_CAPABLE", /Datacenter → Storage/],
    ["VMID_RANGE_UNAVAILABLE", "PROXMOX_VMID_RANGE_EXHAUSTED", /Remove VMs you no longer need/],
    ["TEMPLATE_UNAVAILABLE", "PROXMOX_TEMPLATE_NOT_TEMPLATE", /Convert to template/],
  ])("gives %s real steps instead of Advanced mode", async (code, issue, steps) => {
    const deps = dependencies(report({
      connectionReady: false,
      unmetRequirements: [{ code: issue as ProxmoxPreflightReport["unmetRequirements"][number]["code"], message: "Detected issue" }],
    }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code } });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.remediation).toMatch(steps);
    expect(result.error.remediation).not.toMatch(/Advanced mode/);
  });

  it("points a custom Advanced connection at its own bridge instead of Review setup", async () => {
    const deps = dependencies(report({
      connectionReady: false,
      unmetRequirements: [{ code: "PROXMOX_BRIDGE_NOT_FOUND", message: "Bridge vmbr9 was not found" }],
    }));
    deps.loadConnection.mockResolvedValue(connection({ setupMode: "advanced", configuration: { bridge: "vmbr9" } }));

    const result = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.remediation).toMatch(/Create the bridge this connection names/);
    expect(result.error.remediation).not.toMatch(/Review setup/);
  });

  it.each([
    [undefined, /contact support/, /server's logs|private networks/],
    ["local", /check your Hivra server's logs/, /contact support/],
  ])("words internal and address fixes for how Hivra is run (auth mode %s)", async (mode, expected, absent) => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    const previousServer = process.env.HIVRA_AUTH_MODE;
    delete process.env.HIVRA_AUTH_MODE;
    if (mode) process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = mode;
    else delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    try {
      const deps = dependencies();
      deps.runPreflight.mockRejectedValue(new Error("unexpected"));
      const internal = await preflightInfrastructureConnection("user_1", CONNECTION_ID, deps);
      if (internal.ok) throw new Error("expected a failure");
      expect(internal.error.code).toBe("PREFLIGHT_INTERNAL_ERROR");
      expect(internal.error.remediation).toMatch(expected);
      expect(internal.error.remediation).not.toMatch(absent);

      const blockedDeps = dependencies();
      blockedDeps.resolveDestination.mockRejectedValue(new InfrastructureNetworkError("ssh_host_forbidden", "raw"));
      const blocked = await preflightInfrastructureConnection("user_1", CONNECTION_ID, blockedDeps);
      if (blocked.ok) throw new Error("expected a failure");
      expect(blocked.error.remediation).toMatch(mode ? /self-hosted Hivra/ : /Hosted Hivra can't reach home or office networks/);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previous;
      if (previousServer !== undefined) process.env.HIVRA_AUTH_MODE = previousServer;
    }
  });
});
