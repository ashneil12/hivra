/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  prepareInfrastructureConnection,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import type { InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import { InfrastructurePrepareDialog } from "../InfrastructurePrepareDialog";

jest.mock("@/lib/infrastructure/client", () => ({
  prepareInfrastructureConnection: jest.fn(),
}));

const CONNECTION: InfrastructureConnectionDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Studio Proxmox",
  provider: "proxmox",
  operatingMode: "self-managed",
  setupMode: "simple",
  status: "pending",
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
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const PREPARATION: InfrastructurePreparation = {
  ok: true,
  connectionId: CONNECTION.id,
  provisionerVersion: "2026.08.26.3",
  preflight: {
    ok: true,
    connectionId: CONNECTION.id,
    checkedAt: "2026-08-26T12:05:00.000Z",
    target: {
      externalId: "pve-01",
      displayName: "Studio Proxmox / pve-01",
      proxmoxVersion: "pve-manager/8.4.1",
      launchReady: true,
      capacity: {
        cpu: { totalCores: 8, utilizationRatio: 0.1 },
        memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
        storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
      },
      capabilities: {
        isolationDrivers: ["proxmox-kvm"],
        isolationClass: "hardware-vm",
        kvmAvailable: true,
        bridges: ["hivra0"],
        storages: ["local-lvm"],
        template: null,
        provisioner: { ready: true, version: "2026.08.26.3" },
        runtimeCompatibility: null,
        vmidRange: { start: 200, end: 399, freeCount: 200 },
      },
    },
    warnings: [],
    unmetRequirements: [],
  },
};

describe("InfrastructurePrepareDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires an explicit confirmation before mutating the host", async () => {
    const onPrepared = jest.fn(async () => undefined);
    (prepareInfrastructureConnection as jest.Mock).mockResolvedValue(PREPARATION);

    render(
      <InfrastructurePrepareDialog
        connection={CONNECTION}
        onClose={jest.fn()}
        onPrepared={onPrepared}
      />,
    );

    expect(prepareInfrastructureConnection).not.toHaveBeenCalled();
    expect(screen.getByText(/does not create or start an agent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prepare recommended setup" }));

    const successHeading = await screen.findByRole("heading", { name: /is ready for agents/i });
    expect(successHeading).toHaveFocus();
    expect(prepareInfrastructureConnection).toHaveBeenCalledWith(CONNECTION.id);
    expect(onPrepared).toHaveBeenCalledWith(PREPARATION);
    expect(screen.getByText("Hivra 2026.08.26.3")).toBeInTheDocument();
    expect(screen.getByText("Agent created").nextSibling).toHaveTextContent("No");
  });

  it("keeps a failed preparation visible and retryable", async () => {
    (prepareInfrastructureConnection as jest.Mock).mockRejectedValue(
      new Error("The Proxmox host could not be prepared."),
    );

    render(
      <InfrastructurePrepareDialog
        connection={CONNECTION}
        onClose={jest.fn()}
        onPrepared={jest.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Prepare recommended setup" }));

    const failureHeading = await screen.findByRole("heading", { name: "The host was not prepared." });
    expect(failureHeading).toHaveFocus();
    expect(screen.getByText("The Proxmox host could not be prepared.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and try again" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Prepare the recommended setup on Studio Proxmox?" })).toBeInTheDocument();
    });
  });
});
