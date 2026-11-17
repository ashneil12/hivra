jest.mock("server-only", () => ({}));

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  backupRepository,
  buildBackupPollScript,
  buildBackupPurgeScript,
  buildBackupStartScript,
  parseBackupPoll,
  parseBackupPurgeReceipt,
  parseBackupStartReceipt,
  type BackupStartInput,
} from "../scripts";

const JOB = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000aa";
const TAG = `hivra-bind-${"a".repeat(32)}`;
const DISK = { key: "scsi0", sha256: "b".repeat(64), bytes: 34359738368, snapshotId: "c".repeat(64) };

function input(overrides: Partial<BackupStartInput> = {}): BackupStartInput {
  return {
    kind: "backup", jobId: JOB, agentId: AGENT, vmid: 1107, bindingTag: TAG,
    keepDaily: 7, keepWeekly: 4, uploadLimitKiB: 0, maxHours: 6,
    coldStorageInstall: "true", ...overrides,
  };
}

function bashSyntax(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "hivra-backup-test-"));
  const file = join(dir, "script.sh");
  writeFileSync(file, script);
  execFileSync("bash", ["-n", file]);
}

/** The job's own files, cut out of the start script's heredocs. */
function heredoc(script: string, marker: string): string {
  const start = script.indexOf(`<<'${marker}'\n`);
  const from = start + `<<'${marker}'\n`.length;
  const end = script.indexOf(`\n${marker}\n`, from);
  if (start < 0 || end < 0) {
    const endAlt = script.indexOf(`${marker}\n`, from);
    return script.slice(from, endAlt);
  }
  return script.slice(from, end + 1);
}

describe("computer backup host scripts", () => {
  it.each(["backup", "drill", "restore"] as const)("builds a %s start script that is valid bash, with valid job files", (kind) => {
    const script = buildBackupStartScript(input({ kind, disks: kind === "backup" ? undefined : [DISK] }));
    bashSyntax(script);
    const run = heredoc(script, "HIVRA_BACKUP_RUN");
    expect(run).toContain("done_with");
    expect(run).not.toContain("$#{");
    bashSyntax(run);
    const read = heredoc(script, "HIVRA_BACKUP_READ");
    expect(read).toContain("PIPESTATUS[@]");
    bashSyntax(read);
  });

  it("never puts the password in the script", () => {
    const script = buildBackupStartScript(input());
    expect(script).toContain("IFS= read -r RESTIC_PW");
    expect(script).toContain(backupRepository(AGENT));
    expect(script).not.toMatch(/RESTIC_PASSWORD=[0-9a-f]{16}/);
  });

  it("only touches a VM behind the exact binding tag and the shared per-VM lock", () => {
    const run = heredoc(buildBackupStartScript(input()), "HIVRA_BACKUP_RUN");
    expect(run).toContain("/run/lock/hivra-vm-$VMID.lock");
    expect(run).toContain("has_binding || done_with failed binding_mismatch");
    expect(run).toContain("done_with skipped not_awake");
    expect(run).toContain("--vmstate 0");
    expect(run).toContain("--keep-daily \"$KEEP_DAILY\"");
  });

  it("refuses bad input", () => {
    expect(() => buildBackupStartScript(input({ bindingTag: "nope" }))).toThrow();
    expect(() => buildBackupStartScript(input({ jobId: "x; rm" }))).toThrow();
    expect(() => buildBackupStartScript(input({ vmid: 0 }))).toThrow();
    expect(() => buildBackupStartScript(input({ kind: "drill", disks: [] }))).toThrow();
    expect(() => buildBackupStartScript(input({ kind: "drill", disks: [{ ...DISK, key: "scsi0;x" }] }))).toThrow();
    expect(() => buildBackupStartScript(input({ coldStorageInstall: "" }))).toThrow();
  });

  it("parses the start receipt for this job only", () => {
    expect(parseBackupStartReceipt(`noise\nHIVRA_BACKUP_START {"ok":true,"reason":"started","job":"${JOB}"}\n`, JOB))
      .toEqual({ ok: true, reason: "started", job: JOB });
    expect(parseBackupStartReceipt(`HIVRA_BACKUP_START {"ok":true,"reason":"started","job":"other"}`, JOB)).toBeNull();
    expect(parseBackupStartReceipt("", JOB)).toBeNull();
  });

  it("builds a valid poll script and parses its lines", () => {
    bashSyntax(buildBackupPollScript([JOB]));
    const result = JSON.stringify({ job: JOB, kind: "backup", status: "succeeded", reason: "saved", addedBytes: 1234, disks: [DISK, { key: "bad" }], finishedAt: "2026-11-17T20:00:00Z" });
    const other = "00000000-0000-4000-8000-000000000002";
    const polled = parseBackupPoll(`HIVRA_BACKUP_JOB ${JOB} ${result}\nHIVRA_BACKUP_JOB ${other} running\n`);
    expect(polled).toEqual([
      { jobId: JOB, state: "finished", status: "succeeded", reason: "saved", addedBytes: 1234, disks: [DISK], finishedAt: "2026-11-17T20:00:00Z" },
      { jobId: other, state: "running" },
    ]);
  });

  it("builds a valid purge script", () => {
    bashSyntax(buildBackupPurgeScript(AGENT, "true"));
    expect(parseBackupPurgeReceipt('HIVRA_BACKUP_PURGE {"ok":true,"reason":"removed"}')).toEqual({ ok: true, reason: "removed" });
  });
});
