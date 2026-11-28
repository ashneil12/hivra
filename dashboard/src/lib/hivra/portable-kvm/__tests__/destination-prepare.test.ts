import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedDestroyHivraVmScript } from "../../delete-hivra-agent";
import { serializePortableKvmDestinationReservation } from "../destination-disk";
import {
  buildPortableKvmDestinationPrepareScript,
  buildPortableKvmHostCpuCompatibilityProbeScript,
  parsePortableKvmDestinationPrepareReceipt,
  portableKvmManagedDestinationProfileSchema,
  serializePortableKvmDestinationPreparePermit,
  type PortableKvmDestinationPrepareInput,
} from "../destination-prepare";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));

const gib = 1024 ** 3;
const vmid = 9344;
const dmUuid = "LVM-" + "V".repeat(32) + "L".repeat(32);
const seedUuid = "LVM-" + "V".repeat(32) + "S".repeat(32);
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
const instanceId = "b".repeat(40);
const allocationOperationId = "00000000-0000-4333-8333-00000000ABCD";
const allocationTag = "hivra-op-0000000000004333833300000000abcd";
const managedPlan: PortableKvmDestinationPrepareInput = {
  ...plan,
  profile: {
    ...plan.profile,
    network: { ...plan.profile.network, bridge: "hivra0" },
    managed: {
      allocationOperationId,
      cpu: { vendor: "AuthenticAMD", requiredFlags: ["aes", "avx2", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] },
      cpuLimit: 1.25,
      cloudInit: { instanceId, gateway: "10.251.10.1", nameservers: ["10.251.10.1", "192.0.2.53"] },
    },
  },
};
const resources = { balloonMb: 2048, cpuUnits: 200 };
const managedResourcePlan = {
  ...managedPlan, profile: { ...managedPlan.profile, managed: { ...managedPlan.profile.managed!, resources } },
};
const roots = new Set<string>();
afterEach(() => {
  for (const dir of roots) rmSync(dir, { force: true, recursive: true });
  roots.clear();
});

