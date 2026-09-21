import {
  connectionPresentation,
  formatInfrastructureBytes,
  preflightHeadline,
} from "../formatters";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";

describe("infrastructure presentation formatters", () => {
  it("formats capacity without fake precision", () => {
    expect(formatInfrastructureBytes(0)).toBe("0 B");
    expect(formatInfrastructureBytes(1_610_612_736)).toBe("1.5 GB");
    expect(formatInfrastructureBytes(Number.NaN)).toBe("Unknown");
  });

  it("describes a ready connection as inspected, not agent-ready", () => {
    expect(connectionPresentation({ status: "ready" })).toEqual({
      label: "Inspected",
      tone: "connected",
      detail: "Host connection verified. Agent readiness depends on the latest inspection.",
    });
  });

  it("distinguishes connected-but-incomplete from launch-ready target evidence", () => {
    const result = {
      ok: true as const,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      target: {
        externalId: "pve-01",
        displayName: "Home Proxmox / pve-01",
        proxmoxVersion: "8.4.1",
        launchReady: false,
        capacity: {
          cpu: { totalCores: 8, utilizationRatio: 0.25 },
          memoryBytes: { total: 32_000, available: 24_000 },
          storageBytes: { total: 20_000, available: 15_000 },
        },
        capabilities: {
          isolationDrivers: ["proxmox-kvm" as const],
          isolationClass: "hardware-vm" as const,
          kvmAvailable: true as const,
          bridges: ["vmbr0"],
          storages: ["local-lvm"],
          template: null,
          provisioner: null,
          runtimeCompatibility: null,
          vmidRange: { start: 200, end: 399, freeCount: 200 },
        },
      },
      warnings: ["Prepared assets are still required."],
      unmetRequirements: [{ code: "PROVISIONER_UNAVAILABLE" as const, message: "Prepared assets are still required." }],
    };

    expect(preflightHeadline(result)).toMatchObject({
      title: "Host inspected - setup needed",
      tone: "incomplete",
    });
  });
});
