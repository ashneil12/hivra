import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "../../../../../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function decodeEmbeddedDailyBackupScript(): string {
  const route = readRepoFile("src/app/api/cron/daily-vm-backups/route.ts");
  const match = route.match(/const DAILY_BACKUP_SCRIPT_B64 =\s*"([^"]+)";/);
  if (!match) throw new Error("DAILY_BACKUP_SCRIPT_B64 constant not found");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("daily VM backup host script", () => {
  it("keeps the embedded route installer in sync with the ops script", () => {
    const sourceScript = readRepoFile("scripts/ops/backup-vm-daily.sh");

    expect(decodeEmbeddedDailyBackupScript()).toBe(sourceScript);
  });

  it("refuses live snapshot backups when host memory headroom is unsafe", () => {
    const sourceScript = readRepoFile("scripts/ops/backup-vm-daily.sh");

    expect(sourceScript).toContain("HERMES_DAILY_BACKUP_MIN_HOST_HEADROOM_MB");
    expect(sourceScript).toContain("MEMORY_PREFLIGHT");
    expect(sourceScript).toContain("REFUSING_BACKUP_LOW_HOST_MEMORY");
    expect(sourceScript).toContain('if [ "$MEM_AVAILABLE_MB" -lt "$MIN_HOST_HEADROOM_MB" ]; then');
    expect(sourceScript.indexOf("REFUSING_BACKUP_LOW_HOST_MEMORY")).toBeLessThan(
      sourceScript.indexOf('vzdump "$VMID"')
    );
  });

  it("refuses live snapshot backups when running VM balloon target leaves no host reserve", () => {
    const sourceScript = readRepoFile("scripts/ops/backup-vm-daily.sh");

    expect(sourceScript).toContain("RUNNING_VM_EFFECTIVE_MEMORY_MB");
    expect(sourceScript).toContain("REFUSING_BACKUP_UNSAFE_VM_MEMORY_FOOTPRINT");
    expect(sourceScript).toContain('if [ "$HOST_MEMORY_MARGIN_MB" -lt "$MIN_HOST_HEADROOM_MB" ]; then');
    expect(sourceScript.indexOf("REFUSING_BACKUP_UNSAFE_VM_MEMORY_FOOTPRINT")).toBeLessThan(
      sourceScript.indexOf('vzdump "$VMID"')
    );
  });

  it("treats a configured balloon value as the running VM backup footprint", () => {
    const sourceScript = readRepoFile("scripts/ops/backup-vm-daily.sh");

    expect(sourceScript).toContain("RUNNING_VM_BALLOON_MB");
    expect(sourceScript).toContain("RUNNING_VM_EFFECTIVE_MEMORY_MB=\"$RUNNING_VM_BALLOON_MB\"");
    expect(sourceScript).toContain("running_vm_effective_memory_mb=$RUNNING_VM_EFFECTIVE_TOTAL_MB");
    expect(sourceScript).toContain("running_vm_max_memory_mb=$RUNNING_VM_MAX_MEMORY_MB");
  });

  it("reinstalls the guarded host backup script before automatic apply runs", () => {
    const route = readRepoFile("src/app/api/cron/daily-vm-backups/route.ts");
    const processCandidate = route.slice(
      route.indexOf("async function processCandidate"),
      route.indexOf("await Promise.all(")
    );

    expect(processCandidate).toContain("buildInstallDailyBackupScript()");
    expect(processCandidate.indexOf("buildInstallDailyBackupScript()")).toBeLessThan(
      processCandidate.indexOf('"/usr/local/sbin/backup-vm-daily.sh"')
    );
  });

  it("runs real memory preflight without starting vzdump for host-preflight", () => {
    const route = readRepoFile("src/app/api/cron/daily-vm-backups/route.ts");
    const preflightScript = route.slice(
      route.indexOf("function buildHostPreflightScript"),
      route.indexOf("function buildDetachedApplyScript")
    );

    expect(preflightScript).toContain("HERMES_DAILY_BACKUP_PREFLIGHT_ONLY=1");
    expect(preflightScript).toContain("--apply");
  });
});