const hostTools = String.raw`#!/usr/bin/python3
import hashlib
import json
import os
import sys
from pathlib import Path

r = Path(os.environ["MOCK_ROOT"])
name, *args = [Path(sys.argv[0]).name, *sys.argv[1:]]
env = os.environ
cfg = r / "qemu/9344.conf"
slot = cfg.exists() and "name: hivra-slot-9344\n" in cfg.read_text()
snippet = "hivra-portable-meta-22222222-2222-4222-8222-222222222222.yaml"
meta = r / "vz/snippets" / snippet
managed = env.get("MANAGED") == "yes"
seed = {"meta-data": "instance-id: " + "b"*40 + "\n", "vendor-data": "",
        "user-data": "#cloud-config\nuser: ubuntu\n", "network-config": "version: 2\n"}
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
elif name == "pvesh" and args == ["get", "/storage/local", "--output-format", "json"]:
    print(json.dumps(dict(type="dir", path=str(r / "vz"), content=env.get("SNIPPET_CONTENT", "iso,snippets"))))
elif name == "pvesm" and args == ["status", "--storage", "local-lvm"]:
    print("name type status")
    print("local-lvm lvmthin " + env.get("STORAGE_STATUS", "active"))
elif name == "pvesm" and args == ["path", "local-lvm:vm-9344-disk-0"]:
    print(r / "devices/pve/vm-9344-disk-0")
elif name == "pvesm" and args == ["path", "local-lvm:vm-9344-cloudinit"]:
    print(r / "devices/pve/vm-9344-cloudinit")
elif name == "pvesm" and args == ["path", "local:snippets/" + snippet]:
    print(meta)
elif name == "pvesm" and args == ["list", "local-lvm"]:
    for device in (r / "devices/pve").iterdir():
        print("local-lvm:" + device.name)
elif name == "lvs" and args[0:8] == ["--reportformat", "json", "--units", "b", "--nosuffix", "-o",
      "vg_name,vg_uuid,lv_name,lv_uuid,lv_size,lv_attr,pool_lv,origin,data_percent,metadata_percent"]:
    pool = dict(vg_name="pve", lv_name="data", lv_size=str(100 * 1024**3), lv_attr="twi-aotz--",
                data_percent=env.get("DATA_USED", "35.00"), metadata_percent=env.get("META_USED", "8.00"))
    lvs = [pool]
    if (cfg.exists() and not slot) or env.get("ORPHAN"):
        lvs.append(dict(vg_name="pve", lv_name="vm-9344-disk-0", pool_lv="data", lv_attr="Vwi-a-tz--",
                   origin=env.get("LV_ORIGIN", ""), vg_uuid="-".join(["VVVV"] * 8), lv_uuid="-".join(["LLLL"] * 8)))
    if (cfg.exists() and not slot and managed) or env.get("ORPHAN_SEED"):
        lvs.append(dict(vg_name="pve", lv_name="vm-9344-cloudinit", pool_lv="data", lv_attr="Vwi-a-tz--",
                        origin="", vg_uuid="-".join(["VVVV"] * 8), lv_uuid="-".join(["SSSS"] * 8)))
    print(json.dumps({"report": [{"lv": lvs}]}))
elif name == "qm" and args == ["status", "9344"]:
    if not cfg.exists():
        sys.exit(2)
    print("status: " + env.get("VM_STATUS", "stopped"))
elif name == "qm" and args in (["config", "9344"], ["config", "9344", "--current", "1"]):
    raw = cfg.read_text()
    print(raw.split("\n[special:cloudinit]\n")[0] if managed else raw, end="")
elif name == "qm" and args == ["listsnapshot", "9344"]:
    print("-> current")
elif name == "qm" and args in (["stop", "9344", "--timeout", "30"],
                                ["destroy", "9344", "--purge", "1", "--destroy-unreferenced-disks", "1"]):
    with (r / "events").open("a") as f:
        f.write(args[0] + "\n")
    if "lock: backup\n" in cfg.read_text():
        sys.exit(2)
    if args[0] == "destroy":
        cfg.unlink()
        for device in (r / "devices/pve").glob("vm-9344-*"):
            device.unlink()
elif name == "sleep" and args == ["1"]:
    pass
elif name == "qm" and args[0:2] == (["set", "9344"] if managed else ["create", "9344"]):
    if managed:
        assert slot and args[2:5] == ["--skiplock", "1", "--digest"]
        assert args[5] == hashlib.sha1(cfg.read_bytes()).hexdigest()
    else:
        assert args[2:4] == ["--start", "0"]
    tail = args[6 if managed else 4:]
    options = dict(zip(tail[::2], tail[1::2]))
    expected = {
        "--name": "hivra-portable-9344", "--tags": "hivra-bind-" + "a"*32, "--lock": "backup", "--onboot": "0",
        "--arch": "x86_64", "--bios": "seabios", "--machine": "pc-i440fx-8.1", "--ostype": "l26",
        "--cpu": "x86-64-v2-AES", "--cores": "2", "--memory": "2048", "--agent": "1",
        "--scsihw": "virtio-scsi-single", "--boot": "order=scsi0",
        "--net0": "virtio=" + env["MOCK_MAC"] + ",bridge=vmbr0,firewall=1,link_down=1",
        "--scsi0": "local-lvm:12,replicate=0,discard=on,iothread=1",
    }
    if managed:
        expected.update({
            "--tags": "hivra-bind-" + "a"*32 + ";${allocationTag}",
            "--cpu": "host", "--cpulimit": "1.25", "--serial0": "socket", "--vga": "serial0",
            "--ide2": "local-lvm:cloudinit", "--ciuser": "ubuntu", "--citype": "nocloud", "--ciupgrade": "0",
            "--ipconfig0": "ip=10.251.10.44/24,gw=10.251.10.1", "--nameserver": "10.251.10.1 192.0.2.53",
            "--net0": "virtio=" + env["MOCK_MAC"] + ",bridge=hivra0,firewall=1,link_down=1",
            "--cicustom": "meta=local:snippets/" + snippet,
        })
        assert meta.read_text() == seed["meta-data"] and meta.stat().st_mode & 0o777 == 0o600
    if env.get("RESOURCE_ENVELOPE"):
        expected.update({"--balloon": "2048", "--cpuunits": "200"})
    assert options == expected
    assert (r / "state/portable-kvm-destinations/.attempt-9344").exists()
    with (r / "events").open("a") as f:
        f.write("create\n")
    if env.get("CREATE_ERROR"):
        sys.exit(2)
    options["--agent"] = "enabled=1"
    options["--scsi0"] = "local-lvm:vm-9344-disk-0,discard=on,iothread=1,replicate=0,size=12G"
    if managed:
        options["--ide2"] = "local-lvm:vm-9344-cloudinit,media=cdrom,size=4M"
        (r / "devices/pve/vm-9344-cloudinit").symlink_to(r / "devices/dm-1")
    data = "\n".join(k[2:] + ": " + v for k, v in sorted(options.items())) + "\n"
    if env.get("OPEN_NIC"):
        data = data.replace(",link_down=1", "")
    if env.get("READBACK_TAGS"):
        data = data.replace("tags: " + options["--tags"], "tags: " + env["READBACK_TAGS"])
    if env.get("ALTER_RESOURCE"):
        data = data.replace(env["ALTER_RESOURCE"] + "\n", env.get("ALTERED_RESOURCE", "") + "\n").replace("\n\n", "\n")
    cfg.write_text(data + env.get("EXTRA_CONFIG", "") + ("\n[special:cloudinit]\nadded: nameserver\n" if managed else ""))
    (r / "devices/pve/vm-9344-disk-0").symlink_to(r / "devices/dm-0")
elif name == "perl" and managed and args[-2:] == ["9344", hashlib.sha256(cfg.read_bytes()).hexdigest()]:
    assert "PVE::QemuConfig->lock_config" in args[-3] and "PVE::QemuServer::vmconfig_update_cloudinit_drive" in args[-3]
    assert "lock: backup\n" in cfg.read_text()
    with (r / "events").open("a") as f:
        f.write("regenerate\n")
    if not env.get("KEEP_SECTION"):
        cfg.write_text(cfg.read_text().split("\n[special:cloudinit]\n")[0])
    (r / "seed").write_text(json.dumps(seed))
elif name == "qm" and args == ["cloudinit", "dump", "9344", "user"]:
    print(seed["user-data"])
elif name == "qm" and args == ["cloudinit", "dump", "9344", "network"]:
    print(seed["network-config"])
elif name == "isoinfo" and args[:2] == ["-R", "-i"]:
    assert os.readlink(args[2]) == str(r / "devices/dm-1")
    if args[3] == "-f":
        print("/meta-data\n/network-config\n/user-data\n/vendor-data")
    elif args[3] == "-d":
        print("Volume id: cidata")
    elif args[3] == "-x":
        filename = args[4][1:]
        print("unexpected\n" if env.get("BAD_SEED") == filename else json.loads((r / "seed").read_text())[filename], end="")
    else:
        sys.exit(99)
else:
    sys.exit(99)
`;

