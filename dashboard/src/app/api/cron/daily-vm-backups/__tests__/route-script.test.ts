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

  it("skips memory-backed scratch roots unless they are named explicitly", () => {
    const embedded = decodeEmbeddedDailyBackupScript();

    expect(embedded).toContain("skipped=memory_backed");
    expect(embedded).toContain('[ -z "${HERMES_DAILY_BACKUP_SCRATCH_ROOTS:-}" ] && { [ "$fs" = tmpfs ] || [ "$fs" = ramfs ]; }');
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
    expect(processCandidate).toContain("${HOST_BACKUP_DEADLINE}");
    expect(processCandidate.indexOf("buildInstallDailyBackupScript()")).toBeLessThan(
      processCandidate.indexOf('"/usr/local/sbin/backup-vm-daily.sh"')
    );
  });

  it("keeps a host-side deadline on detached backup writers, sized for a full dump+upload", () => {
    const route = readRepoFile("src/app/api/cron/daily-vm-backups/route.ts");
    // The bound only kills wedged runs now: the archive conflict is prevented
    // by the per-VM storage-op lock below, not by a wall-clock short enough to
    // terminate a legitimate ~46-minute backup mid-upload.
    expect(route).toContain('DETACHED_BACKUP_DEADLINE = "timeout --kill-after=10s 6h"');
    expect(route).toContain("nohup ${DETACHED_BACKUP_DEADLINE} /usr/local/sbin/backup-vm-daily.sh");
  });

  it("holds a per-VM storage-op lock across the whole write path", () => {
    const sourceScript = readRepoFile("scripts/ops/backup-vm-daily.sh");
    // The lock is what lets a long backup run past the pause→archive window:
    // archive-vm-cold.sh refuses while it is held, so the destroy step can
    // never land mid-dump or mid-upload. It must be taken before vzdump and
    // after the preflight-only exit (diagnostics never contend for it), and
    // the fd stays open through the manifest write.
    const lock = sourceScript.indexOf('flock -n 9');
    expect(sourceScript).toContain("/run/hermes-vm-${VMID}.storage-op.lock");
    expect(sourceScript).toContain("REFUSING_BACKUP_STORAGE_OP_IN_FLIGHT");
    expect(lock).toBeGreaterThan(sourceScript.indexOf("PREFLIGHT_OK"));
    expect(lock).toBeLessThan(sourceScript.indexOf('vzdump "$VMID"'));
  });

  it("the cold archive refuses while a daily backup holds the VM's storage-op lock", () => {
    const archiveScript = readRepoFile("scripts/ops/archive-vm-cold.sh");
    // Same lock file, non-blocking: a backup in flight defers the archive to
    // a later tick instead of racing it to `qm destroy --skiplock`.
    const lock = archiveScript.indexOf('flock -n 9');
    expect(archiveScript).toContain("/run/hermes-vm-${VMID}.storage-op.lock");
    expect(archiveScript).toContain("REFUSING_ARCHIVE_STORAGE_OP_IN_FLIGHT");
    expect(lock).toBeLessThan(archiveScript.indexOf('qm start "$VMID"'));
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

describe("daily VM backup age encryption", () => {
  const script = readRepoFile("scripts/ops/backup-vm-daily.sh");
  const route = readRepoFile("src/app/api/cron/daily-vm-backups/route.ts");

  it("refuses with distinct codes before vzdump, never installing age", () => {
    expect(script).toContain("REFUSING_BACKUP_NO_AGE");
    expect(script).toContain("REFUSING_BACKUP_BAD_AGE_RECIPIENT");
    expect(script).toContain("^age1[0-9a-z]{58}$");
    expect(script.indexOf("REFUSING_BACKUP_NO_AGE")).toBeLessThan(script.indexOf('vzdump "$VMID"'));
    expect(script).not.toMatch(/apt(-get)? install/);
  });

  it("encrypts before upload, uploads the .age file and drops the plaintext", () => {
    const enc = script.indexOf('age -r "$BACKUP_AGE_RECIPIENT" -o "$ARCHIVE.age" "$ARCHIVE"');
    expect(enc).toBeGreaterThan(script.indexOf('vzdump "$VMID"'));
    expect(enc).toBeLessThan(script.indexOf('rsync -a --inplace --partial -e ssh "$ARCHIVE"'));
    expect(script).toContain('REMOTE_ARCHIVE="$REMOTE_ARCHIVE.age"');
    expect(script).toContain('"plain_sha256"');
  });

  it("retention accepts and deletes the .age path", () => {
    expect(script).toContain(String.raw`\.vma\.zst(\.age)?$"`);
  });

  it("the route refuses to back up when the switch is on and the recipient is unusable", () => {
    expect(route).toContain("resolveBackupEncryption(process.env)");
    expect(route).toContain("backup_encryption_misconfigured");
    expect(route.indexOf("backup_encryption_misconfigured")).toBeLessThan(route.indexOf("const results = {"));
  });

  it("only the public recipient reaches script command lines", () => {
    expect(route).toContain("backupEncryptionEnvPrefix");
    expect(route).not.toContain("process.env.HERMES_BACKUP_AGE_IDENTITY");
    expect(script).not.toContain("HERMES_BACKUP_AGE_IDENTITY");
  });

  it("restore smoke understands .age backups and owns removal of the identity file", () => {
    const smoke = decodeEmbeddedDailyBackupScript(); // keep the b64 constant parsed
    expect(smoke).toBe(script);
    expect(route).toContain("age -d -i \"$HERMES_BACKUP_AGE_IDENTITY_FILE\"");
    expect(route).toContain("removeOnExit: false");
    expect(route).toContain("hermes-age-identity.*) trap");
  });
});
