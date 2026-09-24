/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { InfrastructureConnectionCard } from "../InfrastructureConnectionCard";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import type { DeploymentTargetDto, InfrastructureConnectionDto, ProxmoxDeploymentTargetDto } from "@/lib/infrastructure/contracts";

const connection: Exclude<InfrastructureConnectionDto, { provider: "hetzner-cloud" }> = {
  id: "11111111-1111-4111-8111-111111111111", name: "My Linux host", provider: "host",
  operatingMode: "self-managed", setupMode: "simple", status: "ready",
  endpoint: { sshHost: "host.example.com", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: "a".repeat(64) },
  configuration: null, credentialsConfigured: true, lastCheckedAt: null, lastErrorCode: null,
  createdAt: "2026-08-27T12:00:00.000Z", updatedAt: "2026-08-27T12:00:00.000Z",
};

it("does not render provider-VM evidence as an SSH/Proxmox host's readiness", () => {
  render(<InfrastructureConnectionCard connection={connection} savedTarget={providerVmTarget()}
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);
  expect(screen.getByRole("heading", { name: "My Linux host" })).toBeInTheDocument();
  expect(screen.queryByText("My cloud computer")).not.toBeInTheDocument();
  expect(screen.queryByText("Latest readiness")).not.toBeInTheDocument();
  expect(screen.queryByText("Ready for agents")).not.toBeInTheDocument();
});

it("distinguishes a completed host discovery from a never-inspected connection", () => {
  render(<InfrastructureConnectionCard connection={{
    ...connection,
    status: "pending",
    lastCheckedAt: "2026-09-15T12:00:00.000Z",
  }} onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);

  expect(screen.getByText("Needs setup")).toBeInTheDocument();
  expect(screen.getByText("Last host check")).toBeInTheDocument();
  expect(screen.queryByText("Not checked yet")).not.toBeInTheDocument();
  expect(screen.getByText(/Inspect it again to see its next step/i)).toBeInTheDocument();
});

it.each([true, false])("renders Proxmox readiness only for the same connection: %s", sameConnection => {
  const target: ProxmoxDeploymentTargetDto = {
    ...providerVmTarget(),
    connectionId: sameConnection ? connection.id : "55555555-5555-4555-8555-555555555555",
    externalId: "pve-home", displayName: "Checked Proxmox target", status: "ready", lastErrorCode: null,
    supportedIsolationDrivers: ["proxmox-kvm"], isolationClass: "hardware-vm",
    capabilities: {
      proxmoxVersion: "8.4.1", launchReady: true, directRootAccess: true, kvmAvailable: true,
      bridges: ["hivra0"], selectedBridge: "hivra0", storages: ["local-lvm"], selectedStorage: "local-lvm",
      template: null, provisioner: { configured: true, ready: true, version: "2026.08.27.3" },
      runtimeCompatibility: { contractVersion: 1, provisionerVersion: "2026.08.27.3", supportedCatalogRuntimeIds: ["codex"] },
      vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 }, issues: [],
    },
  };
  render(<InfrastructureConnectionCard connection={connection} savedTarget={target}
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);
  if (sameConnection) {
    expect(screen.getByText("Checked Proxmox target")).toBeInTheDocument();
    expect(screen.getByText("Ready for agents")).toBeInTheDocument();
    expect(screen.getByText("hivra0")).toBeInTheDocument();
  } else {
    expect(screen.queryByText("Checked Proxmox target")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest readiness")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready for agents")).not.toBeInTheDocument();
  }
});

it("labels the host disconnect for narrow cards while keeping the icon control", () => {
  const onDelete = jest.fn();
  render(<InfrastructureConnectionCard connection={connection}
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={onDelete} />);
  const labelled = screen.getByRole("button", { name: "Disconnect host My Linux host" });
  expect(labelled).toHaveTextContent("Disconnect host");
  fireEvent.click(labelled);
  fireEvent.click(screen.getByRole("button", { name: "Delete My Linux host" }));
  expect(onDelete).toHaveBeenCalledTimes(2);
});

// INF-06: a gVisor-ready host used to keep the generic "Inspected" badge and
// offer no way to launch.
it("labels a ready gVisor host Ready for Linux Sandbox and launches Linux Sandbox on it", () => {
  const gvisor: DeploymentTargetDto = {
    id: "66666666-6666-4666-8666-666666666666",
    connectionId: connection.id,
    evidenceConnectionRevision: 1,
    externalId: `gvisor-${"b".repeat(24)}`,
    displayName: "My Linux host — gVisor",
    status: "ready",
    capacity: {
      cpu: { totalCores: 4, utilizationRatio: null },
      memoryBytes: { total: 8 * 1024 ** 3, available: 6 * 1024 ** 3 },
      storageBytes: { total: 64 * 1024 ** 3, available: 48 * 1024 ** 3 },
    },
    capabilities: {
      kind: "gvisor", launchReady: true, hostIdentityDigest: "c".repeat(64),
      adapter: { version: "2026.09.15.1", sha256: "d".repeat(64) },
      runtime: { path: "/usr/local/bin/runsc", sha256: "e".repeat(64) },
      runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
      resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
      access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false,
    },
    supportedIsolationDrivers: ["gvisor-runsc"],
    isolationClass: "application-kernel",
    lastPreflightAt: "2026-09-15T12:00:00.000Z",
    lastErrorCode: null,
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
  };
  render(<InfrastructureConnectionCard connection={connection} savedTarget={gvisor}
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);

  expect(screen.getByText("Ready for Linux Sandbox")).toBeInTheDocument();
  expect(screen.queryByText("Inspected")).not.toBeInTheDocument();
  expect(screen.getByText("My server")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
    "href",
    `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${gvisor.id}`,
  );
});

it("never offers launch while the host is being inspected", () => {
  const target = {
    ...providerVmTarget(), connectionId: connection.id, externalId: "pve-home", displayName: "Checked Proxmox target",
    status: "ready" as const, lastErrorCode: null, supportedIsolationDrivers: ["proxmox-kvm" as const], isolationClass: "hardware-vm" as const,
    capabilities: {
      proxmoxVersion: "8.4.1", launchReady: true, directRootAccess: true, kvmAvailable: true,
      bridges: ["hivra0"], selectedBridge: "hivra0", storages: ["local-lvm"], selectedStorage: "local-lvm",
      template: null, provisioner: { configured: true, ready: true, version: "2026.08.27.3" },
      runtimeCompatibility: null,
      vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 }, issues: [],
    },
  } as ProxmoxDeploymentTargetDto;
  const { rerender } = render(<InfrastructureConnectionCard connection={connection} savedTarget={target}
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);
  expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
    "href",
    `/dashboard/launch?start=1&targetId=${target.id}`,
  );

  rerender(<InfrastructureConnectionCard connection={connection} savedTarget={target} checking
    onCheck={jest.fn()} onPrepare={jest.fn()} onEdit={jest.fn()} onDelete={jest.fn()} />);
  expect(screen.queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();
});
