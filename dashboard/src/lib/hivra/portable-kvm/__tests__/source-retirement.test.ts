import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPortableKvmSourceRetirementScript,
  parsePortableKvmSourceRetirementReceipt,
  type PortableKvmSourceRetirementInput,
  type PortableKvmSourceRetirementMode,
} from "../source-retirement";

jest.mock("server-only", () => ({}));

const operationId = "22222222-2222-4222-8222-222222222222";
const allocationOperationId = "33333333-3333-4333-8333-333333333333";
const scope = {
  agentId: "11111111-1111-4111-8111-111111111111", operationId, generation: 8,
  hostId: "qa-source", vmid: 9343, bindingTag: `hivra-bind-${"a".repeat(32)}`,
};
const volumeName = "vm-9343-disk-0";
const seedName = "vm-9343-cloudinit";
const disk = {
  volumeId: "local-lvm:" + volumeName, volumeGroup: "pve", thinPool: "data",
  lvUuid: "abc123-aaaa-bbbb-cccc-dddd-eeee-0123AB", bytes: 1024 ** 3,
};
const cloudInit = {
  ...disk, volumeId: "local-lvm:" + seedName, lvUuid: "abc124-aaaa-bbbb-cccc-dddd-eeee-0123AB", bytes: 4 * 1024 ** 2,
};
const current = `boot: order=scsi0
ide2: ${cloudInit.volumeId},media=cdrom,size=4M
lock: backup
memory: 4096
balloon: 4096
cpuunits: 100
onboot: 0
scsi0: ${disk.volumeId},size=1G
tags: ${scope.bindingTag};hivra-op-${allocationOperationId.replaceAll("-", "")}
`;
const cache = `\n[special:cloudinit]\ncicustom: vendor=local:snippets/hivra-qga-9343-${allocationOperationId}.yaml\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const input: PortableKvmSourceRetirementInput = {
  fence: { ...scope, state: "fenced", configurationSha256: sha(current), rawConfigurationSha256: sha(current + cache) },
  allocationOperationId, resources: { balloonMb: 4096, cpuUnits: 100 }, disk, cloudInit,
};

const fakeTools = String.raw`#!/usr/bin/env python3
import fcntl, hashlib, json, os, sys
from pathlib import Path
root = Path(os.environ["FAKE_RETIREMENT_HOST"])
cmd = Path(sys.argv[0]).name
args = sys.argv[1:]
cfg = root / "etc/pve/nodes/qa-source/qemu-server/9343.conf"
lvs = root / "lvs"
rows = json.loads(lvs.read_text())
def flag(name):
    p = root / name
    return p.read_text() if p.is_file() else None
def log(text):
    with (root / "actions").open("a") as f:
        f.write(text + "\n")
def assert_locks():
    for path in ("run/lock/hivra-allocation.lock", "run/lock/hivra-vmids/9343.lock",
                 "run/lock/hivra-computer-backup.lock", "run/lock/hivra-vm-9343.backup.lock",
                 "run/lock/hivra-vm-9343.lock", "var/lock/qemu-server/lock-9343.conf",
                 "run/lock/hivra-portable-22222222-2222-4222-8222-222222222222.dispatch.lock"):
        with (root / path).open("rb") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                sys.exit("lost lock " + path)
if cmd == "hostname":
    print(flag("hostname") or "qa-source")
elif cmd == "qm":
    if args == ["config", "9343", "--current", "1"] and cfg.is_file():
        print((root / "current").read_text(), end="")
    elif args == ["status", "9343"] and cfg.is_file():
        print("status: " + (flag("status") or "stopped"))
    else:
        sys.exit(83)
elif cmd == "systemctl":
    assert args[-1] == "hivra-computer-backup-22222222-2222-4222-8222-222222222222.service"
    print("LoadState=loaded\nActiveState=" + (flag("backup") or "inactive") + "\nJob=" + (flag("job") or ""))
elif cmd == "pvesm":
    assert args[0] == "path" and args[1].startswith("local-lvm:")
    print(str(root / "dev/pve" / args[1].split(":")[1]))
elif cmd == "lvs":
    assert "-a" in args
    print(json.dumps({"report": [{"lv": rows}]}))
