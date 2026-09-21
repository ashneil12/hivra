import { runDormantReclaimSweep } from "@/lib/recovery/dormant-reclaim";
import { supabaseAdmin } from "@/lib/supabase";
import {
  archiveProxmoxDormantInstance,
  deleteProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
} from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  archiveProxmoxDormantInstance: jest.fn(),
  deleteProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
}));

const infra = {
  provider: "proxmox" as const,
  node: "fixturenode6",
  vmid: 610,
  privateIpv4: "10.250.26.10",
  gatewayHost: "inst-610.agents.hermesos.cloud",
};

const dormantRow = {
  id: "inst_610",
  user_id: "user_610",
  name: "Dormant agent",
  status: "stopped",
  lifecycle_state: "paused",
  paused_reason: "inactivity",
  resource_tier: "credit_base",
  host_id: "host_fixturenode6",
  infrastructure_provider: "proxmox",
  proxmox_node: "fixturenode6",
  proxmox_vmid: 610,
  gateway_url: "https://inst-610.agents.hermesos.cloud",
  subdomain: "inst-610",
  config: { infrastructure: infra },
  created_at: "2026-05-01T00:00:00.000Z",
  last_activity_at: "2026-05-01T00:00:00.000Z",
  last_lifecycle_transition_at: "2026-05-05T00:00:00.000Z",
  cpu_limit: 1,
  ram_limit: 1024,
  disk_size_gb: 30,
};

// Builds the instance_usage_snapshots agent-side activity query mock. The
// production guard runs .select().eq(id).gt('sessions',0).gte('stat_date',day).limit(1)
// and treats a non-empty result as "agent was used → skip destructive reclaim".
function makeAgentUsageQuery(opts: { active?: boolean; error?: string } = {}) {
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn().mockReturnValue(query);
  query.eq = jest.fn().mockReturnValue(query);
  query.gt = jest.fn().mockReturnValue(query);
  query.gte = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockResolvedValue(
    opts.error
      ? { data: null, error: { message: opts.error } }
      : { data: opts.active ? [{ instance_id: "inst_610" }] : [], error: null }
  );
  return query;
}

function mockCandidateQuery(
  rows: unknown[],
  usageOpts: { active?: boolean; error?: string } = {}
) {
  const candidateQuery: Record<string, jest.Mock> = {};
  candidateQuery.select = jest.fn().mockReturnValue(candidateQuery);
  candidateQuery.eq = jest.fn().mockReturnValue(candidateQuery);
  candidateQuery.in = jest.fn().mockReturnValue(candidateQuery);
  candidateQuery.lt = jest.fn().mockReturnValue(candidateQuery);
  candidateQuery.limit = jest.fn().mockResolvedValue({ data: rows, error: null });
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "instance_usage_snapshots") return makeAgentUsageQuery(usageOpts);
    return candidateQuery;
  });
  return candidateQuery;
}

