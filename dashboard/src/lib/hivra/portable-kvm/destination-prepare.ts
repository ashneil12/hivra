import { shellQuote } from "@/lib/hivra/proxmox-target";
import { portableKvmSlotPython } from "./slot-claim";
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
const privateIp = z.string().refine(value => isIPv4(value) && /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(value));
export const portableKvmUnicastMacAddress = z.string()
  .regex(/^[0-9A-F][02468ACE](?::[0-9A-F]{2}){5}$/)
  .refine(value => value !== "00:00:00:00:00:00");
const cpuFlags = ["abm", "adx", "aes", "avx", "avx2", "avx512_bf16", "avx512_bitalg", "avx512_vbmi2", "avx512_vnni",
  "avx512_vpopcntdq", "avx512bw", "avx512cd", "avx512dq", "avx512f", "avx512ifma", "avx512vbmi", "avx512vl",
  "bmi1", "bmi2", "cx16", "f16c", "fma", "gfni", "movbe", "pclmulqdq", "pni", "popcnt", "rdrand", "rdseed",
  "sha_ni", "sse4_1", "sse4_2", "sse4a", "ssse3", "vaes", "vpclmulqdq", "xsave"] as const;
const baselineFlags = ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] as const;
const cpuSchema = z.object({
  vendor: z.enum(["GenuineIntel", "AuthenticAMD"]),
  requiredFlags: z.array(z.enum(cpuFlags)).min(baselineFlags.length).max(cpuFlags.length)
    .refine(flags => new Set(flags).size === flags.length && baselineFlags.every(flag => flags.includes(flag))),
}).strict();
export const portableKvmManagedDestinationProfileSchema = z.object({
  cpu: cpuSchema,
  cpuLimit: z.number().min(0.001).max(8).refine(value => Number(value.toFixed(3)) === value),
  cloudInit: z.object({
    instanceId: z.string().regex(/^[0-9a-f]{40}$/),
    gateway: privateIp,
    nameservers: z.array(z.string().refine(value => isIPv4(value) && /^(?!0\.|127\.)/.test(value)
      && Number(value.split(".")[0]) < 224)).min(1).max(4)
      .refine(values => new Set(values).size === values.length),
  }).strict(),
}).strict();
const planSchema = z.object({
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  checkpointSha256: sha256,
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999_999_999).refine(value => value !== 9302),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  ip: privateIp,
  expiresAt: z.string().datetime(),
  storageId: storageName,
  volumeGroup: storageName,
  thinPool: storageName,
  profile: z.object({
    machine: z.string().regex(/^pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?$/),
    cores: z.number().int().min(1).max(8),
    memoryMb: z.number().int().min(1024).max(16384),
    network: z.object({
      bridge: z.string().regex(/^(?:hivra0|vmbr[0-9]{1,4})$/),
      macAddress: portableKvmUnicastMacAddress,
    }).strict(),
    attachment: z.object({ discard: z.boolean(), ssd: z.boolean(), ioThread: z.boolean() }).strict(),
    managed: portableKvmManagedDestinationProfileSchema.optional(),
  }).strict(),
  disk: z.object({
    key: z.literal("scsi0"), snapshotId: sha256,
    bytes: z.number().int().min(gib).max(40 * gib).refine(value => value % gib === 0),
    sha256,
  }).strict(),
}).strict().refine(plan => {
  const managed = plan.profile.managed;
  if (!managed) return true;
  const gateway = managed.cloudInit.gateway;
  return managed.cpuLimit <= plan.profile.cores && gateway !== plan.ip
    && gateway.split(".").slice(0, 3).join(".") === plan.ip.split(".").slice(0, 3).join(".")
    && [gateway, plan.ip].every(ip => !/\.(?:0|255)$/.test(ip));
});

export type PortableKvmDestinationPrepareInput = z.infer<typeof planSchema>;

