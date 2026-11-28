import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPortableKvmSourceAbortScript, parsePortableKvmSourceAbortReceipt, type PortableKvmSourceAbortInput } from "../source-abort";
import { buildPortableKvmSourceFenceScript } from "../source-fence";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const vmid = 9343;
const source = { vmid, hostId: "fixture-source", ip: "10.251.20.30", bindingTag: "hivra-bind-" + "a".repeat(32) };
const fence = { agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", generation: 14,
  hostId: source.hostId, vmid, bindingTag: source.bindingTag };
const allocation = "33333333-3333-4333-8333-333333333333";
const disk = { storage: "local-lvm", vg: "pve", volume: "vm-9343-disk-0", uuid: "aaaaaa-bbbb-cccc-dddd-eeee-ffff-gggggg" };
const current = `balloon: 4096\ncpuunits: 100\nmemory: 4096\nonboot: 0\nscsi0: ${disk.storage}:${disk.volume},size=40G\ntags: ${source.bindingTag};hivra-op-${allocation.replaceAll("-", "")}\n`;
const cache = `\n[special:cloudinit]\ncicustom: vendor=local:snippets/hivra-qga-${vmid}-${allocation}.yaml\n`;
const lock = "lock: backup\n";
const input: PortableKvmSourceAbortInput = { receiptId: "44444444-4444-4444-8444-444444444444", agentId: fence.agentId,
  operationId: fence.operationId, generation: fence.generation, source, allocationOperationId: allocation, resources: { balloonMb: 4096, cpuUnits: 100 },
  disk, configuration: { raw: sha(current + lock + cache), current: sha(current + lock), unlockedRaw: sha(current + cache), unlockedCurrent: sha(current) } };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hivra-portable-source-abort-"));
  for (const dir of ["bin", "state", "state/portable-kvm-fences", "pve", "run", "lock"]) mkdirSync(join(root, dir), { mode: 0o700 });
  const raw = join(root, "pve", vmid + ".conf");
  const marker = join(root, "state", "portable-kvm-fences", String(vmid));
  writeFileSync(raw, current + lock + cache);
  writeFileSync(marker, JSON.stringify(fence), { mode: 0o600 });
  writeFileSync(join(root, "state", "cold-" + vmid), source.bindingTag + "\n", { mode: 0o600 });
  const put = (name: string, body: string) => writeFileSync(join(root, "bin", name), "#!/bin/bash\n" + body, { mode: 0o700 });
  put("hostname", "printf '%s\\n' fixture-source");
  put("systemctl", 'printf "%s\\n" "LoadState=loaded" "ActiveState=${WRITER:-inactive}" "Job=${PENDING_JOB:-0}"');
  put("qm", `case "$1" in status) echo "status: stopped";; config) awk '/^\\[special:cloudinit\\]/{exit}{print}' "$RAW";; *) exit 1;; esac`);
  put("pvesm", "printf '%s\\n' /dev/pve/vm-9343-disk-0");
  put("lvs", `printf '%s\\n' '${JSON.stringify({ report: [{ lv: [{ vg_name: disk.vg, lv_name: disk.volume, lv_uuid: disk.uuid, lv_attr: "Vwi-a-tz--" }] }] })}'`);
  put("perl", `[[ "$*" == *lock_config* && "$*" == *"delete \\$conf"* ]] || exit 1
sed -i '/^lock: backup$/d' "$RAW"
[ -z "${"\$"}{INTERRUPT:-}" ]`);
  const rewrite = (script: string) => script
    .replaceAll("/var/lib/hivra-sleep", join(root, "state"))
    .replaceAll("/etc/pve/qemu-server", join(root, "pve"))
    .replaceAll("/run/qemu-server", join(root, "run"))
    .replaceAll("/run/lock", join(root, "lock"))
    .replaceAll("info.st_uid == 0", "info.st_uid == os.getuid()")
    .replaceAll("os.geteuid() == 0", "True")
    .replaceAll("/usr/bin/perl", join(root, "bin", "perl"));
  function execute(script: string, env = {}) {
    return spawnSync("bash", ["-c", rewrite(script)], { encoding: "utf8", env: { ...process.env, RAW: raw,
      PATH: join(root, "bin") + ":" + process.env.PATH, ...env } });
  }
  const run = (mode: "cleanup" | "verify", data = input, env = {}) => execute(buildPortableKvmSourceAbortScript(mode, data), env);
  return { root, raw, marker, run, execute, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const offline = spawnSync("python3", ["--version"]).status === 0 ? test : test.skip;

offline("restores ordinary cold state without touching the owned source disk or cached metadata", () => {
  const f = fixture();
  try {
    expect(f.run("verify").status).not.toBe(0);
    const cleanup = f.run("cleanup");
    expect({ status: cleanup.status, error: cleanup.stderr }).toEqual({ status: 0, error: "" });
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.raw, "utf8")).toBe(current + cache);
    const verified = f.run("verify");
    expect(verified.status).toBe(0);
    expect(parsePortableKvmSourceAbortReceipt(verified.stdout, input)).toMatchObject({ source, sourceDiskUnchanged: true });
    expect(parsePortableKvmSourceAbortReceipt(verified.stdout, { ...input, generation: input.generation + 1 })).toBeNull();
    expect(f.execute(buildPortableKvmSourceFenceScript(fence)).status).not.toBe(0);
    expect(readFileSync(f.raw, "utf8")).toBe(current + cache);
  } finally { f.dispose(); }
});

offline("converges after native unlock succeeded but its receipt was lost", () => {
  const f = fixture();
  try {
    expect(f.run("cleanup", input, { INTERRUPT: "1" }).status).not.toBe(0);
    expect(existsSync(f.marker)).toBe(true);
    expect(readFileSync(f.raw, "utf8")).toBe(current + cache);
    expect(f.run("verify").status).not.toBe(0);
    expect(f.run("cleanup").status).toBe(0);
    expect(f.run("verify").status).toBe(0);
  } finally { f.dispose(); }
});

offline("refuses wrong allocation, generation, host, volume and active work without mutating", () => {
  const f = fixture();
  try {
    for (const data of [{ ...input, allocationOperationId: input.operationId }, { ...input, generation: 15 },
      { ...input, source: { ...source, hostId: "other-host" } }, { ...input, disk: { ...disk, uuid: disk.uuid.replace("aaaa", "ffff") } }]) {
      expect(f.run("cleanup", data).status).not.toBe(0);
    }
    expect(f.run("cleanup", input, { WRITER: "active" }).status).not.toBe(0);
    expect(f.run("cleanup", input, { PENDING_JOB: "1" }).status).not.toBe(0);
    expect(readFileSync(f.raw, "utf8")).toBe(current + lock + cache);
    expect(existsSync(f.marker)).toBe(true);
  } finally { f.dispose(); }
});
