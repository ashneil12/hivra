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
  id, user_id: "u", vmid: 1100, proxmox_host: "pve11", status: "running", sleep_state: "awake", ...extra,
});
const row = (agentId: string, kind: BackupRow["kind"], hoursAgo: number, disks = true): BackupRow => ({
  id: `${agentId}-${kind}-${hoursAgo}`, agent_id: agentId, user_id: "u", kind, status: "succeeded", proxmox_host: "pve11",
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
    expect(computerBackupSettings({ HIVRA_COMPUTER_BACKUPS_HOSTS: "PVE11, pve12" }).hosts).toEqual(new Set(["pve11", "pve12"]));
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
});