/**
 * Only the operator that independently verifies the active restore claim, the
 * supported source profile, and the exact storage and quarantined network placement
 * may install these bytes at /var/lib/hivra-sleep/portable-kvm-destination-permits/<vmid>.
 * The permit is root:0600 and the permit directory is root:0700. The operator must
 * reserve the IP outside ordinary allocation until cutover. For an ordinary
 * managed guest the operator must capture the active NoCloud instance ID from
 * the source guest before sleep and independently qualify its CPU requirements
 * and destination network. The only regenerated override is that metadata ID.
 */
export function serializePortableKvmDestinationPreparePermit(input: PortableKvmDestinationPrepareInput): string {
  return JSON.stringify(planSchema.parse(input)) + "\n";
}

export const portableKvmHostCpuValidationPython = String.raw`
def observe_host_cpu():
    flags, vendors = [], set()
    for record in Path("/proc/cpuinfo").read_text().strip().split("\n\n"):
        fields = dict((key.strip(), value.strip()) for key, sep, value in
                      (line.partition(":") for line in record.splitlines()) if sep)
        require("processor" in fields and "vendor_id" in fields and "flags" in fields, "host_cpu_unobservable")
        vendors.add(fields["vendor_id"])
        flags.append(set(fields["flags"].split()))
    require(flags and len(vendors) == 1, "host_cpu_unobservable")
    return next(iter(vendors)), set.intersection(*flags)

def require_host_cpu(expected):
    vendor, flags = observe_host_cpu()
    require(vendor == expected["vendor"] and set(expected["requiredFlags"]) <= flags, "host_cpu_incompatible")
`;

export function buildPortableKvmHostCpuCompatibilityProbeScript(hostId: string): string {
  const host = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).parse(hostId);
  const probe = String.raw`
import json
import os
import subprocess
import sys
from pathlib import Path

def require(condition, reason):
    if not condition:
        sys.exit(reason)
${portableKvmHostCpuValidationPython}
require(os.geteuid() == 0 and os.uname().machine == "x86_64"
        and subprocess.check_output(("hostname", "-s"), timeout=3).decode("ascii").strip() == sys.argv[1],
        "wrong_cpu_probe_host")
vendor, flags = observe_host_cpu()
print(json.dumps({"vendor": vendor, "requiredFlags": sorted(flags.intersection(${JSON.stringify(cpuFlags)}))}))
`;
  return `exec timeout -k 2 10 python3 -I -c ${shellQuote(probe)} ${shellQuote(host)}\n`;
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
${portableKvmHostCpuValidationPython}

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
    if managed:
        require_host_cpu(managed["cpu"])
    else:
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
            and size * (80 - used) >= 100 * (plan["disk"]["bytes"] + (4 * 1024**2 if managed else 0)),
            "thin_pool_headroom")
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

${portableKvmSlotPython}

def properties(value):
    result = {}
    for pair in value.split(","):
        key, sep, setting = pair.partition("=")
        require(sep and key not in result, "invalid_destination_device_options")
        result[key] = setting
    return result

def check_configuration(allow_generated_section=False):
    require(output("qm", "status", vmid).strip() == b"status: stopped" and not os.path.lexists(pid),
            "destination_not_stopped")
    raw = cfg.read_bytes()
    current = output("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    raw_current = raw
    if allow_generated_section:
        raw_current, separator, generated = raw.partition(b"\n[special:cloudinit]\n")
        if separator:
            entries = fields(generated)
            added = entries.pop("added", "")
            keys = set(re.split(r"[\s,;]+", added.strip())) if added else set()
            require(keys <= {"cicustom", "citype", "ciupgrade", "ciuser", "ipconfig0", "name", "nameserver", "net0"}
                    and not entries, "unsupported_cloudinit_section")
    require(not re.search(rb"^\s*\[", raw_current, re.M), "destination_has_config_sections")
    config = fields(current)
    require(config == fields(raw_current), "destination_has_pending_configuration")
    for key, value in requested.items():
        if key not in {"agent", "scsi0", "net0", "ide2", "ipconfig0", "cpulimit"}:
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
    if managed:
        require(config.pop("ide2", None) in {seed_volume + ",media=cdrom", seed_volume + ",media=cdrom,size=4M"}
                and properties(config.pop("ipconfig0", "")) == properties(requested["ipconfig0"])
                and Decimal(config.pop("cpulimit", "0")) == Decimal(requested["cpulimit"]),
                "unexpected_managed_configuration")
    require(set(config) <= {"meta", "smbios1", "vmgenid"}
            and ("smbios1" not in config or re.fullmatch(r"uuid=[a-f0-9-]{36}", config["smbios1"])),
            "unsupported_destination_configuration")
    return raw, current

def check_snippet(new):
    for directory in (metadata.parent.parent, metadata.parent):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "unsafe_cloudinit_snippet_directory")
    snippet_storage = json.loads(output("pvesh", "get", "/storage/local", "--output-format", "json"))
    require(snippet_storage.get("type") == "dir" and snippet_storage.get("path") == str(metadata.parent.parent)
            and snippet_storage.get("shared", 0) == 0 and "snippets" in snippet_storage.get("content", "").split(",")
            and output("pvesm", "path", "local:snippets/" + metadata.name).decode("ascii").strip() == str(metadata),
            "unsupported_cloudinit_snippet_storage")
    if new:
        require(not os.path.lexists(metadata), "cloudinit_metadata_already_present")
    else:
        require(private_read(metadata) == meta_wire, "cloudinit_metadata_mismatch")

