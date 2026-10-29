import { runDormantReclaimSweep } from "@/lib/recovery/dormant-reclaim";
import { DORMANT_ARCHIVE_NOT_STOPPED_MARKER } from "@/lib/services/proxmox/script-builders";
import { supabaseAdmin } from "@/lib/supabase";
import {
  archiveProxmoxDormantInstance,
  deleteProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  removeProxmoxDormantArchive,
} from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  archiveProxmoxDormantInstance: jest.fn(),
  deleteProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  removeProxmoxDormantArchive: jest.fn(),
}));

const NOW = new Date("2026-05-14T20:30:00.000Z");

const infra = {
  provider: "proxmox" as const,
  node: "fixturenode6",
  vmid: 610,
  privateIpv4: "10.250.26.10",
  gatewayHost: "inst-610.agents.hermesos.cloud",
};

type Row = Record<string, unknown>;

const dormantRow: Row = {
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
  updated_at: "2026-05-05T00:00:00.000Z",
  cpu_limit: 1,
  ram_limit: 1024,
  disk_size_gb: 30,
};

// The intermediate row a prior run leaves behind after recording the archive
// and dying before the destroy.
const reEntryRow: Row = {
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

// What the owner's Start leaves on the row: the start route's lifecycle patch
// clears paused_reason and bumps updated_at.
function startedBy(owner: Row): Row {
  return {
    ...owner,
    status: "running",
    lifecycle_state: "active",
    paused_reason: null,
    last_lifecycle_transition_at: "2026-05-14T20:10:00.000Z",
    updated_at: "2026-05-14T20:10:00.000Z",
  };
}

const archiveOk = () => ({
  ok: true,
  stdout:
    "HERMES_DORMANT_ARCHIVE_PATH=/mnt/hermes-dormant/vzdump-qemu-610.vma.zst\n" +
    "HERMES_DORMANT_ARCHIVE_SIZE_BYTES=8589934592\n",
  stderr: "",
});

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
  candidateQuery.order = jest.fn().mockReturnValue(candidateQuery);
  candidateQuery.limit = jest.fn().mockResolvedValue({ data: rows, error: null });
  // The sweep re-reads the live row before it dumps and destroys. Here the live
  // row is the candidate itself, so nothing has changed.
  candidateQuery.maybeSingle = jest.fn().mockResolvedValue({ data: rows[0] ?? null, error: null });
  // A skipped row is moved to the back of the batch with a write of updated_at (deferCandidateInQueue).
  candidateQuery.update = jest.fn().mockReturnValue(candidateQuery);
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "instance_usage_snapshots") return makeAgentUsageQuery(usageOpts);
    return candidateQuery;
  });
  return candidateQuery;
}

type InstanceDb = {
  /** The live hermes_instances row, as the owner's writes leave it. */
  live: () => Row;
  /** The owner's Start lands: paused_reason cleared, updated_at bumped. */
  ownerStarts: () => void;
  /** The owner saves settings: config replaced, updated_at bumped. */
  ownerSavesConfig: (config: Row) => void;
  /** The owner's activity lands: last_activity_at and updated_at bumped, lifecycle untouched. */
  ownerRecordsActivity: () => void;
  /** The owner's settings save lands just after the sweep's next read of the row. */
  ownerSavesConfigAfterNextRead: (config: Row) => void;
  instanceUpdate: jest.Mock;
  archiveInsert: jest.Mock;
  archiveDelete: jest.Mock;
};

