/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  InfrastructureApiError,
  prepareGvisorConnection,
  prepareInfrastructureConnection,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import type { DeploymentTargetDto, InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import type { PendingLaunch } from "@/lib/infrastructure/launch-on-server";
import { InfrastructurePrepareDialog } from "../InfrastructurePrepareDialog";
import { LaunchOnServerProvider } from "../LaunchOnServer";

jest.mock("@/lib/infrastructure/client", () => ({
  ...jest.requireActual("@/lib/infrastructure/client"),
  prepareInfrastructureConnection: jest.fn(),
  prepareGvisorConnection: jest.fn(),
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

const LINUX_HOST: InfrastructureConnectionDto = { ...CONNECTION, name: "web-1", provider: "host" };
const GVISOR_TARGET_ID = "22222222-2222-4222-8222-222222222222";

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

const READY_PROXMOX_TARGET: DeploymentTargetDto = {
  id: "33333333-3333-4333-8333-333333333333",
  connectionId: CONNECTION.id,
  evidenceConnectionRevision: 1,
  externalId: "pve-01",
  displayName: "Studio Proxmox / pve-01",
  status: "ready",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: 0.1 },
    memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1", launchReady: true, directRootAccess: true, kvmAvailable: true,
    bridges: ["hivra0"], selectedBridge: "hivra0", storages: ["local-lvm"], selectedStorage: "local-lvm",
    template: null, provisioner: { configured: true, ready: true, version: "2026.08.26.3" },
    runtimeCompatibility: null,
    vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 }, issues: [],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-08-26T12:05:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:05:00.000Z",
};

function withLaunch(children: ReactNode, targets: DeploymentTargetDto[] = [], pending: PendingLaunch | null = null) {
  return <LaunchOnServerProvider pending={pending} targets={targets}>{children}</LaunchOnServerProvider>;
}

function steps() {
  return within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
}

describe("InfrastructurePrepareDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("names every Proxmox step before changing the host, then offers Launch on this server", async () => {
    const onPrepared = jest.fn(async () => undefined);
    (prepareInfrastructureConnection as jest.Mock).mockResolvedValue(PREPARATION);

    render(withLaunch(
      <InfrastructurePrepareDialog connection={CONNECTION} onClose={jest.fn()} onPrepared={onPrepared} />,
      [READY_PROXMOX_TARGET],
    ));

    expect(screen.getByRole("heading", { name: "Set up Studio Proxmox for agents?" })).toBeInTheDocument();
    expect(screen.getByText(/doesn't create an agent or buy anything/i)).toBeInTheDocument();
    expect(steps().map((step) => step.textContent)).toEqual([
      "1Check root access, Proxmox, KVM, storage and the network",
      "2Install Hivra's host tools",
      "3Download and verify the Ubuntu base image",
      "4Set up the private network agent computers use",
      "5Check the server is ready and save the result",
    ]);
    expect(prepareInfrastructureConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Set up Studio Proxmox" }));

    const successHeading = await screen.findByRole("heading", { name: "Studio Proxmox is ready for agents." });
    expect(successHeading).toHaveFocus();
    expect(prepareInfrastructureConnection).toHaveBeenCalledWith(CONNECTION.id);
    expect(onPrepared).toHaveBeenCalledWith(PREPARATION);
    expect(steps().every((step) => step.textContent?.endsWith(", done"))).toBe(true);
    expect(screen.getByText("Hivra 2026.08.26.3")).toBeInTheDocument();
    expect(screen.getByText("Agent created").nextSibling).toHaveTextContent("No");
    expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?start=1&targetId=${READY_PROXMOX_TARGET.id}`,
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("can't be closed while setup runs", async () => {
    let finish: (value: InfrastructurePreparation) => void = () => undefined;
    (prepareInfrastructureConnection as jest.Mock).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onClose = jest.fn();

    render(withLaunch(<InfrastructurePrepareDialog connection={CONNECTION} onClose={onClose} onPrepared={jest.fn(async () => undefined)} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Studio Proxmox" }));

    expect(await screen.findByRole("heading", { name: "Setting up Studio Proxmox…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close host setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel|Close|Done/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Running for 0:0\d/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish(PREPARATION));
    expect(await screen.findByRole("heading", { name: "Studio Proxmox is ready for agents." })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("maps a failure to its cause and marks the step it stopped in", async () => {
    (prepareInfrastructureConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "Setup couldn't find active Proxmox storage for virtual machines.",
      502,
      "PREPARATION_FAILED",
      null,
      { cause: "storage_unavailable" },
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={CONNECTION} onClose={jest.fn()} onPrepared={jest.fn(async () => undefined)} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Studio Proxmox" }));

    const failureHeading = await screen.findByRole("heading", {
      name: "Setup couldn't find active Proxmox storage for virtual machines.",
    });
    expect(failureHeading).toHaveFocus();
    expect(screen.getByText(/open Datacenter → Storage and enable a storage that allows Disk image content/)).toBeInTheDocument();
    expect(steps()[0]).toHaveTextContent(/stopped here/);
    expect(steps()[1]).not.toHaveTextContent(/done|stopped/);
    fireEvent.click(screen.getByRole("button", { name: "Review and try again" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Set up Studio Proxmox for agents?" })).toBeInTheDocument();
    });
  });

  // Retired: this used to surface the raw "Too Many Requests" with a retry
  // button that could only fail again.
  it("says when setup can run again instead of Too Many Requests", async () => {
    (prepareInfrastructureConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "Too Many Requests",
      429,
      "PREPARATION_RATE_LIMITED",
      690,
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={CONNECTION} onClose={jest.fn()} onPrepared={jest.fn(async () => undefined)} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Studio Proxmox" }));

    expect(await screen.findByRole("heading", { name: "Setup ran on Studio Proxmox in the last 15 minutes." })).toBeInTheDocument();
    expect(screen.getByText("You can try again in 12 minutes.")).toBeInTheDocument();
    expect(screen.queryByText("Too Many Requests")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and try again" })).not.toBeInTheDocument();
  });

  it("reviews Linux Sandbox setup in the same dialog and launches Linux Sandbox on the host", async () => {
    const onGvisorPrepared = jest.fn(async () => undefined);
    (prepareGvisorConnection as jest.Mock).mockResolvedValue({ targetId: GVISOR_TARGET_ID, ready: true });

    render(withLaunch(
      <InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} onGvisorPrepared={onGvisorPrepared} />,
    ));

    expect(screen.getByRole("heading", { name: "Set up Linux Sandbox on web-1?" })).toBeInTheDocument();
    expect(steps()).toHaveLength(6);
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));

    expect(await screen.findByRole("heading", { name: "web-1 is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(prepareGvisorConnection).toHaveBeenCalledWith(LINUX_HOST.id);
    expect(prepareInfrastructureConnection).not.toHaveBeenCalled();
    expect(onGvisorPrepared).toHaveBeenCalledWith({ targetId: GVISOR_TARGET_ID, ready: true });
    expect(screen.getByText("Computer created").nextSibling).toHaveTextContent("No");
    expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${GVISOR_TARGET_ID}`,
    );
  });

  it("continues a pending Linux Sandbox launch instead of starting over", async () => {
    (prepareGvisorConnection as jest.Mock).mockResolvedValue({ targetId: GVISOR_TARGET_ID, ready: true });

    render(withLaunch(
      <InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} />,
      [],
      { source: "journey", profileId: "linux-terminal" },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));

    expect(await screen.findByRole("link", { name: "Continue launch" })).toHaveAttribute(
      "href",
      `/dashboard/launch?targetId=${GVISOR_TARGET_ID}`,
    );
  });

  it("names the Linux Sandbox step a failed setup stopped in", async () => {
    (prepareGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "The pinned gVisor bundle could not be downloaded.",
      502,
      "remote_failed",
      null,
      { stage: "bundle-download" },
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));

    expect(await screen.findByRole("heading", {
      name: "Setup stopped at step 3 of 6: Download Hivra's pinned gVisor release and verify it.",
    })).toBeInTheDocument();
    expect(screen.getByText(/couldn't download gVisor from GitHub/)).toBeInTheDocument();
    const list = steps();
    expect(list[0]).toHaveTextContent(/done/);
    expect(list[1]).toHaveTextContent(/done/);
    expect(list[2]).toHaveTextContent(/stopped here/);
    expect(list[3]).not.toHaveTextContent(/done|stopped/);
    expect(screen.getByRole("button", { name: "Review and try again" })).toBeInTheDocument();
  });

  // Review of slice 5: "bundle-download" also covered the checksum check, so a
  // checksum mismatch was told the download from GitHub failed.
  it("tells a checksum mismatch apart from a failed download", async () => {
    (prepareGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "The downloaded gVisor bundle did not match its pinned checksum.", 502, "remote_failed", null, { stage: "bundle-checksum" },
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));

    expect(await screen.findByText(/didn't match the checksum of Hivra's pinned gVisor release/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't download gVisor from GitHub/)).not.toBeInTheDocument();
    expect(steps()[2]).toHaveTextContent(/stopped here/);
  });

  // Review of slice 5: Hivra's own adapter from an earlier release was blamed
  // on "a different gVisor install", with a retry that can't get past it.
  it.each([
    ["installed-adapter-check", /Linux Sandbox setup from another Hivra release/],
    ["installed-identity-check", /already has gVisor, installed another way or at a different release/],
  ])("explains gVisor already on the server (%s) without offering a retry that can't work", async (stage, copy) => {
    (prepareGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "Existing runtime files were not replaced.", 502, "remote_failed", null, { stage },
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));

    expect(await screen.findByRole("heading", {
      name: "Setup stopped at step 4 of 6: Install gVisor and connect it to Docker.",
    })).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByText(/won't replace it/)).toBeInTheDocument();
    expect(steps()[2]).toHaveTextContent(/done/);
    expect(steps()[3]).toHaveTextContent(/stopped here/);
    expect(screen.queryByRole("button", { name: "Review and try again" })).not.toBeInTheDocument();
  });

  it("says setup failed several times when the failure cap refuses a run", async () => {
    (prepareInfrastructureConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "Setup failed on this server 5 times in the last 15 minutes. You can try again in 9 minutes.",
      429,
      "PREPARATION_FAILURES_LIMITED",
      540,
    ));

    render(withLaunch(<InfrastructurePrepareDialog connection={CONNECTION} onClose={jest.fn()} onPrepared={jest.fn(async () => undefined)} />));
    fireEvent.click(screen.getByRole("button", { name: "Set up Studio Proxmox" }));

    expect(await screen.findByRole("heading", {
      name: "Setup failed on Studio Proxmox several times in the last 15 minutes.",
    })).toBeInTheDocument();
    expect(screen.getByText("You can try again in 9 minutes. Fix what the last attempt reported first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and try again" })).not.toBeInTheDocument();
  });

  // Review of slice 5: the dialog promised "Launch checks the server again",
  // but a gVisor launch only works within 15 minutes of the last check.
  it("offers Linux Sandbox launch only while setup's check is fresh", async () => {
    jest.useFakeTimers();
    try {
      (prepareGvisorConnection as jest.Mock).mockResolvedValue({ targetId: GVISOR_TARGET_ID, ready: true });
      render(withLaunch(<InfrastructurePrepareDialog connection={LINUX_HOST} engine="gvisor" onClose={jest.fn()} />));
      fireEvent.click(screen.getByRole("button", { name: "Set up Linux Sandbox" }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByRole("link", { name: "Launch on this server" })).toBeInTheDocument();
      expect(screen.getByText("Its check is good for 15 minutes. After that, check again before you launch.")).toBeInTheDocument();
      expect(screen.queryByText(/Launch checks the server again/)).not.toBeInTheDocument();

      act(() => { jest.advanceTimersByTime(15 * 60_000 + 100); });

      expect(screen.queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();
      expect(screen.getByText(/This check is more than 15 minutes old/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