def generate_seed():
    check_snippet(False)
    raw, _ = check_configuration(allow_generated_section=True)
    with ExitStack() as stack:
        open_device(stack, destination_disks()[seed_name], seed_name, 4 * 1024**2)
    update = r"""
my ($vmid, $sha) = @ARGV;
PVE::QemuConfig->lock_config($vmid, sub {
    my $path = PVE::QemuConfig->config_file($vmid);
    die "configuration changed" if Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) ne $sha;
    my $conf = PVE::QemuConfig->load_config($vmid);
    die "destination not stopped and locked" if $conf->{lock} ne 'backup' || PVE::QemuServer::check_running($vmid);
    PVE::QemuServer::vmconfig_update_cloudinit_drive(PVE::Storage::config(), $conf, $vmid);
});
"""
    output("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Storage", "-MPVE::Tools",
           "-MDigest::SHA", "-e", update, vmid, hashlib.sha256(raw).hexdigest())

def open_device(stack, lv, name, size_expected):
    require(lv["vg_name"] == plan["volumeGroup"] and lv["lv_name"] == name
            and lv["pool_lv"] == plan["thinPool"] and lv["origin"] == ""
            and re.fullmatch(r"V...a...-.", lv["lv_attr"]) is not None,
            "unexpected_destination_volume")
    configured = output("pvesm", "path", plan["storageId"] + ":" + name).decode("ascii").rstrip("\n")
    require(configured == str(Path("/dev", plan["volumeGroup"], name)), "unexpected_destination_volume_path")
    path = os.path.realpath(configured)
    require(re.fullmatch(r"/dev/dm-[0-9]+", path) is not None, "unexpected_destination_device")
    fd = os.open(path, os.O_RDONLY | os.O_EXCL | os.O_NOFOLLOW)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    node = os.stat(path, follow_symlinks=False)
    require(stat.S_ISBLK(info.st_mode) and stat.S_ISBLK(node.st_mode)
            and (info.st_dev, info.st_ino, info.st_rdev) == (node.st_dev, node.st_ino, node.st_rdev),
            "unexpected_destination_device")
    size = struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]
    require(size == size_expected, "unexpected_destination_disk_size")
    dm = Path("/sys/dev/block", str(os.major(info.st_rdev)) + ":" + str(os.minor(info.st_rdev)), "dm/uuid")
    dm_uuid = dm.read_text().strip()
    require(re.fullmatch(r"LVM-[a-zA-Z0-9]{64}", dm_uuid) is not None
            and dm_uuid == "LVM-" + (lv["vg_uuid"] + lv["lv_uuid"]).replace("-", ""),
            "unexpected_destination_device_uuid")
    return fd, dm_uuid

def destination_disks():
    owned = check_storage()
    require(sorted(lv["lv_name"] for lv in owned) == sorted([volume_name, seed_name] if managed else [volume_name]),
            "unexpected_destination_disk_inventory")
    return {lv["lv_name"]: lv for lv in owned}