elif cmd in {"lvchange", "lvremove"}:
    assert_locks()
    assert args[:-1] == (["-an", "--select"] if cmd == "lvchange" else ["--select"])
    assert (root / "state/portable-kvm-cleanup/22222222-2222-4222-8222-222222222222.source").is_file()
    assert (root / "state/portable-kvm-retirements/9343-22222222-2222-4222-8222-222222222222").is_file()
    selected = [r for r in rows if args[-1] == " && ".join([
        "vg_name=" + r["vg_name"], "lv_name=" + r["lv_name"], "lv_uuid=" + r["lv_uuid"],
        "pool_lv=" + r["pool_lv"], "lv_size=" + r["lv_size"] + "b", "lv_attr=" + r["lv_attr"],
    ])]
    assert len(selected) == 1
    row = selected[0]
    if cmd == "lvchange":
        row["lv_attr"] = "Vwi-------"
    else:
        assert row["lv_attr"] == "Vwi-------"
        if flag("pretend-remove") is None:
            rows.remove(row)
    lvs.write_text(json.dumps(rows))
    log(cmd + " " + row["lv_name"])
    if flag("interrupt-after") == row["lv_name"] and cmd == "lvremove":
        sys.exit(99)
elif cmd == "native-proxmox":
    action, host, vmid, hash, inode, *disks = args[args.index("-e") + 2:]
    assert host == "qa-source" and vmid == "9343"
    assert disks == ["local-lvm", "pve", "data"] * 2
    if action == "lock-path":
        print(root / "var/lock/qemu-server/lock-9343.conf", end="")
    elif action == "inventory":
        assert_locks()
        print(flag("inventory") or ("present" if cfg.is_file() else "absent"), end="")
    elif action == "destroy-config":
        assert_locks()
        assert len(rows) == 2
        assert cfg.stat().st_ino == int(inode)
        assert hashlib.sha256(cfg.read_bytes()).hexdigest() == hash
        cfg.unlink()
        log(action)
        if flag("interrupt-after") == action:
            sys.exit(99)
    else:
        sys.exit(84)
else:
    sys.exit(85)
