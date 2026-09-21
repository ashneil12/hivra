import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "../../../../../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function decodeEmbeddedResticScript(): string {
  const route = readRepoFile("src/app/api/cron/daily-instance-backups/route.ts");
  const match = route.match(/const RESTIC_BACKUP_SCRIPT_B64 =\s*"([^"]+)";/);
  if (!match) throw new Error("RESTIC_BACKUP_SCRIPT_B64 constant not found");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("daily instance (restic) backup host script", () => {
  const sourceScript = readRepoFile("scripts/ops/backup-vm-restic.sh");

  it("keeps the embedded route installer in sync with the ops script", () => {
    expect(decodeEmbeddedResticScript()).toBe(sourceScript);
  });

  it("keeps the universal backup safety net enabled for the base tier", () => {
    expect(sourceScript).toContain("refusing restic backup for unsupported tier");
    expect(sourceScript).toMatch(/operator\|fleet\|command/);
    expect(sourceScript).toContain("credit_base");
  });

  it("refuses to stage a new mirror when host-root headroom is low", () => {
    expect(sourceScript).toContain("HERMES_RESTIC_MIN_DISK_FLOOR_MB");
    expect(sourceScript).toContain("REFUSING_BACKUP_LOW_HOST_DISK");
    expect(sourceScript).toContain('df -BM --output=avail "$MIRROR_ROOT"');
  });

  it("excludes regenerable caches but keeps chat/session state", () => {
    expect(sourceScript).toContain("home/.cache");
    expect(sourceScript).toContain("home/.npm");
    expect(sourceScript).toContain("node_modules");
  });

  it("backs up the data volumes, not the whole disk (granular)", () => {
    expect(sourceScript).toContain("_webui-state/_data");
    expect(sourceScript).toContain("_webui-workspace/_data");
    // never invokes vzdump (the word may appear in explanatory comments).
    expect(sourceScript).not.toContain('vzdump "');
  });

  it("keeps the cold-storage credential host-side and reads guest data via sudo rsync", () => {
    expect(sourceScript).toContain('--rsync-path="sudo rsync"');
    expect(sourceScript).toContain("sftp:cold:restic/");
    // the guest hop uses the vm-orchestrator key; the cold-storage key is never referenced
    // inside this script (it lives only in the host's ssh config, installed by the caller).
    expect(sourceScript).not.toContain("hermes-hetzner");
  });

  it("retries rsync and prunes with a retention policy", () => {
    expect(sourceScript).toContain("RSYNC_RETRY");
    expect(sourceScript).toContain("--keep-daily");
    expect(sourceScript).toContain("forget");
  });

  it("removes the host-root staging mirror only after a verified backup", () => {
    expect(sourceScript).toContain("RESTIC_MIRROR_CLEANUP_OK");
    expect(sourceScript).toContain('case "$SRC" in');
    expect(sourceScript).toContain('"$MIRROR_ROOT"/"$INSTANCE_ID")');

    const backupOk = sourceScript.indexOf("RESTIC_BACKUP_OK");
    const cleanupOk = sourceScript.indexOf("RESTIC_MIRROR_CLEANUP_OK");
    expect(backupOk).toBeGreaterThan(-1);
    expect(cleanupOk).toBeGreaterThan(backupOk);
  });

  it("refuses --apply without a repo password", () => {
    expect(sourceScript).toContain("REFUSING_BACKUP_NO_RESTIC_PASSWORD");
  });

  it("derives a per-instance repo password from the master key (route side)", () => {
    const route = readRepoFile("src/app/api/cron/daily-instance-backups/route.ts");
    expect(route).toContain("HERMES_RESTIC_MASTER_KEY");
    expect(route).toContain('createHmac("sha256"');
  });
});
