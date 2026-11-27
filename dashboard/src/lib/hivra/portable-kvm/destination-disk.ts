import { shellQuote } from "@/lib/hivra/proxmox-target";
import { z } from "zod";

const prefix = "HIVRA_KVM_PORTABLE_DESTINATION_V1 ";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const bytes = z.number().int().positive().max(40 * 1024 ** 3).refine(value => value % 512 === 0);
const diskSchema = z.object({ key: z.literal("scsi0"), snapshotId: sha256, bytes, sha256 }).strict();
const reservationSchema = z.object({
  agentId: uuid,
  operationId: uuid,
  generation: z.number().int().positive().safe(),
  checkpointSha256: sha256,
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(9300).max(9399).refine(value => value !== 9302),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  configurationSha256: sha256,
  rawConfigurationSha256: sha256,
  storageId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  volumeName: z.string().regex(/^vm-[0-9]+-disk-[0-9]{1,4}$/),
  volumeGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  deviceMapperUuid: z.string().regex(/^LVM-[a-zA-Z0-9]{64}$/),
  disk: diskSchema,
}).strict().refine(value => value.volumeName.startsWith(`vm-${value.vmid}-disk-`));

/**
 * A trusted destination preparer must independently qualify the host, boot profile and
 * volume, reserve the exact placement under the active lease, and leave it stopped and
 * locked. It must bind the authoritative checkpoint and locally measured destination
 * identities in the root-only reservation file; this helper cannot mint that authority.
 */
export type PortableKvmDestinationReservation = z.infer<typeof reservationSchema>;

export function serializePortableKvmDestinationReservation(input: PortableKvmDestinationReservation): string {
  return JSON.stringify(reservationSchema.parse(input)) + "\n";
}

const readbackSchema = z.object({ bytes, sha256 }).strict();
const receiptSchema = z.object({
  state: z.literal("disk_restored_verified"),
  reservation: reservationSchema,
  readback: readbackSchema,
}).strict();

export type PortableKvmDestinationDiskReceipt = z.infer<typeof receiptSchema>;

