import {
  computeDriftsForHost,
  HOST_RUNNING_VMS_SCRIPT,
  isFleetStatusReconcileLive,
  parseRunningVmids,
  RECONCILABLE_HOST_STATUSES,
  RECONCILE_BATCH_LIMIT,
  STUCK_ARCHIVING_RECOVERY_MS,
  TEMPLATE_VMID_THRESHOLD,
  type InactivityPausedRow,
} from "../fleet-status-reconcile";

function pausedRow(
  overrides: Partial<InactivityPausedRow> & { proxmox_vmid: number },
): InactivityPausedRow {
  return {
    id: `inst-${overrides.proxmox_vmid}`,
    user_id: `user-${overrides.proxmox_vmid}`,
    proxmox_node: "fixturenode1",
    status: "stopped",
    lifecycle_state: "paused",
    paused_reason: "inactivity",
    ...overrides,
  };
}

describe("parseRunningVmids", () => {
  it("parses one running VMID per line into a Set", () => {
    const out = parseRunningVmids("204\n215\n303\n");
    expect(out).toEqual(new Set([204, 215, 303]));
  });

  it("drops template-range VMIDs (>= 9000)", () => {
    const out = parseRunningVmids("401\n9004\n9005\n412\n");
    expect(out.has(9004)).toBe(false);
    expect(out.has(9005)).toBe(false);
    expect(out).toEqual(new Set([401, 412]));
  });

  it("takes the first token so it tolerates extra columns", () => {
    // Defensive: even if the host awk ever emits `<vmid> running`, we want vmid.
    expect(parseRunningVmids("204 running\n215 running\n")).toEqual(
      new Set([204, 215]),
    );
  });

  it("ignores blank lines, noise, and non-numeric / non-positive tokens", () => {
    expect(parseRunningVmids("")).toEqual(new Set());
    expect(parseRunningVmids("\n  \nnoise\n-1\n0\nabc\n301\n")).toEqual(
      new Set([301]),
    );
  });
});

describe("computeDriftsForHost", () => {
  it("flags ONLY parked rows whose VMID the host reports running", () => {
    // fixturenodea incident shape: DB says 202,204,215,303 are paused/stopped, but
    // `qm list` shows 204,215,303 running (auto-booted on a host reboot) while
    // 202 is genuinely stopped.
    const rows = [
      pausedRow({ proxmox_vmid: 202 }),
      pausedRow({ proxmox_vmid: 204 }),
      pausedRow({ proxmox_vmid: 215 }),
      pausedRow({ proxmox_vmid: 303 }),
    ];
    const running = new Set([204, 215, 303]);

    const drifts = computeDriftsForHost("fixturenode1", rows, running);

    expect(drifts.map((d) => d.vmid).sort((a, b) => a - b)).toEqual([
      204, 215, 303,
    ]);
    expect(drifts.every((d) => d.hostId === "fixturenode1")).toBe(true);
    expect(drifts.find((d) => d.vmid === 204)).toMatchObject({
      instanceId: "inst-204",
      userId: "user-204",
      fromStatus: "stopped",
      fromLifecycle: "paused",
    });
  });

  it("is strictly one-way: a parked row NOT in the running set is never a drift", () => {
    // The genuinely-stopped paused row stays untouched — never inverted to
    // running. This is the core safety property.
    const rows = [pausedRow({ proxmox_vmid: 202 })];
    expect(computeDriftsForHost("fixturenode1", rows, new Set())).toEqual([]);
  });

  it("returns [] when there are no parked rows even if VMs are running", () => {
    expect(computeDriftsForHost("fixturenode1", [], new Set([204, 215]))).toEqual([]);
  });

  it("never matches a template-range VMID even if a parked row somehow has one", () => {
    const rows = [pausedRow({ proxmox_vmid: TEMPLATE_VMID_THRESHOLD })];
    const running = new Set([TEMPLATE_VMID_THRESHOLD]);
    expect(computeDriftsForHost("fixturenode1", rows, running)).toEqual([]);
  });

  it("carries the host id and source fields needed to write the correction", () => {
    const rows = [pausedRow({ proxmox_vmid: 500, proxmox_node: "fixturenode5" })];
    const drifts = computeDriftsForHost("fixturenode5", rows, new Set([500]));
    expect(drifts).toEqual([
      {
        instanceId: "inst-500",
        userId: "user-500",
        hostId: "fixturenode5",
        vmid: 500,
        fromStatus: "stopped",
        fromLifecycle: "paused",
      },
    ]);
  });

  it("also flags stuck-archiving rows whose VM is running (reused for the archiving path)", () => {
    // The archiving-recovery path feeds rows shaped lifecycle_state='archiving'
    // through the SAME drift computation. A stuck-archiving row whose VM is
    // running is a drift; carries fromLifecycle='archiving' so the writer/logs
    // can tell the two repair classes apart.
    const rows = [
      pausedRow({ proxmox_vmid: 938, lifecycle_state: "archiving", paused_reason: null }),
      pausedRow({ proxmox_vmid: 939, lifecycle_state: "archiving", paused_reason: null }),
    ];
    const drifts = computeDriftsForHost("fixturenode9", rows, new Set([938]));
    expect(drifts).toEqual([
      {
        instanceId: "inst-938",
        userId: "user-938",
        hostId: "fixturenode9",
        vmid: 938,
        fromStatus: "stopped",
        fromLifecycle: "archiving",
      },
    ]);
  });
});

