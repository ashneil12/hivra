/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { InfrastructureConnectionCard } from "../InfrastructureConnectionCard";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import type { InfrastructureConnectionDto, ProxmoxDeploymentTargetDto } from "@/lib/infrastructure/contracts";

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

  expect(screen.getByText("Inspected — setup needed")).toBeInTheDocument();
  expect(screen.getByText("Last host check")).toBeInTheDocument();
  expect(screen.queryByText("Not checked yet")).not.toBeInTheDocument();
  expect(screen.getByText(/Choose a supported setup/i)).toBeInTheDocument();
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
