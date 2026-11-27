import { shellQuote } from "@/lib/hivra/proxmox-target";
import { isIPv4 } from "node:net";
import { z } from "zod";
import {
  serializePortableKvmDestinationReservation,
  type PortableKvmDestinationReservation,
} from "./destination-disk";

const prefix = "HIVRA_KVM_PORTABLE_PREPARE_V1 ";
const gib = 1024 ** 3;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const storageName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const planSchema = z.object({
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  checkpointSha256: sha256,
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(9300).max(9399).refine(value => value !== 9302),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  ip: z.string().refine(value => isIPv4(value) && /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(value)),
  expiresAt: z.string().datetime(),
  storageId: storageName,
  volumeGroup: storageName,
  thinPool: storageName,
  profile: z.object({
    machine: z.string().regex(/^pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?$/),
    cores: z.number().int().min(1).max(8),
    memoryMb: z.number().int().min(1024).max(16384),
    network: z.object({
      bridge: z.string().regex(/^vmbr[0-9]{1,4}$/),
      macAddress: z.string().regex(/^[0-9A-F][26AE](?::[0-9A-F]{2}){5}$/),
    }).strict(),
    attachment: z.object({ discard: z.boolean(), ssd: z.boolean(), ioThread: z.boolean() }).strict(),
  }).strict(),
  disk: z.object({
    key: z.literal("scsi0"), snapshotId: sha256,
    bytes: z.number().int().min(gib).max(40 * gib).refine(value => value % gib === 0),
    sha256,
  }).strict(),
}).strict();

export type PortableKvmDestinationPrepareInput = z.infer<typeof planSchema>;

/**
 * Only the operator that independently verifies the active restore claim, the
 * supported source profile, and the exact storage and quarantined network placement
 * may install these bytes at /var/lib/hivra-sleep/portable-kvm-destination-permits/<vmid>.
 * The permit is root:0600 and the permit directory is root:0700. The operator must
 * reserve the IP outside ordinary allocation until cutover; prep does not assign it.
 */
export function serializePortableKvmDestinationPreparePermit(input: PortableKvmDestinationPrepareInput): string {
  return JSON.stringify(planSchema.parse(input)) + "\n";
}

