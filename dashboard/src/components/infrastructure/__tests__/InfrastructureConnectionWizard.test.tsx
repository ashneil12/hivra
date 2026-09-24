/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import {
  InfrastructureConnectionWizard,
  buildInfrastructureConnectionCreate,
  buildInfrastructureConnectionUpdate,
  type InfrastructureConnectionFormValues,
} from "../InfrastructureConnectionWizard";
import type {
  InfrastructureConnectionDto,
  ProxmoxPreflightResult,
} from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import { captureServerHostKey } from "@/lib/infrastructure/server-enrollment-client";
import {
  InfrastructureApiError,
  checkGvisorConnection,
  createInfrastructureConnection,
  discoverInfrastructureHost,
  preflightInfrastructureConnection,
} from "@/lib/infrastructure/client";

jest.mock("@/lib/infrastructure/server-enrollment-client", () => ({ captureServerHostKey: jest.fn() }));
jest.mock("@/lib/infrastructure/client", () => ({
  ...jest.requireActual("@/lib/infrastructure/client"),
  createInfrastructureConnection: jest.fn(),
  discoverInfrastructureHost: jest.fn(),
  preflightInfrastructureConnection: jest.fn(),
  updateInfrastructureConnection: jest.fn(),
  checkGvisorConnection: jest.fn(),
}));

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(96),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function form(overrides: Partial<InfrastructureConnectionFormValues> = {}): InfrastructureConnectionFormValues {
  return {
    name: "Home Proxmox",
    setupMode: "simple",
    sshHost: "pve.example.com",
    sshPort: "22",
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
    sshHostKeyType: null,
    sshPrivilege: "login",
    sshPrivateKey: PRIVATE_KEY,
    sshPrivateKeyPassphrase: "",
    node: "",
    bridge: "",
    storage: "",
    templateVmid: "",
    templateExpectedName: "",
    provisionerDirectory: "",
    provisionerExpectedVersion: "",
    vmidStart: "200",
    vmidEnd: "399",
    capacityPolicyConfigured: false,
    capacityPolicyMode: "observe",
    hostMemoryReserveMb: "2048",
    cpuCeilingDensity: "1",
    memoryCeilingDensity: "1",
    ...overrides,
  };
}

const current: InfrastructureConnectionDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Home Proxmox",
  provider: "proxmox",
  operatingMode: "self-managed",
  setupMode: "advanced",
  status: "ready",
  endpoint: {
    sshHost: "pve.example.com",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: {
    node: "pve-01",
    bridge: "vmbr0",
    storage: "local-lvm",
  },
  credentialsConfigured: true,
  lastCheckedAt: "2026-08-25T17:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-08-25T16:00:00.000Z",
  updatedAt: "2026-08-25T17:00:00.000Z",
};

const savedHost: InfrastructureConnectionDto = {
  ...current,
  name: "My host",
  provider: "host",
  setupMode: "simple",
  status: "pending",
  configuration: null,
  lastCheckedAt: null,
};

const supportedDiscovery: Extract<HostDiscoveryResult, { ok: true }> = {
  ok: true,
  snapshot: {
    discoveryId: "22222222-2222-4222-8222-222222222222",
    connectionId: current.id,
    connectionRevision: 2,
    connectionProvider: "host",
    contractVersion: 1,
    observedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:15:00.000Z",
    hostIdentityDigest: "b".repeat(64),
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
        cpu: { logicalCores: 8 },
        memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
        rootStorageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
      },
      kvm: { devicePresent: true, cpuVirtualization: true },
    },
    engines: [
      { id: "proxmox-kvm", availability: "installed", supported: true, detectedVersion: "pve-manager/8.4.1", unmetRequirements: [] },
      { id: "qemu-kvm", availability: "installed", supported: false, detectedVersion: "9.0", unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "gvisor", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "docker", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "containerd", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "podman", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "oci-runc", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "oci-crun", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "lxc", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
    ],
  },
};

