/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { spawnSync } from "node:child_process";

import type { LoadedInfrastructureConnection } from "../connection-store";
import {
  buildReadOnlyHostDiscoveryScript,
  discoverInfrastructureHost,
  parseHostDiscoveryOutput,
} from "../host-discovery";
import {
  HOST_DISCOVERY_PROTOCOL,
  MAX_HOST_DISCOVERY_OUTPUT_BYTES,
} from "../host-discovery-contracts";

const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-26T12:00:00.000Z");

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function protocolOutput(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    PROTOCOL: "1",
    OS_FAMILY: "linux",
    OS_ID_B64: b64("debian"),
    OS_VERSION_ID_B64: b64("12"),
    KERNEL_RELEASE_B64: b64("6.8.0-1-amd64"),
    ARCH_B64: b64("x86_64"),
    EUID: "0",
    VIRTUALIZATION: "bare-metal",
    CGROUP_VERSION: "2",
    CPU_LOGICAL_CORES: "16",
    MEMORY_TOTAL_BYTES: "34359738368",
    MEMORY_AVAILABLE_BYTES: "25769803776",
    ROOT_STORAGE_TOTAL_BYTES: "1099511627776",
    ROOT_STORAGE_AVAILABLE_BYTES: "824633720832",
    KVM_DEVICE: "1",
    CPU_VIRTUALIZATION: "1",
    PACKAGE_MANAGERS: "apt",
    MACHINE_ID_DIGEST: "c".repeat(64),
    PROXMOX_KVM_INSTALLED: "1",
    PROXMOX_KVM_VERSION_B64: b64("pve-manager/8.4.1/2a5fa54a8503f96d"),
    QEMU_KVM_INSTALLED: "1",
    QEMU_KVM_VERSION_B64: b64("QEMU emulator version 9.2.0"),
    GVISOR_INSTALLED: "0",
    GVISOR_VERSION_B64: "",
    DOCKER_INSTALLED: "1",
    DOCKER_VERSION_B64: b64("Docker version 27.5.1"),
    CONTAINERD_INSTALLED: "1",
    CONTAINERD_VERSION_B64: b64("containerd 2.0.2"),
    PODMAN_INSTALLED: "0",
    PODMAN_VERSION_B64: "",
    OCI_RUNC_INSTALLED: "1",
    OCI_RUNC_VERSION_B64: b64("runc version 1.2.4"),
    OCI_CRUN_INSTALLED: "0",
    OCI_CRUN_VERSION_B64: "",
    LXC_INSTALLED: "1",
    LXC_VERSION_B64: b64("6.0.0"),
    END: "1",
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${HOST_DISCOVERY_PROTOCOL}\t${key}\t${value}`)
    .join("\n");
}

function connection(
  overrides: Partial<LoadedInfrastructureConnection> = {},
): LoadedInfrastructureConnection {
  return {
    id: CONNECTION_ID,
    name: "My host",
    provider: "host",
    operatingMode: "self-managed",
    setupMode: "simple",
    status: "pending",
    endpoint: {
      sshHost: "host.example.test",
      sshPort: 22,
      sshUser: "root",
      sshHostFingerprintSha256: "ab".repeat(32),
    },
    configuration: null,
    revision: 3,
    pendingBindingRebindFromRevision: null,
    credentials: { sshPrivateKey: "secret-private-key" },
    lastCheckedAt: null,
    lastErrorCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function dependencies() {
  return {
    loadConnection: jest.fn().mockResolvedValue(connection()),
    beginDiscovery: jest.fn().mockResolvedValue(true),
    completeDiscovery: jest.fn().mockResolvedValue(true),
    releaseDiscovery: jest.fn().mockResolvedValue(true),
    resolveDestination: jest.fn().mockResolvedValue({
      hostname: "host.example.test",
      address: "203.0.113.20",
      family: 4,
    }),
    executeHostScript: jest.fn().mockResolvedValue({
      ok: true,
      stdout: protocolOutput(),
      stderr: "",
    }),
    now: () => NOW,
    newRunId: () => RUN_ID,
  };
}

describe("read-only host discovery", () => {
  it("builds a bounded probe with no install, service, package, or filesystem mutation", () => {
    const script = buildReadOnlyHostDiscoveryScript(CONNECTION_ID);

    expect(script).toContain("/etc/os-release");
    expect(script).toContain("/proc/meminfo");
    expect(script).toContain("/dev/kvm");
    expect(script).toContain("sha256sum");
    expect(script).not.toMatch(/\b(?:sudo|apt-get\s+install|dnf\s+install|yum\s+install|apk\s+add|systemctl|service|mkdir|mktemp|touch|rm|mv|cp|tee)\b/);
    expect(script).not.toContain("source /etc/os-release");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  it("parses sanitized capability evidence and distinguishes installed, installable, and supported", () => {
    const snapshot = parseHostDiscoveryOutput({
      output: protocolOutput(),
      discoveryId: RUN_ID,
      connectionId: CONNECTION_ID,
      connectionRevision: 3,
      connectionProvider: "host",
      normalizedHostFingerprint: "ab".repeat(32),
      observedAt: NOW,
    });

    expect(snapshot).toMatchObject({
      connectionProvider: "host",
      host: {
        kernel: { architecture: "amd64" },
        environment: { effectivePrivilege: "root", packageManagers: ["apt"] },
        kvm: { devicePresent: true, cpuVirtualization: true },
      },
    });
    expect(snapshot.engines.find((engine) => engine.id === "proxmox-kvm")).toMatchObject({
      availability: "installed",
      supported: true,
    });
    expect(snapshot.engines.find((engine) => engine.id === "gvisor")).toMatchObject({
      availability: "installable",
      supported: false,
      unmetRequirements: expect.arrayContaining(["ENGINE_NOT_INSTALLED", "SUPPORTED_OS_REQUIRED"]),
    });
    expect(snapshot.engines.find((engine) => engine.id === "docker")).toMatchObject({
      availability: "installed",
      supported: false,
      unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("machine-id");
    expect(JSON.stringify(snapshot)).not.toContain("launchReady");
  });

  it("recognizes installed gVisor on its supported Ubuntu cgroup-v2 host without claiming a launch target", () => {
    const snapshot = parseHostDiscoveryOutput({
      output: protocolOutput({ OS_ID_B64: b64("ubuntu"), OS_VERSION_ID_B64: b64("24.04"),
        GVISOR_INSTALLED: "1", GVISOR_VERSION_B64: b64("runsc version release-20260914.0") }),
      discoveryId: RUN_ID, connectionId: CONNECTION_ID, connectionRevision: 3,
      connectionProvider: "host", normalizedHostFingerprint: "ab".repeat(32), observedAt: NOW,
    });
    expect(snapshot.engines.find(engine => engine.id === "gvisor")).toMatchObject({
      availability: "installed", supported: true, unmetRequirements: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("launchReady");
  });

  it("offers supported gVisor preparation on an eligible Ubuntu host before runsc or Docker is installed", () => {
    const snapshot = parseHostDiscoveryOutput({
      output: protocolOutput({
        OS_ID_B64: b64("ubuntu"),
        OS_VERSION_ID_B64: b64("22.04"),
        GVISOR_INSTALLED: "0",
        GVISOR_VERSION_B64: "",
        DOCKER_INSTALLED: "0",
        DOCKER_VERSION_B64: "",
      }),
      discoveryId: RUN_ID,
      connectionId: CONNECTION_ID,
      connectionRevision: 3,
      connectionProvider: "host",
      normalizedHostFingerprint: "ab".repeat(32),
      observedAt: NOW,
    });

    expect(snapshot.engines.find(engine => engine.id === "gvisor")).toMatchObject({
      availability: "installable",
      supported: true,
      detectedVersion: null,
      unmetRequirements: expect.arrayContaining(["ENGINE_NOT_INSTALLED", "DOCKER_REQUIRED"]),
    });
  });

  it.each([
    ["20.04", "unsupported Ubuntu version"],
    ["25.04", "unapproved Ubuntu version"],
  ])("does not offer gVisor preparation for %s (%s)", (versionId) => {
    const snapshot = parseHostDiscoveryOutput({
      output: protocolOutput({
        OS_ID_B64: b64("ubuntu"),
        OS_VERSION_ID_B64: b64(versionId),
        GVISOR_INSTALLED: "0",
        GVISOR_VERSION_B64: "",
      }),
      discoveryId: RUN_ID,
      connectionId: CONNECTION_ID,
      connectionRevision: 3,
      connectionProvider: "host",
      normalizedHostFingerprint: "ab".repeat(32),
      observedAt: NOW,
    });

    expect(snapshot.engines.find(engine => engine.id === "gvisor")).toMatchObject({
      supported: false,
      unmetRequirements: expect.arrayContaining(["SUPPORTED_OS_REQUIRED"]),
    });
  });

  it("rejects duplicate, noncanonical, and oversized protocol evidence", () => {
    const input = {
      discoveryId: RUN_ID,
      connectionId: CONNECTION_ID,
      connectionRevision: 3,
      connectionProvider: "host" as const,
      normalizedHostFingerprint: "ab".repeat(32),
      observedAt: NOW,
    };
    expect(() => parseHostDiscoveryOutput({
      ...input,
      output: `${protocolOutput()}\n${HOST_DISCOVERY_PROTOCOL}\tEND\t1`,
    })).toThrow();
    expect(() => parseHostDiscoveryOutput({
      ...input,
      output: protocolOutput({ OS_ID_B64: "ZGViaWFu==" }),
    })).toThrow();
    expect(() => parseHostDiscoveryOutput({
      ...input,
      output: `${protocolOutput()}${"x".repeat(MAX_HOST_DISCOVERY_OUTPUT_BYTES)}`,
    })).toThrow();
  });

  it("persists one immutable revision-bound snapshot without target authority", async () => {
    const deps = dependencies();

    const result = await discoverInfrastructureHost("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: true, snapshot: { connectionRevision: 3 } });
    expect(deps.beginDiscovery).toHaveBeenCalledWith({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 3,
      runId: RUN_ID,
    });
    expect(deps.executeHostScript).toHaveBeenCalledWith(
      expect.stringContaining(HOST_DISCOVERY_PROTOCOL),
      expect.objectContaining({
        PROXMOX_SSH_HOST: "203.0.113.20",
        PROXMOX_SSH_HOST_FINGERPRINT: "ab".repeat(32),
        PROXMOX_ALLOW_SSH_AGENT: "false",
      }),
      { timeoutMs: 30_000, maxOutputBytes: MAX_HOST_DISCOVERY_OUTPUT_BYTES },
    );
    expect(deps.completeDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 3,
      runId: RUN_ID,
      snapshot: expect.objectContaining({ connectionProvider: "host" }),
    }));
    expect(deps.releaseDiscovery).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-private-key");
  });

  it("fails closed before DNS or SSH when no pinned fingerprint exists", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue(connection({
      endpoint: { ...connection().endpoint, sshHostFingerprintSha256: "" },
    }));

    const result = await discoverInfrastructureHost("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_CONNECTION" } });
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.beginDiscovery).not.toHaveBeenCalled();
    expect(deps.executeHostScript).not.toHaveBeenCalled();
  });

  it("releases the exact lease and never returns raw transport output", async () => {
    const deps = dependencies();
    deps.executeHostScript.mockResolvedValue({
      ok: false,
      stdout: "secret-private-key",
      stderr: "Permission denied (publickey): secret-private-key",
      error: "Permission denied (publickey)",
    });

    const result = await discoverInfrastructureHost("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "SSH_AUTHENTICATION_FAILED" } });
    expect(JSON.stringify(result)).not.toContain("secret-private-key");
    expect(deps.releaseDiscovery).toHaveBeenCalledWith({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 3,
      runId: RUN_ID,
    });
  });

  it("rejects stale completion and releases only its own revision lease", async () => {
    const deps = dependencies();
    deps.completeDiscovery.mockResolvedValue(false);

    const result = await discoverInfrastructureHost("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "DISCOVERY_SUPERSEDED" } });
    expect(deps.releaseDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 3,
      runId: RUN_ID,
    }));
  });
});
