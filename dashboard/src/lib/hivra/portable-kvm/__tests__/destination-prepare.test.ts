import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializePortableKvmDestinationReservation } from "../destination-disk";
import {
  buildPortableKvmDestinationPrepareScript,
  parsePortableKvmDestinationPrepareReceipt,
  serializePortableKvmDestinationPreparePermit,
  type PortableKvmDestinationPrepareInput,
} from "../destination-prepare";

jest.mock("server-only", () => ({}));

const gib = 1024 ** 3;
const vmid = 9344;
const dmUuid = "LVM-" + "V".repeat(32) + "L".repeat(32);
const plan: PortableKvmDestinationPrepareInput = {
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generation: 3, checkpointSha256: "3".repeat(64), hostId: "qa-destination", vmid,
  bindingTag: "hivra-bind-" + "a".repeat(32), ip: "10.251.10.44", expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  storageId: "local-lvm", volumeGroup: "pve", thinPool: "data",
  profile: {
    machine: "pc-i440fx-8.1", cores: 2, memoryMb: 2048,
    network: { bridge: "vmbr0", macAddress: "02:11:22:33:44:55" },
    attachment: { discard: true, ssd: false, ioThread: true },
  },
  disk: { key: "scsi0", snapshotId: "4".repeat(64), bytes: 12 * gib, sha256: "5".repeat(64) },
};
const roots = new Set<string>();
afterEach(() => {
  for (const dir of roots) rmSync(dir, { force: true, recursive: true });
  roots.clear();
});

const hostTools = String.raw`#!/usr/bin/python3
import json
import os
import sys
from pathlib import Path

r = Path(os.environ["MOCK_ROOT"])
name, *args = [Path(sys.argv[0]).name, *sys.argv[1:]]
env = os.environ
cfg = r / "qemu/9344.conf"
if name == "hostname" and args == ["-s"]:
    print(env.get("HOST", "qa-destination"))
elif name == "kvm" and args == ["-machine", "help"]:
    print(env.get("MACHINE", "pc-i440fx-8.1   pc"))
elif name == "findmnt" and args == ["-n", "-o", "FSTYPE", "--target", str(r / "space/stage")]:
    print(env.get("FS", "ext4"))
elif name == "pvesh" and args == ["get", "/cluster/ha/resources", "--output-format", "json"]:
    print(env.get("HA", "[]"))
elif name == "pvesh" and args == ["get", "/cluster/nextid", "--vmid", "9344"]:
    print(env.get("NEXTID", "9344"))
elif name == "pvesh" and args == ["get", "/storage/local-lvm", "--output-format", "json"]:
    print(json.dumps(dict(type="lvmthin", vgname="pve", thinpool=env.get("THINPOOL", "data"), content="rootdir,images")))
elif name == "pvesm" and args == ["status", "--storage", "local-lvm"]:
    print("name type status")
    print("local-lvm lvmthin " + env.get("STORAGE_STATUS", "active"))
elif name == "pvesm" and args == ["path", "local-lvm:vm-9344-disk-0"]:
    print(r / "devices/pve/vm-9344-disk-0")
elif name == "lvs" and args[0:8] == ["--reportformat", "json", "--units", "b", "--nosuffix", "-o",
      "vg_name,vg_uuid,lv_name,lv_uuid,lv_size,lv_attr,pool_lv,origin,data_percent,metadata_percent"]:
    pool = dict(vg_name="pve", lv_name="data", lv_size=str(100 * 1024**3), lv_attr="twi-aotz--",
                data_percent=env.get("DATA_USED", "35.00"), metadata_percent=env.get("META_USED", "8.00"))
    lvs = [pool]
    if cfg.exists() or env.get("ORPHAN"):
        lvs.append(dict(vg_name="pve", lv_name="vm-9344-disk-0", pool_lv="data", lv_attr="Vwi-a-tz--",
                   origin=env.get("LV_ORIGIN", ""), vg_uuid="-".join(["VVVV"] * 8), lv_uuid="-".join(["LLLL"] * 8)))
    print(json.dumps({"report": [{"lv": lvs}]}))
elif name == "qm" and args == ["status", "9344"]:
    print("status: " + env.get("VM_STATUS", "stopped"))
elif name == "qm" and args == ["config", "9344", "--current", "1"]:
    print(cfg.read_text(), end="")
elif name == "qm" and args[:4] == ["create", "9344", "--start", "0"]:
    options = dict(zip(args[4::2], args[5::2]))
    assert options == {
        "--name": "hivra-portable-9344", "--tags": "hivra-bind-" + "a"*32, "--lock": "backup", "--onboot": "0",
        "--arch": "x86_64", "--bios": "seabios", "--machine": "pc-i440fx-8.1", "--ostype": "l26",
        "--cpu": "x86-64-v2-AES", "--cores": "2", "--memory": "2048", "--agent": "1",
        "--scsihw": "virtio-scsi-single", "--boot": "order=scsi0",
        "--net0": "virtio=02:11:22:33:44:55,bridge=vmbr0,firewall=1,link_down=1",
        "--scsi0": "local-lvm:12,replicate=0,discard=on,iothread=1",
    }
    assert (r / "state/portable-kvm-destinations/.attempt-9344").exists()
    with (r / "events").open("a") as f:
        f.write("create\n")
    if env.get("CREATE_ERROR"):
        sys.exit(2)
    options["--agent"] = "enabled=1"
    options["--scsi0"] = "local-lvm:vm-9344-disk-0,discard=on,iothread=1,replicate=0,size=12G"
    data = "\n".join(k[2:] + ": " + v for k, v in sorted(options.items())) + "\n"
    if env.get("OPEN_NIC"):
        data = data.replace(",link_down=1", "")
    cfg.write_text(data + env.get("EXTRA_CONFIG", ""))
    (r / "devices/pve/vm-9344-disk-0").symlink_to(r / "devices/dm-0")
else:
    sys.exit(99)
`;

