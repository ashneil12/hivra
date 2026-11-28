import { z } from "zod";
import { shellQuote } from "../proxmox-target";
import { portableKvmSourceConfigurationPython } from "./source-configuration";
import type { PortableKvmSourceFence } from "./source-fence";

const prefix = "HIVRA_KVM_PORTABLE_SOURCE_RETIREMENT_V1 ";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const modeSchema = z.enum(["cleanup", "verify-absent"]);
const storageName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const volume = z.object({
  volumeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}:vm-[0-9]+-(?:disk-[0-9]{1,4}|cloudinit)$/),
  volumeGroup: z.string().regex(storageName),
  thinPool: z.string().regex(storageName),
  lvUuid: z.string().regex(/^[a-zA-Z0-9]{6}(?:-[a-zA-Z0-9]{4}){5}-[a-zA-Z0-9]{6}$/),
  bytes: z.number().int().positive().max(40 * 1024 ** 3).refine(n => n % 512 === 0),
}).strict();
const inputSchema = z.object({
  fence: z.object({
    agentId: uuid, operationId: uuid, generation: z.number().int().positive().safe(),
    hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    vmid: z.number().int().min(100).max(999_999_999).refine(n => n !== 9302),
    bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
    configurationSha256: sha, rawConfigurationSha256: sha, state: z.literal("fenced"),
  }).strict(),
  allocationOperationId: uuid,
  resources: z.object({
    balloonMb: z.number().int().min(1024).max(16384), cpuUnits: z.number().int().min(1).max(10000),
  }).strict().optional(),
  disk: volume,
  cloudInit: volume.optional(),
}).strict().refine(({ fence, disk, cloudInit, allocationOperationId }) =>
  new RegExp(`:vm-${fence.vmid}-disk-[0-9]{1,4}$`).test(disk.volumeId)
  && disk.bytes % (1024 ** 3) === 0
  && allocationOperationId !== fence.operationId
  && (!cloudInit || (cloudInit.volumeId.endsWith(`:vm-${fence.vmid}-cloudinit`) && cloudInit.lvUuid !== disk.lvUuid)),
"Volumes and allocation must belong to the exact source");
const receiptSchema = z.object({
  input: inputSchema, mode: modeSchema, state: z.literal("retired"),
  sourceVmAbsent: z.literal(true), sourceDiskAbsent: z.literal(true),
}).strict();

export type PortableKvmSourceRetirementInput = Omit<z.infer<typeof inputSchema>, "fence"> & { fence: PortableKvmSourceFence };
export type PortableKvmSourceRetirementMode = z.infer<typeof modeSchema>;
export type PortableKvmSourceRetirementReceipt = z.infer<typeof receiptSchema>;

const native = String.raw`
use strict;
use warnings;
my ($action, $node, $vmid, $hash, $inode, @volumes) = @ARGV;
die "native node mismatch" if PVE::INotify::nodename() ne $node;
if ($action eq 'lock-path') {
    print PVE::QemuConfig->config_file_lock($vmid);
    exit;
}
PVE::Cluster::cfs_update();
PVE::Cluster::check_cfs_quorum();
my $ids = PVE::Cluster::get_vmlist()->{ids} // die "native inventory unavailable";
my $guest = $ids->{$vmid};
die "source VMID belongs to another guest" if $guest && ($guest->{node} ne $node || $guest->{type} ne 'qemu');
die "source is running" if PVE::QemuServer::check_running($vmid, 1);
die "source is HA managed" if PVE::HA::Config::service_is_configured("vm:$vmid");
PVE::ReplicationConfig->new()->check_for_existing_jobs($vmid);
my $store = PVE::Storage::config();
for (my $i = 0; $i < @volumes; $i += 3) {
    my ($id, $vg, $pool) = @volumes[$i..$i+2];
    my $cfg = PVE::Storage::storage_config($store, $id);
    die "unsupported source storage" if $cfg->{type} ne 'lvmthin' || $cfg->{shared} || $cfg->{disable}
        || ($cfg->{vgname} // '') ne $vg || ($cfg->{thinpool} // '') ne $pool;
    PVE::Storage::storage_check_node($store, $id, $node);
}
if ($action eq 'destroy-config') {
    die "source missing from native inventory" unless $guest;
    my $path = PVE::QemuConfig->config_file($vmid, $node);
    my @info = lstat($path);
    die "source config replaced" if !@info || $info[1] != $inode || !-f _ || -l _;
    die "configuration changed" unless Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) eq $hash;
    my $conf = PVE::QemuConfig->load_config($vmid, $node);
    die "source fence changed" unless ($conf->{lock} // '') eq 'backup';
    PVE::QemuConfig->check_protection($conf, "can't retire protected source");
    PVE::QemuConfig->destroy_config($vmid);
} elsif ($action eq 'inventory') {
    print $guest ? 'present' : 'absent';
} else {
    die "unsupported action";
}
`;

