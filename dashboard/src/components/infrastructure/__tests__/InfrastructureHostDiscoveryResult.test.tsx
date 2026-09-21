/** @jest-environment jsdom */

jest.mock("server-only", () => ({}));

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  HostDiscoveryEngine,
  HostDiscoveryResult,
} from "@/lib/infrastructure/host-discovery-contracts";
import { parseHostDiscoveryOutput } from "@/lib/infrastructure/host-discovery";
import { HOST_DISCOVERY_PROTOCOL } from "@/lib/infrastructure/host-discovery-contracts";
import { InfrastructureHostDiscoveryResult } from "../InfrastructureHostDiscoveryResult";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function discoveredUbuntuGvisor(installed = false): HostDiscoveryResult {
  const values: Record<string, string> = {
    PROTOCOL: "1", OS_FAMILY: "linux", OS_ID_B64: b64("ubuntu"),
    OS_VERSION_ID_B64: b64("22.04"), KERNEL_RELEASE_B64: b64("6.8.0-79-generic"),
    ARCH_B64: b64("x86_64"), EUID: "0", VIRTUALIZATION: "virtual-machine",
    CGROUP_VERSION: "2", CPU_LOGICAL_CORES: "4", MEMORY_TOTAL_BYTES: "8321499136",
    MEMORY_AVAILABLE_BYTES: "6543114240", ROOT_STORAGE_TOTAL_BYTES: "68719476736",
    ROOT_STORAGE_AVAILABLE_BYTES: "51539607552", KVM_DEVICE: "0", CPU_VIRTUALIZATION: "1",
    PACKAGE_MANAGERS: "apt", MACHINE_ID_DIGEST: "c".repeat(64),
    PROXMOX_KVM_INSTALLED: "0", PROXMOX_KVM_VERSION_B64: "",
    QEMU_KVM_INSTALLED: "1", QEMU_KVM_VERSION_B64: b64("QEMU emulator version 6.2.0"),
    GVISOR_INSTALLED: installed ? "1" : "0",
    GVISOR_VERSION_B64: installed ? b64("runsc version release-20260907.0") : "",
    DOCKER_INSTALLED: installed ? "1" : "0",
    DOCKER_VERSION_B64: installed ? b64("Docker version 29.1.3") : "",
    CONTAINERD_INSTALLED: "0", CONTAINERD_VERSION_B64: "",
    PODMAN_INSTALLED: "0", PODMAN_VERSION_B64: "", OCI_RUNC_INSTALLED: "1",
    OCI_RUNC_VERSION_B64: b64("runc version 1.1.12"), OCI_CRUN_INSTALLED: "0",
    OCI_CRUN_VERSION_B64: "", LXC_INSTALLED: "0", LXC_VERSION_B64: "", END: "1",
  };
  const output = Object.entries(values)
    .map(([key, value]) => `${HOST_DISCOVERY_PROTOCOL}\t${key}\t${value}`)
    .join("\n");
  return {
    ok: true,
    snapshot: parseHostDiscoveryOutput({
      output,
      discoveryId: "22222222-2222-4222-8222-222222222222",
      connectionId: CONNECTION_ID,
      connectionRevision: 2,
      connectionProvider: "host",
      normalizedHostFingerprint: "ab".repeat(32),
      observedAt: new Date("2026-08-26T12:00:00.000Z"),
    }),
  };
}

function engines(proxmox: Partial<HostDiscoveryEngine>): HostDiscoveryEngine[] {
  const ids: HostDiscoveryEngine["id"][] = [
    "proxmox-kvm",
    "qemu-kvm",
    "gvisor",
    "docker",
    "containerd",
    "podman",
    "oci-runc",
    "oci-crun",
    "lxc",
  ];
  return ids.map((id) => id === "proxmox-kvm"
    ? {
        id,
        availability: "installed",
        supported: true,
        detectedVersion: "pve-manager/8.4.1",
        unmetRequirements: [],
        ...proxmox,
      }
    : {
        id,
        availability: "unavailable",
        supported: false,
        detectedVersion: null,
        unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"],
      });
}

function discovery(proxmox: Partial<HostDiscoveryEngine> = {}): HostDiscoveryResult {
  return {
    ok: true,
    snapshot: {
      discoveryId: "22222222-2222-4222-8222-222222222222",
      connectionId: CONNECTION_ID,
      connectionRevision: 2,
      connectionProvider: "host",
      contractVersion: 1,
      observedAt: "2026-08-26T12:00:00.000Z",
      expiresAt: "2026-08-26T12:15:00.000Z",
      hostIdentityDigest: "a".repeat(64),
      host: {
        os: { family: "linux", id: "debian", versionId: "12" },
        kernel: { release: "6.8.12", architecture: "amd64" },
        environment: {
          effectivePrivilege: "root",
          virtualization: "bare-metal",
          cgroupVersion: 2,
          packageManagers: ["apt"],
        },
        capacity: {
          cpu: { logicalCores: 16 },
          memoryBytes: { total: 64 * 1024 ** 3, available: 48 * 1024 ** 3 },
          rootStorageBytes: { total: 2_000 * 1024 ** 3, available: 1_500 * 1024 ** 3 },
        },
        kvm: { devicePresent: true, cpuVirtualization: true },
      },
      engines: engines(proxmox),
    },
  };
}