function fixture(input = plan) {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-destination-prepare-"));
  roots.add(root);
  for (const dir of ["state/portable-kvm-destination-permits", "space/stage", "bin", "qemu", "lxc", "pids",
    "provision", "intents", "results", "locks/hivra-vmids", "devices/pve", "dm/0:0/dm", "net/vmbr0/bridge"]) {
    mkdirSync(join(root, dir), { mode: 0o700, recursive: true });
  }
  const put = (path: string, content: string) => writeFileSync(join(root, path), content, { mode: 0o600 });
  const permit = `state/portable-kvm-destination-permits/${vmid}`;
  const marker = join(root, "state/portable-kvm-destinations", String(vmid));
  put(permit, serializePortableKvmDestinationPreparePermit(input));
  put("pressure", "full avg10=0.50 avg60=0.50 avg300=0.50 total=1\n");
  put("meminfo", "MemAvailable: 93716480 kB\n");
  put("cpuinfo", "flags : aes popcnt pni sse4_1 sse4_2 ssse3\n");
  put("events", "");
  put("devices/kvm", "");
  put("devices/dm-0", "");
  put("dm/0:0/dm/uuid", dmUuid);
  const tool = join(root, "host-tools");
  writeFileSync(tool, hostTools, { mode: 0o700 });
  for (const command of ["qm", "pvesh", "pvesm", "hostname", "findmnt", "lvs", "kvm"]) {
    symlinkSync(tool, join(root, "bin", command));
  }
  const run = (flags: Record<string, string> = {}, lock?: string, current = input) => {
    const replacements = {
      "/var/lib/hivra-sleep": "state", "/var/lib/hivra/portable-kvm-restore-staging": "space/stage",
      "/var/lib/hivra/provision-operations": "intents", "/var/lib/hivra/provision-results": "results",
      "/etc/pve/qemu-server": "qemu", "/etc/pve/lxc": "lxc", "/run/qemu-server": "pids",
      "/run/hivra-provision": "provision", "/run/lock": "locks", "/proc/pressure/io": "pressure",
      "/proc/meminfo": "meminfo", "/proc/cpuinfo": "cpuinfo", "/sys/class/net": "net",
      "/usr/bin/kvm": "bin/kvm", "/sys/dev/block": "dm", "/dev/kvm": "devices/kvm",
      '"/dev"': 'devices"', "/dev/dm-": "devices/dm-",
    };
    let script = buildPortableKvmDestinationPrepareScript(current);
    for (const [path, target] of Object.entries(replacements)) {
      const quote = path.startsWith('"') ? '"' : "";
      script = script.replaceAll(path, quote + join(root, target));
    }
    script = script
      .replaceAll("st_uid == 0", "st_uid == " + (process.getuid?.() ?? 0))
      .replace("os.geteuid() == 0", "os.geteuid() == " + (process.getuid?.() ?? 0))
      .replace("os.uname().machine == \"x86_64\"", "True")
      .replace("len(os.sched_getaffinity(0))", "8")
      .replaceAll("stat.S_ISCHR", "stat.S_ISREG")
      .replaceAll("stat.S_ISBLK", "stat.S_ISREG")
      .replace('struct.unpack("=Q", fcntl.ioctl(device.fileno(), 0x80081272, bytes(8)))[0]', flags.SMALL_DISK ? "0" : String(plan.disk.bytes))
      .replace("space.f_bavail * space.f_frsize", flags.LOW_STAGING ? "0" : String(64 * gib));
    return spawnSync(lock ? "flock" : "bash",
      lock ? [join(root, "locks", lock), "bash", "-c", script] : ["-c", script], {
        encoding: "utf8", timeout: 5000, env: { NODE_ENV: "test", PATH: join(root, "bin") + ":/usr/bin:/bin", MOCK_ROOT: root, ...flags },
      });
  };
  return { root, put, run, permit, marker, events: () => readFileSync(join(root, "events"), "utf8") };
}