// A stand-in for public.hermes_instances. The candidate query reads the
// `candidates` snapshot the sweep was handed. Every other read goes to the live
// row, and every write is conditional on the filters it names and bumps
// updated_at, as the table's trigger does. `afterWrite` runs once a write has
// landed, so a test can let the owner's Start land at an exact point in the sweep.
function installDatabase(options: {
  candidates: Row[];
  live: Row;
  usage?: { active?: boolean };
  afterWrite?: (payload: Row, db: InstanceDb) => void;
}): InstanceDb {
  let live: Row = { ...options.live };
  let writes = 0;
  let saveAfterRead: Row | null = null;
  const stamp = () => {
    writes += 1;
    return new Date(Date.parse("2026-05-14T20:00:00.000Z") + writes * 1000).toISOString();
  };

  const instanceUpdate = jest.fn((payload: Row) => {
    const filters: Array<[string, unknown]> = [];
    const query: Record<string, unknown> = {};
    query.eq = jest.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    });
    query.select = jest.fn(() => query);
    query.maybeSingle = jest.fn(async () => {
      const matched = filters.every(([column, value]) => live[column] === value);
      if (!matched) return { data: null, error: null };
      live = { ...live, ...payload, updated_at: stamp() };
      options.afterWrite?.(payload, db);
      return { data: { updated_at: live.updated_at }, error: null };
    });
    return query;
  });

  const db: InstanceDb = {
    live: () => live,
    ownerStarts: () => {
      live = { ...live, status: "running", lifecycle_state: "active", paused_reason: null, updated_at: stamp() };
    },
    ownerSavesConfig: (config: Row) => {
      live = { ...live, config, updated_at: stamp() };
    },
    ownerSavesConfigAfterNextRead: (config: Row) => {
      saveAfterRead = config;
    },
    ownerRecordsActivity: () => {
      const at = new Date(Date.parse("2026-05-14T20:00:00.000Z") + writes * 1000 + 500).toISOString();
      live = { ...live, last_activity_at: at, updated_at: stamp() };
    },
    instanceUpdate,
    archiveInsert: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: "archive_610" }, error: null }),
      }),
    }),
    archiveDelete: jest.fn(() => ({
      eq: jest.fn().mockResolvedValue({ error: null }),
    })),
  };

  const instanceSelect = () => {
    const query: Record<string, unknown> = {};
    query.eq = jest.fn(() => query);
    query.in = jest.fn(() => query);
    query.lt = jest.fn(() => query);
    query.order = jest.fn(() => query);
    query.limit = jest.fn(async () => ({ data: options.candidates, error: null }));
    query.maybeSingle = jest.fn(async () => {
      // The read returns the row as it stands; a save armed for "after the read" lands now.
      const snapshot = live;
      if (saveAfterRead) {
        live = { ...live, config: saveAfterRead, updated_at: stamp() };
        saveAfterRead = null;
      }
      return { data: snapshot, error: null };
    });
    return query;
  };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") {
      return { select: jest.fn(() => instanceSelect()), update: instanceUpdate };
    }
    if (table === "instance_dormancy_archives") {
      return { insert: db.archiveInsert, delete: db.archiveDelete };
    }
    if (table === "instance_usage_snapshots") return makeAgentUsageQuery(options.usage ?? {});
    throw new Error(`Unexpected table: ${table}`);
  });

  return db;
}

// A row the sweep skips gets no marker and no terminal state. Its only write is the rotation
// stamp that moves it behind the rest of the batch: updated_at, and nothing else.
function expectOnlyRotationStamp(calls: unknown[][]) {
  for (const [payload] of calls) {
    expect(Object.keys(payload as Row)).toEqual(["updated_at"]);
  }
}