function fixture(input = plan) {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-destination-prepare-"));
  roots.add(root);
  for (const dir of ["state/portable-kvm-destination-permits", "space/stage", "bin", "qemu", "lxc", "pids",
    "provision", "intents", "results", "locks/hivra-vmids", "devices/pve", "dm/0:0/dm", "dm/0:1/dm",
    "net/vmbr0/bridge", "net/hivra0/bridge", "vz/snippets"]) {
    mkdirSync(join(root, dir), { mode: 0o700, recursive: true });
  }
  const put = (path: string, content: string) => writeFileSync(join(root, path), content, { mode: 0o600 });
  const permit = `state/portable-kvm-destination-permits/${vmid}`;
  const marker = join(root, "state/portable-kvm-destinations", String(vmid));
  put(permit, serializePortableKvmDestinationPreparePermit(input));
  if (input.profile.managed) {
    put(`qemu/${vmid}.conf`, [
      `ipconfig0: ip=${input.ip}/24`, "lock: backup",
      `name: hivra-slot-${vmid}`, "onboot: 0", `tags: hivra-slot-${input.bindingTag.slice(11)}`, "",
    ].join("\n"));
  }
  put("pressure", "full avg10=0.50 avg60=0.50 avg300=0.50 total=1\n");
  put("meminfo", "MemAvailable: 93716480 kB\n");
  put("cpuinfo", "processor : 0\nvendor_id : AuthenticAMD\nflags : aes avx2 cx16 popcnt pni sse4_1 sse4_2 ssse3\n");
  put("events", "");
  put("devices/kvm", "");
  put("devices/dm-0", "");
  put("devices/dm-1", "");
  put("dm/0:0/dm/uuid", dmUuid);
  put("dm/0:1/dm/uuid", seedUuid);
  const tool = join(root, "host-tools");
  writeFileSync(tool, hostTools, { mode: 0o700 });
  for (const command of ["qm", "pvesh", "pvesm", "hostname", "findmnt", "lvs", "kvm", "perl", "isoinfo", "sleep"]) {
    symlinkSync(tool, join(root, "bin", command));
  }
  const run = (flags: Record<string, string> = {}, lock?: string, current = input) => {
    const replacements = {
      "/var/lib/hivra-sleep": "state", "/var/lib/hivra/portable-kvm-restore-staging": "space/stage",
      "/var/lib/hivra/provision-operations": "intents", "/var/lib/hivra/provision-results": "results",
      "/etc/pve/qemu-server": "qemu", "/etc/pve/lxc": "lxc", "/run/qemu-server": "pids",
      "/run/hivra-provision": "provision", "/run/lock": "locks", "/proc/pressure/io": "pressure",
      "/proc/meminfo": "meminfo", "/proc/cpuinfo": "cpuinfo", "/sys/class/net": "net",
      "/usr/bin/kvm": "bin/kvm", "/usr/bin/perl": "bin/perl", "/var/lib/vz/snippets": "vz/snippets",
      "/sys/dev/block": "dm", "/dev/kvm": "devices/kvm",
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
      .replace('struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]', flags.SMALL_DISK ? "0" : "size_expected")
      .replace("str(os.minor(info.st_rdev))", '("1" if name.endswith("cloudinit") else "0")')
      .replace("space.f_bavail * space.f_frsize", flags.LOW_STAGING ? "0" : String(64 * gib));
    return spawnSync(lock ? "flock" : "bash",
      lock ? [join(root, "locks", lock), "bash", "-c", script] : ["-c", script], {
        encoding: "utf8", timeout: 5000, env: {
          NODE_ENV: "test", PATH: join(root, "bin") + ":/usr/bin:/bin", MOCK_ROOT: root,
          MANAGED: current.profile.managed ? "yes" : "", MOCK_MAC: current.profile.network.macAddress, ...flags,
          RESOURCE_ENVELOPE: current.profile.managed?.resources ? "yes" : "",
        },
      });
  };
  const runDelete = (
    expectedAllocationOperationId: string | null,
    expectedInfrastructureBindingTag: string | null,
  ) => {
    const script = verifiedDestroyHivraVmScript({
      vmid, storage: input.storageId, expectedAllocationOperationId, expectedInfrastructureBindingTag,
      allowManagedLegacyAuthority: false, cleanupPaths: [],
    }).replaceAll("/run/lock", join(root, "locks"))
      .replaceAll("/run/hivra-provision", join(root, "provision"))
      .replaceAll("/var/lib/hivra/provision-results", join(root, "results"))
      .replaceAll("/var/lib/hivra/provision-operations", join(root, "intents"));
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 5000,
      env: { NODE_ENV: "test", PATH: join(root, "bin") + ":/usr/bin:/bin", MOCK_ROOT: root },
    });
  };
  return { root, put, run, runDelete, permit, marker, events: () => readFileSync(join(root, "events"), "utf8") };
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
  expect(configuration.toString()).toContain(`tags: ${plan.bindingTag}\n`);
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
  expect(() => buildPortableKvmDestinationPrepareScript({ ...plan, vmid: 1221 })).not.toThrow();
  expect(() => buildPortableKvmDestinationPrepareScript({ ...plan, disk: { ...plan.disk, bytes: gib + 512 } })).toThrow();
});