function gvisorDiscovery(installed: boolean): Extract<HostDiscoveryResult, { ok: true }> {
  return {
    ok: true,
    snapshot: {
      ...supportedDiscovery.snapshot,
      host: {
        ...supportedDiscovery.snapshot.host,
        os: { family: "linux", id: "ubuntu", versionId: "24.04" },
        environment: { ...supportedDiscovery.snapshot.host.environment, virtualization: "virtual-machine" },
        kvm: { devicePresent: false, cpuVirtualization: true },
      },
      engines: supportedDiscovery.snapshot.engines.map((engine) => engine.id === "proxmox-kvm"
        ? { ...engine, availability: "unavailable" as const, supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED" as const] }
        : engine.id === "gvisor"
          ? {
              ...engine,
              availability: installed ? "installed" as const : "installable" as const,
              supported: true,
              detectedVersion: installed ? "runsc version release-20260907.0" : null,
              unmetRequirements: installed ? [] : ["ENGINE_NOT_INSTALLED" as const, "DOCKER_REQUIRED" as const],
            }
          : engine),
    },
  };
}

function fillAndConnect() {
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
  fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
  fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
}

const incompletePreflight: ProxmoxPreflightResult = {
  ok: true,
  connectionId: current.id,
  checkedAt: "2026-08-26T12:01:00.000Z",
  target: {
    externalId: "pve-01",
    displayName: "My host / pve-01",
    proxmoxVersion: "8.4.1",
    launchReady: false,
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.2 },
      memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
      storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
    },
    capabilities: {
      isolationDrivers: ["proxmox-kvm"],
      isolationClass: "hardware-vm",
      kvmAvailable: true,
      bridges: ["vmbr0"],
      storages: ["local-lvm"],
      template: null,
      provisioner: null,
      runtimeCompatibility: null,
      vmidRange: { start: 200, end: 399, freeCount: 180 },
    },
  },
  warnings: ["Prepared assets are not configured."],
  unmetRequirements: [{ code: "PROVISIONER_UNAVAILABLE", message: "Prepared assets are not configured." }],
};

function WizardHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open connection setup</button>
      {open ? (
        <InfrastructureConnectionWizard
          onClose={() => setOpen(false)}
          onConnectionSaved={jest.fn()}
          onPreflightComplete={jest.fn()}
        />
      ) : null}
    </>
  );
}