const restore = String.raw`
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path

def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)

def private_dir(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "unsafe_private_directory")

def check_reservation():
    private_dir(root)
    private_dir(registry)
    with os.fdopen(os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and file.read(len(expected) + 1) == expected,
                "reservation_mismatch")

def lock(stack, filename):
    fd = os.open(Path("/run/lock") / filename, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "unsafe_vm_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

def check_vm():
    check_reservation()
    require(output("qm", "status", vmid).strip() == b"status: stopped"
            and not os.path.lexists("/run/qemu-server/" + vmid + ".pid"), "destination_not_stopped")
    raw = Path("/etc/pve/qemu-server", vmid + ".conf").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == r["rawConfigurationSha256"], "raw_configuration_mismatch")
    require(not re.search(rb"^\s*\[", raw, re.M), "destination_has_config_sections")
    current = output("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    require(hashlib.sha256(current).hexdigest() == r["configurationSha256"], "configuration_mismatch")
    fields = {}
    allowed = {"agent", "arch", "bios", "boot", "cores", "cpu", "description", "lock", "machine",
               "memory", "meta", "name", "net0", "numa", "onboot", "ostype", "scsi0", "scsihw",
               "smbios1", "sockets", "tags", "vcpus", "vmgenid"}
    for line in current.decode("utf-8").splitlines():
        key, sep, value = line.partition(": ")
        require(sep and key in allowed and key not in fields, "unsupported_destination_configuration")
        fields[key] = value
    require(fields.get("lock") == "backup" and fields.get("onboot", "0") == "0", "destination_not_locked")
    tags = fields.get("tags", "").split(";")
    require([tag for tag in tags if tag.startswith("hivra-bind-")] == [r["bindingTag"]], "destination_binding_mismatch")
    require(fields.get("agent", "0") in {"0", "1", "enabled=1"} and fields.get("arch", "x86_64") == "x86_64"
            and fields.get("bios", "seabios") == "seabios"
            and fields.get("ostype") == "l26" and fields.get("scsihw") == "virtio-scsi-single"
            and fields.get("boot") == "order=scsi0"
            and re.fullmatch(r"pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?", fields.get("machine", "")),
            "unsupported_destination_boot")
    disk, *options = fields.get("scsi0", "").split(",")
    keys = [option.partition("=")[0] for option in options]
    require(disk == volume and len(set(keys)) == len(keys) and all(
        re.fullmatch(r"(?:discard=(?:on|ignore)|(?:ssd|iothread|backup|replicate)=[01]|size=[0-9]+[KMGT]?)", option)
        for option in options), "unsupported_destination_disk")

def device_path():
    storage = output("pvesm", "status", "--storage", r["storageId"]).decode("ascii").splitlines()
    require(len(storage) == 2 and storage[1].split()[:3] == [r["storageId"], "lvmthin", "active"],
            "unsupported_destination_storage")
    configured = output("pvesm", "path", volume).decode("ascii").rstrip("\n")
    require(configured == "/dev/" + r["volumeGroup"] + "/" + r["volumeName"], "destination_path_mismatch")
    path = os.path.realpath(configured)
    require(re.fullmatch(r"/dev/dm-[0-9]+", path), "destination_path_mismatch")
    return path

def check_device(fd, path):
    info = os.fstat(fd)
    node = os.stat(path, follow_symlinks=False)
    require(stat.S_ISBLK(info.st_mode) and stat.S_ISBLK(node.st_mode)
            and (info.st_dev, info.st_ino, info.st_rdev) == (node.st_dev, node.st_ino, node.st_rdev),
            "destination_device_mismatch")
    dm = Path("/sys/dev/block", str(os.major(info.st_rdev)) + ":" + str(os.minor(info.st_rdev)), "dm/uuid")
    require(dm.read_text().strip() == r["deviceMapperUuid"], "destination_volume_identity_mismatch")
    size = struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]
    require(size == disk_bytes, "destination_size_mismatch")

def measure(stream, sink=None):
    count = 0
    sha = hashlib.sha256()
    while data := stream.read(min(4 * 1024**2, disk_bytes - count + 1)):
        count += len(data)
        require(count <= disk_bytes, "image_too_long")
        sha.update(data)
        if sink is not None:
            sink.write(data)
    return {"bytes": count, "sha256": sha.hexdigest()}

def collect(args, sink=None, **kwargs):
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, **kwargs) as child:
        try:
            result = measure(child.stdout, sink)
            require(child.wait() == 0, "image_reader_failed")
        finally:
            if child.poll() is None:
                child.kill()
    return result

def check_pressure():
    pressure = Path("/proc/pressure/io").read_text()
    full = re.findall(r"^full avg10=([0-9]+\.[0-9]+) ", pressure, re.M)
    require(len(full) == 1 and float(full[0]) <= 1.0, "host_io_pressure")

def run():
    require(os.geteuid() == 0 and output("hostname", "-s").strip() == r["hostId"].encode("ascii"), "wrong_host")
    os.umask(0o077)
    parent = stage.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022, "unsafe_staging_parent")
    private_dir(stage)
    with ExitStack() as stack:
        lock(stack, "hivra-computer-backup.lock")
        lock(stack, "hivra-vm-" + vmid + ".backup.lock")
        lock(stack, "hivra-vm-" + vmid + ".lock")
        check_pressure()
        check_vm()
        path = device_path()
        device = os.open(path, os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW)
        stack.callback(os.close, device)
        check_device(device, path)

        password = sys.stdin.buffer.readline(66)
        require(re.fullmatch(rb"[a-f0-9]{64}\n", password), "invalid_repository_password")
        env = {key: value for key, value in os.environ.items() if not key.startswith("RESTIC_")}
        env["RESTIC_PASSWORD"] = password[:-1].decode("ascii")
        repo = "sftp:cold:hivra-portable-computers/" + r["agentId"] + "-" + r["operationId"]
        with tempfile.TemporaryFile(dir=stage) as image:
            os.posix_fallocate(image.fileno(), 0, disk_bytes)
            downloaded = collect(["restic", "--repo", repo, "--no-cache", "dump", "--quiet",
                                  r["disk"]["snapshotId"], "/scsi0.raw"], sink=image, env=env)
            require(downloaded == image_expected, "checkpoint_disk_mismatch")
            image.seek(0)
            check_vm()
            require(device_path() == path, "destination_path_changed")
            check_device(device, path)
            check_pressure()
            with os.fdopen(os.dup(device), "wb") as writer:
                shutil.copyfileobj(image, writer, 4 * 1024**2)
            os.fsync(device)

        check_vm()
        require(device_path() == path, "destination_path_changed")
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb", buffering=0) as reader:
            fd = reader.fileno()
            check_device(fd, path)
            readback = collect(["dd", "if=/proc/self/fd/" + str(fd), "iflag=direct", "bs=4M", "status=none"],
                               pass_fds=(fd,))
            require(readback == image_expected, "destination_readback_mismatch")
            check_vm()
            require(device_path() == path, "destination_path_changed")
            check_device(device, path)
        print("HIVRA_KVM_PORTABLE_DESTINATION_V1 " + json.dumps(
            {"state": "disk_restored_verified", "reservation": r, "readback": readback}))

r = json.loads(sys.argv[1])
expected = sys.argv[1].encode("ascii")
vmid = str(r["vmid"])
volume = r["storageId"] + ":" + r["volumeName"]
disk_bytes = r["disk"]["bytes"]
image_expected = {"bytes": disk_bytes, "sha256": r["disk"]["sha256"]}
root = Path("/var/lib/hivra-sleep")
registry = root / "portable-kvm-destinations"
marker = registry / vmid
stage = Path("/var/lib/hivra/portable-kvm-restore-staging")
try:
    run()
except RuntimeError as error:
    sys.exit("portable KVM destination: " + str(error))
except (OSError, UnicodeError, ValueError, subprocess.SubprocessError):
    sys.exit("portable KVM destination: host or I/O check failed")
`;