`;

function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-retire-"));
  const source = "etc/pve/nodes/qa-source/qemu-server/9343.conf";
  const marker = "state/portable-kvm-fences/9343";
  const intent = `state/portable-kvm-retirements/9343-${operationId}`;
  const dispatchFence = `state/portable-kvm-cleanup/${operationId}.source`;
  for (const dir of ["bin", "etc/pve/nodes/qa-source/qemu-server", "etc/pve/nodes/qa-destination/qemu-server",
    "etc/pve/firewall", "run/lock/hivra-vmids", "run/qemu-server", "var/lock/qemu-server",
    "state/portable-kvm-fences", "dev/pve", "dev/mapper"]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  symlinkSync(join(root, "etc/pve/nodes/qa-source/qemu-server"), join(root, "etc/pve/qemu-server"));
  const put = (path: string, content: string, mode = 0o600) => writeFileSync(join(root, path), content, { mode });
  const sourceVolume = (v: typeof disk, lv_attr = "Vwi-a-----") => ({
    vg_name: "pve", lv_name: v.volumeId.split(":")[1], lv_uuid: v.lvUuid,
    lv_size: String(v.bytes), pool_lv: "data", lv_attr, origin: "",
  });
  const inventory = [
    sourceVolume(disk), sourceVolume(cloudInit, "Vwi-------"),
    { ...sourceVolume({ ...disk, volumeId: "local-lvm:data", lvUuid: "pool" }), lv_attr: "twi-a-tz--", pool_lv: "" },
    { ...sourceVolume({ ...disk, volumeId: "local-lvm:vm-9344-disk-0", lvUuid: "other" }) },
  ];
  const destination = "etc/pve/nodes/qa-destination/qemu-server/9344.conf";
  const destinationConfig = "name: healthy-authoritative\nscsi0: local-lvm:vm-9344-disk-0\n";
  put(source, current + cache);
  put(destination, destinationConfig);
  put("current", current);
  put(marker, JSON.stringify(scope) + "\n");
  put("state/cold-9343", scope.bindingTag + "\n");
  put("state/onboot-9343", "");
  put("actions", "");
  put("lvs", JSON.stringify(inventory));
  for (const name of ["hostname", "qm", "systemctl", "pvesm", "lvs", "lvchange", "lvremove", "native-proxmox"]) {
    put("bin/" + name, fakeTools, 0o700);
  }
  const run = (pin = input, mode: PortableKvmSourceRetirementMode = "cleanup", heldLock?: string) => {
    const uid = process.getuid?.() ?? 0;
    const script = buildPortableKvmSourceRetirementScript(pin, mode)
      .replaceAll("/var/lib/hivra-sleep", join(root, "state"))
      .replaceAll("/usr/bin/perl", join(root, "bin/native-proxmox"))
      .replaceAll("/run/lock", join(root, "run/lock"))
      .replaceAll("/run/qemu-server", join(root, "run/qemu-server"))
      .replaceAll("/var/lock/qemu-server", join(root, "var/lock/qemu-server"))
      .replaceAll("/etc/pve", join(root, "etc/pve"))
      .replaceAll("/dev/", join(root, "dev") + "/")
      .replaceAll("os.geteuid() == 0", "os.geteuid() == " + uid)
      .replaceAll("st_uid == 0", "st_uid == " + uid);
    const options = { encoding: "utf8" as const, timeout: 10_000,
      env: { ...process.env, FAKE_RETIREMENT_HOST: root, PATH: join(root, "bin") + ":" + process.env.PATH } };
    return heldLock ? spawnSync("flock", ["-x", join(root, heldLock), "bash", "-c", script], options)
      : spawnSync("bash", ["-c", script], options);
  };
  const get = (path: string) => readFileSync(join(root, path), "utf8");
  return { run, get, put, inventory, putInventory: (rows: typeof inventory) => put("lvs", JSON.stringify(rows)),
    actions: () => get("actions").trim().split("\n").filter(Boolean),
    has: (path: string) => existsSync(join(root, path)), remove: (path: string) => rmSync(join(root, path)),
    rename: (from: string, to: string) => renameSync(join(root, from), join(root, to)),
    source, marker, intent, dispatchFence, destination, destinationConfig,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

function proof(host: ReturnType<typeof fakeHost>, mode: PortableKvmSourceRetirementMode) {
  const result = host.run(input, mode);
  expect({ code: result.status, error: result.stderr }).toEqual({ code: 0, error: "" });
  expect(parsePortableKvmSourceRetirementReceipt(result.stdout, input, mode)).toEqual({
    input, mode, state: "retired", sourceVmAbsent: true, sourceDiskAbsent: true,
  });
  return result.stdout;
}

it("retires only the exact fenced source and independently verifies absence", () => {
  const host = fakeHost();
  try {
    expect(host.run(input, "verify-absent").status).not.toBe(0);
    const cleanup = proof(host, "cleanup");
    expect(host.actions()).toEqual([`lvchange ${volumeName}`, `lvremove ${volumeName}`, `lvremove ${seedName}`, "destroy-config"]);
    expect([host.source, host.marker, "state/cold-9343", "state/onboot-9343"].map(host.has)).toEqual([false, false, false, false]);
    expect(host.get(host.destination)).toBe(host.destinationConfig);
    expect(JSON.parse(host.get("lvs"))).toEqual(host.inventory.slice(2));
    expect(proof(host, "cleanup")).toBe(cleanup);
    const verify = proof(host, "verify-absent");
    expect(host.actions()).toHaveLength(4);
    expect(JSON.parse(host.get(host.intent)).phase).toBe("complete");
    expect(JSON.parse(host.get(host.dispatchFence)).input).toEqual(input);
    expect(parsePortableKvmSourceRetirementReceipt(verify, input, "cleanup")).toBeNull();
    expect(parsePortableKvmSourceRetirementReceipt(verify + verify, input, "verify-absent")).toBeNull();
    expect(parsePortableKvmSourceRetirementReceipt(verify.replace('"state":"retired"', '"state":"retired","state":"retired"'),
      input, "verify-absent")).toBeNull();
    expect(parsePortableKvmSourceRetirementReceipt(verify, { ...input, disk: { ...disk, bytes: 2 * disk.bytes } },
      "verify-absent")).toBeNull();
    host.putInventory(host.inventory.slice(1));
    expect(host.run(input, "verify-absent").status).not.toBe(0);
  } finally { host.close(); }
});

it.each([
  ["hostname", "qa-destination"], ["status", "running"], ["backup", "active"], ["job", "17"],
  ["run/qemu-server/9343.pid", "99"], ["run/qemu-server/9343.qmp", ""],
  ["current", current.replace("4096", "2048")], ["state/cold-9343", "wrong\n"],
  ["inventory", "absent"],
  ["etc/pve/nodes/qa-destination/qemu-server/9343.conf", "name: reused\n"],
])("refuses stale or writer evidence at %s", (path, value) => {
  const host = fakeHost();
  try {
    host.put(path, value);
    expect(host.run().status).not.toBe(0);
    expect(host.actions()).toEqual([]);
    expect(host.has(host.dispatchFence)).toBe(false);
    expect(host.get(host.source)).toBe(current + cache);
  } finally { host.close(); }
});

it.each([
  `run/lock/hivra-portable-${operationId}.dispatch.lock`, "run/lock/hivra-allocation.lock",
  "run/lock/hivra-vmids/9343.lock", "run/lock/hivra-computer-backup.lock", "run/lock/hivra-vm-9343.backup.lock",
  "run/lock/hivra-vm-9343.lock", "var/lock/qemu-server/lock-9343.conf",
])("refuses an existing holder of the %s lock", held => {
  const host = fakeHost();
  try {
    expect(host.run(input, "cleanup", held).status).not.toBe(0);
    expect(host.actions()).toEqual([]);
    expect(host.has(host.dispatchFence)).toBe(false);
  } finally { host.close(); }
});

it("refuses a stale scope, an unowned empty slot, open volume, or volume reference elsewhere", () => {
  const host = fakeHost();
  try {
    const differentAllocation = "44444444-4444-4444-8444-444444444444";
    expect(host.run({ ...input, allocationOperationId: differentAllocation }).status).not.toBe(0);
    expect(host.run({ ...input, fence: { ...input.fence, generation: 9 } }).status).not.toBe(0);
    expect(host.run({ ...input, fence: { ...input.fence, rawConfigurationSha256: sha(current) } }).status).not.toBe(0);
    expect(() => buildPortableKvmSourceRetirementScript({ ...input,
      disk: { ...disk, volumeId: "local-lvm:vm-9344-disk-0" } }, "cleanup")).toThrow();
    host.putInventory([{ ...host.inventory[0], lv_attr: "Vwi-ao----" }, ...host.inventory.slice(1)]);
    expect(host.run().status).not.toBe(0);
    host.putInventory([{ ...host.inventory[0], lv_uuid: "another" }, ...host.inventory.slice(1)]);
    expect(host.run().status).not.toBe(0);
    host.putInventory([...host.inventory, { ...host.inventory[0], lv_name: "snap_" + volumeName + "_existing" }]);
    expect(host.run().status).not.toBe(0);
    host.putInventory([...host.inventory, { ...host.inventory[0], lv_name: "vm-9343-disk-4", lv_uuid: "another" }]);
    expect(host.run().status).not.toBe(0);
    host.putInventory(host.inventory);
    host.put(host.destination, "scsi0: another-storage:" + volumeName + "\n");
    expect(host.run().status).not.toBe(0);
    host.put(host.destination, host.destinationConfig);
    host.putInventory(host.inventory.slice(2));
    expect(host.run().status).not.toBe(0);
    host.remove(host.source);
    expect(host.run().status).not.toBe(0);
    expect(host.actions()).toEqual([]);
    expect(host.has(host.intent)).toBe(false);
  } finally { host.close(); }
});

it.each([volumeName, seedName, "destroy-config"])("resumes the exact transaction after interruption at %s", cut => {
  const host = fakeHost();
  try {
    host.put("interrupt-after", cut);
    expect(host.run().status).not.toBe(0);
    expect(host.has(host.marker)).toBe(true);
    expect(host.run(input, "verify-absent").status).not.toBe(0);
    expect(host.run({ ...input, disk: { ...disk, bytes: 2 * disk.bytes } }).status).not.toBe(0);
    host.remove("interrupt-after");
    proof(host, "cleanup");
    proof(host, "verify-absent");
    expect(host.actions()).toEqual([`lvchange ${volumeName}`, `lvremove ${volumeName}`, `lvremove ${seedName}`, "destroy-config"]);
  } finally { host.close(); }
});

it("requires independently observed absence and cannot adopt a lost source config", () => {
  const host = fakeHost();
  try {
    host.put("pretend-remove", "");
    expect(host.run().status).not.toBe(0);
    expect(host.has(host.source)).toBe(true);
    expect(host.actions()).toEqual([`lvchange ${volumeName}`, `lvremove ${volumeName}`]);
    host.remove("pretend-remove");
    host.put("interrupt-after", volumeName);
    expect(host.run().status).not.toBe(0);
    host.remove("interrupt-after");
    host.remove(host.source);
    expect(host.run().status).not.toBe(0);
    expect(host.actions()).not.toContain("destroy-config");
  } finally { host.close(); }
});

it("does not remove an identical replacement config after authorization", () => {
  const host = fakeHost();
  try {
    host.put("replacement", current + cache);
    host.put("interrupt-after", "destroy-config");
    expect(host.run().status).not.toBe(0);
    host.remove("interrupt-after");
    host.rename("replacement", host.source);
    expect(host.run().status).not.toBe(0);
    expect(host.actions().filter(action => action === "destroy-config")).toHaveLength(1);
    expect(host.has(host.source)).toBe(true);
  } finally { host.close(); }
});