describe("InfrastructureConnectionWizard payload builders", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (createInfrastructureConnection as jest.Mock).mockResolvedValue(savedHost);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(supportedDiscovery);
    (preflightInfrastructureConnection as jest.Mock).mockResolvedValue(incompletePreflight);
  });

  it("creates a generic host connection in Simple mode", () => {
    const built = buildInfrastructureConnectionCreate(form());

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).not.toHaveProperty("configuration");
    expect(built.value.setupMode).toBe("simple");
    expect(built.value.provider).toBe("host");
  });

  it("rejects Advanced fields before a new host has been discovered", () => {
    const built = buildInfrastructureConnectionCreate(form({
      setupMode: "advanced",
      node: "pve-01",
      bridge: "vmbr0",
      storage: "local-lvm",
      templateVmid: "9000",
      templateExpectedName: "hivra-template",
      provisionerDirectory: "/opt/hivra/provisioner",
      provisionerExpectedVersion: "1.0.0",
    }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.setupMode).toMatch(/start in Simple mode/i);
  });

  it("clears Advanced overrides when an existing connection switches to Simple", () => {
    const built = buildInfrastructureConnectionUpdate(form({
      setupMode: "simple",
      sshPrivateKey: "",
    }), current);

    expect(built).toEqual({
      ok: true,
      value: { setupMode: "simple", configuration: null },
    });
  });

  it("keeps an explicitly configured capacity policy when saving Simple mode", () => {
    const built = buildInfrastructureConnectionUpdate(form({
      setupMode: "simple",
      capacityPolicyConfigured: true,
      capacityPolicyMode: "enforce",
      hostMemoryReserveMb: "4096",
      cpuCeilingDensity: "2",
      memoryCeilingDensity: "1.5",
      sshPrivateKey: "",
    }), current);

    expect(built).toEqual({
      ok: true,
      value: {
        setupMode: "simple",
        configuration: {
          capacityPolicy: {
            mode: "enforce",
            hostMemoryReserveMb: 4096,
            cpuCeilingDensity: 2,
            memoryCeilingDensity: 1.5,
          },
        },
      },
    });
  });

  it("does not resend a saved secret when the edit field stays blank", () => {
    const built = buildInfrastructureConnectionUpdate(form({
      name: "Renamed Proxmox",
      setupMode: "advanced",
      node: "pve-01",
      bridge: "vmbr0",
      storage: "local-lvm",
      vmidStart: "",
      vmidEnd: "",
      sshPrivateKey: "",
    }), current);

    expect(built.ok).toBe(true);
    if (!built.ok || !built.value) return;
    expect(built.value.name).toBe("Renamed Proxmox");
    expect(built.value).not.toHaveProperty("credentials");
  });

  it("rejects half-configured Advanced groups instead of sending partial contracts", () => {
    const built = buildInfrastructureConnectionUpdate(form({
      setupMode: "advanced",
      node: "pve-01",
      bridge: "vmbr0",
      storage: "local-lvm",
      provisionerDirectory: "/opt/hivra/provisioner",
      provisionerExpectedVersion: "",
      vmidStart: "",
      vmidEnd: "",
      sshPrivateKey: "",
    }), current);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors["configuration.provisioner.expectedVersion"]).toBeDefined();
  });

  it("never redisplays a saved private key or invents VMID overrides while editing", () => {
    render(
      <InfrastructureConnectionWizard
        connection={current}
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
      />,
    );

    expect(screen.getByLabelText("SSH private key")).toHaveValue("");
    expect(screen.getByLabelText("VMID range start")).toHaveValue(null);
    expect(screen.getByLabelText("VMID range end")).toHaveValue(null);
    expect(document.body.textContent).not.toContain(PRIVATE_KEY);
  });

  it("contains keyboard focus inside the modal and isolates the dashboard behind it", () => {
    render(
      <>
        <button type="button">Dashboard action</button>
        <InfrastructureConnectionWizard
          onClose={jest.fn()}
          onConnectionSaved={jest.fn()}
          onPreflightComplete={jest.fn()}
        />
      </>,
    );

    const backgroundAction = screen.getByRole("button", { name: "Dashboard action" });
    const dialog = screen.getByRole("dialog", { name: "Connect a host" });
    const closeButton = within(dialog).getByRole("button", {
      name: "Close infrastructure setup",
    });
    const lastButton = within(dialog).getByRole("button", { name: "Connect and inspect" });

    expect(backgroundAction).toHaveAttribute("inert");
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();
  });

  it("restores focus to the control that opened the modal", () => {
    render(<WizardHarness />);
    const opener = screen.getByRole("button", { name: "Open connection setup" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole("button", { name: "Close infrastructure setup" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("connects validation copy to the field and focuses the first invalid control", () => {
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));

    const host = screen.getByLabelText("SSH host");
    expect(host).toHaveAttribute("aria-invalid", "true");
    const descriptionId = host.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId as string)).toHaveTextContent(/required/i);
    expect(host).toHaveFocus();
  });

  it("keeps new connections Simple until discovery while legacy Proxmox edits retain Advanced", () => {
    const { unmount } = render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
      />,
    );

    expect(screen.queryByRole("group", { name: "Setup mode" })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only inspection first")).toBeInTheDocument();
    expect(screen.getByText(/existing Proxmox KVM installation can continue/i)).toBeInTheDocument();
    expect(screen.getByText(/Hardware VM does not mean a dedicated physical server/i)).toBeInTheDocument();
    expect(screen.getByText(/gVisor provides an application-kernel boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/explicitly prepare the pinned gVisor adapter/i)).toBeInTheDocument();
    unmount();

    render(
      <InfrastructureConnectionWizard
        connection={current}
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Advanced/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Network bridge")).toHaveValue("vmbr0");
    // Touch keyboards must not turn vmbr0 into Vmbr0 or autocorrect paths.
    for (const label of [
      "Node",
      "Network bridge",
      "VM storage",
      "Expected template name",
      "Provisioner directory",
      "Provisioner version",
    ]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute("autocapitalize", "none");
      expect(input).toHaveAttribute("autocorrect", "off");
      expect(input).toHaveAttribute("spellcheck", "false");
    }
  });

  it("saves a generic host, discovers it first, then requires an explicit strict readiness check", async () => {
    const onPrepareRequested = jest.fn();
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        onPrepareRequested={onPrepareRequested}
      />,
    );

    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
    fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
    fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));

    expect(await screen.findByRole("heading", {
      name: "My host runs Proxmox VE 8.4.1.",
    })).toBeInTheDocument();
    expect(createInfrastructureConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "host",
      setupMode: "simple",
    }));
    expect(discoverInfrastructureHost).toHaveBeenCalledWith(savedHost.id);
    expect(preflightInfrastructureConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    expect(await screen.findByRole("heading", { name: "Host inspected - setup needed" })).toBeInTheDocument();
    expect(preflightInfrastructureConnection).toHaveBeenCalledWith(savedHost.id);

    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(onPrepareRequested).toHaveBeenCalledWith(savedHost);
  });

  it("hands Linux Sandbox setup to the shared review dialog", async () => {
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(gvisorDiscovery(false));
    const onGvisorSetupRequested = jest.fn();
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        onGvisorSetupRequested={onGvisorSetupRequested}
      />,
    );
    fillAndConnect();

    expect(await screen.findByRole("heading", { name: "My host can run Linux Sandbox after a short setup." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(onGvisorSetupRequested).toHaveBeenCalledWith(savedHost, "prepare");
  });

  // INF-17: the progress bar used to stop at Recommend on the Linux Sandbox path.
  it("moves the progress bar to Ready when this wizard's Linux Sandbox check passes", async () => {
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(gvisorDiscovery(true));
    (checkGvisorConnection as jest.Mock).mockResolvedValue({ targetId: "44444444-4444-4444-8444-444444444444", ready: true });
    const onGvisorReady = jest.fn();
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        onGvisorReady={onGvisorReady}
      />,
    );
    fillAndConnect();

    fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
    expect(await screen.findByRole("heading", { name: "My host is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Ready for Linux Sandbox" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Ready, current" })).toHaveAttribute("aria-current", "step");
    expect(onGvisorReady).toHaveBeenCalledWith(savedHost.id);
  });

  // Review of slice 5: the header kept saying ready after the check lapsed.
  it("stops calling the host ready once this wizard's Linux Sandbox check is 15 minutes old", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      (discoverInfrastructureHost as jest.Mock).mockResolvedValue(gvisorDiscovery(true));
      (checkGvisorConnection as jest.Mock).mockResolvedValue({ targetId: "44444444-4444-4444-8444-444444444444", ready: true });
      render(
        <InfrastructureConnectionWizard
          onClose={jest.fn()}
          onConnectionSaved={jest.fn()}
          onPreflightComplete={jest.fn()}
          onGvisorReady={jest.fn()}
        />,
      );
      fillAndConnect();
      fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Ready for Linux Sandbox" })).toBeInTheDocument();

      act(() => { jest.advanceTimersByTime(15 * 60_000 + 1_000); });
      expect(screen.getByRole("heading", { level: 1, name: "Needs a check" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 1, name: "Ready for Linux Sandbox" })).not.toBeInTheDocument();
    } finally { jest.useRealTimers(); }
  });

  it("offers Change SSH user when discovery signed in without root or passwordless sudo", async () => {
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue({
      ...supportedDiscovery,
      snapshot: {
        ...gvisorDiscovery(false).snapshot,
        host: { ...gvisorDiscovery(false).snapshot.host, environment: { ...gvisorDiscovery(false).snapshot.host.environment, effectivePrivilege: "non-root" } },
        engines: gvisorDiscovery(false).snapshot.engines.map((engine) => engine.id === "gvisor"
          ? { ...engine, availability: "unavailable" as const, supported: false, unmetRequirements: ["ROOT_REQUIRED" as const, "ENGINE_NOT_INSTALLED" as const] }
          : engine),
      },
    } satisfies HostDiscoveryResult);
    const onEditRequested = jest.fn();
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        onEditRequested={onEditRequested}
      />,
    );
    fireEvent.click(screen.getByText("SSH settings"));
    fireEvent.change(screen.getByLabelText("SSH user"), { target: { value: "ubuntu" } });
    fillAndConnect();

    expect(await screen.findByRole("heading", { name: "Signed in as ubuntu without passwordless sudo." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change SSH user" }));
    expect(onEditRequested).toHaveBeenCalledWith(savedHost);
  });

  it.each([
    ["phone", "visible", true],
    ["desktop", "auto", false],
  ])("on %s layouts, starts each in-place phase at the top only when the page scrolls the dialog", async (_layout, overflowY, scrolls) => {
    // Phone CSS makes the in-flow dialog overflow visible so the dashboard
    // main scrolls it; desktop dialogs scroll themselves.
    const layout = document.createElement("style");
    layout.textContent = `[role="dialog"] { overflow-y: ${overflowY}; }`;
    document.head.appendChild(layout);
    try {
      render(
        <InfrastructureConnectionWizard
          onClose={jest.fn()}
          onConnectionSaved={jest.fn()}
          onPreflightComplete={jest.fn()}
        />,
      );
      const dialog = screen.getByRole("dialog");
      const scrollIntoView = jest.fn();
      dialog.scrollIntoView = scrollIntoView;

      // A validation error keeps the form phase; focus goes to the field instead.
      fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
      expect(screen.getByLabelText("SSH host")).toHaveFocus();
      expect(scrollIntoView).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
      fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
      fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
      fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
      await screen.findByRole("heading", { name: "My host runs Proxmox VE 8.4.1." });

      if (scrolls) {
        expect(scrollIntoView).toHaveBeenCalled();
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });
      } else {
        expect(scrollIntoView).not.toHaveBeenCalled();
      }
    } finally {
      layout.remove();
    }
  });

  it("shows a failed save's error instead of the form top when the page scrolls the dialog", async () => {
    (createInfrastructureConnection as jest.Mock).mockRejectedValue(new Error("The host rejected the saved SSH key."));
    const layout = document.createElement("style");
    layout.textContent = '[role="dialog"] { overflow-y: visible; }';
    document.head.appendChild(layout);
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrolled: Array<[Element, unknown]> = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: unknown) {
      scrolled.push([this, options]);
    };
    try {
      render(
        <InfrastructureConnectionWizard
          onClose={jest.fn()}
          onConnectionSaved={jest.fn()}
          onPreflightComplete={jest.fn()}
        />,
      );
      fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
      fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
      fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
      fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));

      const error = (await screen.findByText("The host rejected the saved SSH key.")).closest('[role="alert"]');
      expect(error).not.toBeNull();
      expect(scrolled.at(-1)).toEqual([error, { block: "center" }]);
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      layout.remove();
    }
  });

  it("keeps the recommendation step current while the strict readiness check is running", async () => {
    let finishPreflight!: (result: ProxmoxPreflightResult) => void;
    (preflightInfrastructureConnection as jest.Mock).mockImplementation(
      () => new Promise<ProxmoxPreflightResult>((resolve) => {
        finishPreflight = resolve;
      }),
    );
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
    fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
    fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
    await screen.findByRole("heading", { name: "My host runs Proxmox VE 8.4.1." });

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    expect(screen.getByRole("listitem", { name: "Recommend, current" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("listitem", { name: "Prepare" })).not.toHaveAttribute("aria-current");

    finishPreflight(incompletePreflight);
    expect(await screen.findByRole("heading", { name: "Host inspected - setup needed" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Prepare, current" })).toHaveAttribute("aria-current", "step");
  });

  it("keeps a non-remediable readiness failure out of the preparation step", async () => {
    (preflightInfrastructureConnection as jest.Mock).mockResolvedValue({
      ...incompletePreflight,
      warnings: ["The host does not have enough available capacity."],
      unmetRequirements: [{
        code: "CAPACITY_UNAVAILABLE",
        message: "The host does not have enough available capacity.",
      }],
    } satisfies ProxmoxPreflightResult);

    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        onPrepareRequested={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "host.example.com" } });
    fireEvent.change(screen.getByLabelText("Pinned SSH fingerprint"), { target: { value: "c".repeat(64) } });
    fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
    await screen.findByRole("heading", { name: "My host runs Proxmox VE 8.4.1." });

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));

    expect(await screen.findByRole("heading", { name: "Readiness issue" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Recommend, current" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("listitem", { name: "Prepare" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
  });
});

// INF-14 and T44: the advanced wizard keeps the pasted fingerprint as its
// default, adds a key passphrase and a sudo-user option, and offers reading
// the key from the server only as a fallback that pins nothing by itself.
describe("advanced SSH details", () => {
  const presented = { publicKey: "ssh-ed25519 " + "A".repeat(68), fingerprintSha256: "SHA256:" + "Q".repeat(43) };

  beforeEach(() => {
    jest.clearAllMocks();
    (createInfrastructureConnection as jest.Mock).mockResolvedValue(savedHost);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(supportedDiscovery);
  });

  function renderWizard(extra: Record<string, unknown> = {}) {
    render(
      <InfrastructureConnectionWizard
        onClose={jest.fn()}
        onConnectionSaved={jest.fn()}
        onPreflightComplete={jest.fn()}
        {...extra}
      />,
    );
  }

  it("sends a passphrase only when one is typed, and never keeps it in the form after saving", async () => {
    const withPassphrase = buildInfrastructureConnectionCreate(form({ setupMode: "simple", sshPrivateKeyPassphrase: "open sesame" }));
    expect(withPassphrase.ok && withPassphrase.value.credentials).toEqual({ sshPrivateKey: PRIVATE_KEY, sshPrivateKeyPassphrase: "open sesame" });
    const without = buildInfrastructureConnectionCreate(form());
    expect(without.ok && without.value.credentials).toEqual({ sshPrivateKey: PRIVATE_KEY });

    renderWizard();
    fireEvent.change(screen.getByLabelText("Key passphrase (only if your key has one)"), { target: { value: "open sesame" } });
    fillAndConnect();
    expect(await screen.findByRole("heading", { name: "My host runs Proxmox VE 8.4.1." })).toBeInTheDocument();
    expect((createInfrastructureConnection as jest.Mock).mock.calls[0][0].credentials)
      .toEqual({ sshPrivateKey: PRIVATE_KEY, sshPrivateKeyPassphrase: "open sesame" });
  });

  it("shows a wrong or missing passphrase under the passphrase field", async () => {
    (createInfrastructureConnection as jest.Mock).mockRejectedValue(
      new InfrastructureApiError("That passphrase didn't unlock this key.", 422, "key_passphrase_incorrect"));
    renderWizard();
    fillAndConnect();
    expect(await screen.findByText("That passphrase didn't unlock this key.")).toBeInTheDocument();
    expect(screen.getByLabelText("Key passphrase (only if your key has one)")).toBeInTheDocument();
    expect(discoverInfrastructureHost).not.toHaveBeenCalled();
  });

  it("offers passwordless sudo for a non-root user only, and sends it as the connection's privilege", () => {
    const endpointOf = (built: ReturnType<typeof buildInfrastructureConnectionCreate>) =>
      built.ok && "endpoint" in built.value ? built.value.endpoint : null;
    expect(endpointOf(buildInfrastructureConnectionCreate(form({ sshUser: "ubuntu", sshPrivilege: "sudo" }))))
      .toMatchObject({ sshUser: "ubuntu", sshPrivilege: "sudo" });
    // Root never uses sudo: its login already is root.
    const root = endpointOf(buildInfrastructureConnectionCreate(form({ sshUser: "root", sshPrivilege: "sudo" })));
    expect(root).not.toBeNull();
    expect(root).not.toHaveProperty("sshPrivilege");
    // Turning sudo off on a saved sudo connection says so explicitly.
    const back = buildInfrastructureConnectionUpdate(form({ sshUser: "ubuntu", sshPrivilege: "login", sshPrivateKey: "" }), {
      ...savedHost, endpoint: { ...savedHost.endpoint!, sshUser: "ubuntu", sshPrivilege: "sudo" },
    });
    expect(back.ok && back.value?.endpoint).toMatchObject({ sshPrivilege: "login" });

    renderWizard();
    fireEvent.click(screen.getByText("SSH settings"));
    expect(screen.queryByText(/uses passwordless sudo/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SSH user"), { target: { value: "ubuntu" } });
    expect(screen.getByText("ubuntu uses passwordless sudo")).toBeInTheDocument();
    expect(screen.getByText(/Proxmox launches need a root login for now\./)).toBeInTheDocument();
  });

  it("keeps the pasted fingerprint as the default and offers the setup command next to it", () => {
    const onSetupCommandRequested = jest.fn();
    renderWizard({ onSetupCommandRequested });
    expect(screen.getByLabelText("Pinned SSH fingerprint")).toBeRequired();
    expect(screen.getByRole("button", { name: "Copy the fingerprint command" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the setup command" }));
    expect(onSetupCommandRequested).toHaveBeenCalledTimes(1);
    for (const provider of ["AWS:", "Hetzner:", "DigitalOcean:"]) expect(screen.getByText(provider)).toBeInTheDocument();
    expect(captureServerHostKey).not.toHaveBeenCalled();
  });

  it("reads the key from the server only when asked, warns, and pins it only after the owner confirms (T44)", async () => {
    (captureServerHostKey as jest.Mock).mockResolvedValue(presented);
    renderWizard();
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "203.0.113.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Read it from the server" }));
    expect(captureServerHostKey).toHaveBeenCalledWith("203.0.113.9", 22);
    const result = await screen.findByRole("group", { name: "SSH identity the server presented" });
    expect(within(result).getByText(presented.fingerprintSha256)).toBeInTheDocument();
    expect(within(result).getByText(/If someone is intercepting Hivra's connection, this could be their key instead of your server's\./))
      .toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Copy the presented fingerprint" })).toBeInTheDocument();
    // Nothing is pinned or saved yet.
    expect(screen.getByLabelText("Pinned SSH fingerprint")).toHaveValue("");
    expect(createInfrastructureConnection).not.toHaveBeenCalled();
    fireEvent.click(within(result).getByRole("button", { name: /It matches: use this fingerprint/ }));
    expect(screen.getByLabelText("Pinned SSH fingerprint")).toHaveValue(presented.fingerprintSha256);
    expect(createInfrastructureConnection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: PRIVATE_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and inspect" }));
    await screen.findByRole("heading", { name: "My host runs Proxmox VE 8.4.1." });
    // A key read from the server is Ed25519, so SSH offers only that algorithm.
    expect((createInfrastructureConnection as jest.Mock).mock.calls[0][0].endpoint)
      .toMatchObject({ sshHostFingerprintSha256: presented.fingerprintSha256, sshHostKeyType: "ssh-ed25519" });
  });

  it("says the same thing for every capture failure and lets the owner dismiss a key", async () => {
    (captureServerHostKey as jest.Mock).mockRejectedValue(new Error("Hivra couldn't read an Ed25519 SSH identity from 203.0.113.9:22."));
    renderWizard();
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "203.0.113.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Read it from the server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hivra couldn't read an Ed25519 SSH identity from 203.0.113.9:22.");
    (captureServerHostKey as jest.Mock).mockResolvedValue(presented);
    fireEvent.click(screen.getByRole("button", { name: "Read it from the server" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't use it" }));
    expect(screen.getByLabelText("Pinned SSH fingerprint")).toHaveValue("");
  });
});