it("recreates only the generated managed NoCloud seed and preserves the source instance ID", () => {
  const host = fixture(managedPlan);
  const result = host.run();
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  const reservation = parsePortableKvmDestinationPrepareReceipt(result.stdout, managedPlan)!;
  expect(readFileSync(host.marker, "utf8")).toBe(serializePortableKvmDestinationReservation(reservation));
  expect(result.stdout).not.toContain(instanceId);
  expect(result.stdout).not.toContain(managedPlan.ip);
  expect(result.stdout).not.toContain("#cloud-config");
  expect(readFileSync(join(host.root, `vz/snippets/hivra-portable-meta-${managedPlan.operationId}.yaml`), "utf8"))
    .toBe(`instance-id: ${instanceId}\n`);
  const config = readFileSync(join(host.root, "qemu/9344.conf"), "utf8");
  expect(config).not.toContain("[special:cloudinit]");
  expect(config).not.toMatch(/sshkeys|cipassword|(?:user|vendor|network)=local:/);
  expect(config).toContain("ide2: local-lvm:vm-9344-cloudinit,media=cdrom,size=4M");
  expect(host.run().stdout).toBe(result.stdout);
  expect(host.events()).toBe("create\nregenerate\n");

  host.put(`vz/snippets/hivra-portable-meta-${managedPlan.operationId}.yaml`, `instance-id: ${"a".repeat(40)}\n`);
  expect(host.run().stderr).toContain("cloudinit_metadata_mismatch");
  expect(host.events()).toBe("create\nregenerate\n");
});