const prepare = String.raw`
import fcntl
import hashlib
import json
import os
import re
import stat
import struct
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)

def private_dir(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "unsafe_private_directory")

def private_read(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 8192, "unsafe_private_file")
        return handle.read(8193)

def publish(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent) as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
        os.link(handle.name, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def lock(stack, path):
    fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "unsafe_host_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

def check_permit():
    seconds = (expires - datetime.now(timezone.utc)).total_seconds()
    require(0 < seconds <= 86400 and private_read(permit) == expected, "destination_permit_mismatch_or_expired")

def check_unowned():
    for path in ([root / (name + "-" + vmid) for name in ("cold", "stored")]
                 + [root / "portable-kvm-fences" / vmid, Path("/etc/pve/lxc", vmid + ".conf"), pid]
                 + [Path("/run/hivra-provision", vmid + "." + suffix)
                    for suffix in ("allocated", "env", "pid", "secret")]
                 + [Path("/var/lib/hivra/provision-results", vmid + ".secret")]):
        require(not os.path.lexists(path), "destination_has_existing_state")
    ip = plan["ip"].encode("ascii")
    for intent in Path("/var/lib/hivra/provision-operations").glob("operation-*.selected"):
        lines = private_read(intent).splitlines()
        require(b"vmid=" + vmid.encode("ascii") not in lines and b"ip=" + ip not in lines,
                "destination_has_provision_intent")
    for other in cfg.parent.glob("*.conf"):
        if other != cfg:
            require(not re.search(rb"^ipconfig[0-9]+:.*[ ,]ip=" + re.escape(ip) + rb"(?:[/,\s]|$)",
                                  other.read_bytes(), re.M), "destination_ip_in_use")
    ha = json.loads(output("pvesh", "get", "/cluster/ha/resources", "--output-format", "json"))
    require(isinstance(ha, list) and all(item["sid"] not in {"vm:" + vmid, "ct:" + vmid, "lxc:" + vmid}
                                       for item in ha), "destination_is_ha_managed")

def check_headroom():
    pressure = re.findall(r"^full avg10=([0-9]+\.[0-9]+) ", Path("/proc/pressure/io").read_text(), re.M)
    require(len(pressure) == 1 and Decimal(pressure[0]) <= 1, "host_io_pressure")
    memory = re.findall(r"^MemAvailable:\s+([0-9]+) kB$", Path("/proc/meminfo").read_text(), re.M)
    require(len(memory) == 1 and int(memory[0]) >= (60 * 1024 + profile["memoryMb"]) * 1024,
            "host_memory_headroom")
    require(stat.S_ISCHR(Path("/dev/kvm").stat().st_mode) and os.uname().machine == "x86_64"
            and len(os.sched_getaffinity(0)) >= profile["cores"], "host_kvm_unavailable")
    flags = re.findall(r"^flags\s*:\s*([\w ]+)$", Path("/proc/cpuinfo").read_text(), re.M)
    require(flags and all({"aes", "popcnt", "pni", "sse4_1", "sse4_2", "ssse3"} <= set(cpu.split())
                          for cpu in flags), "host_cpu_unsupported")
    machine = profile["machine"].encode("ascii")
    machines = output("/usr/bin/kvm", "-machine", "help").splitlines()
    require(any(line.split()[:1] == [machine] and b"(alias of " not in line for line in machines),
            "host_machine_unsupported")
    require(Path("/sys/class/net", profile["network"]["bridge"], "bridge").is_dir(), "host_bridge_unavailable")
    parent = stage.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022,
            "unsafe_staging_parent")
    private_dir(stage)
    require(output("findmnt", "-n", "-o", "FSTYPE", "--target", str(stage)).strip()
            in {b"ext4", b"xfs", b"zfs", b"btrfs"}, "unsupported_staging_filesystem")
    space = os.statvfs(stage)
    require(space.f_bavail * space.f_frsize >= plan["disk"]["bytes"] + 4 * gib, "staging_headroom")

def check_storage():
    storage = json.loads(output("pvesh", "get", "/storage/" + plan["storageId"], "--output-format", "json"))
    require(storage.get("type") == "lvmthin" and storage.get("vgname") == plan["volumeGroup"]
            and storage.get("thinpool") == plan["thinPool"] and storage.get("shared", 0) == 0
            and "images" in storage.get("content", "").split(","), "unsupported_destination_storage")
    status = output("pvesm", "status", "--storage", plan["storageId"]).decode("ascii").splitlines()
    require(len(status) == 2 and status[1].split()[:3] == [plan["storageId"], "lvmthin", "active"],
            "inactive_destination_storage")
    groups = json.loads(output("lvs", "--reportformat", "json", "--units", "b", "--nosuffix", "-o",
                        "vg_name,vg_uuid,lv_name,lv_uuid,lv_size,lv_attr,pool_lv,origin,data_percent,metadata_percent"))["report"]
    require(len(groups) == 1, "invalid_lvm_report")
    all_lvs = groups[0]["lv"]
    pool, = [lv for lv in all_lvs if lv["vg_name"] == plan["volumeGroup"] and lv["lv_name"] == plan["thinPool"]]
    require(re.fullmatch(r"t...a...-.", pool["lv_attr"]) is not None, "unhealthy_thin_pool")
    size, used, meta = map(Decimal, (pool["lv_size"], pool["data_percent"], pool["metadata_percent"]))
    require(size > 0 and 0 <= used <= 80 and 0 <= meta <= 70
            and size * (80 - used) >= 100 * plan["disk"]["bytes"], "thin_pool_headroom")
    owned = [lv for lv in all_lvs if re.match(r"(?:snap_)?(?:vm|base)-" + vmid + "-", lv["lv_name"])]
    return owned

def fields(data):
    result = {}
    for line in data.decode("utf-8").splitlines():
        if not line:
            continue
        key, sep, value = line.partition(": ")
        require(sep and key not in result, "invalid_destination_configuration")
        result[key] = value
    return result

def properties(value):
    result = {}
    for pair in value.split(","):
        key, sep, setting = pair.partition("=")
        require(sep and key not in result, "invalid_destination_device_options")
        result[key] = setting
    return result

def measure_destination():
    require(output("qm", "status", vmid).strip() == b"status: stopped" and not os.path.lexists(pid),
            "destination_not_stopped")
    raw = cfg.read_bytes()
    current = output("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    require(not re.search(rb"^\s*\[", raw, re.M), "destination_has_config_sections")
    config = fields(current)
    require(config == fields(raw), "destination_has_pending_configuration")
    for key, value in requested.items():
        if key not in {"agent", "scsi0", "net0"}:
            require(config.pop(key, None) == value, "unexpected_destination_configuration")
    require(config.pop("agent", None) in {"1", "enabled=1"}, "missing_destination_guest_agent")
    require(config.pop("net0", None) == requested["net0"], "destination_nic_not_quarantined")
    disk, _, options = config.pop("scsi0", "").partition(",")
    props = properties(options)
    require(disk == volume and props.pop("replicate", None) == "0"
            and props.pop("size", None) == str(size_gib) + "G", "unexpected_destination_disk")
    require(props.pop("discard", "ignore") == ("on" if attach["discard"] else "ignore")
            and props.pop("ssd", "0") == str(int(attach["ssd"]))
            and props.pop("iothread", "0") == str(int(attach["ioThread"])) and not props,
            "unexpected_destination_disk_options")
    require(set(config) <= {"meta", "smbios1", "vmgenid"}
            and ("smbios1" not in config or re.fullmatch(r"uuid=[a-f0-9-]{36}", config["smbios1"])),
            "unsupported_destination_configuration")

    lv, = check_storage()
    require(lv["vg_name"] == plan["volumeGroup"] and lv["lv_name"] == volume_name
            and lv["pool_lv"] == plan["thinPool"] and lv["origin"] == ""
            and re.fullmatch(r"V...a...-.", lv["lv_attr"]) is not None,
            "unexpected_destination_volume")
    configured = output("pvesm", "path", volume).decode("ascii").rstrip("\n")
    require(configured == str(volume_path), "unexpected_destination_volume_path")
    path = os.path.realpath(configured)
    require(re.fullmatch(r"/dev/dm-[0-9]+", path) is not None, "unexpected_destination_device")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_EXCL | os.O_NOFOLLOW), "rb") as device:
        info = os.fstat(device.fileno())
        node = os.stat(path, follow_symlinks=False)
        require(stat.S_ISBLK(info.st_mode) and stat.S_ISBLK(node.st_mode)
                and (info.st_dev, info.st_ino, info.st_rdev) == (node.st_dev, node.st_ino, node.st_rdev),
                "unexpected_destination_device")
        size = struct.unpack("=Q", fcntl.ioctl(device.fileno(), 0x80081272, bytes(8)))[0]
        require(size == plan["disk"]["bytes"], "unexpected_destination_disk_size")
        dm = Path("/sys/dev/block", str(os.major(info.st_rdev)) + ":" + str(os.minor(info.st_rdev)), "dm/uuid")
        dm_uuid = dm.read_text().strip()
        require(re.fullmatch(r"LVM-[a-zA-Z0-9]{64}", dm_uuid) is not None
                and dm_uuid == "LVM-" + (lv["vg_uuid"] + lv["lv_uuid"]).replace("-", ""),
                "unexpected_destination_device_uuid")
    return {**{key: plan[key] for key in ("agentId", "operationId", "generation", "checkpointSha256",
                                         "hostId", "vmid", "bindingTag")},
            "configurationSha256": hashlib.sha256(current).hexdigest(),
            "rawConfigurationSha256": hashlib.sha256(raw).hexdigest(),
            "storageId": plan["storageId"], "volumeName": volume_name, "volumeGroup": plan["volumeGroup"],
            "deviceMapperUuid": dm_uuid, "disk": plan["disk"]}

def run():
    require(os.geteuid() == 0 and output("hostname", "-s").strip() == plan["hostId"].encode("ascii"), "wrong_host")
    os.umask(0o077)
    parent = root.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and stat.S_IMODE(parent.st_mode) in {0o700, 0o755},
            "unsafe_sleep_state_directory")
    private_dir(permit.parent)
    check_permit()
    with ExitStack() as stack:
        lock(stack, locks / "hivra-allocation.lock")
        vmids = locks / "hivra-vmids"
        try:
            vmids.mkdir(mode=0o755)
        except FileExistsError:
            pass
        directory = vmids.lstat()
        require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and not directory.st_mode & 0o022,
                "unsafe_vmid_lock_directory")
        lock(stack, vmids / (vmid + ".lock"))
        lock(stack, locks / "hivra-computer-backup.lock")
        lock(stack, locks / ("hivra-vm-" + vmid + ".backup.lock"))
        lock(stack, locks / ("hivra-vm-" + vmid + ".lock"))
        private_dir(registry, create=True)
        check_unowned()
        check_headroom()
        if os.path.lexists(marker):
            require(private_read(attempt) == expected, "destination_attempt_mismatch")
            reservation = measure_destination()
            wire = (json.dumps(reservation, separators=(",", ":")) + "\n").encode("ascii")
            require(private_read(marker) == wire, "destination_reservation_drift")
        else:
            require(not os.path.lexists(attempt), "destination_incomplete_attempt_requires_reconciliation")
            require(not os.path.lexists(cfg) and not os.path.lexists(volume_path)
                    and output("pvesh", "get", "/cluster/nextid", "--vmid", vmid).strip() == vmid.encode("ascii"),
                    "destination_not_free")
            require(not check_storage(), "destination_has_existing_volumes")
            check_permit()
            publish(attempt, expected)
            args = [item for key, value in requested.items() for item in ("--" + key, value)]
            output("qm", "create", vmid, "--start", "0", *args)
            check_permit()
            check_headroom()
            check_unowned()
            reservation = measure_destination()
            wire = (json.dumps(reservation, separators=(",", ":")) + "\n").encode("ascii")
            publish(marker, wire)
        check_permit()
        print("HIVRA_KVM_PORTABLE_PREPARE_V1 " + wire.decode("ascii").rstrip("\n"))

expected = sys.argv[1].encode("ascii")
plan = json.loads(expected)
vmid = str(plan["vmid"])
profile = plan["profile"]
attach = profile["attachment"]
gib = 1024 ** 3
size_gib = plan["disk"]["bytes"] // gib
volume_name = "vm-" + vmid + "-disk-0"
volume = plan["storageId"] + ":" + volume_name
volume_path = Path("/dev", plan["volumeGroup"], volume_name)
root = Path("/var/lib/hivra-sleep")
registry = root / "portable-kvm-destinations"
permit = root / "portable-kvm-destination-permits" / vmid
attempt = registry / (".attempt-" + vmid)
marker = registry / vmid
stage = Path("/var/lib/hivra/portable-kvm-restore-staging")
locks = Path("/run/lock")
cfg = Path("/etc/pve/qemu-server", vmid + ".conf")
pid = Path("/run/qemu-server", vmid + ".pid")
network = profile["network"]
requested = {"name": "hivra-portable-" + vmid, "tags": plan["bindingTag"], "lock": "backup", "onboot": "0",
             "arch": "x86_64", "bios": "seabios", "machine": profile["machine"], "ostype": "l26",
             "cpu": "x86-64-v2-AES", "cores": str(profile["cores"]), "memory": str(profile["memoryMb"]),
             "agent": "1", "scsihw": "virtio-scsi-single", "boot": "order=scsi0",
             "net0": "virtio=" + network["macAddress"] + ",bridge=" + network["bridge"] + ",firewall=1,link_down=1",
             "scsi0": plan["storageId"] + ":" + str(size_gib) + ",replicate=0"
                      + (",discard=on" if attach["discard"] else "")
                      + (",ssd=1" if attach["ssd"] else "") + (",iothread=1" if attach["ioThread"] else "")}
try:
    expires = datetime.fromisoformat(plan["expiresAt"].replace("Z", "+00:00"))
    run()
except RuntimeError as error:
    sys.exit("portable KVM prepare: " + str(error))
except (ArithmeticError, KeyError, OSError, TypeError, ValueError, subprocess.SubprocessError):
    sys.exit("portable KVM prepare: host admission or readback failed")
`;

