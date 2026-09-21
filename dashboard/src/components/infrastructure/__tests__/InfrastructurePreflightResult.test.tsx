/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ProxmoxPreflightResult } from "@/lib/infrastructure/contracts";
import { InfrastructurePreflightResult } from "../InfrastructurePreflightResult";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";

function success(launchReady: boolean): ProxmoxPreflightResult {
  return {
    ok: true,
    connectionId: CONNECTION_ID,
    checkedAt: CHECKED_AT,
    target: {
      externalId: "pve-01",
      displayName: "Home Proxmox / pve-01",
      proxmoxVersion: "8.4.1",
      launchReady,
      capacity: {
        cpu: { totalCores: 8, utilizationRatio: 0.25 },
        memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
        storageBytes: { total: 1_000 * 1024 ** 3, available: 750 * 1024 ** 3 },
      },
      capabilities: {
        isolationDrivers: ["proxmox-kvm"],
        isolationClass: "hardware-vm",
        kvmAvailable: true,
        bridges: ["vmbr0"],
        storages: ["local-lvm"],
        template: launchReady ? { vmid: 9000, ready: true } : null,
        provisioner: launchReady ? { ready: true, version: "1.0.0" } : null,
        runtimeCompatibility: null,
        vmidRange: { start: 200, end: 399, freeCount: 180 },
      },
    },
    warnings: launchReady ? [] : ["Prepared launch assets are still required."],
    unmetRequirements: launchReady
      ? []
      : [{ code: "PROVISIONER_UNAVAILABLE", message: "Prepared launch assets are still required." }],
  };
}

describe("InfrastructurePreflightResult", () => {
  it("shows launch readiness only when the target evidence says it is ready", () => {
    render(<InfrastructurePreflightResult result={success(true)} onRetry={jest.fn()} onDone={jest.fn()} />);

    expect(screen.getByRole("heading", { name: "Host ready for agents" })).toBeInTheDocument();
    expect(screen.getByText("Recommended: Hardware-isolated VM")).toBeInTheDocument();
    expect(screen.getByText("Detected platform: Proxmox VE 8.4.1")).toBeInTheDocument();
    expect(screen.getByText("24 GB available")).toBeInTheDocument();
    expect(screen.getByText("After computer reservations and host headroom")).toBeInTheDocument();
  });

  it("keeps a successful connection visibly incomplete when launch proof is missing", () => {
    const onPrepareRequested = jest.fn();
    render(
      <InfrastructurePreflightResult
        result={success(false)}
        onRetry={jest.fn()}
        onDone={jest.fn()}
        onPrepareRequested={onPrepareRequested}
      />,
    );

    expect(screen.getByRole("heading", { name: "Host inspected - setup needed" })).toBeInTheDocument();
    expect(screen.getByText("Prepared launch assets are still required.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Host ready for agents" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare recommended setup" }));
    expect(onPrepareRequested).toHaveBeenCalledTimes(1);
  });

  it("shows stable remediation for a failed preflight", () => {
    const result: ProxmoxPreflightResult = {
      ok: false,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      error: {
        code: "SSH_HOST_KEY_MISMATCH",
        message: "The host identity did not match the pinned fingerprint.",
        remediation: "Verify the server fingerprint independently before updating it.",
      },
      unmetRequirements: [{
        code: "SSH_HOST_KEY_MISMATCH",
        message: "A verified SSH host identity is required.",
      }],
    };

    render(<InfrastructurePreflightResult result={result} onRetry={jest.fn()} onDone={jest.fn()} />);

    expect(screen.getByRole("heading", { name: "Host inspection needs attention" })).toBeInTheDocument();
    expect(screen.getByText("Verify the server fingerprint independently before updating it.")).toBeInTheDocument();
    expect(screen.getByText("A verified SSH host identity is required.")).toBeInTheDocument();
  });

  it("can offer preparation for a caller-verified remediable failure", () => {
    const onPrepareRequested = jest.fn();
    const result: ProxmoxPreflightResult = {
      ok: false,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      error: {
        code: "BRIDGE_UNAVAILABLE",
        message: "The dedicated Hivra network is not configured.",
      },
      unmetRequirements: [{
        code: "BRIDGE_UNAVAILABLE",
        message: "The dedicated Hivra network is not configured.",
      }],
    };

    render(
      <InfrastructurePreflightResult
        result={result}
        onRetry={jest.fn()}
        onDone={jest.fn()}
        onPrepareRequested={onPrepareRequested}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Prepare recommended setup" }));
    expect(onPrepareRequested).toHaveBeenCalledTimes(1);
  });
});