/**
 * Run as root with the operation-scoped checkpoint password on stdin and a preinstalled
 * cold alias. The preparer writes the serialized reservation as root:0600 at
 * /var/lib/hivra-sleep/portable-kvm-destinations/<vmid>; both directories must be
 * root:0700. Hash the exact raw .conf and the current `qm config <vmid> --current 1`
 * output (with exactly one trailing LF). Prepare and activate only the reserved LV.
 * Provide a root:0700 /var/lib/hivra/portable-kvm-restore-staging filesystem with
 * space for the full image. Keep the reservation, VM and LV exclusively assigned
 * until verification is consumed, including when failure may have partially written
 * the disk. Only consume a receipt from a successful execution.
 */
export function buildPortableKvmDestinationDiskScript(input: PortableKvmDestinationReservation): string {
  return `exec timeout -k 10 3600 python3 -I -c ${shellQuote(restore)} ${shellQuote(serializePortableKvmDestinationReservation(input))}\n`;
}

export function parsePortableKvmDestinationDiskReceipt(
  stdout: string, input: PortableKvmDestinationReservation,
): PortableKvmDestinationDiskReceipt | null {
  const expected = serializePortableKvmDestinationReservation(input);
  const receipts = stdout.split("\n").filter(line => line.startsWith(prefix));
  if (receipts.length !== 1) return null;
  try {
    const result = receiptSchema.safeParse(JSON.parse(receipts[0].slice(prefix.length)));
    if (!result.success || serializePortableKvmDestinationReservation(result.data.reservation) !== expected
      || result.data.readback.bytes !== input.disk.bytes || result.data.readback.sha256 !== input.disk.sha256) return null;
    return result.data;
  } catch { return null; }
}
