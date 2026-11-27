/** @jest-environment node */

// Runs the store and unstore jobs for real against a fake host: the stub qm of
// the sleep tests, plus stand-ins for restic, pvesm, the LVM tools and the
// storage box. The "disk" is a file, and "freeing" it turns it into zeros.

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { backupJobFiles, type BackupDisk, type BackupJobKind } from "../computer-backups/scripts";
import { buildWakeHostScript, parseWakeReceipt } from "../agent-sleep-scripts";
import { AWAKE, COLD, TAG, VMID, makeHostHarness, type HostHarness, type HostState } from "./sleep-stub-host.fixtures";

const hasTools = ["bash", "python3", "sha256sum"].every((cmd) => spawnSync("which", [cmd]).status === 0);
const host = hasTools ? describe : describe.skip;

const RESTIC = `#!/usr/bin/env bash
echo "restic $*" >> "$STUB_DIR/calls.log"
REPO="$STUB_DIR/repo"
case "$1" in
  cat) [ -d "$REPO" ] ;;
  init) mkdir -p "$REPO" ;;
  unlock|forget|check) exit 0 ;;
  backup)
    shift
    name=""; cmd=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --stdin-filename) name="$2"; shift 2 ;;
        --) shift; cmd=("$@"); break ;;
        --host|--tag|--limit-upload) shift 2 ;;
        *) shift ;;
      esac
    done
    id="$(printf '%s-%s-%s' "$name" "$RANDOM" "$RANDOM" | sha256sum | awk '{print $1}')"
    mkdir -p "$REPO/$id"
    "\${cmd[@]}" > "$REPO/$id/$name" || exit 1
    [ -z "\${STUB_RESTIC_CORRUPT:-}" ] || printf 'x' >> "$REPO/$id/$name"
    printf '{"message_type":"summary","snapshot_id":"%s","data_added":%s}\\n' "$id" "$(stat -c %s "$REPO/$id/$name")"
    ;;
  dump)
    # The owner's computer changes while its copy is being checked.
    if [ -n "\${STUB_TOUCH_DISK_ON_DUMP:-}" ]; then
      python3 - "$STUB_DIR/vg0/vm-1234-disk-0" <<'PY'
import sys

with open(sys.argv[1], "r+b") as disk:
    disk.seek(7)
    byte = disk.read(1)[0]
    disk.seek(7)
    disk.write(bytes([byte ^ 0xff]))
PY
    fi
    cat "$REPO/$3$4"
    ;;
  *) exit 2 ;;
esac
`;
const PVESM = `#!/usr/bin/env bash
echo "pvesm $*" >> "$STUB_DIR/calls.log"
case "$1" in
  path) v="\${2#*:}"; echo "$STUB_DIR/vg0/$v" ;;
  status) printf 'Name Type Status\\nlocal-lvm %s active\\n' "\${STUB_STORAGE_TYPE:-lvmthin}" ;;
  *) exit 0 ;;
esac
`;
const BLOCKDEV = `#!/usr/bin/env bash\nstat -c %s "$2"\n`;
const BLKDISCARD = `#!/usr/bin/env bash
echo "blkdiscard $*" >> "$STUB_DIR/calls.log"
[ -z "\${STUB_DISCARD_FAILS:-}" ] || exit 1
size="$(stat -c %s "$1")"; : > "$1"; truncate -s "$size" "$1"
`;
// O_DIRECT does not work on every temp filesystem.
const DD = `#!/usr/bin/env bash
args=()
for a in "$@"; do case "$a" in iflag=direct) ;; iflag=fullblock) args+=("$a") ;; *) args+=("$a") ;; esac; done
exec /usr/bin/dd "\${args[@]}"
`;
const NOOP = `#!/usr/bin/env bash\necho "$(basename "$0") $*" >> "$STUB_DIR/calls.log"\nexit 0\n`;

const JOB = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";

