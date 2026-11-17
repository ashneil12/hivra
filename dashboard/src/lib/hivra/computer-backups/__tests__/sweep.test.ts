jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn(), runProxmoxHostScriptWithStdin: jest.fn() }));
jest.mock("@/lib/hivra/agent-wake", () => ({ resolveSleepTarget: jest.fn() }));

import {
  computerBackupPassword,
  computerBackupSettings,
  computerBackupsMode,
  pickNextJob,
  runComputerBackupSweep,
  type BackupRow,
} from "../sweep";

const NOW = Date.parse("2026-11-17T20:00:00Z");
const settings = computerBackupSettings({});
const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: "u", vmid: 1100, proxmox_host: "alpha", status: "running", sleep_state: "awake", ...extra,
});
const row = (agentId: string, kind: BackupRow["kind"], hoursAgo: number, disks = true): BackupRow => ({
  id: `${agentId}-${kind}-${hoursAgo}`, agent_id: agentId, user_id: "u", kind, status: "succeeded", proxmox_host: "alpha",
  vmid: 1100, reason: null, disks: disks ? [{ key: "scsi0", sha256: "a".repeat(64), bytes: 1, snapshotId: "b".repeat(64) }] : [],
  started_at: new Date(NOW - hoursAgo * 3_600_000).toISOString(), finished_at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
});

