import { InfrastructureApiError } from "@/lib/infrastructure/client";
import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { HIVRA_GVISOR_ADAPTER_VERSION } from "@/lib/hivra/gvisor-computer-contract";
import { GvisorRecheckError, gvisorNeedsRecheck, recheckGvisorForLaunch } from "../gvisor-launch-recheck";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function gvisorTarget(checkedMinutesAgo: number, patch: Partial<DeploymentTargetDto> = {}): DeploymentTargetDto {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    connectionId: "11111111-1111-4111-8111-111111111111",
    evidenceConnectionRevision: 3,
    externalId: `gvisor-${"b".repeat(24)}`,
    displayName: "Linux host — gVisor",
    status: "ready",
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: null },
      memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
      storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
    },
    capabilities: {
      kind: "gvisor", launchReady: true, hostIdentityDigest: "c".repeat(64),
      adapter: { version: HIVRA_GVISOR_ADAPTER_VERSION, sha256: "d".repeat(64) },
      runtime: { path: "/usr/local/bin/runsc", sha256: "e".repeat(64) },
      runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
      resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
      access: { terminal: "owner-gated-command-v1", publicPorts: false },
      desktop: false, windows: false,
    },
    supportedIsolationDrivers: ["gvisor-runsc"],
    isolationClass: "application-kernel",
    lastPreflightAt: new Date(NOW - checkedMinutesAgo * 60_000).toISOString(),
    lastErrorCode: null,
    createdAt: "2026-09-24T11:00:00.000Z",
    updatedAt: "2026-09-24T11:00:00.000Z",
    ...patch,
  } as DeploymentTargetDto;
}

describe("gvisorNeedsRecheck", () => {
  it("re-checks a host whose 15-minute window ends within two minutes, or already ended", () => {
    expect(gvisorNeedsRecheck(gvisorTarget(1), NOW)).toBe(false);
    expect(gvisorNeedsRecheck(gvisorTarget(12.9), NOW)).toBe(false);
    expect(gvisorNeedsRecheck(gvisorTarget(13.5), NOW)).toBe(true);
    expect(gvisorNeedsRecheck(gvisorTarget(40), NOW)).toBe(true);
  });

  it("leaves other servers and missing targets alone", () => {
    expect(gvisorNeedsRecheck(null, NOW)).toBe(false);
    expect(gvisorNeedsRecheck(gvisorTarget(40, { status: "unavailable" }), NOW)).toBe(false);
    const proxmox = gvisorTarget(40);
    (proxmox.capabilities as unknown as { kind?: string }).kind = undefined;
    expect(gvisorNeedsRecheck(proxmox, NOW)).toBe(false);
  });
});

describe("recheckGvisorForLaunch", () => {
  it("passes when the read-only check passes", async () => {
    const check = jest.fn().mockResolvedValue({ targetId: "t", ready: true });
    const discover = jest.fn();
    await expect(recheckGvisorForLaunch(gvisorTarget(40), { check, discover })).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(discover).not.toHaveBeenCalled();
  });

  it("inspects first when Hivra's last look has expired, then checks again", async () => {
    const check = jest.fn()
      .mockRejectedValueOnce(new InfrastructureApiError("Inspect first.", 409, "discovery_required"))
      .mockResolvedValueOnce({ targetId: "t", ready: true });
    const discover = jest.fn().mockResolvedValue({ ok: true });
    await recheckGvisorForLaunch(gvisorTarget(40), { check, discover });
    expect(discover).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("says in plain words why the host can't launch now", async () => {
    const failing = (error: unknown) => recheckGvisorForLaunch(gvisorTarget(40), {
      check: jest.fn().mockRejectedValue(error), discover: jest.fn(),
    });
    await expect(failing(new InfrastructureApiError("x", 429, "rate_limited", 90)))
      .rejects.toThrow(new GvisorRecheckError("Hivra checked Linux host — gVisor a moment ago. You can try again in 2 minutes.", 429));
    await expect(failing(new InfrastructureApiError("x", 502, "remote_failed")))
      .rejects.toThrow("Linux Sandbox setup on Linux host — gVisor didn't pass its check. Reinstall the setup to repair it.");
    await expect(recheckGvisorForLaunch(gvisorTarget(40), {
      check: jest.fn().mockResolvedValue({ targetId: "t", ready: false }), discover: jest.fn(),
    })).rejects.toBeInstanceOf(GvisorRecheckError);
  });
});