def measure_destination():
    raw, current = check_configuration()
    by_name = destination_disks()
    with ExitStack() as stack:
        _, dm_uuid = open_device(stack, by_name[volume_name], volume_name, plan["disk"]["bytes"])
        if managed:
            check_snippet(False)
            fd, _ = open_device(stack, by_name[seed_name], seed_name, 4 * 1024**2)
            def iso(*args):
                return subprocess.check_output(("isoinfo", "-R", "-i", "/proc/self/fd/" + str(fd), *args),
                                               stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, pass_fds=(fd,))
            require(sorted(iso("-f").splitlines()) == [b"/meta-data", b"/network-config", b"/user-data", b"/vendor-data"],
                    "generated_cloudinit_seed_inventory_mismatch")
            require(re.findall(rb"^Volume id: (.*)$", iso("-d"), re.M) == [b"cidata"],
                    "generated_cloudinit_seed_label_mismatch")
            for filename, content in (
                ("meta-data", meta_wire), ("vendor-data", b""),
                ("user-data", output("qm", "cloudinit", "dump", vmid, "user").rstrip(b"\n")),
                ("network-config", output("qm", "cloudinit", "dump", vmid, "network").rstrip(b"\n")),
            ):
                observed = iso("-x", "/" + filename)
                require(observed.rstrip(b"\n") == content.rstrip(b"\n"), "generated_cloudinit_seed_mismatch")
            require(check_configuration() == (raw, current), "destination_changed_during_readback")
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
            digest = None
            if managed:
                digest = slot_digest(cfg, vmid, plan["ip"], plan["bindingTag"])
            else:
                require(not os.path.lexists(cfg)
                        and output("pvesh", "get", "/cluster/nextid", "--vmid", vmid).strip() == vmid.encode("ascii"),
                        "destination_not_free")
            require(not os.path.lexists(volume_path), "destination_disk_not_free")
            require(not check_storage(), "destination_has_existing_volumes")
            if managed:
                check_snippet(True)
            check_permit()
            publish(attempt, expected)
            if managed:
                publish(metadata, meta_wire)
            args = [item for key, value in requested.items() for item in ("--" + key, value)]
            if digest:
                output("qm", "set", vmid, "--skiplock", "1", "--digest", digest, *args)
            else:
                output("qm", "create", vmid, "--start", "0", *args)
            check_permit()
            check_headroom()
            check_unowned()
            if managed:
                generate_seed()
            reservation = measure_destination()
            wire = (json.dumps(reservation, separators=(",", ":")) + "\n").encode("ascii")
            publish(marker, wire)
        check_permit()
        print("HIVRA_KVM_PORTABLE_PREPARE_V1 " + wire.decode("ascii").rstrip("\n"))

expected = sys.argv[1].encode("ascii")
plan = json.loads(expected)
vmid = str(plan["vmid"])
profile = plan["profile"]
managed = profile.get("managed")
attach = profile["attachment"]
gib = 1024 ** 3
size_gib = plan["disk"]["bytes"] // gib
volume_name = "vm-" + vmid + "-disk-0"
volume = plan["storageId"] + ":" + volume_name
seed_name = "vm-" + vmid + "-cloudinit"
seed_volume = plan["storageId"] + ":" + seed_name
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
    if managed:
        cloudinit = managed["cloudInit"]
        metadata = Path("/var/lib/vz/snippets", "hivra-portable-meta-" + plan["operationId"] + ".yaml")
        meta_wire = ("instance-id: " + cloudinit["instanceId"] + "\n").encode("ascii")
        requested.update({
            "cpu": "host", "cpulimit": str(managed["cpuLimit"]), "serial0": "socket", "vga": "serial0",
            "ide2": plan["storageId"] + ":cloudinit", "ciuser": "ubuntu", "citype": "nocloud", "ciupgrade": "0",
            "ipconfig0": "ip=" + plan["ip"] + "/24,gw=" + cloudinit["gateway"],
            "nameserver": " ".join(cloudinit["nameservers"]),
            "cicustom": "meta=local:snippets/" + metadata.name,
        })
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