describe("computer backup sweep", () => {
  it("is off unless the switch says dry or on", () => {
    expect(computerBackupsMode({})).toBe("off");
    expect(computerBackupsMode({ HIVRA_COMPUTER_BACKUPS: "yes" })).toBe("off");
    expect(computerBackupsMode({ HIVRA_COMPUTER_BACKUPS: "On" })).toBe("on");
    expect(computerBackupsMode({ HIVRA_COMPUTER_BACKUPS: "dry" })).toBe("dry");
  });

  it("reads retention from settings, with safe defaults", () => {
    expect(settings.keepDaily).toBe(7);
    expect(settings.keepWeekly).toBe(4);
    expect(computerBackupSettings({ HIVRA_COMPUTER_BACKUPS_KEEP_DAILY: "14" }).keepDaily).toBe(14);
    expect(computerBackupSettings({ HIVRA_COMPUTER_BACKUPS_KEEP_DAILY: "-1" }).keepDaily).toBe(7);
    expect(computerBackupSettings({ HIVRA_COMPUTER_BACKUPS_HOSTS: "ALPHA, beta" }).hosts).toEqual(new Set(["alpha", "beta"]));
  });

  it("derives a distinct password per computer, and none without a key", () => {
    const env = { HIVRA_COMPUTER_BACKUP_KEY: "k" };
    expect(computerBackupPassword("a", env)).toHaveLength(64);
    expect(computerBackupPassword("a", env)).not.toBe(computerBackupPassword("b", env));
    expect(computerBackupPassword("a", {})).toBeNull();
  });

  it("backs up the awake computer whose copy is oldest first", () => {
    const pick = pickNextJob({
      agents: [agent("fresh"), agent("old"), agent("never")],
      lastBackup: new Map([["fresh", row("fresh", "backup", 2)], ["old", row("old", "backup", 30)]]),
      lastDrill: new Map(), now: NOW, settings,
    });
    expect(pick?.kind).toBe("backup");
    expect(pick?.agent.id).toBe("never");
  });

  it("skips asleep computers for backups, and drills once nothing is due", () => {
    const pick = pickNextJob({
      agents: [agent("sleepy", { sleep_state: "hibernated" }), agent("fresh")],
      lastBackup: new Map([["fresh", row("fresh", "backup", 2)], ["sleepy", row("sleepy", "backup", 40)]]),
      lastDrill: new Map([["fresh", row("fresh", "drill", 24)]]), now: NOW, settings,
    });
    expect(pick?.kind).toBe("drill");
    expect(pick?.agent.id).toBe("sleepy");
  });

  it("does nothing when everything is fresh and checked", () => {
    expect(pickNextJob({
      agents: [agent("a")],
      lastBackup: new Map([["a", row("a", "backup", 2)]]),
      lastDrill: new Map([["a", row("a", "drill", 2)]]), now: NOW, settings,
    })).toBeNull();
  });

  it("does nothing while off, or without a backup key", async () => {
    expect(await runComputerBackupSweep({ env: {} })).toMatchObject({ skipped: true, reason: "flag_off" });
    expect(await runComputerBackupSweep({ env: { HIVRA_COMPUTER_BACKUPS: "on" }, db: {} })).toMatchObject({ skipped: true, reason: "no_backup_key" });
  });

  it("does not back a computer up again in the same run its backup finished", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000b1";
    const agentId = "00000000-0000-4000-8000-0000000000a1";
    const tables: Record<string, unknown[]> = {
      hivra_agents: [agent(agentId)],
      hivra_computer_backups: [{ ...row(agentId, "backup", 0.2), id: jobId, status: "running", finished_at: null, disks: [] }],
    };
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const db = {
      from(table: string) {
        const builder: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "neq", "not", "in", "order", "limit"]) builder[m] = () => builder;
        builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
        builder.insert = async (value: unknown) => { inserts.push(value); return { error: null }; };
        builder.update = (value: unknown) => { updates.push(value); return builder; };
        return builder;
      },
    };
    const disk = { key: "scsi0", sha256: "a".repeat(64), bytes: 1, snapshotId: "b".repeat(64) };
    const runHostScript = jest.fn(async () => ({
      stdout: `HIVRA_BACKUP_JOB ${jobId} ${JSON.stringify({ job: jobId, kind: "backup", status: "succeeded", reason: "saved", addedBytes: 5, disks: [disk] })}\n`,
    }));
    const runHostScriptWithStdin = jest.fn();
    const resolveTarget = jest.fn(async () => ({ ok: true, target: { env: {}, vmid: 1100, bindingTag: `hivra-bind-${"c".repeat(32)}` } }));
    const summary = await runComputerBackupSweep({
      env: { HIVRA_COMPUTER_BACKUPS: "on", HIVRA_COMPUTER_BACKUP_KEY: "k".repeat(32) },
      db, now: () => NOW, runHostScript, runHostScriptWithStdin, resolveTarget,
    } as never);
    expect(summary.finished).toEqual({ backup_succeeded: 1 });
    // The fresh copy is next checked by a drill, never copied a second time.
    expect(inserts).toEqual([expect.objectContaining({ kind: "drill", source_backup_id: jobId })]);
  });

  describe("removing a deleted computer's copies", () => {
    const goneId = "00000000-0000-4000-8000-0000000000d1";
    const env = { HIVRA_COMPUTER_BACKUPS: "on", HIVRA_COMPUTER_BACKUP_KEY: "k".repeat(32), HIVRA_COMPUTER_BACKUPS_HOSTS: "alpha" };
    // Each read of a table takes the next answer from its queue.
    const fakeDb = (answers: Record<string, Array<{ data: unknown; error: unknown }>>) => {
      const inserts: Array<Record<string, unknown>> = [];
      const db = {
        from(table: string) {
          const builder: Record<string, unknown> = {};
          for (const m of ["select", "eq", "is", "neq", "not", "in", "order", "limit"]) builder[m] = () => builder;
          builder.then = (resolve: (v: unknown) => unknown) => resolve(answers[table]?.shift() ?? { data: [], error: null });
          builder.insert = async (value: Record<string, unknown>) => { inserts.push(value); return { error: null }; };
          builder.update = () => builder;
          return builder;
        },
      };
      return { db, inserts };
    };
    const run = (db: unknown, runHostScript = jest.fn(async () => ({ stdout: "" }))) => runComputerBackupSweep({
      env, db, now: () => NOW, runHostScript, runHostScriptWithStdin: jest.fn(),
      resolveTarget: jest.fn(async () => ({ ok: true, target: { env: {}, vmid: 1100, bindingTag: `hivra-bind-${"c".repeat(32)}` } })),
      newId: () => "00000000-0000-4000-8000-0000000000e1",
    } as never);
    const copy = { ...row(goneId, "backup", 30), id: "00000000-0000-4000-8000-0000000000c1" };

    it("removes nothing when the database cannot say whether the computer is gone", async () => {
      const { db, inserts } = fakeDb({
        hivra_agents: [{ data: [], error: null }, { data: null, error: { message: "column does not exist" } }],
        hivra_computer_backups: [{ data: [copy], error: null }],
      });
      const hostScript = jest.fn(async () => ({ stdout: "" }));
      const summary = await run(db, hostScript);
      expect(hostScript).not.toHaveBeenCalled();
      expect(inserts).toHaveLength(0);
      expect(summary.errors).toBe(1);
    });

    it("first notes a deleted computer, and waits out the grace period before removing its copies", async () => {
      const { db, inserts } = fakeDb({
        hivra_agents: [{ data: [], error: null }, { data: [{ id: goneId, status: "deleted" }], error: null }],
        hivra_computer_backups: [{ data: [copy], error: null }],
      });
      const hostScript = jest.fn(async () => ({ stdout: "" }));
      const summary = await run(db, hostScript);
      expect(hostScript).not.toHaveBeenCalled();
      expect(inserts).toEqual([expect.objectContaining({ kind: "purge", status: "skipped", reason: "deleted_waiting" })]);
      expect(summary.refused).toMatchObject({ purge_waiting: 1 });

      const note = { ...row(goneId, "purge", 2), status: "skipped" as const, reason: "deleted_waiting" };
      const second = fakeDb({
        hivra_agents: [{ data: [], error: null }, { data: [{ id: goneId, status: "deleted" }], error: null }],
        hivra_computer_backups: [{ data: [note, copy], error: null }],
      });
      await run(second.db, hostScript);
      expect(hostScript).not.toHaveBeenCalled();
      expect(second.inserts).toHaveLength(0);
    });

    it("removes the copies once the computer has been gone past the grace period", async () => {
      const note = { ...row(goneId, "purge", 25), status: "skipped" as const, reason: "deleted_waiting" };
      // A live computer on the same host, freshly copied, is how the sweep reaches the host.
      const liveId = "00000000-0000-4000-8000-0000000000a2";
      const { db, inserts } = fakeDb({
        hivra_agents: [{ data: [agent(liveId)], error: null }, { data: [{ id: goneId, status: "deleted" }], error: null }],
        hivra_computer_backups: [{ data: [note, copy, row(liveId, "backup", 1), row(liveId, "drill", 1)], error: null }],
      });
      const hostScript = jest.fn(async () => ({ stdout: 'HIVRA_BACKUP_PURGE {"ok":true,"reason":"removed"}\n' }));
      await run(db, hostScript);
      expect(hostScript).toHaveBeenCalledTimes(1);
      expect(inserts).toEqual([expect.objectContaining({ kind: "purge" })]);
    });

    it("leaves a computer that is alive but on another host alone", async () => {
      const { db, inserts } = fakeDb({
        hivra_agents: [{ data: [], error: null }, { data: [{ id: goneId, status: "running" }], error: null }],
        hivra_computer_backups: [{ data: [copy], error: null }],
      });
      const hostScript = jest.fn(async () => ({ stdout: "" }));
      await run(db, hostScript);
      expect(hostScript).not.toHaveBeenCalled();
      expect(inserts).toHaveLength(0);
    });
  });
});