it("allocates once, measures the host readback and emits the disk helper's canonical reservation", () => {
  const host = fixture();
  chmodSync(join(host.root, "state"), 0o755);
  const result = host.run();
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  const reservation = parsePortableKvmDestinationPrepareReceipt(result.stdout, plan)!;
  expect(reservation).toMatchObject({ storageId: "local-lvm", volumeName: "vm-9344-disk-0", deviceMapperUuid: dmUuid,
    hostId: plan.hostId, vmid, disk: plan.disk });
  const configuration = readFileSync(join(host.root, `qemu/${vmid}.conf`));
  const sha256 = createHash("sha256").update(configuration).digest("hex");
  expect(reservation.configurationSha256).toBe(sha256);
  expect(reservation.rawConfigurationSha256).toBe(sha256);
  expect(readFileSync(host.marker, "utf8")).toBe(serializePortableKvmDestinationReservation(reservation));
  expect(statSync(host.marker).mode & 0o777).toBe(0o600);
  expect(statSync(join(host.root, "state/portable-kvm-destinations")).mode & 0o777).toBe(0o700);
  expect(host.run().stdout).toBe(result.stdout);
  expect(host.events()).toBe("create\n");
  expect(parsePortableKvmDestinationPrepareReceipt(result.stdout.repeat(2), plan)).toBeNull();
  expect(parsePortableKvmDestinationPrepareReceipt(result.stdout, { ...plan, generation: 4 })).toBeNull();
  expect(parsePortableKvmDestinationPrepareReceipt(result.stdout.replace(dmUuid, "LVM-unproven"), plan)).toBeNull();
});

it.each([
  ["wrong host", { HOST: "source" }],
  ["cluster collision", { NEXTID: "9345" }],
  ["existing HA resource", { HA: '[{"sid":"vm:9344"}]' }],
  ["unadmitted machine", { MACHINE: "pc-i440fx-8.1 (alias of pc)" }],
  ["unsupported staging filesystem", { FS: "nfs" }],
  ["insufficient staging capacity", { LOW_STAGING: "yes" }],
  ["unapproved thin pool", { THINPOOL: "different" }],
  ["inactive storage", { STORAGE_STATUS: "inactive" }],
  ["insufficient thin data headroom", { DATA_USED: "69.00" }],
  ["insufficient thin metadata headroom", { META_USED: "71.00" }],
  ["orphan LV", { ORPHAN: "yes" }],
] as [string, Record<string, string>][])("refuses %s without creating a VM", (_, flags) => {
  const host = fixture();
  const result = host.run(flags);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("portable KVM prepare:");
  expect(existsSync(host.marker)).toBe(false);
  expect(host.events()).toBe("");
});