describe("RECONCILABLE_HOST_STATUSES", () => {
  it("includes maintenance so over-tenant full-but-live hosts are reconciled", () => {
    // fixturenodea/fixturenodea (2026-06-23) sat at status='maintenance' with 50+ running
    // tenants between them; scanning only active/draining left them drifting.
    expect(RECONCILABLE_HOST_STATUSES).toContain("active");
    expect(RECONCILABLE_HOST_STATUSES).toContain("draining");
    expect(RECONCILABLE_HOST_STATUSES).toContain("maintenance");
  });
});

describe("STUCK_ARCHIVING_RECOVERY_MS", () => {
  it("is a sane positive 'stuck' threshold", () => {
    expect(STUCK_ARCHIVING_RECOVERY_MS).toBeGreaterThan(0);
    // At least a few minutes (don't fight an in-flight archive), well under a day.
    expect(STUCK_ARCHIVING_RECOVERY_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(STUCK_ARCHIVING_RECOVERY_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("isFleetStatusReconcileLive", () => {
  it("is OFF by default and only on for an explicit 'true' (dry-run by default)", () => {
    expect(isFleetStatusReconcileLive({})).toBe(false);
    expect(isFleetStatusReconcileLive({ FLEET_STATUS_RECONCILE_LIVE: "false" })).toBe(
      false,
    );
    expect(isFleetStatusReconcileLive({ FLEET_STATUS_RECONCILE_LIVE: "1" })).toBe(
      false,
    );
    expect(isFleetStatusReconcileLive({ FLEET_STATUS_RECONCILE_LIVE: "yes" })).toBe(
      false,
    );
    expect(
      isFleetStatusReconcileLive({ FLEET_STATUS_RECONCILE_LIVE: "  TRUE " }),
    ).toBe(true);
    expect(isFleetStatusReconcileLive({ FLEET_STATUS_RECONCILE_LIVE: "true" })).toBe(
      true,
    );
  });
});

describe("HOST_RUNNING_VMS_SCRIPT", () => {
  it("lists only running VMs and never mutates anything", () => {
    expect(HOST_RUNNING_VMS_SCRIPT).toContain("qm list");
    expect(HOST_RUNNING_VMS_SCRIPT).toContain('$3=="running"');
    // Read-only: the script must never start/stop/set anything.
    expect(HOST_RUNNING_VMS_SCRIPT).not.toMatch(/qm (start|stop|shutdown|set|destroy)/);
  });
});

describe("RECONCILE_BATCH_LIMIT", () => {
  it("is a sane positive cap that blast-radius-limits the first live run", () => {
    expect(RECONCILE_BATCH_LIMIT).toBeGreaterThan(0);
    expect(RECONCILE_BATCH_LIMIT).toBeLessThanOrEqual(1000);
  });
});
