import { createHash } from "node:crypto";
import { shellQuote } from "../proxmox-target";
import {
  serializePortableKvmDestinationPreparePermit,
  type PortableKvmDestinationPrepareInput,
} from "./destination-prepare";
import { portableKvmSlotPython } from "./slot-claim";
import { z } from "zod";

const prefix = "HIVRA_KVM_PORTABLE_DESTINATION_ABORT_V1 ";
const modeSchema = z.enum(["cleanup", "verify-absent"]);
const receiptSchema = z.object({
  state: z.literal("destination_abort_absent"),
  preparationSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type PortableKvmDestinationAbortInput = {
  preparation: PortableKvmDestinationPrepareInput;
};
export type PortableKvmDestinationAbortReceipt = z.infer<typeof receiptSchema>;

function preparationWire(input: PortableKvmDestinationAbortInput): string {
  z.object({ preparation: z.unknown() }).strict().parse(input);
  const wire = serializePortableKvmDestinationPreparePermit(input.preparation);
  if (!input.preparation.abortScope || !input.preparation.profile.managed) {
    throw new Error("Portable KVM destination abort requires an owner-scoped managed preparation");
  }
  return wire;
}

const program = String.raw`
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

mode, argument = sys.argv[1:]
expected = argument.encode("ascii")
plan = json.loads(expected)
prepare_hash = hashlib.sha256(expected).hexdigest()
vmid = str(plan["vmid"])
operation = plan["operationId"]
root = Path("/var/lib/hivra-sleep")
registry = root / "portable-kvm-destinations"
permit_dir = root / "portable-kvm-destination-permits"
jobs = root / "portable-kvm-destination-jobs"
job = jobs / operation
locks = Path("/run/lock")
cfg = Path("/etc/pve/qemu-server", vmid + ".conf")
cluster = Path("/etc/pve/nodes")
pid = Path("/run/qemu-server", vmid + ".pid")
snippet = Path("/var/lib/vz/snippets", "hivra-portable-meta-" + operation + ".yaml")
snip_wire = ("instance-id: " + plan["profile"]["managed"]["cloudInit"]["instanceId"] + "\n").encode("ascii")
names = ["vm-" + vmid + "-disk-0", "vm-" + vmid + "-cloudinit"]
files = {
    "attempt": registry / (".attempt-" + vmid),
    "slot": registry / (".abort-slot-" + vmid),
    "native": registry / (".abort-native-" + vmid),
    "seed": registry / (".abort-seed-" + vmid),
    "reservation": registry / vmid,
    "permit": permit_dir / vmid,
    "snippet": snippet,
    **{"job/" + name: job / name for name in ("identity", "restore.sh", "receipt.pending", "receipt")},
}
journal = registry / (".abort-journal-" + operation)

def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def exists(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False

def output(*args, pass_fds=()):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                                   pass_fds=pass_fds)

def read_dir(path, private=False):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and (not private or stat.S_IMODE(info.st_mode) == 0o700), "unsafe_artifact_directory")

def read_private(path, limit=8192):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW), "rb") as f:
        info = os.fstat(f.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= limit, "unsafe_artifact_file")
        data = f.read(limit + 1)
        require(len(data) <= limit, "oversize_artifact_file")
        return data

def take(stack, path, create=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT if create else 0), 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "unsafe_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def take_legacy(stack):
    path = locks / "hermes-proxmox-provision.lock.d"
    path.mkdir(mode=0o755)
    stack.callback(path.rmdir)
    owner = path / "pid"
    with owner.open("x") as handle:
        stack.callback(owner.unlink)
        handle.write(str(os.getpid()) + "\n")

def publish(data):
    with tempfile.NamedTemporaryFile(dir=registry) as f:
        f.write(json.dumps(data, separators=(",", ":")).encode("ascii") + b"\n")
        f.flush()
        os.fsync(f.fileno())
        os.link(f.name, journal)
    sync_dir(registry)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def is_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None

def fields(data):
    config = {}
    for line in data.decode("ascii").splitlines():
        if line:
            key, sep, value = line.partition(": ")
            require(sep and key not in config, "invalid_slot_config")
            config[key] = value
    return config

${portableKvmSlotPython}

def verify_job(stack):
    if exists(jobs):
        read_dir(jobs, private=True)
    else:
        require(not exists(job), "unsafe_restore_job")
    if exists(job):
        read_dir(job, private=True)
        require({entry.name for entry in job.iterdir()} <=
                {"identity", "restore.sh", "receipt", "receipt.pending"}, "unrecognized_or_pending_restore_job")
        if exists(files["job/identity"]):
            take(stack, files["job/identity"])
        else:
            require(exists(journal) and not list(job.iterdir()), "missing_restore_job_identity")

    unit = "hivra-portable-kvm-destination-" + operation + ".service"
    result = subprocess.run(["systemctl", "show", "--all", "--no-pager", "-p", "LoadState", "-p", "ActiveState",
                             "-p", "MainPID", "-p", "ControlPID", "-p", "Job", unit],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
    pairs = [line.split("=", 1) for line in result.stdout.decode("ascii").splitlines()]
    status = dict(pairs)
    require(len(pairs) == len(status) == 5 and set(status) == {"LoadState", "ActiveState", "MainPID", "ControlPID", "Job"}
            and ((result.returncode == 0 and status["LoadState"] == "loaded" and status["ActiveState"] in {"inactive", "failed"})
                 or (result.returncode in {0, 1, 4} and status["LoadState"] == "not-found" and status["ActiveState"] == "inactive"))
            and status["MainPID"] == status["ControlPID"] == "0" and status["Job"] in {"", "0"}, "restore_writer_not_quiesced")

def inventory(config_present):
    for path in [pid, root / ("cold-" + vmid), root / ("stored-" + vmid), root / "portable-kvm-fences" / vmid,
                 registry / (vmid + ".boot-attempt"), registry / (vmid + ".released"),
                 Path("/etc/pve/lxc", vmid + ".conf"),
                 Path("/var/lib/hivra/provision-results", vmid + ".secret"),
                 *[Path("/run/hivra-provision", vmid + "." + suffix) for suffix in ("allocated", "env", "pid", "secret")]]:
        require(not exists(path), "unexpected_destination_artifact")
    for name in ("tap" + vmid + "i0", "fwbr" + vmid + "i0", "fwln" + vmid + "i0", "fwpr" + vmid + "p0"):
        require(not exists(Path("/sys/class/net", name)), "unexpected_destination_network_device")
    tables = json.loads(output("nft", "-j", "list", "tables"))["nftables"]
    require(isinstance(tables, list) and not any(item["table"]["name"].startswith("hivra_portable_" + vmid + "_")
            for item in tables if "table" in item), "unexpected_destination_bridge_fence")
    cluster_vms = json.loads(output("pvesh", "get", "/cluster/resources", "--type", "vm", "--output-format", "json"))
    require(isinstance(cluster_vms, list), "invalid_cluster_inventory")
    claims = [row for row in cluster_vms if str(row["vmid"]) == vmid]
    require((not claims and not config_present)
            or (config_present and len(claims) == 1 and claims[0]["node"] == plan["hostId"]
                and claims[0]["type"] == "qemu" and claims[0]["status"] == "stopped"), "destination_id_reused_or_running")
    ha = json.loads(output("pvesh", "get", "/cluster/ha/resources", "--output-format", "json"))
    require(isinstance(ha, list) and all(row["sid"] not in {"vm:" + vmid, "ct:" + vmid, "lxc:" + vmid} for row in ha),
            "destination_managed_by_ha")
    if not config_present:
        require(output("pvesh", "get", "/cluster/nextid", "--vmid", vmid).strip() == vmid.encode("ascii"),
                "destination_id_not_free")
    ip = plan["ip"].encode("ascii")
    for intent in Path("/var/lib/hivra/provision-operations").glob("operation-*.selected"):
        lines = read_private(intent).splitlines()
        require(b"vmid=" + vmid.encode("ascii") not in lines and b"ip=" + ip not in lines, "destination_provision_intent")
    for ledger in Path("/var/lib/hivra/vmid-references").glob("*.list"):
        require(vmid.encode("ascii") not in ledger.read_bytes().splitlines(), "destination_reference_ledger")
    require(cluster.is_dir(), "cluster_configuration_inventory_unavailable")
    for directory in ("qemu-server", "lxc"):
        for other in cluster.glob("*/" + directory + "/*.conf"):
            if config_present and other == cluster / plan["hostId"] / "qemu-server" / cfg.name:
                continue
            data = other.read_bytes()
            require(other.name != cfg.name
                    and (other.parent.parent.name != plan["hostId"]
                         or not re.search(rb"^ipconfig[0-9]+:.*[ ,]ip=" + re.escape(ip) + rb"(?:[/,\s]|$)", data, re.M))
                    and not any(name.encode("ascii") in data for name in names + [snippet.name]),
                    "destination_shared_or_reused")

def volume_inventory():
    storage = json.loads(output("pvesh", "get", "/storage/" + plan["storageId"], "--output-format", "json"))
    require(storage["type"] == "lvmthin" and storage["vgname"] == plan["volumeGroup"]
            and storage["thinpool"] == plan["thinPool"] and storage.get("shared", 0) == 0
            and "images" in storage["content"].split(","), "destination_storage_changed")
    storage_status = output("pvesm", "status", "--storage", plan["storageId"]).decode("ascii").splitlines()
    require(len(storage_status) == 2 and storage_status[1].split()[:3] == [plan["storageId"], "lvmthin", "active"],
            "destination_storage_inactive")
    report = json.loads(output("lvs", "--reportformat", "json", "-o",
                               "vg_name,vg_uuid,lv_name,lv_uuid,lv_attr,pool_lv,origin,origin_uuid"))["report"]
    require(len(report) == 1 and isinstance(report[0]["lv"], list), "invalid_volume_inventory")
    all_volumes = report[0]["lv"]
    owned = {}
    for lv in all_volumes:
        name = lv["lv_name"]
        if re.match(r"(?:snap_)?(?:vm|base)-" + vmid + "-", name):
            require(name in names and name not in owned and lv["vg_name"] == plan["volumeGroup"]
                    and lv["pool_lv"] == plan["thinPool"] and lv["origin"] == ""
                    and re.fullmatch(r"V...a-..-.", lv["lv_attr"]), "unknown_or_open_destination_volume")
            path = Path("/dev", plan["volumeGroup"], name)
            require(output("pvesm", "path", plan["storageId"] + ":" + name).strip() == str(path).encode("ascii"),
                    "destination_volume_path_changed")
            require(exists(path), "missing_destination_device_path")
            target = path.resolve(strict=True)
            require(target.parent == Path("/dev") and re.fullmatch(r"dm-[0-9]+", target.name)
                    and Path("/sys/class/block", target.name, "dm/uuid").read_text().strip() ==
                        "LVM-" + (lv["vg_uuid"] + lv["lv_uuid"]).replace("-", ""), "destination_device_uuid_changed")
            owned[name] = {"vgUuid": lv["vg_uuid"], "lvUuid": lv["lv_uuid"]}
    for name in names:
        if name not in owned:
            require(not exists(Path("/dev", plan["volumeGroup"], name)), "unregistered_destination_device")
    require(not any(lv["origin_uuid"] in {vol["lvUuid"] for vol in owned.values()}
                    or (lv["vg_name"] == plan["volumeGroup"] and lv["origin"] in owned)
                    for lv in all_volumes), "destination_volume_has_dependents")
    listed = output("pvesm", "list", plan["storageId"], "--vmid", vmid).decode("ascii").splitlines()
    require((not listed or listed[0].split()[0:1] == ["Volid"])
            and sorted(line.split()[0] for line in listed[1:]) == sorted(plan["storageId"] + ":" + n for n in owned),
            "storage_inventory_disagreement")
    return owned

def gather():
    read_dir(permit_dir, private=True)
    for directory in (snippet.parent.parent, snippet.parent):
        read_dir(directory)
    observed = {}
    for key, path in files.items():
        if exists(path):
            observed[key] = read_private(path, 32768 if key == "job/restore.sh" else 8192)
    return observed

def inspect_lineage(data, volumes):
    require(data.get("attempt") == expected and data.get("permit") == expected, "preparation_scope_mismatch")
    require("snippet" not in data or data["snippet"] == snip_wire, "destination_snippet_changed")
    slot = json.loads(data["slot"])
    require(set(slot) == {"prepareSha256", "rawSha256"} and slot["prepareSha256"] == prepare_hash
            and is_sha(slot["rawSha256"]), "slot_lineage_mismatch")
    require(not cfg.is_symlink() and cfg.is_file(), "missing_or_unsafe_destination_config")
    raw = cfg.read_bytes()
    raw_hash = sha(raw)
    if "snippet" in data:
        snippet_storage = json.loads(output("pvesh", "get", "/storage/local", "--output-format", "json"))
        require(snippet_storage["type"] == "dir" and snippet_storage["path"] == str(snippet.parent.parent)
                and snippet_storage.get("shared", 0) == 0 and "snippets" in snippet_storage["content"].split(",")
                and output("pvesm", "path", "local:snippets/" + snippet.name).strip() == str(snippet).encode("ascii"),
                "destination_snippet_storage_changed")
    if "native" not in data:
        require(not volumes and not any(k in data for k in ("seed", "reservation", "job/identity"))
                and raw_hash == slot["rawSha256"], "native_lineage_unconfirmed")
        slot_digest(cfg, vmid, plan["ip"], plan["bindingTag"])
        return raw_hash

    require("snippet" in data, "missing_destination_snippet")
    def lineage(key):
        record = json.loads(data[key])
        require(set(record) == {"prepareSha256", "rawSha256", "currentSha256", "volumes"}
                and record["prepareSha256"] == prepare_hash and is_sha(record["rawSha256"])
                and is_sha(record["currentSha256"]) and record["volumes"] == volumes
                and set(volumes) == set(names), "destination_volume_lineage_mismatch")
        for volume in volumes.values():
            require(all(re.fullmatch(r"[A-Za-z0-9-]{32,48}", v) and len(v.replace("-", "")) == 32
                        for v in volume.values()), "invalid_destination_volume_identity")
        return record

    native = lineage("native")
    latest = lineage("seed") if "seed" in data else native
    current = output("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    require(raw_hash == latest["rawSha256"] and sha(current) == latest["currentSha256"]
            and output("qm", "status", vmid).strip() == b"status: stopped", "destination_configuration_drift")
    config = fields(current)
    managed = plan["profile"]["managed"]
    require(config.get("lock") == "backup" and config.get("onboot") == "0"
            and config.get("name") == "hivra-portable-" + vmid
            and set(config.get("tags", "").split(";")) ==
                {plan["bindingTag"], "hivra-op-" + managed["allocationOperationId"].replace("-", "")}
            and config.get("net0", "").endswith(",firewall=1,link_down=1")
            and config.get("scsi0", "").split(",")[0] == plan["storageId"] + ":" + names[0]
            and config.get("ide2", "").split(",")[0] == plan["storageId"] + ":" + names[1]
            and config.get("cicustom") == "meta=local:snippets/" + snippet.name, "destination_binding_or_quarantine_mismatch")
    if "reservation" in data:
        reservation = json.loads(data["reservation"])
        require("seed" in data and all(reservation[k] == plan[k] for k in
                ("agentId", "operationId", "generation", "checkpointSha256", "hostId", "vmid", "bindingTag",
                 "storageId", "volumeGroup", "disk"))
                and reservation["rawConfigurationSha256"] == raw_hash
                and reservation["configurationSha256"] == latest["currentSha256"]
                and reservation["volumeName"] == names[0]
                and reservation["deviceMapperUuid"] == "LVM-" + (
                    volumes[names[0]]["vgUuid"] + volumes[names[0]]["lvUuid"]).replace("-", ""),
                "destination_reservation_mismatch")
    if exists(job):
        require("reservation" in data and data.get("job/identity") == data["reservation"]
                and "job/restore.sh" in data, "restore_job_lineage_mismatch")
    return raw_hash

native_program = r"""
use strict;
use warnings;
my ($vmid, $sha, $volumes) = @ARGV;
PVE::QemuConfig->lock_config($vmid, sub {
    my $path = PVE::QemuConfig->config_file($vmid);
    die "destination running" if PVE::QemuServer::check_running($vmid);
    if ($sha eq "") {
        die "destination configuration present" if lstat($path) || !$!{ENOENT};
        return;
    }
    die "destination configuration changed" if !-f $path || -l $path
        || Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) ne $sha;
    my $conf = PVE::QemuConfig->load_config($vmid);
    die "destination configuration not backup-locked" if ($conf->{lock} // "") ne "backup";
    foreach my $selector (@{JSON::PP::decode_json($volumes)}) {
        open(my $before, "-|", "lvs", "--noheadings", "--options", "lv_uuid", "--select", $selector)
            or die "exact volume inventory unavailable";
        my @before = <$before>;
        close($before) && @before == 1 && $before[0] =~ /^\s*[A-Za-z0-9-]+\s*$/
            or die "exact volume identity no longer present";
        system("lvremove", "--yes", "--select", $selector) == 0 or die "exact volume removal failed";
        open(my $after, "-|", "lvs", "--noheadings", "--options", "lv_uuid", "--select", $selector)
            or die "exact volume inventory unavailable";
        my @after = <$after>;
        close($after) && !@after or die "exact volume still present";
    }
    die "destination configuration changed" if Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) ne $sha;
    PVE::QemuConfig->destroy_config($vmid);
});
"""

def native(fds, raw_hash="", volumes=None):
    selectors = ["vg_uuid=" + item["vgUuid"] + " && lv_uuid=" + item["lvUuid"] + " && lv_name=" + name
                 for name, item in (volumes or {}).items()]
    output("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Tools", "-MDigest::SHA",
           "-MJSON::PP", "-e", native_program, vmid, raw_hash, json.dumps(selectors), pass_fds=fds)

def verify_physical_absence(fds):
    native(fds)
    require(not exists(cfg) and not volume_inventory(), "destination_physical_absence_unproven")
    inventory(False)

def run(stack):
    require(os.geteuid() == 0 and output("hostname", "-s").strip() == plan["hostId"].encode("ascii"), "wrong_host")
    read_dir(root)
    read_dir(registry, private=True)
    read_dir(locks / "hivra-vmids")
    fds = [take(stack, locks / key, create=True) for key in ("hivra-allocation.lock", "hivra-vmids/" + vmid + ".lock")]
    take_legacy(stack)
    fds += [take(stack, locks / key, create=True) for key in (
        "hivra-computer-backup.lock",
        "hivra-vm-" + vmid + ".backup.lock", "hivra-vm-" + vmid + ".lock",
        "hivra-portable-kvm-job-" + operation + ".lock")]
    verify_job(stack)
    data = gather()
    if exists(journal):
        record = json.loads(read_private(journal))
        require(set(record) == {"prepareSha256", "files"} and record["prepareSha256"] == prepare_hash
                and isinstance(record["files"], dict) and set(record["files"]) <= set(files)
                and {"attempt", "slot", "permit"} <= set(record["files"])
                and all(is_sha(value) for value in record["files"].values()), "abort_journal_mismatch")
        require(all(record["files"].get(key) == sha(value) for key, value in data.items()), "abort_artifacts_reappeared_or_changed")
        verify_physical_absence(fds)
    else:
        require(mode == "cleanup", "missing_abort_journal")
        inventory(True)
        volumes = volume_inventory()
        raw_hash = inspect_lineage(data, volumes)
        publish({"prepareSha256": prepare_hash, "files": {key: sha(value) for key, value in data.items()}})
        native(fds, raw_hash, volumes)
        verify_physical_absence(fds)

    if mode == "cleanup":
        for key in ("job/receipt.pending", "job/receipt", "job/restore.sh", "job/identity",
                    "snippet", "reservation", "permit", "seed", "native", "slot", "attempt"):
            if key in data:
                path = files[key]
                require(read_private(path, 32768 if key == "job/restore.sh" else 8192) == data[key],
                        "abort_artifact_changed_before_unlink")
                path.unlink()
                sync_dir(path.parent)
        if exists(job):
            job.rmdir()
            sync_dir(jobs)
    else:
        require(not data and not exists(job), "destination_artifact_absence_unproven")
        receipt = {"state": "destination_abort_absent", "preparationSha256": prepare_hash}
        print("${prefix}" + json.dumps(receipt, separators=(",", ":")))

try:
    os.umask(0o077)
    with ExitStack() as stack:
        run(stack)
except RuntimeError as error:
    sys.exit("portable KVM destination abort: " + str(error))
except (KeyError, OSError, subprocess.SubprocessError, TypeError, ValueError):
    sys.exit("portable KVM destination abort: host admission, lock or readback failed")
`;

/**
 * Dispatch only while holding authoritative pre-CAS abort ownership, after independently
 * proving that the source remains recoverable. Hold that authority through verification.
 * Cleanup never issues a proof. If native cleanup is interrupted while any VM or volume
 * survives, the durable journal requires reconciliation rather than destructive replay.
 */
export function buildPortableKvmDestinationAbortScript(
  mode: z.infer<typeof modeSchema>,
  input: PortableKvmDestinationAbortInput,
): string {
  return `exec timeout -k 5 150 python3 -I -c ${shellQuote(program)} ${shellQuote(modeSchema.parse(mode))} ${shellQuote(preparationWire(input))}\n`;
}

/** Accept only a successful, independently dispatched verify-absent execution. */
export function parsePortableKvmDestinationAbortReceipt(
  stdout: string,
  input: PortableKvmDestinationAbortInput,
): PortableKvmDestinationAbortReceipt | null {
  try {
    if (!stdout.startsWith(prefix) || !stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) return null;
    const json = stdout.slice(prefix.length, -1);
    const parsed = receiptSchema.safeParse(JSON.parse(json));
    if (!parsed.success || JSON.stringify(parsed.data) !== json) return null;
    const expected = createHash("sha256").update(preparationWire(input)).digest("hex");
    return parsed.data.preparationSha256 === expected ? parsed.data : null;
  } catch {
    return null;
  }
}