it.each([
  ["pressure", "full avg10=1.01 avg60=1.00 avg300=1.00 total=1\n"],
  ["meminfo", "MemAvailable: 63000000 kB\n"],
  ["cpuinfo", "flags : aes popcnt pni sse4_1 sse4_2\n"],
  ["lxc/9344.conf", ""],
  ["qemu/9344.conf", ""],
  ["qemu/9345.conf", "ipconfig0: ip=10.251.10.44/24\n"],
  ["pids/9344.pid", ""],
  ["state/stored-9344", ""],
  ["provision/9344.allocated", "operation_id=someone-else\n"],
  ["intents/operation-existing.selected", "vmid=9344\n"],
  ["intents/operation-another.selected", "vmid=9345\nip=10.251.10.44\n"],
])("refuses conflicting or inadmissible local state (%s)", (file, content) => {
  const host = fixture();
  host.put(file, content);
  expect(host.run().status).toBe(1);
  expect(host.events()).toBe("");
});

it("requires a private, unexpired, exact scope permit under a safe parent", () => {
  const host = fixture();
  expect(host.run({}, undefined, { ...plan, ip: "10.251.10.45" }).status).toBe(1);
  rmSync(join(host.root, host.permit));
  host.put("fake-permit", serializePortableKvmDestinationPreparePermit(plan));
  symlinkSync(join(host.root, "fake-permit"), join(host.root, host.permit));
  expect(host.run().status).toBe(1);
  chmodSync(join(host.root, "state"), 0o775);
  expect(host.run().stderr).toContain("unsafe_sleep_state_directory");
  const expired = fixture({ ...plan, expiresAt: "2025-01-01T00:00:00.000Z" });
  expect(expired.run().status).toBe(1);
  expect(host.events() + expired.events()).toBe("");
});

it("won't reissue a reservation after configuration or device drift", () => {
  const host = fixture();
  expect(host.run().status).toBe(0);
  const cfg = "qemu/9344.conf";
  const original = readFileSync(join(host.root, cfg), "utf8");
  host.put(cfg, original + "vmgenid: 11111111-1111-4111-8111-111111111111\n");
  expect(host.run().stderr).toContain("destination_reservation_drift");
  host.put(cfg, original);
  host.put("dm/0:0/dm/uuid", "LVM-" + "X".repeat(64));
  expect(host.run().stderr).toContain("unexpected_destination_device_uuid");
  expect(host.events()).toBe("create\n");
});

it.each(["hivra-allocation.lock", "hivra-vmids/9344.lock", "hivra-computer-backup.lock",
  "hivra-vm-9344.backup.lock", "hivra-vm-9344.lock"])("refuses the held %s", lock => {
  const host = fixture();
  expect(host.run({}, lock).status).toBe(1);
  expect(host.events()).toBe("");
});

it.each([
  { CREATE_ERROR: "yes" },
  { VM_STATUS: "running" },
  { OPEN_NIC: "yes" },
  { EXTRA_CONFIG: "ide2: local-lvm:cloudinit\n" },
  { EXTRA_CONFIG: "net1: virtio=02:11:22:33:44:55,bridge=vmbr0\n" },
  { EXTRA_CONFIG: "[PENDING]\nonboot: 1\n" },
  { LV_ORIGIN: "parent" },
  { SMALL_DISK: "yes" },
] as Record<string, string>[])("never publishes or adopts a partial attempt (%j)", flags => {
  const host = fixture();
  expect(host.run(flags).status).toBe(1);
  expect(existsSync(host.marker)).toBe(false);
  expect(host.run().stderr).toContain("incomplete_attempt_requires_reconciliation");
  expect(host.events()).toBe("create\n");
});

it("rejects a block path resolving to another LVM identity", () => {
  const host = fixture();
  host.put("dm/0:0/dm/uuid", "LVM-" + "X".repeat(64));
  expect(host.run().stderr).toContain("unexpected_destination_device_uuid");
  expect(existsSync(host.marker)).toBe(false);
});

it("refuses unknown boot configuration, public IPs, special VMIDs and non-GiB disks at the boundary", () => {
  expect(() => buildPortableKvmDestinationPrepareScript({
    ...plan, profile: { ...plan.profile, args: "unapproved" } as PortableKvmDestinationPrepareInput["profile"],
  })).toThrow();
  expect(() => buildPortableKvmDestinationPrepareScript({ ...plan, ip: "203.0.113.44" })).toThrow();
  expect(() => buildPortableKvmDestinationPrepareScript({ ...plan, vmid: 9302 })).toThrow();
  expect(() => buildPortableKvmDestinationPrepareScript({ ...plan, disk: { ...plan.disk, bytes: gib + 512 } })).toThrow();
});