it.each([
  ["without explicit resources", managedPlan], ["with explicit resources", managedResourcePlan],
] as const)("lets signed Delete destroy the released managed destination %s using its original allocation identity", (_, input) => {
  const host = fixture(input);
  const result = host.run();
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  const cfg = `qemu/${vmid}.conf`;
  const prepared = readFileSync(join(host.root, cfg), "utf8");
  expect(prepared).toContain(`tags: ${managedPlan.bindingTag};${allocationTag}\n`);
  const reservation = parsePortableKvmDestinationPrepareReceipt(result.stdout, input);
  expect(reservation?.resources).toEqual(input.profile.managed!.resources);
  expect(readFileSync(host.marker, "utf8")).toBe(serializePortableKvmDestinationReservation(reservation!));
  if (input.profile.managed!.resources) {
    expect(prepared).toContain("balloon: 2048\n");
    expect(prepared).toContain("cpuunits: 200\n");
    expect(parsePortableKvmDestinationPrepareReceipt(result.stdout, managedPlan)).toBeNull();
    expect(parsePortableKvmDestinationPrepareReceipt(result.stdout.replace('"cpuUnits":200', '"cpuUnits":100'), input)).toBeNull();
  }

  const released = prepared.replace("lock: backup\n", "");
  expect(released).not.toBe(prepared);
  host.put(cfg, released);

  for (const [allocation, binding, error] of [
    [null, managedPlan.bindingTag, "without complete provider ownership evidence"],
    [managedPlan.operationId, managedPlan.bindingTag, "ownership changed before deletion"],
    [allocationOperationId, null, "without complete provider ownership evidence"],
    [allocationOperationId, "hivra-bind-" + "c".repeat(32), "ownership changed before deletion"],
  ] as const) {
    const refused = host.runDelete(allocation, binding);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(error);
    expect(readFileSync(join(host.root, cfg), "utf8")).toBe(released);
    expect(host.events()).toBe("create\nregenerate\n");
  }

  const deleted = host.runDelete(allocationOperationId, managedPlan.bindingTag);
  expect({ status: deleted.status, error: deleted.stderr, receipt: deleted.stdout }).toEqual({
    status: 0, error: "", receipt: `destroyed ${vmid}\n`,
  });
  expect(existsSync(join(host.root, cfg))).toBe(false);
  expect(host.events()).toBe("create\nregenerate\nstop\ndestroy\n");
});

