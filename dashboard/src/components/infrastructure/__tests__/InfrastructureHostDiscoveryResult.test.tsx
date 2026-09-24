/** @jest-environment jsdom */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/infrastructure/client", () => ({
  ...jest.requireActual("@/lib/infrastructure/client"),
  checkGvisorConnection: jest.fn(),
  prepareGvisorConnection: jest.fn(),
}));

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  checkGvisorConnection,
  InfrastructureApiError,
  prepareGvisorConnection,
} from "@/lib/infrastructure/client";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import { parseHostDiscoveryOutput } from "@/lib/infrastructure/host-discovery";
import { HOST_DISCOVERY_PROTOCOL } from "@/lib/infrastructure/host-discovery-contracts";
import { InfrastructureHostDiscoveryResult } from "../InfrastructureHostDiscoveryResult";
import { LaunchOnServerProvider } from "../LaunchOnServer";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Real discovery protocol output, parsed by the real parser. */
function discovered(overrides: Record<string, string> = {}): HostDiscoveryResult {
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
    GVISOR_INSTALLED: "0", GVISOR_VERSION_B64: "",
    DOCKER_INSTALLED: "0", DOCKER_VERSION_B64: "",
    CONTAINERD_INSTALLED: "0", CONTAINERD_VERSION_B64: "",
    PODMAN_INSTALLED: "0", PODMAN_VERSION_B64: "", OCI_RUNC_INSTALLED: "1",
    OCI_RUNC_VERSION_B64: b64("runc version 1.1.12"), OCI_CRUN_INSTALLED: "0",
    OCI_CRUN_VERSION_B64: "", LXC_INSTALLED: "0", LXC_VERSION_B64: "", END: "1",
    ...overrides,
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

const PROXMOX = {
  OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12"), VIRTUALIZATION: "bare-metal",
  KVM_DEVICE: "1", PROXMOX_KVM_INSTALLED: "1", PROXMOX_KVM_VERSION_B64: b64("pve-manager/8.4.1/2a5fa54a8503f96d"),
};
const INSTALLED_GVISOR = {
  GVISOR_INSTALLED: "1", GVISOR_VERSION_B64: b64("runsc version release-20260907.0"),
  DOCKER_INSTALLED: "1", DOCKER_VERSION_B64: b64("Docker version 29.1.3"),
};

function renderResult(
  result: HostDiscoveryResult,
  props: Partial<Parameters<typeof InfrastructureHostDiscoveryResult>[0]> = {},
) {
  const handlers = {
    onRetry: jest.fn(),
    onDone: jest.fn(),
    onStrictPreflightRequested: jest.fn(),
    onGvisorSetupRequested: jest.fn(),
    onConnectAsRootRequested: jest.fn(),
    onGvisorReady: jest.fn(),
  };
  render(
    <LaunchOnServerProvider pending={null} targets={[]}>
      <InfrastructureHostDiscoveryResult
        result={result}
        hostName="web-1"
        sshUser="root"
        connectionId={CONNECTION_ID}
        {...handlers}
        {...props}
      />
    </LaunchOnServerProvider>,
  );
  return handlers;
}

function technicalDetails(): HTMLDetailsElement {
  return screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
}

describe("InfrastructureHostDiscoveryResult", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends a supported Proxmox server to its strict readiness check, with raw facts under Technical details", () => {
    const handlers = renderResult(discovered(PROXMOX), { hostName: "pve-home" });

    const heading = screen.getByRole("heading", { name: "pve-home runs Proxmox VE 8.4.1." });
    expect(heading).toHaveFocus();
    expect(technicalDetails()).not.toHaveAttribute("open");
    expect(technicalDetails()).toHaveTextContent("Debian 12");
    expect(technicalDetails()).toHaveTextContent("4 logical cores");

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    expect(handlers.onStrictPreflightRequested).toHaveBeenCalledTimes(1);
  });

  it("offers Linux Sandbox setup through the review dialog without changing the host here", () => {
    const handlers = renderResult(discovered());

    expect(screen.getByRole("heading", { name: "web-1 can run Linux Sandbox after a short setup." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(handlers.onGvisorSetupRequested).toHaveBeenCalledWith("prepare");
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    expect(checkGvisorConnection).not.toHaveBeenCalled();
  });

  it("checks an installed Linux Sandbox setup read-only and then offers Launch on this server", async () => {
    (checkGvisorConnection as jest.Mock).mockResolvedValue({ targetId: TARGET_ID, ready: true });
    const handlers = renderResult(discovered(INSTALLED_GVISOR));

    expect(screen.getByRole("heading", { name: "web-1 has Linux Sandbox set up." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));

    expect(await screen.findByRole("heading", { name: "web-1 is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(checkGvisorConnection).toHaveBeenCalledWith(CONNECTION_ID);
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    expect(handlers.onGvisorReady).toHaveBeenCalledWith(TARGET_ID);
    expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${TARGET_ID}`,
    );
  });

  it("keeps reinstalling an installed setup behind Technical details and the review dialog", () => {
    const handlers = renderResult(discovered(INSTALLED_GVISOR));
    fireEvent.click(screen.getByRole("button", { name: "Reinstall Linux Sandbox setup" }));
    expect(handlers.onGvisorSetupRequested).toHaveBeenCalledWith("repair");
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
  });

  // INF-04: a default cloud image signs in as a sudo user on a VM without
  // nested KVM. The old result blamed nested KVM; root is the real blocker.
  it("reports the missing root login first on a cloud VM, never nested KVM", () => {
    const handlers = renderResult(discovered({ EUID: "1000" }), { sshUser: "ubuntu" });

    expect(screen.getByRole("heading", { name: "Signed in as ubuntu without root access." })).toBeInTheDocument();
    expect(screen.getByText(/Hivra needs a root login on web-1 for now/)).toBeInTheDocument();
    expect(screen.queryByText(/nested KVM/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect as root" }));
    expect(handlers.onConnectAsRootRequested).toHaveBeenCalledTimes(1);
  });

  it("puts root before nested KVM on an installed Proxmox VM too", () => {
    renderResult(discovered({ ...PROXMOX, EUID: "1000", VIRTUALIZATION: "virtual-machine", KVM_DEVICE: "0" }), { sshUser: "admin" });
    expect(screen.getByRole("heading", { name: "Signed in as admin without root access." })).toBeInTheDocument();
    expect(screen.queryByText(/nested KVM/i)).not.toBeInTheDocument();
  });

  // INF-05: the fix is a supported image, not "gVisor detected, but not
  // supported yet".
  it("names the supported Ubuntu releases for an Ubuntu 20.04 server and checks again", () => {
    const handlers = renderResult(discovered({ OS_VERSION_ID_B64: b64("20.04") }));

    expect(screen.getByRole("heading", {
      name: "web-1 runs Ubuntu 20.04. Linux Sandbox needs Ubuntu 22.04 or 24.04 on x86.",
    })).toBeInTheDocument();
    expect(screen.getByText("Rebuild it with a supported image, then check again.")).toBeInTheDocument();
    expect(screen.queryByText(/detected, but not supported yet/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it("names the processor on an ARM server", () => {
    renderResult(discovered({ OS_VERSION_ID_B64: b64("24.04"), ARCH_B64: b64("aarch64") }));
    expect(screen.getByRole("heading", {
      name: "web-1 runs Ubuntu 24.04 on ARM. Linux Sandbox needs Ubuntu 22.04 or 24.04 on x86.",
    })).toBeInTheDocument();
  });

  it("reports nested KVM only when it is the remaining blocker on a Proxmox VM", () => {
    renderResult(discovered({ ...PROXMOX, VIRTUALIZATION: "virtual-machine", KVM_DEVICE: "0" }));
    expect(screen.getByRole("heading", {
      name: "web-1 is a virtual machine without nested KVM, so Proxmox can't create computers on it.",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Proxmox readiness" })).not.toBeInTheDocument();
  });

  it("says when a rate-limited check can run again", async () => {
    (checkGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError("Too Many Requests", 429, undefined, 42));
    renderResult(discovered(INSTALLED_GVISOR));
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hivra checked web-1 a moment ago. You can try again in 1 minute.");
    expect(screen.queryByText("Too Many Requests")).not.toBeInTheDocument();
  });

  it("offers the review dialog to repair a setup whose check failed", async () => {
    (checkGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError("The gVisor adapter did not pass its strict readiness check.", 502, "remote_failed"));
    const handlers = renderResult(discovered(INSTALLED_GVISOR));
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Linux Sandbox setup on web-1 didn't pass its check.");
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(handlers.onGvisorSetupRequested).toHaveBeenCalledWith("repair");
  });

  it("shows a failed inspection's cause and fix with Inspect again", () => {
    const handlers = renderResult({
      ok: false,
      connectionId: CONNECTION_ID,
      attemptedAt: "2026-08-26T12:00:00.000Z",
      error: {
        code: "SSH_AUTHENTICATION_FAILED",
        message: "SSH authentication failed.",
        remediation: "Check the SSH user and private key authorized on this host.",
      },
    });
    expect(screen.getByRole("heading", { name: "SSH authentication failed." })).toBeInTheDocument();
    expect(screen.getByText("Check the SSH user and private key authorized on this host.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect again" }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
});