describe("InfrastructureHostDiscoveryResult", () => {
  afterEach(() => { jest.restoreAllMocks(); delete (global as { fetch?: unknown }).fetch; });
  it("shows detected host facts and offers strict readiness only for supported installed Proxmox", () => {
    const onStrictPreflightRequested = jest.fn();
    render(
      <InfrastructureHostDiscoveryResult
        result={discovery()}
        onRetry={jest.fn()}
        onDone={jest.fn()}
        onStrictPreflightRequested={onStrictPreflightRequested}
      />,
    );

    const heading = screen.getByRole("heading", { name: "A supported isolation engine is installed." });
    expect(heading).toHaveFocus();
    expect(screen.getByText("Debian 12")).toBeInTheDocument();
    expect(screen.getByText("Bare metal")).toBeInTheDocument();
    expect(screen.getByText("16 logical cores")).toBeInTheDocument();
    expect(screen.getByText("Use Proxmox KVM")).toBeInTheDocument();
    expect(screen.getByText(/Proxmox is the installed management layer/i)).toBeInTheDocument();
    expect(screen.getByText(/does not mean dedicated physical hardware/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    expect(onStrictPreflightRequested).toHaveBeenCalledTimes(1);
  });

  it("prefers the supported gVisor path and prepares only after the explicit action", async () => {
    const result = discoveredUbuntuGvisor();

    render(
      <InfrastructureHostDiscoveryResult
        result={result}
        connectionId={CONNECTION_ID}
        onRetry={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    Object.defineProperty(global, "fetch", { value: fetchMock, configurable: true });
    expect(screen.getByRole("heading", { name: "A supported Linux sandbox path is available." })).toBeInTheDocument();
    expect(screen.getByText(/non-root Linux terminal and Python application workspaces/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare gVisor" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/gvisor/prepare`, expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText(/pinned runtime, application adapter, and exact host evidence passed/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Proxmox readiness" })).not.toBeInTheDocument();
  });

  it("checks installed gVisor readiness without reinstalling and keeps repair explicit", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    Object.defineProperty(global, "fetch", { value: fetchMock, configurable: true });
    render(
      <InfrastructureHostDiscoveryResult
        result={discoveredUbuntuGvisor(true)}
        connectionId={CONNECTION_ID}
        onRetry={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    expect(screen.getByText("Check the gVisor sandbox runtime")).toBeInTheDocument();
    expect(screen.getByText(/without reinstalling them/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair gVisor" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check gVisor readiness" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/gvisor/preflight`, expect.objectContaining({ method: "POST" }),
    ));
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/infrastructure/connections/${CONNECTION_ID}/gvisor/prepare`, expect.anything(),
    );
    expect(await screen.findByText(/passed strict readiness/i)).toBeInTheDocument();
  });

  it("explains why a Linux VM without nested KVM cannot become a Proxmox hardware-VM host", () => {
    const result = discovery({
      availability: "unavailable",
      supported: false,
      detectedVersion: null,
      unmetRequirements: ["KVM_REQUIRED"],
    });
    if (!result.ok) throw new Error("Expected successful discovery fixture");
    result.snapshot.host.environment.virtualization = "virtual-machine";
    result.snapshot.host.kvm = { devicePresent: false, cpuVirtualization: false };

    render(
      <InfrastructureHostDiscoveryResult
        result={result}
        onRetry={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    expect(screen.getByText("Nested KVM is not available on this virtual machine")).toBeInTheDocument();
    expect(screen.getByText(/cannot run Proxmox KVM hardware VMs here/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Proxmox readiness" })).not.toBeInTheDocument();
  });

  it("keeps an installable plain host non-mutating when no supported preparation exists", () => {
    render(
      <InfrastructureHostDiscoveryResult
        result={discovery({
          availability: "installable",
          supported: false,
          detectedVersion: null,
          unmetRequirements: ["ENGINE_NOT_INSTALLED"],
        })}
        onRetry={jest.fn()}
        onDone={jest.fn()}
        onStrictPreflightRequested={jest.fn()}
      />,
    );

    expect(screen.getByRole("heading", {
      name: "Host detected. Preparation is not supported yet.",
    })).toBeInTheDocument();
    expect(screen.getByText("Proxmox KVM could be installed, but is not supported by this flow yet")).toBeInTheDocument();
    expect(screen.getByText("Isolation compatibility")).toBeInTheDocument();
    expect(screen.queryByText("Recommended isolation")).not.toBeInTheDocument();
    expect(screen.getByText(/automatic installation is not supported/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Proxmox readiness" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it.each(["qemu-kvm", "docker"] as const)(
    "labels unsupported installed %s as detected capability rather than a recommendation",
    (engineId) => {
      const result = discovery({
        availability: "unavailable",
        supported: false,
        detectedVersion: null,
        unmetRequirements: ["ENGINE_NOT_INSTALLED"],
      });
      if (!result.ok) throw new Error("Expected successful discovery fixture");
      result.snapshot.engines = result.snapshot.engines.map((engine) => engine.id === engineId
        ? {
            ...engine,
            availability: "installed",
            supported: false,
            detectedVersion: "test-version",
            unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"],
          }
        : engine);

      render(
        <InfrastructureHostDiscoveryResult
          result={result}
          onRetry={jest.fn()}
          onDone={jest.fn()}
          onStrictPreflightRequested={jest.fn()}
        />,
      );

      expect(screen.getByText(/detected, but not supported yet/i)).toBeInTheDocument();
      expect(screen.getByText(/not a Hivra recommendation/i)).toBeInTheDocument();
      expect(screen.getByText("Isolation compatibility")).toBeInTheDocument();
      expect(screen.queryByText("Recommended isolation")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Check Proxmox readiness" })).not.toBeInTheDocument();
    },
  );
});