it.each([
  [{ balloonMb: 2048 }], [{ cpuUnits: 200 }], [{ balloonMb: 1024, cpuUnits: 200 }],
  [{ balloonMb: 16385, cpuUnits: 200 }], [{ balloonMb: 2048, cpuUnits: 0 }],
  [{ balloonMb: 2048, cpuUnits: 10001 }], [{ balloonMb: 2048, cpuUnits: 50.1 }],
  [{ balloonMb: 2048, cpuUnits: 200, source: true }],
])("rejects an invalid or mismatched managed resource envelope: %j", invalid => {
  const profile = managedResourcePlan.profile;
  expect(() => serializePortableKvmDestinationPreparePermit({
    ...managedResourcePlan, profile: { ...profile, managed: { ...profile.managed, resources: invalid as typeof resources } },
  })).toThrow();
});

it("does not accept allocation resources in the base managed runtime profile", () => {
  const { cpu, cpuLimit, cloudInit } = managedResourcePlan.profile.managed;
  expect(portableKvmManagedDestinationProfileSchema.safeParse({ cpu, cpuLimit, cloudInit, resources }).success).toBe(false);
});

it.each([
  ["memory: 2048", "memory: 4096"], ["balloon: 2048", "balloon: 1024"], ["cpuunits: 200", "cpuunits: 100"],
  ["balloon: 2048", ""], ["cpuunits: 200", ""],
])("does not reserve a destination with resource readback drift (%s → %s)", (key, value) => {
  const host = fixture(managedResourcePlan);
  const result = host.run({ ALTER_RESOURCE: key, ALTERED_RESOURCE: value });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unexpected_destination_configuration");
  expect(existsSync(host.marker)).toBe(false);
});