/**
 * Run only on the authenticated, pinned destination as root, with a trusted
 * operation-specific permit already installed. Never consumes source VM config.
 * A partial attempt leaves its claim and any stopped/locked artifacts in place
 * for operator reconciliation; retry only reads an existing complete reservation.
 */
export function buildPortableKvmDestinationPrepareScript(input: PortableKvmDestinationPrepareInput): string {
  return `exec timeout -k 5 105 python3 -I -c ${shellQuote(prepare)} ${shellQuote(serializePortableKvmDestinationPreparePermit(input))}\n`;
}

export function parsePortableKvmDestinationPrepareReceipt(
  stdout: string, input: PortableKvmDestinationPrepareInput,
): PortableKvmDestinationReservation | null {
  const plan = planSchema.parse(input);
  const receipts = stdout.split("\n").filter(line => line.startsWith(prefix));
  if (receipts.length !== 1) return null;
  try {
    const reservation: PortableKvmDestinationReservation = JSON.parse(receipts[0].slice(prefix.length));
    serializePortableKvmDestinationReservation(reservation);
    if (reservation.agentId !== plan.agentId || reservation.operationId !== plan.operationId
      || reservation.generation !== plan.generation || reservation.checkpointSha256 !== plan.checkpointSha256
      || reservation.hostId !== plan.hostId || reservation.vmid !== plan.vmid || reservation.bindingTag !== plan.bindingTag
      || reservation.storageId !== plan.storageId || reservation.volumeGroup !== plan.volumeGroup
      || reservation.volumeName !== `vm-${plan.vmid}-disk-0` || reservation.disk.bytes !== plan.disk.bytes
      || reservation.disk.sha256 !== plan.disk.sha256 || reservation.disk.snapshotId !== plan.disk.snapshotId) return null;
    return reservation;
  } catch { return null; }
}