const retire = String.raw`
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from decimal import Decimal
${portableKvmSourceConfigurationPython}

input, mode = json.loads(sys.argv[1])
native = sys.argv[2]
fence = input["fence"]
vmid, host, tag = str(fence["vmid"]), fence["hostId"], fence["bindingTag"]
root = Path("/var/lib/hivra-sleep")
fences = root / "portable-kvm-fences"
registry = root / "portable-kvm-retirements"
intent = registry / (vmid + "-" + fence["operationId"])
dispatch_fences = root / "portable-kvm-cleanup"
dispatch_fence = dispatch_fences / (fence["operationId"] + ".source")
scope = {key: fence[key] for key in ("agentId", "operationId", "generation", "hostId", "vmid", "bindingTag")}
markers = [fences / vmid, root / ("cold-" + vmid), root / ("onboot-" + vmid)]
config = Path("/etc/pve/qemu-server", vmid + ".conf")
volumes = [input["disk"]] + ([input["cloudInit"]] if "cloudInit" in input else [])
locks = []

def require(ok, reason):
    if not ok:
        raise ValueError(reason)

def run(*args, ok=(0,)):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=15, pass_fds=locks)
    require(result.returncode in ok, "command_failed:" + Path(args[0]).name)
    return result.stdout

def pve(action, inode=0):
    return run("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Cluster",
               "-MPVE::INotify", "-MPVE::Storage", "-MPVE::HA::Config", "-MPVE::ReplicationConfig",
               "-MPVE::Tools", "-MDigest::SHA", "-e", native, action, host, vmid, fence["rawConfigurationSha256"], str(inode),
               *(part for v in volumes for part in (v["volumeId"].split(":")[0], v["volumeGroup"], v["thinPool"]))).decode()

def lstat(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None

def directory(path, private=False):
    m = path.lstat()
    require(stat.S_ISDIR(m.st_mode) and m.st_uid == 0 and not m.st_mode & 0o022
            and (not private or stat.S_IMODE(m.st_mode) == 0o700), "unsafe_state_directory")

def lock(stack, path):
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    stack.callback(os.close, fd)
    m = os.fstat(fd)
    require(stat.S_ISREG(m.st_mode) and m.st_uid == 0 and m.st_nlink == 1
            and not m.st_mode & 0o022, "unsafe_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    locks.append(fd)

def private_read(path, exact=False):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as f:
        m = os.fstat(f.fileno())
        require(stat.S_ISREG(m.st_mode) and m.st_uid == 0 and m.st_nlink == 1
                and (stat.S_IMODE(m.st_mode) == 0o600 if exact else not m.st_mode & 0o022)
                and m.st_size <= 16384, "unsafe_state_file")
        return f.read(16385), [m.st_dev, m.st_ino, m.st_ctime_ns]

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def publish(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".new-", delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
            os.replace(tmp, path)
            sync_dir(path.parent)
        finally:
            tmp.unlink(missing_ok=True)

def record(phase, tokens, inode):
    publish(intent, json.dumps({"input": input, "phase": phase, "markers": tokens, "configInode": inode}).encode())

def block_late_dispatch(create=False):
    expected = json.dumps({"purpose": "post-commit-source-retirement", "input": input}, separators=(",", ":")).encode()
    if lstat(dispatch_fences) is None and create:
        dispatch_fences.mkdir(mode=0o700)
        sync_dir(root)
    directory(dispatch_fences, private=True)
    if lstat(dispatch_fence) is None and create:
        publish(dispatch_fence, expected)
    require(private_read(dispatch_fence, exact=True)[0] == expected, "late_dispatch_fence_mismatch")

def check_markers(tokens=None, missing=False):
    found = []
    for i, path in enumerate(markers):
        if lstat(path) is None:
            require((tokens is None and i == 2) or (tokens is not None and (missing or tokens[i] is None)),
                    "source_marker_missing")
            found.append(None)
            continue
        data, token = private_read(path, i == 0)
        expected = [json.dumps(scope, separators=(",", ":")).encode() + b"\n", tag.encode() + b"\n", b""][i]
        require(data == expected and (tokens is None or token == tokens[i]), "source_marker_mismatch")
        found.append(token)
    return found

def no_writer():
    for suffix in ("pid", "qmp", "qga", "vnc"):
        require(lstat(Path("/run/qemu-server", vmid + "." + suffix)) is None, "source_runtime_present")
    require(lstat(root / ("stored-" + vmid)) is None, "source_is_stored")
    status = run("systemctl", "show", "--all", "-p", "LoadState", "-p", "ActiveState", "-p", "Job",
                 "hivra-computer-backup-" + fence["operationId"] + ".service", ok=(0, 1)).decode().splitlines()
    fields = dict(line.split("=", 1) for line in status)
    require(len(status) == len(fields) == 3 and fields.get("LoadState") in {"loaded", "not-found"}
            and fields.get("ActiveState") in {"inactive", "failed"} and fields.get("Job") in {"", "0"},
            "source_backup_writer")

def source_present():
    no_writer()
    state = pve("inventory")
    present = lstat(config) is not None
    require(state == ("present" if present else "absent"), "inconsistent_source_inventory")
    return present

def check_config(inode):
    require(run("qm", "status", vmid).strip() == b"status: stopped", "source_not_stopped")
    st = config.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_ino == inode, "unsafe_or_recreated_source_config")
    raw = config.read_bytes()
    current = run("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    require(hashlib.sha256(raw).hexdigest() == fence["rawConfigurationSha256"]
            and hashlib.sha256(current).hexdigest() == fence["configurationSha256"], "source_configuration_drift")
    managed = {"allocationOperationId": input["allocationOperationId"], "resources": input.get("resources")}
    fields = source_configuration(raw.decode(), current.decode(), vmid, tag, managed)
    allowed = {"agent", "arch", "balloon", "bios", "boot", "citype", "ciupgrade", "ciuser", "cores", "cpu", "cpulimit",
               "cpuunits", "description", "ide2", "ipconfig0", "lock", "machine", "memory", "meta", "name", "nameserver",
               "net0", "onboot", "ostype", "scsi0", "scsihw", "serial0", "smbios1", "sockets", "sshkeys", "tags", "vga", "vmgenid"}
    require(not set(fields) - allowed and fields.get("lock") == "backup"
            and fields.get("onboot", "0") == "0" and fields.get("boot") == "order=scsi0", "unsupported_source_configuration")
    disk, *opts = fields.get("scsi0", "").split(",")
    require(disk == volumes[0]["volumeId"] and len({opt.partition("=")[0] for opt in opts}) == len(opts)
            and all(re.fullmatch(r"(?:discard=(?:on|ignore)|(?:ssd|iothread|backup|replicate)=[01]|size=[0-9]+[KMGT]?)", opt)
                    for opt in opts), "source_disk_not_pinned")
    if len(volumes) == 2:
        require(re.fullmatch(re.escape(volumes[1]["volumeId"]) + r",media=cdrom(?:,size=[0-9]+[KMGT]?)?",
                             fields.get("ide2", "")), "source_seed_not_pinned")
    else:
        require("ide2" not in fields, "source_seed_not_pinned")

def check_references():
    nodes = Path("/etc/pve/nodes")
    for node in nodes.iterdir():
        for kind in ("qemu-server", "lxc"):
            for path in (node / kind).glob("*.conf"):
                if node.name == host and kind == "qemu-server" and path.name == config.name:
                    continue
                require(path.name != config.name, "source_vmid_conflict")
                text = path.read_text()
                for v in volumes:
                    lv = v["volumeId"].split(":")[1]
                    require(lv not in text and lv.replace("-", "--") not in text and v["lvUuid"] not in text,
                            "source_volume_referenced_elsewhere")
    require(lstat(Path("/etc/pve/firewall", vmid + ".fw")) is None, "source_firewall_requires_reconciliation")

def inspect_volumes():
    fields = "vg_name,lv_name,lv_uuid,lv_size,pool_lv,lv_attr,origin"
    report = json.loads(run("lvs", "-a", "--reportformat", "json", "--units", "b", "--nosuffix", "-o", fields))
    require(len(report["report"]) == 1 and isinstance(report["report"][0]["lv"], list), "invalid_lvm_inventory")
    rows = report["report"][0]["lv"]
    for row in rows:
        require(all(isinstance(row.get(key), str) for key in fields.split(",")), "invalid_lvm_inventory")
    expected = {(v["volumeGroup"], v["volumeId"].split(":")[1]) for v in volumes}
    require(not any(re.match(r"^(?:vm|base)-" + vmid + "-", row["lv_name"])
                    and (row["vg_name"], row["lv_name"]) not in expected for row in rows), "unpinned_source_volume")
    found = []
    for v in volumes:
        lv = v["volumeId"].split(":")[1]
        vg = v["volumeGroup"]
        path = "/dev/" + vg + "/" + lv
        require(run("pvesm", "path", v["volumeId"]).decode().rstrip("\n") == path, "source_volume_path_changed")
        named = [r for r in rows if r["vg_name"] == vg and r["lv_name"] == lv]
        identified = [r for r in rows if r["lv_uuid"] == v["lvUuid"]]
        require(any(r["vg_name"] == vg and r["lv_name"] == v["thinPool"] and r["lv_attr"].startswith("t")
                    for r in rows), "source_pool_unavailable")
        require(not any(r["vg_name"] == vg and (r["origin"] == lv or r["lv_name"].startswith("snap_" + lv + "_"))
                        for r in rows), "source_volume_has_dependents")
        if not named and not identified:
            mapper = Path("/dev/mapper", vg.replace("-", "--") + "-" + lv.replace("-", "--"))
            require(lstat(Path(path)) is None and lstat(mapper) is None, "source_volume_device_still_present")
            found.append(False)
            continue
        require(len(named) == 1 and named == identified, "source_volume_identity_changed")
        row = named[0]
        attr = row["lv_attr"]
        require(Decimal(row["lv_size"]) == v["bytes"] and row["pool_lv"] == v["thinPool"] and not row["origin"]
                and re.fullmatch(r"Vw[a-zA-Z-]{2}[a-]-[a-zA-Z-]{4}", attr),
                "source_volume_changed_or_open")
        found.append(attr)
    return found

def check_absent():
    require(not source_present(), "source_configuration_still_present")
    check_references()
    require(not any(inspect_volumes()), "source_volume_still_present")

def retire():
    require(os.geteuid() == 0 and run("hostname", "-s").decode().strip() == host, "wrong_source_host")
    directory(root)
    directory(fences, private=True)
    lockdir = Path("/run/lock")
    with ExitStack() as stack:
        lock(stack, lockdir / ("hivra-portable-" + fence["operationId"] + ".dispatch.lock"))
        lock(stack, lockdir / "hivra-allocation.lock")
        try:
            (lockdir / "hivra-vmids").mkdir(mode=0o755)
        except FileExistsError:
            pass
        directory(lockdir / "hivra-vmids")
        lock(stack, lockdir / "hivra-vmids" / (vmid + ".lock"))
        lock(stack, lockdir / "hivra-computer-backup.lock")
        lock(stack, lockdir / ("hivra-vm-" + vmid + ".backup.lock"))
        lock(stack, lockdir / ("hivra-vm-" + vmid + ".lock"))
        native_path = "/var/lock/qemu-server/lock-" + vmid + ".conf"
        require(pve("lock-path") == native_path, "unexpected_native_lock")
        lock(stack, Path(native_path))
        present = source_present()
        check_references()
        if lstat(registry) is not None:
            directory(registry, private=True)
        if lstat(intent) is None:
            require(mode == "cleanup" and present, "source_retirement_not_proven")
            inode = config.lstat().st_ino
            check_config(inode)
            tokens = check_markers()
            require(all(inspect_volumes()), "source_volume_missing_before_intent")
            if lstat(registry) is None:
                registry.mkdir(mode=0o700)
                sync_dir(root)
            block_late_dispatch(create=True)
            record("armed", tokens, inode)
            phase = "armed"
        else:
            recorded = json.loads(private_read(intent, exact=True)[0])
            require(set(recorded) == {"input", "phase", "markers", "configInode"} and recorded["input"] == input,
                    "source_retirement_intent_mismatch")
            phase, tokens, inode = recorded["phase"], recorded["markers"], recorded["configInode"]
            require(phase in {"armed", "config-authorized", "complete"} and len(tokens) == 3
                    and type(inode) is int and inode > 0
                    and all(token is None and i == 2 or isinstance(token, list) and len(token) == 3
                            and all(type(n) is int for n in token) for i, token in enumerate(tokens)),
                    "invalid_source_retirement_intent")
            block_late_dispatch()
        require(mode == "cleanup" or phase == "complete", "source_retirement_not_complete")
        if phase == "armed":
            require(present, "source_config_missing_before_authorization")
            check_config(inode)
            check_markers(tokens)
            for idx, v in enumerate(volumes):
                attr = inspect_volumes()[idx]
                if attr:
                    no_writer()
                    check_references()
                    vg, lv = v["volumeGroup"], v["volumeId"].split(":")[1]
                    selector = ("vg_name=" + vg + " && lv_name=" + lv + " && lv_uuid=" + v["lvUuid"]
                                + " && pool_lv=" + v["thinPool"] + " && lv_size=" + str(v["bytes"]) + "b")
                    if attr[4] == "a":
                        run("lvchange", "-an", "--select", selector + " && lv_attr=" + attr)
                    inactive = inspect_volumes()[idx]
                    require(inactive and inactive[4] == "-", "source_volume_not_inactive")
                    run("lvremove", "--select", selector + " && lv_attr=" + inactive)
                    require(not inspect_volumes()[idx], "source_volume_still_present")
            require(not any(inspect_volumes()), "source_volume_still_present")
            record("config-authorized", tokens, inode)
            phase = "config-authorized"
        if phase == "config-authorized":
            require(not any(inspect_volumes()), "source_volume_reappeared")
            found = check_markers(tokens, missing=not present)
            if present:
                no_writer()
                check_config(inode)
                pve("destroy-config", inode)
            check_absent()
            for i, token in enumerate(found):
                if token is not None:
                    require(private_read(markers[i], i == 0)[1] == token, "source_marker_changed")
                    markers[i].unlink()
                    sync_dir(markers[i].parent)
            record("complete", tokens, inode)
        check_absent()
        require(all(lstat(path) is None for path in markers), "source_marker_still_present")
        print("HIVRA_KVM_PORTABLE_SOURCE_RETIREMENT_V1 " + json.dumps({
            "input": input, "mode": mode, "state": "retired", "sourceVmAbsent": True, "sourceDiskAbsent": True,
        }, separators=(",", ":")))

try:
    os.umask(0o077)
    retire()
except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, ArithmeticError) as exc:
    sys.exit("Portable KVM source retirement refused: " + str(exc))
`;

export function buildPortableKvmSourceRetirementScript(
  input: PortableKvmSourceRetirementInput,
  mode: PortableKvmSourceRetirementMode,
): string {
  return `exec python3 -I -c ${shellQuote(retire)} ${shellQuote(JSON.stringify([
    inputSchema.parse(input), modeSchema.parse(mode),
  ]))} ${shellQuote(native)}\n`;
}

export function parsePortableKvmSourceRetirementReceipt(
  stdout: string,
  input: PortableKvmSourceRetirementInput,
  mode: PortableKvmSourceRetirementMode,
): PortableKvmSourceRetirementReceipt | null {
  const expected = inputSchema.parse(input);
  modeSchema.parse(mode);
  if (!stdout.startsWith(prefix) || !stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) return null;
  try {
    const result = receiptSchema.safeParse(JSON.parse(stdout.slice(prefix.length, -1)));
    if (!result.success || result.data.mode !== mode || JSON.stringify(result.data.input) !== JSON.stringify(expected)
      || stdout !== prefix + JSON.stringify(result.data) + "\n") return null;
    return result.data;
  } catch { return null; }
}