describe("runDormantReclaimSweep", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.HERMES_DORMANT_RECLAIM_ENABLED;
    delete process.env.HERMES_DORMANT_RECLAIM_COMMIT;
    delete process.env.HERMES_DORMANT_ARCHIVE_DIR;
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(infra);
    (archiveProxmoxDormantInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout:
        "HERMES_DORMANT_ARCHIVE_PATH=/mnt/hermes-dormant/vzdump-qemu-610.vma.zst\n" +
        "HERMES_DORMANT_ARCHIVE_SIZE_BYTES=8589934592\n",
      stderr: "",
    });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "deleted",
      stderr: "",
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not scan the database unless the dormant reclaim opt-in is enabled", async () => {
    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toEqual({
      enabled: false,
      commit: false,
      scanned: 0,
      archived: 0,
      reclaimed: 0,
      skipped: 0,
      failed: 0,
      reclaimAfterDays: 7,
    });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("dry-runs eligible paused instances without archiving or deleting VMs", async () => {
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    mockCandidateQuery([dormantRow]);

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toMatchObject({
      enabled: true,
      commit: false,
      scanned: 1,
      archived: 0,
      reclaimed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(archiveProxmoxDormantInstance).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("does not delete a VM when the Proxmox backup fails", async () => {
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
    process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";
    mockCandidateQuery([dormantRow]);
    (archiveProxmoxDormantInstance as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "vzdump failed",
    });

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toMatchObject({
      enabled: true,
      commit: true,
      scanned: 1,
      archived: 0,
      reclaimed: 0,
      failed: 1,
    });
    expect(archiveProxmoxDormantInstance).toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("records the backup before destroying and releasing the dormant VM", async () => {
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
    process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";

    const archiveInsert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: { id: "archive_610" },
          error: null,
        }),
      }),
    });
    const instanceUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    let hermesInstancesCalls = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        hermesInstancesCalls += 1;
        if (hermesInstancesCalls === 1) {
          const query: Record<string, jest.Mock> = {};
          query.select = jest.fn().mockReturnValue(query);
          query.eq = jest.fn().mockReturnValue(query);
          query.in = jest.fn().mockReturnValue(query);
          query.lt = jest.fn().mockReturnValue(query);
          query.limit = jest.fn().mockResolvedValue({ data: [dormantRow], error: null });
          return query;
        }
        return { update: instanceUpdate };
      }
      if (table === "instance_dormancy_archives") {
        return { insert: archiveInsert };
      }
      if (table === "instance_usage_snapshots") {
        return makeAgentUsageQuery({ active: false });
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toMatchObject({
      enabled: true,
      commit: true,
      scanned: 1,
      archived: 1,
      reclaimed: 1,
      failed: 0,
    });
    expect(archiveInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: "inst_610",
        user_id: "user_610",
        archive_path: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
        archive_size_bytes: 8589934592,
        archive_kind: "proxmox_vzdump",
      })
    );
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(infra, {
      hostConfig: null,
      expectedInstanceId: "inst_610",
    });
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle_state: "paused",
        paused_reason: "dormant_reclaimed",
        status: "stopped",
        host_id: null,
        proxmox_node: null,
        proxmox_vmid: null,
      })
    );
    // First write (markDormantArchiveRecorded) keeps the row in the
    // intermediate, STILL-RECLAIMABLE state so a crash before destroy is
    // retried — it must NOT flip to the terminal 'dormant_reclaimed' yet.
    expect(instanceUpdate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        lifecycle_state: "paused",
        paused_reason: "dormant_reclaiming",
        lifecycle_substate: "dormant_archive_recorded",
        status: "stopped",
        config: expect.objectContaining({
          infrastructure: infra,
          dormantArchive: expect.objectContaining({
            archiveId: "archive_610",
            archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
          }),
        }),
      })
    );
    // Crucially, the intermediate write must NOT bump
    // last_lifecycle_transition_at, or the candidate query (which filters on it
    // being older than the cutoff) could not re-select a mid-death row.
    expect(instanceUpdate.mock.calls[0]?.[0]).not.toHaveProperty(
      "last_lifecycle_transition_at"
    );
    expect(instanceUpdate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        host_id: null,
        proxmox_node: null,
        proxmox_vmid: null,
        config: expect.objectContaining({
          infrastructureReleased: expect.objectContaining({
            reason: "dormant_reclaim",
          }),
          dormantArchive: expect.objectContaining({
            archiveId: "archive_610",
          }),
        }),
      })
    );
    expect(instanceUpdate.mock.calls[1]?.[0].config.infrastructure).toBeUndefined();
    expect(archiveInsert.mock.invocationCallOrder[0]).toBeLessThan(
      instanceUpdate.mock.invocationCallOrder[0]
    );
    expect(instanceUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      (deleteProxmoxInstance as jest.Mock).mock.invocationCallOrder[0]
    );
    expect((deleteProxmoxInstance as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      instanceUpdate.mock.invocationCallOrder[1]
    );
    expect(getProxmoxHostRoutingConfigFromInfrastructure).toHaveBeenCalledWith(infra, {
      host_id: "host_fixturenode6",
    });
  });

  it("on re-entry ('dormant_reclaiming' with a recorded archive) skips re-archiving and resumes at the idempotent destroy", async () => {
    // Models a prior run that recorded the archive then died before destroy.
    // The candidate query re-selects the intermediate row; this run must NOT
    // re-archive (wasteful + duplicate) and must finalize the reclaim.
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
    process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";

    const reEntryRow = {
      ...dormantRow,
      paused_reason: "dormant_reclaiming",
      config: {
        infrastructure: infra,
        dormantArchive: {
          archiveId: "archive_610",
          archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
          archivedAt: "2026-05-13T00:00:00.000Z",
        },
      },
    };

    const archiveInsert = jest.fn();
    const instanceUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    let hermesInstancesCalls = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        hermesInstancesCalls += 1;
        if (hermesInstancesCalls === 1) {
          const query: Record<string, jest.Mock> = {};
          query.select = jest.fn().mockReturnValue(query);
          query.eq = jest.fn().mockReturnValue(query);
          query.in = jest.fn().mockReturnValue(query);
          query.lt = jest.fn().mockReturnValue(query);
          query.limit = jest.fn().mockResolvedValue({ data: [reEntryRow], error: null });
          return query;
        }
        return { update: instanceUpdate };
      }
      if (table === "instance_dormancy_archives") return { insert: archiveInsert };
      if (table === "instance_usage_snapshots") return makeAgentUsageQuery({ active: false });
      throw new Error(`Unexpected table: ${table}`);
    });

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    // No re-archive, no duplicate archive row.
    expect(archiveProxmoxDormantInstance).not.toHaveBeenCalled();
    expect(archiveInsert).not.toHaveBeenCalled();
    // Resumed straight at the idempotent destroy and finalized.
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(infra, {
      hostConfig: null,
      expectedInstanceId: "inst_610",
    });
    expect(summary).toMatchObject({ archived: 0, reclaimed: 1, failed: 0 });
    // Exactly one instance write — the terminal markDormantReclaimed.
    expect(instanceUpdate).toHaveBeenCalledTimes(1);
    expect(instanceUpdate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ paused_reason: "dormant_reclaimed", proxmox_vmid: null })
    );
  });

  it("does NOT archive a paused row that had agent-side usage before the pause", async () => {
    // The pause itself was a false positive of the dashboard-only idle signal
    // (the user was active over Telegram). Destroying the VM here would lose a
    // box the user is still using, so the guard must skip it.
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
    process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";
    mockCandidateQuery([dormantRow], { active: true });

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toMatchObject({
      enabled: true,
      commit: true,
      scanned: 1,
      archived: 0,
      reclaimed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(archiveProxmoxDormantInstance).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("fails CLOSED and skips reclaim when the agent-usage signal is unreadable", async () => {
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
    process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";
    mockCandidateQuery([dormantRow], {
      error: "permission denied for table instance_usage_snapshots",
    });

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(summary).toMatchObject({
      scanned: 1,
      archived: 0,
      reclaimed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });
});