host("store and unstore jobs against a fake host", () => {
  let h: HostHarness;
  let bin: string;
  let disk: string;
  let original: Buffer;
  const markDir = () => path.join(h.dir, "var-lib-hivra-sleep");
  const coldMark = () => path.join(markDir(), `cold-${VMID}`);
  const storedMark = () => path.join(markDir(), `stored-${VMID}`);

  beforeAll(() => {
    h = makeHostHarness();
    bin = path.join(h.dir, "storage-bin");
    mkdirSync(bin);
    const put = (name: string, body: string) => { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); };
    put("restic", RESTIC);
    put("pvesm", PVESM);
    put("blockdev", BLOCKDEV);
    put("blkdiscard", BLKDISCARD);
    put("dd", DD);
    for (const name of ["lvchange", "ssh", "ionice"]) put(name, name === "ionice" ? `#!/usr/bin/env bash\nshift\nexec "$@"\n` : NOOP);
    disk = path.join(h.dir, "vg0", `vm-${VMID}-disk-0`);
    mkdirSync(path.dirname(disk));
    original = randomBytes(3 * 1024 * 1024 + 123);
  });
  afterAll(() => h.cleanup());
  beforeEach(() => {
    writeFileSync(disk, original);
    rmSync(path.join(h.dir, "repo"), { recursive: true, force: true });
    rmSync(markDir(), { recursive: true, force: true });
    mkdirSync(markDir(), { recursive: true });
  });

  type Result = { status: string; reason: string; disks: BackupDisk[]; kind: string };
  function runJob(kind: BackupJobKind, state: HostState, opts: { disks?: BackupDisk[]; env?: Record<string, string> } = {}) {
    const files = backupJobFiles(kind);
    const jobDir = path.join(h.dir, "job");
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(jobDir);
    const local = (text: string) => text.replaceAll("/var/lib/hivra/restic-cache", path.join(h.dir, "restic-cache"));
    writeFileSync(path.join(jobDir, "run.sh"), local(files.run));
    // The reader makes its pipe under /run, which only root can write: keep it in the temp folder.
    writeFileSync(path.join(jobDir, "read-disk.sh"), files.readDisk.replaceAll("/run/", `${jobDir}/`));
    writeFileSync(path.join(jobDir, "params"), [
      `JOB_ID='${JOB}'`, `KIND='${kind}'`, `AGENT_ID='${AGENT}'`, `VMID=${VMID}`, `EXPECTED_BINDING_TAG='${TAG}'`,
      "KEEP_DAILY=7", "KEEP_WEEKLY=4", "UPLOAD_LIMIT_KIB=0", "REPO_FOLDER='hivra-computers'",
    ].join("\n"));
    writeFileSync(path.join(jobDir, "secret"), "RESTIC_REPOSITORY=stub\nRESTIC_PASSWORD=stub\n");
    writeFileSync(path.join(jobDir, "disks"), (opts.disks ?? []).map((d) => `${d.key} ${d.sha256} ${d.bytes} ${d.snapshotId}`).join("\n") + "\n");
    // The harness moves /run and the mark folder into its temp folder; the job file must get the same treatment,
    // so it is passed through as text and written by the wrapper.
    const wrapper = `cat > ${jobDir}/run-local.sh <<'HIVRA_TEST_RUN'\n${local(files.run)}\nHIVRA_TEST_RUN\ncp ${jobDir}/run-local.sh ${jobDir}/run.sh\nbash ${jobDir}/run.sh\n`;
    const run = h.run(wrapper, state, { PATH: `${bin}:${h.dir}/bin:/usr/bin:/bin`, ...(opts.env ?? {}) });
    const resultFile = path.join(jobDir, "result.json");
    const result = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as Result) : null;
    if (!result) throw new Error(`no result\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr.slice(-3000)}`);
    return { ...run, result };
  }
  const isZeros = (file: string) => readFileSync(file).every((byte) => byte === 0);
  const markCold = () => writeFileSync(coldMark(), `${TAG}\n`);

  it("packs a dropped long sleeper: uploads, reads back, then frees the disk and marks it stored", () => {
    markCold();
    const run = runJob("store", COLD);
    expect(run.result).toMatchObject({ status: "succeeded", reason: "stored", kind: "store" });
    expect(run.result.disks).toHaveLength(1);
    expect(run.result.disks[0]).toMatchObject({ key: "scsi0", bytes: original.length });
    expect(isZeros(disk)).toBe(true);
    expect(readFileSync(disk).length).toBe(original.length);
    expect(readFileSync(storedMark(), "utf8")).toBe(`${TAG}\n`);
    expect(existsSync(coldMark())).toBe(false);
    // Read back from the storage box before the free, and never started, stopped or destroyed.
    const at = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
    expect(at("restic dump")).toBeGreaterThan(-1);
    expect(at("restic dump")).toBeLessThan(at("blkdiscard"));
    expect(run.calls.some((c) => /^qm (start|stop|destroy|set|unlock|resume|suspend)/.test(c))).toBe(false);
    expect(run.state).toEqual(COLD);
  });

  it("leaves alone anything that is not an off, dropped computer", () => {
    // Off but never dropped (an owner switched it off): no cold mark.
    expect(runJob("store", COLD).result).toMatchObject({ status: "skipped", reason: "not_dropped" });
    markCold();
    expect(runJob("store", AWAKE).result).toMatchObject({ status: "skipped", reason: "not_stopped" });
    expect(runJob("store", { ...COLD, lock: "backup" }).result).toMatchObject({ status: "skipped", reason: "locked" });
    expect(runJob("store", { ...COLD, tags: "hivra-bind-other" }).result).toMatchObject({ status: "failed", reason: "binding_mismatch" });
    expect(runJob("store", COLD, { env: { STUB_STORAGE_TYPE: "dir" } }).result).toMatchObject({ status: "skipped", reason: "unsupported_storage" });
    expect(readFileSync(disk).equals(original)).toBe(true);
    expect(existsSync(storedMark())).toBe(false);
    expect(existsSync(coldMark())).toBe(true);
  });

  it("frees nothing when the copy in the storage box does not read back exactly", () => {
    markCold();
    const run = runJob("store", COLD, { env: { STUB_RESTIC_CORRUPT: "1" } });
    expect(run.result).toMatchObject({ status: "failed", reason: "hash_mismatch" });
    expect(run.calls.some((c) => c.startsWith("blkdiscard"))).toBe(false);
    expect(readFileSync(disk).equals(original)).toBe(true);
    expect(existsSync(storedMark())).toBe(false);
    expect(existsSync(coldMark())).toBe(true);
  });

  it.each([0x79, 0x00])("frees nothing when byte 7 (initially %i) changes after upload", (byte) => {
    markCold();
    const expected = Buffer.from(original);
    expected[7] = byte;
    writeFileSync(disk, expected);
    const run = runJob("store", COLD, { env: { STUB_TOUCH_DISK_ON_DUMP: "1" } });
    expect(run.result).toMatchObject({ status: "skipped", reason: "changed_meanwhile" });
    expect(run.calls.some((c) => c.startsWith("blkdiscard"))).toBe(false);
    expected[7] ^= 0xff;
    expect(readFileSync(disk).equals(expected)).toBe(true);
    expect(existsSync(storedMark())).toBe(false);
    expect(existsSync(coldMark())).toBe(true);
  });

  it("brings a stored computer back byte for byte and makes it bootable again", () => {
    markCold();
    const stored = runJob("store", COLD);
    expect(stored.result.reason).toBe("stored");
    expect(isZeros(disk)).toBe(true);

    // A wake that meets a stored computer never starts it, and says why.
    const wake = buildWakeHostScript({
      vmid: VMID, bindingTag: TAG, coldStart: true,
      admission: { provisionerDirectory: h.provisionerDir, hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200 },
    });
    const woke = h.run(wake, COLD);
    expect(parseWakeReceipt(woke.stdout, VMID)).toMatchObject({ ok: false, reason: "stored", to: "cold" });
    expect(woke.calls.some((c) => c.startsWith("qm start"))).toBe(false);

    const back = runJob("unstore", COLD, { disks: stored.result.disks });
    expect(back.result).toMatchObject({ status: "succeeded", reason: "restored", kind: "unstore" });
    expect(readFileSync(disk).equals(original)).toBe(true);
    expect(readFileSync(coldMark(), "utf8")).toBe(`${TAG}\n`);
    expect(existsSync(storedMark())).toBe(false);
    expect(back.calls.some((c) => /^qm (start|destroy|set|unlock)/.test(c))).toBe(false);

    // Now the wake boots it from its disk.
    const cold = h.run(wake, COLD);
    expect(parseWakeReceipt(cold.stdout, VMID)).toMatchObject({ ok: true, reason: "cold_started" });
  });

  it("writes nothing over a computer that is not marked stored, or is running", () => {
    markCold();
    const stored = runJob("store", COLD);
    rmSync(storedMark());
    writeFileSync(disk, original);
    expect(runJob("unstore", COLD, { disks: stored.result.disks }).result).toMatchObject({ status: "failed", reason: "not_stored" });
    writeFileSync(storedMark(), `${TAG}\n`);
    expect(runJob("unstore", AWAKE, { disks: stored.result.disks }).result).toMatchObject({ status: "failed", reason: "not_stopped" });
    expect(readFileSync(disk).equals(original)).toBe(true);
    expect(existsSync(storedMark())).toBe(true);
  });

  it("keeps the stored mark when a restore fails part way, so it is tried again and never booted half written", () => {
    markCold();
    const stored = runJob("store", COLD);
    const wrong = stored.result.disks.map((d) => ({ ...d, sha256: "0".repeat(64) }));
    expect(runJob("unstore", COLD, { disks: wrong }).result).toMatchObject({ status: "failed", reason: "hash_mismatch" });
    expect(existsSync(storedMark())).toBe(true);
    expect(existsSync(coldMark())).toBe(false);
    // The next try, with the right record, succeeds.
    expect(runJob("unstore", COLD, { disks: stored.result.disks }).result.reason).toBe("restored");
    expect(readFileSync(disk).equals(original)).toBe(true);
  });
});