it.each([plan, managedPlan])("rejects unauthorized resource fields in prepared config", input => {
  const host = fixture(input);
  const result = host.run({ EXTRA_CONFIG: "balloon: 2048\ncpuunits: 200\n" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsupported_destination_configuration");
  expect(existsSync(host.marker)).toBe(false);
});

const invalidOwnershipTags = [
  ["missing allocation", managedPlan.bindingTag],
  ["wrong allocation", `${managedPlan.bindingTag};hivra-op-22222222222242228222222222222222`],
  ["missing binding", allocationTag],
  ["wrong binding", `hivra-bind-${"c".repeat(32)};${allocationTag}`],
] as const;

it.each([
  ...invalidOwnershipTags,
  ["extra tag", `${managedPlan.bindingTag};${allocationTag};extra`] as const,
])("rejects the managed destination readback with %s", (_, tags) => {
  const host = fixture(managedPlan);
  const result = host.run({ READBACK_TAGS: tags });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unexpected_destination_ownership");
  expect(existsSync(host.marker)).toBe(false);
  expect(host.events()).toBe("create\n");
});

it.each(invalidOwnershipTags)("refuses to Delete the partial destination config with %s", (_, tags) => {
  const host = fixture(managedPlan);
  expect(host.run({ READBACK_TAGS: tags }).status).toBe(1);
  const cfg = join(host.root, `qemu/${vmid}.conf`);
  const partial = readFileSync(cfg, "utf8");
  const refused = host.runDelete(allocationOperationId, managedPlan.bindingTag);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("ownership changed before deletion");
  expect(readFileSync(cfg, "utf8")).toBe(partial);
  expect(host.events()).toBe("create\n");
});

it("preserves the ordinary globally administered Proxmox unicast MAC and refuses group or empty addresses", () => {
  const profile = { ...managedPlan.profile, network: { ...managedPlan.profile.network, macAddress: "BC:24:11:12:34:56" } };
  const input = { ...managedPlan, profile };
  const host = fixture(input);
  const result = host.run();
  expect(parsePortableKvmDestinationPrepareReceipt(result.stdout, input)).not.toBeNull();
  expect(readFileSync(join(host.root, "qemu/9344.conf"), "utf8")).toContain("virtio=BC:24:11:12:34:56");
  for (const macAddress of ["01:24:11:12:34:56", "00:00:00:00:00:00"]) {
    expect(() => serializePortableKvmDestinationPreparePermit({
      ...input, profile: { ...profile, network: { ...profile.network, macAddress } },
    })).toThrow();
  }
});

it.each([
  ["missing", ""],
  ["different binding", "tags: hivra-slot-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  ["network hardware", "net0: virtio=02:11:22:33:44:55,bridge=hivra0"],
  ["bootable", "boot: order=net0"],
])("does not convert a %s managed destination slot", (variant, extra) => {
  const host = fixture(managedPlan);
  const cfg = join(host.root, "qemu/9344.conf");
  if (variant === "missing") rmSync(cfg);
  else {
    const raw = readFileSync(cfg, "utf8");
    const key = extra.split(":")[0];
    host.put("qemu/9344.conf", raw.split("\n").filter(line => !line.startsWith(key + ":")).concat(extra, "").join("\n"));
  }
  expect(host.run().stderr).toMatch(/destination_slot_(?:missing|binding_mismatch|not_diskless)/);
  expect(host.events()).toBe("");
  expect(existsSync(host.marker)).toBe(false);
});

it.each([
  { SNIPPET_CONTENT: "images" },
  { ORPHAN_SEED: "yes" },
] as Record<string, string>[])("refuses conflicting seed prerequisites before VM creation (%j)", flags => {
  const host = fixture(managedPlan);
  expect(host.run(flags).status).toBe(1);
  expect(host.events()).toBe("");
});

it.each(["meta-data", "vendor-data", "user-data", "network-config"])("refuses a generated %s seed mismatch", filename => {
  const host = fixture(managedPlan);
  expect(host.run({ BAD_SEED: filename }).stderr).toContain("generated_cloudinit_seed_mismatch");
  expect(existsSync(host.marker)).toBe(false);
  expect(host.events()).toBe("create\nregenerate\n");
});

it("refuses remaining sections and arbitrary config even on the generated-seed profile", () => {
  const host = fixture(managedPlan);
  expect(host.run({ KEEP_SECTION: "yes" }).stderr).toContain("destination_has_config_sections");
  expect(existsSync(host.marker)).toBe(false);
  const unexpected = fixture(managedPlan);
  expect(unexpected.run({ EXTRA_CONFIG: "sshkeys: unauthorized\n" }).stderr).toContain("unsupported_destination_configuration");
  expect(unexpected.events()).toBe("create\n");
});

it("records durable owner-scoped abort lineage only after each native step confirms it", () => {
  const abortPlan = { ...managedPlan, abortScope: { ownerId: "user_OfflineFixture" } };
  const failedConversion = fixture(abortPlan);
  const slot = readFileSync(join(failedConversion.root, "qemu/9344.conf"));
  expect(failedConversion.run({ CREATE_ERROR: "yes" }).status).toBe(1);
  const dir = "state/portable-kvm-destinations";
  const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  const prepareSha256 = digest(serializePortableKvmDestinationPreparePermit(abortPlan));
  expect(JSON.parse(readFileSync(join(failedConversion.root, dir, ".abort-slot-9344"), "utf8"))).toEqual({
    prepareSha256, rawSha256: digest(slot),
  });
  expect(existsSync(join(failedConversion.root, dir, ".abort-native-9344"))).toBe(false);

  const failedSeedReadback = fixture(abortPlan);
  expect(failedSeedReadback.run({ BAD_SEED: "meta-data" }).stderr).toContain("generated_cloudinit_seed_mismatch");
  const native = JSON.parse(readFileSync(join(failedSeedReadback.root, dir, ".abort-native-9344"), "utf8"));
  const seeded = JSON.parse(readFileSync(join(failedSeedReadback.root, dir, ".abort-seed-9344"), "utf8"));
  expect(native).toMatchObject({ prepareSha256, volumes: {
    "vm-9344-disk-0": { vgUuid: Array(8).fill("VVVV").join("-"), lvUuid: Array(8).fill("LLLL").join("-") },
    "vm-9344-cloudinit": { vgUuid: Array(8).fill("VVVV").join("-"), lvUuid: Array(8).fill("SSSS").join("-") },
  } });
  expect(seeded).toMatchObject({ prepareSha256, currentSha256: native.currentSha256, volumes: native.volumes });
  expect(native.rawSha256).not.toBe(seeded.rawSha256);
  expect(existsSync(failedSeedReadback.marker)).toBe(false);

  const journalClaimed = fixture(abortPlan);
  mkdirSync(join(journalClaimed.root, dir), { recursive: true, mode: 0o700 });
  journalClaimed.put(dir + "/.abort-journal-" + abortPlan.operationId, "{}");
  expect(journalClaimed.run().stderr).toContain("destination_abort_already_claimed");
  expect(journalClaimed.events()).toBe("");
});

it("checks measured source CPU features on every target processor before creating a host-CPU VM", () => {
  const host = fixture(managedPlan);
  const flags = "aes avx2 cx16 popcnt pni sse4_1 sse4_2 ssse3";
  host.put("cpuinfo", `processor: 0\nvendor_id: AuthenticAMD\nflags: ${flags}\n\nprocessor: 1\nvendor_id: AuthenticAMD\nflags: ${flags.replace("avx2 ", "")}\n`);
  expect(host.run().stderr).toContain("host_cpu_incompatible");
  expect(host.events()).toBe("");
  const script = buildPortableKvmHostCpuCompatibilityProbeScript(plan.hostId)
    .replaceAll("/proc/cpuinfo", join(host.root, "cpuinfo"))
    .replace("os.geteuid() == 0", "os.geteuid() == " + (process.getuid?.() ?? 0))
    .replace('os.uname().machine == "x86_64"', "True");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8", env: { NODE_ENV: "test", PATH: join(host.root, "bin") + ":/usr/bin:/bin", MOCK_ROOT: host.root },
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ vendor: "AuthenticAMD", requiredFlags: flags.split(" ").filter(flag => flag !== "avx2").sort() });
});

it("validates the managed permit without allowing scripts, passwords, SSH keys or a different network", () => {
  const profile = managedPlan.profile;
  const managed = profile.managed!;
  const cloudInit = managed.cloudInit;
  for (const invalid of [
    { ...cloudInit, instanceId: instanceId + "\nruncmd: fakescript" },
    { ...cloudInit, gateway: "10.251.12.1" },
    { ...cloudInit, nameservers: ["127.0.0.1"] },
    { ...cloudInit, nameservers: ["192.0.2.53", "192.0.2.53"] },
    { ...cloudInit, vendor: "unapproved" },
    { ...cloudInit, password: "unapproved" },
    { ...cloudInit, sshKeys: ["unapproved"] },
  ]) {
    expect(() => serializePortableKvmDestinationPreparePermit({
      ...managedPlan, profile: { ...profile, managed: { ...managed, cloudInit: invalid } },
    })).toThrow();
  }
});

it.each([undefined, "", "00000000-0000-7333-8333-00000000ABCD", "00000000-0000-4333-7333-00000000ABCD"])(
  "refuses an invalid or missing managed allocation operation ID (%s)",
  invalid => {
    expect(() => serializePortableKvmDestinationPreparePermit({
      ...managedPlan, profile: {
        ...managedPlan.profile, managed: { ...managedPlan.profile.managed!, allocationOperationId: invalid as string },
      },
    })).toThrow();
  },
);