function setCommitEnv() {
  process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
  process.env.HERMES_DORMANT_RECLAIM_COMMIT = "true";
  process.env.HERMES_DORMANT_ARCHIVE_DIR = "/mnt/hermes-dormant";
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
    (archiveProxmoxDormantInstance as jest.Mock).mockResolvedValue(archiveOk());
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "deleted",
      stderr: "",
    });
    (removeProxmoxDormantArchive as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "HERMES_DORMANT_ARCHIVE_REMOVED /mnt/hermes-dormant/vzdump-qemu-610.vma.zst\n",
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
    const candidateQuery = mockCandidateQuery([dormantRow]);

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
    // A dry run writes nothing, including the rotation stamp.
    expect(candidateQuery.update).not.toHaveBeenCalled();
  });

  it("reads the least recently written paused rows first, so rows that keep failing cannot take the whole batch", async () => {
    process.env.HERMES_DORMANT_RECLAIM_ENABLED = "true";
    const candidateQuery = mockCandidateQuery([dormantRow]);

    await runDormantReclaimSweep({ now: NOW });

    // Skipped rows are moved back by a write of updated_at, so ordering on it is what rotates them.
    expect(candidateQuery.order).toHaveBeenCalledWith("updated_at", {
      ascending: true,
    });
    // The order is applied before the batch limit, or it would not choose which rows the limit keeps.
    expect(candidateQuery.order.mock.invocationCallOrder[0]).toBeLessThan(
      candidateQuery.limit.mock.invocationCallOrder[0]
    );
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
    setCommitEnv();
    const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
    const instanceUpdate = db.instanceUpdate;

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
    expect(db.archiveInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: "inst_610",
        user_id: "user_610",
        archive_path: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
        archive_size_bytes: 8589934592,
        archive_kind: "proxmox_vzdump",
      })
    );
    // The destroy refuses a running guest: the owner may have started it.
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(infra, {
      hostConfig: null,
      expectedInstanceId: "inst_610",
      refuseIfRunning: true,
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
    expect(db.archiveInsert.mock.invocationCallOrder[0]).toBeLessThan(
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
    setCommitEnv();
    const db = installDatabase({ candidates: [reEntryRow], live: reEntryRow });
    const instanceUpdate = db.instanceUpdate;

    const summary = await runDormantReclaimSweep({
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    // No re-archive, no duplicate archive row.
    expect(archiveProxmoxDormantInstance).not.toHaveBeenCalled();
    expect(db.archiveInsert).not.toHaveBeenCalled();
    // Resumed straight at the idempotent destroy and finalized.
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(infra, {
      hostConfig: null,
      expectedInstanceId: "inst_610",
      refuseIfRunning: true,
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

  describe("when the owner starts a row the sweep has already selected", () => {
    it("does not dump a VM whose owner started after the sweep read its row", async () => {
      // The candidate snapshot is from the start of the run. The owner started
      // the VM before the sweep reached it.
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: startedBy(dormantRow) });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ archived: 0, reclaimed: 0, skipped: 1, failed: 0 });
      expect(archiveProxmoxDormantInstance).not.toHaveBeenCalled();
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      expect(db.live()).toMatchObject({ status: "running", lifecycle_state: "active", paused_reason: null });
    });

    it("does not overwrite or destroy a VM whose owner started while the disk was being archived", async () => {
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerStarts();
        return archiveOk();
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      // The owner's running row is left as the owner wrote it, not stamped
      // dormant_reclaiming by the sweep.
      expect(db.live()).toMatchObject({ status: "running", lifecycle_state: "active", paused_reason: null });
      // The dump of the still-running guest is removed from the host first, and only then
      // its manifest row, so the record never points at a file that is gone.
      expect(removeProxmoxDormantArchive).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({
          archiveDir: "/mnt/hermes-dormant",
          archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
        })
      );
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
      expect((removeProxmoxDormantArchive as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        db.archiveDelete.mock.invocationCallOrder[0]
      );
    });

    it("keeps the record when the host cannot remove the abandoned dump", async () => {
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerStarts();
        return archiveOk();
      });
      (removeProxmoxDormantArchive as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "rm: permission denied",
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, failed: 1 });
      // The file is still there, so its manifest row must stay too.
      expect(db.archiveDelete).not.toHaveBeenCalled();
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    });

    it("keeps archiving when the owner only records activity or saves settings during the archive", async () => {
      // Owner activity writes updated_at without a lifecycle change. It must not abort the
      // reclaim, which would leave a full dump on disk to be taken again tomorrow.
      setCommitEnv();
      const ownerConfig = { infrastructure: infra, settings: { model: "owner-choice" } };
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerRecordsActivity();
        db.ownerSavesConfig(ownerConfig);
        return archiveOk();
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ archived: 1, reclaimed: 1, skipped: 0, failed: 0 });
      expect(removeProxmoxDormantArchive).not.toHaveBeenCalled();
      expect(db.archiveDelete).not.toHaveBeenCalled();
      expect(deleteProxmoxInstance).toHaveBeenCalledTimes(1);
      // The marker is written from the row as the owner left it, so the settings survive.
      expect(db.instanceUpdate.mock.calls[0]?.[0].config).toEqual(
        expect.objectContaining({ settings: { model: "owner-choice" } })
      );
    });

    it("keeps the owner's settings when a save lands between the marker's read and its update", async () => {
      // The marker re-reads the row, then writes a config merged from that read. A settings save
      // in that one round trip must make the marker's compare-and-swap fail, not be overwritten.
      setCommitEnv();
      const ownerConfig = { infrastructure: infra, settings: { model: "owner-choice" } };
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockImplementationOnce(async () => {
        // The next row read is the marker's re-read; the save lands just after it.
        db.ownerSavesConfigAfterNextRead(ownerConfig);
        return archiveOk();
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      // The owner's save is what the row keeps; the sweep did not write its dormant_reclaiming marker.
      expect(db.live()).toMatchObject({ config: ownerConfig, paused_reason: "inactivity" });
      // The dump the sweep took is discarded: file first, then its manifest row.
      expect(removeProxmoxDormantArchive).toHaveBeenCalledTimes(1);
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
    });

    it("does not destroy a VM whose owner started after the archive was recorded", async () => {
      setCommitEnv();
      const db = installDatabase({
        candidates: [dormantRow],
        live: dormantRow,
        afterWrite: (payload, database) => {
          if (payload.paused_reason === "dormant_reclaiming") database.ownerStarts();
        },
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, failed: 0 });
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      expect(db.live()).toMatchObject({ status: "running", lifecycle_state: "active", paused_reason: null });
      // The VM is kept, so its dump is removed (file first, then the manifest row). The
      // row's config still carries the dormantArchive blob; nothing reads it outside the sweep.
      expect(removeProxmoxDormantArchive).toHaveBeenCalledTimes(1);
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
      expect((removeProxmoxDormantArchive as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        db.archiveDelete.mock.invocationCallOrder[0]
      );
    });

    it("does not destroy a re-entered VM whose owner started since the prior run", async () => {
      setCommitEnv();
      const db = installDatabase({
        candidates: [reEntryRow],
        live: startedBy(reEntryRow),
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      expect(db.instanceUpdate).not.toHaveBeenCalled();
      // The row no longer points at the dump, so the dump goes.
      expect(removeProxmoxDormantArchive).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({ archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst" })
      );
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
    });

    it("reverts the archive record before removing the dump when the VM is running at destroy", async () => {
      // The row still reads dormant_reclaiming with the dump recorded on it. Removing the file
      // first would leave a row that a later run resumes into a destroy with no archive.
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (deleteProxmoxInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 610\n",
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      // The row is a plain paused row again: the pre-archive reason, no dump on it, the
      // lifecycle transition unchanged.
      expect(db.live()).toMatchObject({
        lifecycle_state: "paused",
        paused_reason: "inactivity",
        last_lifecycle_transition_at: dormantRow.last_lifecycle_transition_at,
        status: "stopped",
      });
      expect(db.live().config).toEqual({ infrastructure: infra });
      expect(removeProxmoxDormantArchive).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({ archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst" })
      );
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
      // Revert first, then the file, then the manifest row.
      const revert = db.instanceUpdate.mock.invocationCallOrder[1];
      expect(revert).toBeLessThan((removeProxmoxDormantArchive as jest.Mock).mock.invocationCallOrder[0]);
      expect((removeProxmoxDormantArchive as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        db.archiveDelete.mock.invocationCallOrder[0]
      );
    });

    it("does not resume a destroy from a removed dump: a later run archives the VM afresh", async () => {
      setCommitEnv();
      const first = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (deleteProxmoxInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 610\n",
      });
      await runDormantReclaimSweep({ now: NOW });

      // The next day the same row is selected again, with the revert it was left with.
      const second = installDatabase({ candidates: [first.live()], live: first.live() });
      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ archived: 1, reclaimed: 1, failed: 0 });
      expect(archiveProxmoxDormantInstance).toHaveBeenCalledTimes(2);
      expect(second.archiveInsert).toHaveBeenCalledTimes(1);
      // The destroy follows the new dump, never the removed one.
      expect((deleteProxmoxInstance as jest.Mock).mock.invocationCallOrder[1]).toBeGreaterThan(
        (archiveProxmoxDormantInstance as jest.Mock).mock.invocationCallOrder[1]
      );
    });

    it("keeps the dump and the dormant_reclaiming record on re-entry while the VM is running", async () => {
      // Re-entry does not know the pre-archive reason any more, so the row cannot be reverted
      // to it. It stays reclaimable with its dump, and the next sweep decides again.
      setCommitEnv();
      const db = installDatabase({ candidates: [reEntryRow], live: reEntryRow });
      (deleteProxmoxInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 610\n",
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      // The only write is the rotation stamp; the marker and the dump are left as they were.
      expect(db.instanceUpdate).toHaveBeenCalledTimes(1);
      expectOnlyRotationStamp(db.instanceUpdate.mock.calls);
      expect(removeProxmoxDormantArchive).not.toHaveBeenCalled();
      expect(db.archiveDelete).not.toHaveBeenCalled();
      expect(db.live()).toMatchObject({ paused_reason: "dormant_reclaiming" });
    });

    it("reverts the archive record when a settings save lands between its read and its update", async () => {
      setCommitEnv();
      const ownerConfig = {
        infrastructure: infra,
        dormantArchive: {
          archiveId: "archive_610",
          archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
          archivedAt: NOW.toISOString(),
        },
        settings: { model: "owner-choice" },
      };
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (deleteProxmoxInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerSavesConfigAfterNextRead(ownerConfig);
        return { ok: false, stdout: "", stderr: "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 610\n" };
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      // The owner's save is kept; only the sweep's own record is taken off it.
      expect(db.live()).toMatchObject({ paused_reason: "inactivity", lifecycle_state: "paused" });
      expect(db.live().config).toEqual({ infrastructure: infra, settings: { model: "owner-choice" } });
      expect(removeProxmoxDormantArchive).toHaveBeenCalledTimes(1);
      expect(db.archiveDelete).toHaveBeenCalledTimes(1);
    });

    it("skips a paused row whose guest is running at dump time: nothing dumped, recorded or destroyed", async () => {
      // A paused row can have a running guest: a PVE host reboot starts onboot guests, or
      // the owner started it outside the row. The host refuses to dump a guest that is not
      // exactly stopped, so the sweep must record no archive, write no marker and destroy
      // nothing, and the row stays paused for the owner.
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: `${DORMANT_ARCHIVE_NOT_STOPPED_MARKER} 610 state=running\n`,
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ archived: 0, reclaimed: 0, skipped: 1, failed: 0 });
      expect(archiveProxmoxDormantInstance).toHaveBeenCalledTimes(1);
      expect(db.archiveInsert).not.toHaveBeenCalled();
      expect(db.instanceUpdate).toHaveBeenCalledTimes(1);
      expectOnlyRotationStamp(db.instanceUpdate.mock.calls);
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
      expect(db.live()).toMatchObject({ lifecycle_state: "paused", paused_reason: "inactivity" });
    });

    it("does not record or destroy a row whose VMID the host reports as another instance's guest", async () => {
      // The host refuses the dump when the VMID holds a guest with another identity. That
      // is a failure for this row: nothing is recorded, marked or destroyed.
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (archiveProxmoxDormantInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "HERMES_VM_IDENTITY_MISMATCH 610\n",
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ archived: 0, reclaimed: 0, failed: 1 });
      expect(db.archiveInsert).not.toHaveBeenCalled();
      expect(db.instanceUpdate).toHaveBeenCalledTimes(1);
      expectOnlyRotationStamp(db.instanceUpdate.mock.calls);
      expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    });

    it("treats a host refusal to destroy a running VM as skipped and writes no terminal state", async () => {
      setCommitEnv();
      const db = installDatabase({ candidates: [dormantRow], live: dormantRow });
      (deleteProxmoxInstance as jest.Mock).mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 610\n",
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, skipped: 1, failed: 0 });
      // Marker, then the revert back to a plain paused row. No terminal state is written.
      expect(db.instanceUpdate).toHaveBeenCalledTimes(2);
      expect(db.instanceUpdate.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ paused_reason: "dormant_reclaiming" })
      );
      expect(db.instanceUpdate.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ paused_reason: "inactivity", lifecycle_substate: null })
      );
      expect(db.instanceUpdate.mock.calls[1]?.[0].config).not.toHaveProperty("dormantArchive");
      expect(db.live()).not.toHaveProperty("paused_reason", "dormant_reclaimed");
    });

    it("keeps settings the owner saves while the VM is destroyed in the terminal write", async () => {
      setCommitEnv();
      const ownerConfig = {
        infrastructure: infra,
        dormantArchive: (reEntryRow.config as Row).dormantArchive,
        settings: { model: "owner-choice" },
      };
      const db = installDatabase({ candidates: [reEntryRow], live: reEntryRow });
      (deleteProxmoxInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerSavesConfig(ownerConfig);
        return { ok: true, stdout: "deleted", stderr: "" };
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 1, failed: 0 });
      expect(db.instanceUpdate.mock.calls[0]?.[0].config).toEqual(
        expect.objectContaining({
          settings: { model: "owner-choice" },
          dormantArchive: expect.objectContaining({ archiveId: "archive_610" }),
        })
      );
      expect(db.instanceUpdate.mock.calls[0]?.[0].config).not.toHaveProperty("infrastructure");
    });

    it("does not write back a config over a settings save that lands between the terminal read and the update", async () => {
      // The terminal write merges from a read one round trip before its update. A save in
      // that gap must make the update refuse, not be overwritten. The VM is already gone, so
      // the row stays dormant_reclaiming and the next sweep finishes it.
      setCommitEnv();
      const ownerConfig = {
        infrastructure: infra,
        dormantArchive: (reEntryRow.config as Row).dormantArchive,
        settings: { model: "owner-choice" },
      };
      const db = installDatabase({ candidates: [reEntryRow], live: reEntryRow });
      (deleteProxmoxInstance as jest.Mock).mockImplementationOnce(async () => {
        db.ownerSavesConfigAfterNextRead(ownerConfig);
        return { ok: true, stdout: "deleted", stderr: "" };
      });

      const summary = await runDormantReclaimSweep({ now: NOW });

      expect(summary).toMatchObject({ reclaimed: 0, failed: 1 });
      // The terminal write refused; the only write after it is the rotation stamp.
      expect(db.instanceUpdate).toHaveBeenCalledTimes(2);
      expectOnlyRotationStamp(db.instanceUpdate.mock.calls.slice(1));
      expect(db.live()).toMatchObject({ paused_reason: "dormant_reclaiming" });
      expect(db.live().config).toEqual(expect.objectContaining({ settings: { model: "owner-choice" } }));
    });
  });

  describe("a batch of rows the sweep skips", () => {
    // Ten older paused rows the sweep cannot act on, and one newer row it can reclaim. The batch
    // holds ten rows, so the newer row is only reached once the older rows stop filling it.
    const STUCK_ROWS = 10;
    type StuckKind = "not_stopped" | "identity_mismatch" | "agent_usage";

    function batchRows(): Row[] {
      return Array.from({ length: STUCK_ROWS + 1 }, (_, index) => {
        const n = index + 1;
        const id = `inst_${String(n).padStart(2, "0")}`;
        const pausedAt =
          n <= STUCK_ROWS
            ? `2026-04-${String(n).padStart(2, "0")}T00:00:00.000Z`
            : "2026-05-01T00:00:00.000Z";
        return {
          ...dormantRow,
          id,
          user_id: `user_${n}`,
          subdomain: id,
          gateway_url: `https://${id}.agents.hermesos.cloud`,
          last_lifecycle_transition_at: pausedAt,
          updated_at: pausedAt,
        };
      });
    }

    // A stand-in for public.hermes_instances that applies the candidate query's filters,
    // its order and its batch limit, and applies conditional updates the way PostgREST does,
    // with the table's trigger moving updated_at. The fixed candidate list above cannot show
    // which rows a batch of ten would pick.
    function installTable(rows: Row[], usageActiveFor: string[]) {
      let tick = 0;
      const clock = () => new Date(Date.parse(NOW.toISOString()) + ++tick * 1000).toISOString();

      const instanceUpdate = jest.fn((payload: Row) => {
        const eqs: Array<[string, unknown]> = [];
        const query: Record<string, unknown> = {};
        query.eq = jest.fn((column: string, value: unknown) => {
          eqs.push([column, value]);
          return query;
        });
        query.select = jest.fn(() => query);
        query.maybeSingle = jest.fn(async () => {
          const row = rows.find((r) => eqs.every(([c, v]) => r[c] === v));
          if (!row) return { data: null, error: null };
          Object.assign(row, payload, { updated_at: clock() });
          return { data: { id: row.id }, error: null };
        });
        return query;
      });

      const instanceSelect = () => {
        const eqs: Array<[string, unknown]> = [];
        const predicates: Array<(r: Row) => boolean> = [];
        let orderColumn: string | null = null;
        let ascending = true;
        const query: Record<string, unknown> = {};
        query.eq = jest.fn((column: string, value: unknown) => {
          eqs.push([column, value]);
          predicates.push((r) => r[column] === value);
          return query;
        });
        query.in = jest.fn((column: string, values: unknown[]) => {
          predicates.push((r) => values.includes(r[column]));
          return query;
        });
        query.lt = jest.fn((column: string, value: string) => {
          predicates.push((r) => String(r[column]) < value);
          return query;
        });
        query.order = jest.fn((column: string, options: { ascending: boolean }) => {
          orderColumn = column;
          ascending = options.ascending;
          return query;
        });
        query.limit = jest.fn(async (n: number) => {
          const matched = rows.filter((r) => predicates.every((p) => p(r)));
          if (orderColumn) {
            const column = orderColumn;
            matched.sort((a, b) => {
              const left = String(a[column]);
              const right = String(b[column]);
              if (left === right) return 0;
              return (left < right ? -1 : 1) * (ascending ? 1 : -1);
            });
          }
          return { data: matched.slice(0, n).map((r) => ({ ...r })), error: null };
        });
        query.maybeSingle = jest.fn(async () => {
          const row = rows.find((r) => eqs.every(([c, v]) => r[c] === v));
          return { data: row ? { ...row } : null, error: null };
        });
        return query;
      };

      const usageQuery = () => {
        let instanceId: unknown = null;
        const query: Record<string, unknown> = {};
        query.select = jest.fn(() => query);
        query.eq = jest.fn((_column: string, value: unknown) => {
          instanceId = value;
          return query;
        });
        query.gt = jest.fn(() => query);
        query.gte = jest.fn(() => query);
        query.limit = jest.fn(async () => ({
          data: usageActiveFor.includes(String(instanceId)) ? [{ instance_id: instanceId }] : [],
          error: null,
        }));
        return query;
      };

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        if (table === "hermes_instances") {
          return { select: jest.fn(() => instanceSelect()), update: instanceUpdate };
        }
        if (table === "instance_usage_snapshots") return usageQuery();
        if (table === "instance_dormancy_archives") {
          return {
            insert: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(async () => ({ data: { id: "archive_batch" }, error: null })),
              })),
            })),
            delete: jest.fn(() => ({ eq: jest.fn(async () => ({ error: null })) })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      return {
        row: (id: string) => rows.find((r) => r.id === id) as Row,
        instanceUpdate,
      };
    }

    it.each([
      ["a running guest at dump time", "not_stopped"],
      ["an identity mismatch on the guest", "identity_mismatch"],
      ["agent-side usage before the pause", "agent_usage"],
    ] as Array<[string, StuckKind]>)(
      "a newer reclaimable row is archived by the next run when the older rows have %s",
      async (_label, kind) => {
        setCommitEnv();
        const rows = batchRows();
        const stuckIds = rows.slice(0, STUCK_ROWS).map((r) => r.id as string);
        const table = installTable(rows, kind === "agent_usage" ? stuckIds : []);
        (archiveProxmoxDormantInstance as jest.Mock).mockImplementation(
          async (_infra: unknown, opts: { instanceId: string }) => {
            const stuck = stuckIds.includes(opts.instanceId);
            if (stuck && kind === "not_stopped") {
              return {
                ok: false,
                stdout: "",
                stderr: `${DORMANT_ARCHIVE_NOT_STOPPED_MARKER} 610 state=running\n`,
              };
            }
            if (stuck && kind === "identity_mismatch") {
              return { ok: false, stdout: "", stderr: "HERMES_VM_IDENTITY_MISMATCH 610\n" };
            }
            return archiveOk();
          }
        );

        const first = await runDormantReclaimSweep({ now: NOW });
        const second = await runDormantReclaimSweep({ now: NOW });

        expect(first.reclaimed).toBe(0);
        expect(second.reclaimed).toBe(1);
        expect(table.row("inst_11")).toMatchObject({
          lifecycle_state: "paused",
          paused_reason: "dormant_reclaimed",
        });
        // Only the newer row is destroyed. The skipped rows stay paused, for the owner.
        expect(deleteProxmoxInstance).toHaveBeenCalledTimes(1);
        expect(deleteProxmoxInstance).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ expectedInstanceId: "inst_11" })
        );
        for (const id of stuckIds) {
          expect(table.row(id)).toMatchObject({ lifecycle_state: "paused", paused_reason: "inactivity" });
        }
      }
    );
  });
});
