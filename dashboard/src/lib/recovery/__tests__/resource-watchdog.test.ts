import { runResourceWatchdog } from "@/lib/recovery/resource-watchdog";
import { supabaseAdmin } from "@/lib/supabase";
import {
  shutdownProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { sendResourceWatchdogCustomerEmail } from "@/lib/email/resource-watchdog-customer";
import { sendFreeRamPressureEmail } from "@/lib/email/resource-watchdog-free-ram";
import { sendResourceWatchdogAdminEmail } from "@/lib/email/resource-watchdog-admin";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
}));

jest.mock("@/lib/email/resource-watchdog-customer", () => ({
  sendResourceWatchdogCustomerEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

jest.mock("@/lib/email/resource-watchdog-free-ram", () => ({
  sendFreeRamPressureEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

jest.mock("@/lib/email/resource-watchdog-admin", () => ({
  sendResourceWatchdogAdminEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(async () => ({
    users: {
      getUser: jest.fn(async () => ({
        primaryEmailAddress: { emailAddress: "user@example.com" },
        emailAddresses: [{ emailAddress: "user@example.com" }],
      })),
    },
  })),
}));

type InstanceRow = {
  id: string;
  user_id: string;
  resource_tier: string;
  cpu_limit: number | null;
  ram_limit: number | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  name: string | null;
};

type Sample = {
  sampled_at: string;
  cpu_seconds_total: number;
  ram_peak_bytes: number;
  runtime_seconds: number;
};

type WatchdogStub = {
  flagsInserted: Array<Record<string, unknown>>;
  pauseUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
};

function buildWatchdogStub(params: {
  instances: InstanceRow[];
  samplesByInstance: Record<string, Sample[]>;
  openFlagInstanceIds?: Set<string>;
  updateError?: { message: string };
}): WatchdogStub {
  const flagsInserted: Array<Record<string, unknown>> = [];
  const pauseUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const openFlagInstanceIds = params.openFlagInstanceIds ?? new Set<string>();

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") {
      let mode: "select" | "update" = "select";
      let updatePatch: Record<string, unknown> = {};
      const query: Record<string, unknown> = {};
      query.select = jest.fn(() => {
        mode = "select";
        return query;
      });
      query.update = jest.fn((patch: Record<string, unknown>) => {
        mode = "update";
        updatePatch = patch;
        return query;
      });
      query.eq = jest.fn((col: string, value: string) => {
        if (mode === "update" && col === "id") {
          // Terminating call on the update path: capture and resolve.
          pauseUpdates.push({ id: value, patch: updatePatch });
          return Promise.resolve({ error: params.updateError ?? null });
        }
        return query;
      });
      query.in = jest.fn().mockReturnValue(query);
      query.limit = jest.fn(async () => ({
        data: params.instances,
        error: null,
      }));
      return query;
    }
    if (table === "instance_metering_events") {
      let instanceId: string | null = null;
      const query: Record<string, unknown> = {};
      query.select = jest.fn().mockReturnValue(query);
      query.eq = jest.fn((col: string, value: string) => {
        if (col === "instance_id") instanceId = value;
        return query;
      });
      query.gte = jest.fn().mockReturnValue(query);
      query.order = jest.fn(async () => ({
        data: instanceId ? params.samplesByInstance[instanceId] ?? [] : [],
        error: null,
      }));
      return query;
    }
    if (table === "instance_flags") {
      const query: Record<string, unknown> = {};
      let instanceId: string | null = null;
      query.select = jest.fn().mockReturnValue(query);
      query.eq = jest.fn((col: string, value: string) => {
        if (col === "instance_id") instanceId = value;
        return query;
      });
      query.is = jest.fn().mockReturnValue(query);
      query.limit = jest.fn().mockReturnValue(query);
      query.maybeSingle = jest.fn(async () => ({
        data: instanceId && openFlagInstanceIds.has(instanceId)
          ? { id: "existing-flag" }
          : null,
        error: null,
      }));
      query.insert = jest.fn(async (row: Record<string, unknown>) => {
        flagsInserted.push(row);
        return { error: null };
      });
      return query;
    }
    throw new Error(`Unexpected table lookup: ${table}`);
  });

  return { flagsInserted, pauseUpdates };
}

const baseInfra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.21.50",
  gatewayHost: "abc.agents.hermesos.cloud",
};

const FREE_RAM_BYTES = 1024 * 1024 * 1024; // 1 GB ram_limit
const RAM_PINNED = Math.floor(FREE_RAM_BYTES * 0.97);
const RAM_BELOW = Math.floor(FREE_RAM_BYTES * 0.5);

describe("runResourceWatchdog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(baseInfra);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(
      null
    );
    (sendFreeRamPressureEmail as jest.Mock).mockResolvedValue({ sent: true });
  });

  it("pauses a free-tier instance with sustained RAM at the cap", async () => {
    const instance: InstanceRow = {
      id: "inst_free_pin",
      user_id: "user_free",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Free Agent",
    };
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: RAM_PINNED,
        runtime_seconds: 7200,
      },
      {
        sampled_at: "2026-05-10T11:55:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: RAM_PINNED,
        runtime_seconds: 8700,
      },
    ];

    const { flagsInserted, pauseUpdates } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_free_pin: samples },
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.ramCapHits).toBe(1);
    expect(summary.cpuSustainedFlags).toBe(0);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(pauseUpdates).toHaveLength(1);
    expect(pauseUpdates[0].patch).toEqual(
      expect.objectContaining({
        lifecycle_state: "paused",
        paused_reason: "ram_cap_hit",
        status: "stopped",
      })
    );
    expect(flagsInserted).toHaveLength(1);
    expect(flagsInserted[0]).toEqual(
      expect.objectContaining({
        instance_id: "inst_free_pin",
        flag_type: "ram_cap_hit",
        resolution_action: "auto_resolved",
      })
    );
  });

  it.each([
    { ramLimitMb: 1024, expectedPauses: 1 },
    { ramLimitMb: 2048, expectedPauses: 0 },
  ])("uses the actual recorded allocation ($ramLimitMb MiB) for a temporary capacity grant", async ({ ramLimitMb, expectedPauses }) => {
    // A VM-only support resize is insufficient: the unchanged 1 GiB row
    // caused the watchdog to repeatedly stop a VM using about 1.8 GiB.
    // Recording the actual 2 GiB allocation must not require a tier change
    // or disabling the watchdog. The stale-row case intentionally still trips.
    const instance: InstanceRow = {
      id: "temporary_capacity_fixture",
      user_id: "temporary_capacity_owner",
      resource_tier: "credit_base",
      cpu_limit: 1,
      ram_limit: ramLimitMb,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Temporary capacity fixture",
    };
    const { pauseUpdates } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: {
        [instance.id]: [{
          sampled_at: "2026-08-28T08:55:00.000Z",
          cpu_seconds_total: 100,
          ram_peak_bytes: Math.floor(1.8 * FREE_RAM_BYTES),
          runtime_seconds: 7200,
        }],
      },
    });
    const result = await runResourceWatchdog({ now: new Date("2026-08-28T09:00:00.000Z") });
    expect(result.ramCapHits).toBe(expectedPauses);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(expectedPauses);
    expect(pauseUpdates).toHaveLength(expectedPauses);
  });

  // Regression for the 2026-08-04 support report ("why does the Agent
  // automatically go offline at random times every day?"). The pause itself is
  // intended — a 1 GB box on the ceiling has outgrown the free tier. What was
  // broken is that this path told the owner NOTHING: only the paid CPU branch
  // emailed, so a Telegram/Discord user watched their agent go dark with no
  // reason given and no idea a restart was one click away.
  it("emails the owner when a free-tier agent is paused for the RAM cap", async () => {
    const instance: InstanceRow = {
      id: "inst_free_pin",
      user_id: "user_free",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Free Agent",
    };
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: RAM_PINNED,
        runtime_seconds: 7200,
      },
    ];

    buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_free_pin: samples },
    });

    await runResourceWatchdog({ now: new Date("2026-05-10T12:00:00.000Z") });

    expect(sendFreeRamPressureEmail).toHaveBeenCalledTimes(1);
    expect(sendFreeRamPressureEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        agentName: "Free Agent",
        ramLimitMb: 1024,
        windowMinutes: 60,
        // Day-scoped so a same-day re-fire can't double-send.
        idempotencyKey: "watchdog-ram/inst_free_pin/2026-05-10",
      })
    );
    // The RAM path must not borrow the paid-tier CPU email.
    expect(sendResourceWatchdogCustomerEmail).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "database", "email"])("handles %s failure without claiming an uncompleted RAM pause", async (failure) => {
    const instance: InstanceRow = {
      id: "ram_failure", user_id: "owner", resource_tier: "credit_base",
      cpu_limit: 1, ram_limit: 2048, proxmox_node: "fixturenode1", proxmox_vmid: 200,
      host_id: null, config: { infrastructure: baseInfra }, name: "Agent",
    };
    const { pauseUpdates } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { ram_failure: [{ sampled_at: "2026-08-28T11:55:00Z", cpu_seconds_total: 10, ram_peak_bytes: RAM_PINNED * 2, runtime_seconds: 60 }] },
      updateError: failure === "database" ? { message: "write unavailable" } : undefined,
    });
    if (failure === "shutdown") (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: false, error: "shutdown failed" });
    if (failure === "email") (sendFreeRamPressureEmail as jest.Mock).mockResolvedValue({ sent: false, reason: "send_failed" });
    const result = await runResourceWatchdog({ now: new Date("2026-08-28T12:00:00Z") });
    if (failure === "email") {
      expect(result.ramCapHits).toBe(1);
      expect(result.errors).toBe(0);
      expect(pauseUpdates).toHaveLength(1);
      expect(sendFreeRamPressureEmail).toHaveBeenCalledWith(expect.objectContaining({ ramLimitMb: 2048 }));
    } else {
      expect(result.ramCapHits).toBe(0);
      expect(result.errors).toBe(1);
      expect(sendFreeRamPressureEmail).not.toHaveBeenCalled();
      if (failure === "shutdown") expect(pauseUpdates).toHaveLength(0);
    }
  });

  // The flag is auto-resolved on insert (a re-pinned box gets paused again, by
  // design), so this guard only bites while a flag is genuinely open — but
  // when it does, it must suppress the whole branch, email included.
  it("does not re-pause or re-email while a ram_cap_hit flag is still open", async () => {
    const instance: InstanceRow = {
      id: "inst_free_pin",
      user_id: "user_free",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Free Agent",
    };
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: RAM_PINNED,
        runtime_seconds: 7200,
      },
    ];

    const { flagsInserted } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_free_pin: samples },
      openFlagInstanceIds: new Set(["inst_free_pin"]),
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.ramCapHits).toBe(0);
    expect(flagsInserted).toHaveLength(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(sendFreeRamPressureEmail).not.toHaveBeenCalled();
  });

  it("does not pause a free-tagged instance whose metered RAM dwarfs its cap (split-brain)", async () => {
    // Row says credit_base / 1GB, but the VM was actually provisioned
    // Command-sized and is metering tens of GB. Pausing would wrongly shut
    // down a paid-sized workload (the fixturenodea incident). The watchdog must skip
    // the pause and raise an ops event instead.
    const instance: InstanceRow = {
      id: "inst_split_brain",
      user_id: "user_split",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode10",
      proxmox_vmid: 1000,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Mislabeled Command Agent",
    };
    const BIG_BYTES = 40 * 1024 * 1024 * 1024; // ~40 GB, 40x the 1 GB cap
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: BIG_BYTES,
        runtime_seconds: 7200,
      },
      {
        sampled_at: "2026-05-10T11:55:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: BIG_BYTES,
        runtime_seconds: 8700,
      },
    ];

    const { flagsInserted, pauseUpdates } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_split_brain: samples },
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.ramCapHits).toBe(0);
    expect(summary.ramCapInconsistencies).toBe(1);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(pauseUpdates).toHaveLength(0);
    // First time we see the mismatch we record an open flag so the next */15
    // tick can de-dup against it (mirrors the ram_cap_hit / cpu_sustained
    // branches) instead of re-firing the same warn every cron run.
    expect(flagsInserted).toHaveLength(1);
    expect(flagsInserted[0]).toEqual(
      expect.objectContaining({
        instance_id: "inst_split_brain",
        user_id: "user_split",
        flag_type: "ram_cap_inconsistent",
      })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "ram_cap_inconsistent",
        severity: "warn",
        instanceId: "inst_split_brain",
      })
    );
  });

  it("de-dups the split-brain warn once a ram_cap_inconsistent flag is already open", async () => {
    // Regression for #136 (2026-06-09): without the hasOpenFlag guard, the
    // */15 watchdog re-fired an identical ram_cap_inconsistent warn every tick
    // (6x alert-spam from one mislabeled row). With an open flag present the
    // branch must short-circuit: no new flag, no re-fired ops event, no count.
    const instance: InstanceRow = {
      id: "inst_split_brain",
      user_id: "user_split",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode10",
      proxmox_vmid: 1000,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Mislabeled Command Agent",
    };
    const BIG_BYTES = 40 * 1024 * 1024 * 1024; // ~40 GB, 40x the 1 GB cap
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: BIG_BYTES,
        runtime_seconds: 7200,
      },
      {
        sampled_at: "2026-05-10T11:55:00.000Z",
        cpu_seconds_total: 200,
        ram_peak_bytes: BIG_BYTES,
        runtime_seconds: 8700,
      },
    ];

    const { flagsInserted, pauseUpdates } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_split_brain: samples },
      openFlagInstanceIds: new Set(["inst_split_brain"]),
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.ramCapHits).toBe(0);
    expect(summary.ramCapInconsistencies).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(pauseUpdates).toHaveLength(0);
    expect(flagsInserted).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("does not pause a free-tier instance with one sample below threshold", async () => {
    const instance: InstanceRow = {
      id: "inst_free_ok",
      user_id: "user_ok",
      resource_tier: "credit_base",
      cpu_limit: 0.5,
      ram_limit: 1024,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "OK Agent",
    };
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:30:00.000Z",
        cpu_seconds_total: 100,
        ram_peak_bytes: RAM_PINNED,
        runtime_seconds: 7200,
      },
      {
        sampled_at: "2026-05-10T11:55:00.000Z",
        cpu_seconds_total: 200,
        // One sample below threshold breaks the chain.
        ram_peak_bytes: RAM_BELOW,
        runtime_seconds: 8700,
      },
    ];

    buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_free_ok: samples },
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.ramCapHits).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("flags a paid instance with sustained CPU and emails the customer + admin", async () => {
    const instance: InstanceRow = {
      id: "inst_paid_hot",
      user_id: "user_paid",
      resource_tier: "operator",
      cpu_limit: 2,
      ram_limit: 4096,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 201,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Pro Agent",
    };
    // 24h apart, used essentially all available CPU seconds → ~100% pegged.
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-09T12:00:00.000Z",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        runtime_seconds: 0,
      },
      {
        sampled_at: "2026-05-10T12:00:00.000Z",
        cpu_seconds_total: 86400 * 2 * 0.99, // 99% of (24h * 2 vCPU)
        ram_peak_bytes: 0,
        runtime_seconds: 86400,
      },
    ];

    const { flagsInserted } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_paid_hot: samples },
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.cpuSustainedFlags).toBe(1);
    expect(summary.ramCapHits).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(flagsInserted).toHaveLength(1);
    expect(flagsInserted[0]).toEqual(
      expect.objectContaining({
        flag_type: "cpu_sustained",
      })
    );
    expect(flagsInserted[0].resolved_at).toBeUndefined();
    expect(sendResourceWatchdogCustomerEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        agentName: "Pro Agent",
      })
    );
    expect(sendResourceWatchdogAdminEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst_paid_hot",
        userId: "user_paid",
      })
    );
  });

  it("skips a paid instance whose CPU window is too short to be meaningful", async () => {
    const instance: InstanceRow = {
      id: "inst_paid_recent",
      user_id: "user_paid",
      resource_tier: "operator",
      cpu_limit: 2,
      ram_limit: 4096,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 201,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Newish Agent",
    };
    // Only 1 hour apart — under 12-hour minimum interval.
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-10T11:00:00.000Z",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        runtime_seconds: 0,
      },
      {
        sampled_at: "2026-05-10T12:00:00.000Z",
        cpu_seconds_total: 7200,
        ram_peak_bytes: 0,
        runtime_seconds: 3600,
      },
    ];

    buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_paid_recent: samples },
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.cpuSustainedFlags).toBe(0);
    expect(sendResourceWatchdogCustomerEmail).not.toHaveBeenCalled();
  });

  it("does not re-flag an instance that already has an open cpu_sustained flag", async () => {
    const instance: InstanceRow = {
      id: "inst_already_flagged",
      user_id: "user_flagged",
      resource_tier: "operator",
      cpu_limit: 2,
      ram_limit: 4096,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 202,
      host_id: null,
      config: { infrastructure: baseInfra },
      name: "Already Flagged",
    };
    const samples: Sample[] = [
      {
        sampled_at: "2026-05-09T12:00:00.000Z",
        cpu_seconds_total: 0,
        ram_peak_bytes: 0,
        runtime_seconds: 0,
      },
      {
        sampled_at: "2026-05-10T12:00:00.000Z",
        cpu_seconds_total: 86400 * 2 * 0.99,
        ram_peak_bytes: 0,
        runtime_seconds: 86400,
      },
    ];

    const { flagsInserted } = buildWatchdogStub({
      instances: [instance],
      samplesByInstance: { inst_already_flagged: samples },
      openFlagInstanceIds: new Set(["inst_already_flagged"]),
    });

    const summary = await runResourceWatchdog({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.cpuSustainedFlags).toBe(0);
    expect(flagsInserted).toHaveLength(0);
    expect(sendResourceWatchdogCustomerEmail).not.toHaveBeenCalled();
  });
});
