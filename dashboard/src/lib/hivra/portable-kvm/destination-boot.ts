import "server-only";

import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { isCanonicalGitCanaryDeployment } from "../canonical-git-canary";
import { shellQuote } from "../proxmox-target";
import {
  portableKvmResourceValidationPython,
  serializePortableKvmDestinationReservation,
  type PortableKvmDestinationDiskReceipt,
  type PortableKvmDestinationReservation,
} from "./destination-disk";
import { portableKvmAllocationOperationId, portableKvmHostCpuValidationPython, portableKvmManagedAllocationProfileSchema } from "./destination-prepare";
import { isPortableKvmWakeClaimed, portableKvmPlacement, resolvePortableKvmPilotPlacement, type PortableKvmPilot } from "./pilot";

const prefix = "HIVRA_KVM_PORTABLE_BOOT_V1 ";
const timeoutMs = 125_000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const machineId = z.string().regex(/^[a-f0-9]{32}$/).refine(value => !/^0+$/.test(value));
const bootId = z.string().uuid().refine(value => value !== "00000000-0000-0000-0000-000000000000");
const privateIpv4 = z.string().refine(value => isIPv4(value)
  && /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(value));
const leaseSchema = z.object({
  agent_id: z.string().uuid(),
  owner_id: z.string(),
  operation_id: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.enum(["restore_claimed", "destination_verified", "placement_committed", "connector_verified"]),
  expires_at: z.string(),
  checkpoint_sha256: sha256,
  source: portableKvmPlacement,
  destination: portableKvmPlacement,
  destination_evidence: z.object({
    destination: portableKvmPlacement,
    checkpointSha256: sha256,
    coldBootVerified: z.literal(true),
    destinationConnectorBlocked: z.literal(true),
    bootId,
    reservationSha256: sha256,
  }).strict().nullish(),
  connector_evidence: z.object({
    destination: portableKvmPlacement,
    sourceFenced: z.literal(true),
    sourceConnectorOff: z.literal(true),
    destinationConnectorReady: z.literal(true),
    bootId,
    connectorId: bootId,
  }).strict().nullish(),
});
const receiptSchema = z.object({
  state: z.enum(["destination_quarantined", "destination_network_enabled", "destination_lock_released"]),
  profileSha256: sha256,
  bootId,
  connectorId: bootId.optional(),
}).strict();
type Receipt<S> = Omit<z.infer<typeof receiptSchema>, "state" | "connectorId"> & { state: S };

export type PortableKvmDestinationBootReceipt = Receipt<"destination_quarantined">;
export type PortableKvmDestinationNetworkReceipt = Receipt<"destination_network_enabled"> & { connectorId: string };
export type PortableKvmDestinationLockReceipt = Receipt<"destination_lock_released"> & { connectorId: string };

export type PortableKvmDestinationBootProfile = {
  reservation: PortableKvmDestinationReservation;
  ip: string;
  machineId: string;
  managed?: z.input<typeof portableKvmManagedAllocationProfileSchema>;
};

/**
 * A trusted preparer pins the source disk's machine ID, independently qualified
 * guest network profile and exact restore reservation at
 * /var/lib/hivra-sleep/portable-kvm-destinations/<vmid>.boot (root:0600).
 * This cannot be derived from the destination's own unverified QGA response.
 */
export function serializePortableKvmDestinationBootProfile(profile: PortableKvmDestinationBootProfile): string {
  const managed = portableKvmManagedAllocationProfileSchema.optional().parse(profile.managed);
  const ip = (managed ? privateIpv4 : z.string().refine(isIPv4)).parse(profile.ip);
  const reservation: PortableKvmDestinationReservation = JSON.parse(serializePortableKvmDestinationReservation(profile.reservation));
  if (reservation.resources?.balloonMb !== managed?.resources?.balloonMb
    || reservation.resources?.cpuUnits !== managed?.resources?.cpuUnits) {
    throw new Error("Portable KVM managed resources do not match the destination reservation");
  }
  if (managed && (![ip, managed.cloudInit.gateway].every(value => !/\.(?:0|255)$/.test(value)) || ip === managed.cloudInit.gateway
    || ip.split(".").slice(0, 3).join(".") !== managed.cloudInit.gateway.split(".").slice(0, 3).join("."))) {
    throw new Error("Portable KVM managed seed gateway does not match the leased subnet");
  }
  return JSON.stringify({
    reservation,
    ip,
    machineId: machineId.parse(profile.machineId),
    managed,
  }) + "\n";
}

export type PortableKvmDestinationBootAdapter = {
  // Reread the singleton lease and live owned agent independently of the caller's
  // inputs. Never satisfy this from an earlier CAS result or client-provided proof.
  readAuthority(input: { ownerId: string; agentId: string }): Promise<{
    lease: unknown;
    agent: Record<string, unknown>;
    pilot: PortableKvmPilot;
  } | null>;
  runHostScript(input: { hostId: string; script: string; timeoutMs: number }): Promise<{ ok: boolean; stdout: string }>;
};

export type PortableKvmDestinationReleaseAdapter = PortableKvmDestinationBootAdapter & {
  verifyConnector(input: { agentId: string; tunnelId: string; connectorId: string }): Promise<boolean>;
};

const guestProbe = String.raw`
import json
import re
import subprocess
import sys
from pathlib import Path

mac, want_carrier, ip, instance_id, gateway = sys.argv[1:]
interfaces = [p for p in Path("/sys/class/net").iterdir()
              if p.name != "lo" and (p / "address").read_text().strip() == mac]
if len(interfaces) != 1 or (interfaces[0] / "carrier").read_text().strip() != ("0" if want_carrier == "0" else "1"):
    sys.exit(1)
unit = "hivra-cf-tunnel.service"
def run(*args):
    return subprocess.check_output(args, timeout=5, stderr=subprocess.DEVNULL)
if set(run("systemctl", "show", "--property=FragmentPath,DropInPaths,LoadState", unit).splitlines()) != {
    b"FragmentPath=/etc/systemd/system/hivra-cf-tunnel.service", b"DropInPaths=", b"LoadState=loaded",
}:
    sys.exit(1)
proof = {"machineId": Path("/etc/machine-id").read_text().strip(),
         "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
if instance_id:
    actual = json.loads(Path("/run/cloud-init/instance-data.json").read_text())["v1"]["instance_id"]
    if actual != instance_id:
        sys.exit(1)
    proof["instanceId"] = actual
if want_carrier == "1":
    addresses = json.loads(run("ip", "-j", "-4", "address", "show", "dev", interfaces[0].name))
    if not any(a.get("local") == ip and a.get("scope") == "global"
               and not any(k in a.get("flags", []) for k in ("tentative", "dadfailed"))
               for interface in addresses for a in interface.get("addr_info", [])):
        sys.exit(1)
    if gateway:
        routes = json.loads(run("ip", "-j", "-4", "route", "show", "default", "dev", interfaces[0].name))
        if not any(route.get("gateway") == gateway and route.get("dev") == interfaces[0].name for route in routes):
            sys.exit(1)
    def invocation():
        keys = ("ActiveState", "InvocationID", "MainPID")
        values = dict(line.split("=", 1) for line in run("systemctl", "show", "--property=" + ",".join(keys), unit)
                      .decode("ascii").splitlines())
        if values["ActiveState"] != "active" or not re.fullmatch(r"[a-f0-9]{32}", values["InvocationID"]):
            sys.exit(1)
        if not re.fullmatch(r"[1-9][0-9]{0,9}", values["MainPID"]):
            sys.exit(1)
        if str(Path("/proc", values["MainPID"], "exe").readlink()) != "/usr/local/bin/cloudflared":
            sys.exit(1)
        return values["InvocationID"], values["MainPID"]
    current = invocation()
    lines = run("journalctl", "--boot=0", "--unit=" + unit, "--no-pager", "--output=json", "--lines=10",
                "--grep=Generated Connector ID:", "_SYSTEMD_INVOCATION_ID=" + current[0], "_PID=" + current[1],
                "_EXE=/usr/local/bin/cloudflared").splitlines()
    ids = set()
    for line in lines:
        message = json.loads(line)["MESSAGE"]
        match = re.fullmatch(r"(?:\S+ INF )?Generated Connector ID: ([0-9a-f-]{36})", message)
        if match:
            ids.add(match.group(1))
    if len(ids) != 1 or invocation() != current:
        sys.exit(1)
    proof["connectorId"], = ids
print(json.dumps(proof))
`;

const destinationHost = String.raw`
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
import time
from contextlib import ExitStack
from pathlib import Path

profile_raw, reservation_raw, mode, expected_boot, expected_connector, expires, guest = sys.argv[1:]
p = json.loads(profile_raw)
r = p["reservation"]
managed = p.get("managed")
seed = managed["cloudInit"] if managed else {}
vmid = str(r["vmid"])
root = Path("/var/lib/hivra-sleep")
registry = root / "portable-kvm-destinations"
config = Path("/etc/pve/qemu-server", vmid + ".conf")
pidfile = Path("/run/qemu-server", vmid + ".pid")
volume = r["storageId"] + ":" + r["volumeName"]
profile_hash = hashlib.sha256(profile_raw.encode("ascii")).hexdigest()
table = "hivra_portable_" + vmid + "_" + profile_hash[:24]
tap = "tap" + vmid + "i0"
firewall_port = "fwpr" + vmid + "p0"
release_marker = registry / (vmid + ".released")
attempt_marker = registry / (vmid + ".boot-attempt")
post_commit = mode in {"enable", "release", "retirement-witness"}
attempt_wire = (profile_hash + "\n").encode("ascii")

def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)

${portableKvmHostCpuValidationPython}
${portableKvmResourceValidationPython}

def output(*args, timeout=12):
    return subprocess.check_output(args, timeout=timeout, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def lock(stack, name):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(Path("/run/lock") / name, flags | (0 if mode == "verify" else os.O_CREAT), 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "unsafe_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

def private_bytes(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 8192,
                "reservation_mismatch")
        return file.read(8193)

def write_private_marker(path, content):
    with tempfile.NamedTemporaryFile(dir=registry) as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
        os.link(handle.name, path)
    fd = os.open(registry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def check_reservation():
    for path, modes in ((root, {0o700, 0o755}), (registry, {0o700})):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) in modes,
                "unsafe_reservation_directory")
    require(private_bytes(registry / vmid) == reservation_raw.encode("ascii")
            and private_bytes(registry / (vmid + ".boot")) == profile_raw.encode("ascii"), "reservation_mismatch")
    require(not any(os.path.lexists(root / name) for name in
                    ("cold-" + vmid, "stored-" + vmid, "portable-kvm-fences/" + vmid)), "existing_vm_fence")
    ha = json.loads(output("pvesh", "get", "/cluster/ha/resources", "--output-format", "json"))
    require(isinstance(ha, list) and all(item["sid"] not in {"vm:" + vmid, "ct:" + vmid, "lxc:" + vmid} for item in ha)
            and not os.path.lexists(Path("/etc/pve/lxc", vmid + ".conf")), "destination_vmid_conflict")

def check_managed_seed(fields):
    snippet = "hivra-portable-meta-" + r["operationId"] + ".yaml"
    metadata = "local:snippets/" + snippet
    cdrom = r["storageId"] + ":vm-" + vmid + "-cloudinit,media=cdrom"
    require(fields.get("cpu") == "host" and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", fields.get("cpulimit", ""))
            and re.fullmatch(r"[1-8]", fields.get("cores", ""))
            and float(fields["cpulimit"]) == managed["cpuLimit"] <= int(fields["cores"]), "unsupported_managed_cpu")
    require(fields.get("serial0") == "socket" and fields.get("vga") == "serial0"
            and fields.get("ide2") in {cdrom, cdrom + ",size=4M"}
            and fields.get("ciuser") == "ubuntu" and fields.get("citype") == "nocloud"
            and fields.get("ciupgrade") == "0" and fields.get("cicustom") == "meta=" + metadata
            and fields.get("ipconfig0") == "ip=" + p["ip"] + "/24,gw=" + seed["gateway"]
            and fields.get("nameserver") == " ".join(seed["nameservers"]), "unsupported_managed_seed")
    dirpath = Path("/var/lib/vz/snippets")
    info = dirpath.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and dirpath.resolve() == dirpath, "unsafe_seed_directory")
    path = output("pvesm", "path", metadata).decode("ascii").rstrip("\n")
    require(path == str(dirpath / snippet)
            and private_bytes(dirpath / snippet) == ("instance-id: " + seed["instanceId"] + "\n").encode("ascii"),
            "managed_seed_metadata_mismatch")

def tracked_link(nic):
    return ("\n[special:cloudinit]\nnet0: " + nic + ",link_down=1\n").encode("ascii")

def clear_managed_link_cache(nic):
    raw = config.read_bytes()
    tracked = tracked_link(nic)
    if not managed or not raw.endswith(tracked):
        return False
    clear = """
use strict;
use warnings;
my ($vmid, $sha, $old_nic) = @ARGV;
PVE::QemuConfig->lock_config($vmid, sub {
    my $path = PVE::QemuConfig->config_file($vmid);
    die "configuration changed" if Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) ne $sha;
    my $conf = PVE::QemuConfig->load_config($vmid);
    die "guest no longer running and locked" if ($conf->{lock} // '') ne 'backup' || !PVE::QemuServer::check_running($vmid);
    my $cache = $conf->{'special-sections'}->{cloudinit};
    die "unexpected cloud-init cache" if !$cache || scalar(keys %$cache) != 1 || ($cache->{net0} // '') ne $old_nic;
    delete $conf->{'special-sections'}->{cloudinit};
    PVE::QemuConfig->write_config($vmid, $conf);
});
"""
    output("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Tools", "-MDigest::SHA",
           "-e", clear, vmid, hashlib.sha256(raw).hexdigest(), nic + ",link_down=1")
    require(config.read_bytes() == raw[:-len(tracked)], "managed_link_cache_not_cleared")
    return True

def check_config():
    check_reservation()
    raw = config.read_bytes()
    current = output("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
    allowed = {"agent", "arch", "bios", "boot", "cores", "cpu", "description", "lock", "machine",
               "memory", "meta", "name", "net0", "numa", "onboot", "ostype", "scsi0", "scsihw",
               "smbios1", "sockets", "tags", "vcpus", "vmgenid", "balloon", "cpuunits"}
    if managed:
        allowed.update({"cicustom", "citype", "ciupgrade", "ciuser", "cpulimit", "ide2", "ipconfig0", "nameserver",
                        "serial0", "vga"})
    fields = {}
    for line in current.decode("utf-8").splitlines():
        key, sep, value = line.partition(": ")
        require(sep and key in allowed and key not in fields, "unsupported_configuration")
        fields[key] = value
    require_resource_configuration(fields, raw, r.get("resources"))
    lock_state = fields.get("lock")
    release = json.loads(private_bytes(release_marker)) if os.path.lexists(release_marker) else None
    require(release is None or (mode in {"release", "retirement-witness"} and release["bootId"] == expected_boot
            and release["profileSha256"] == profile_hash), "invalid_release_marker")
    require((lock_state == "backup" or (lock_state is None and release is not None))
            and fields.get("onboot", "0") == "0"
            and fields.get("agent") in {"1", "enabled=1"}
            and fields.get("arch", "x86_64") == "x86_64" and fields.get("bios", "seabios") == "seabios"
            and fields.get("ostype") == "l26" and fields.get("scsihw") == "virtio-scsi-single"
            and fields.get("boot") == "order=scsi0"
            and re.fullmatch(r"pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?", fields.get("machine", "")),
            "unsupported_boot_configuration")
    if managed:
        check_managed_seed(fields)
    tags = fields.get("tags", "").split(";")
    require([tag for tag in tags if tag.startswith("hivra-bind-")] == [r["bindingTag"]], "binding_mismatch")
    if managed:
        require([tag for tag in tags if tag.startswith("hivra-op-")] ==
                ["hivra-op-" + managed["allocationOperationId"].replace("-", "")], "allocation_mismatch")
    disk, *options = fields.get("scsi0", "").split(",")
    require(disk == volume and len({option.partition("=")[0] for option in options}) == len(options)
            and all(re.fullmatch(r"(?:discard=(?:on|ignore)|(?:ssd|iothread|backup|replicate)=[01]|size=[0-9]+[KMGT]?)",
                                 option) for option in options), "unsupported_disk")
    nic = fields.get("net0", "")
    match = re.fullmatch(r"virtio=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}),bridge=(vmbr[0-9]{1,4}|hivra0)"
                         r",firewall=1(,link_down=1)?", nic)
    require(match, "unsupported_network")
    require(Path("/sys/class/net", match.group(2), "bridge").is_dir(), "destination_not_linux_bridge")
    fenced = match.group(3) is not None
    active_nic = nic.removesuffix(",link_down=1")
    if managed and post_commit and not fenced:
        tracked = tracked_link(active_nic)
        if raw.endswith(tracked):
            raw = raw[:-len(tracked)]
    require(not re.search(rb"^\s*\[", raw, re.M), "configuration_sections_present")
    unlocked = {"profileSha256": profile_hash, "bootId": expected_boot}
    for data, key in ((current, "configurationSha256"), (raw, "rawConfigurationSha256")):
        if lock_state == "backup":
            require(data.splitlines(keepends=True).count(b"lock: backup\n") == 1, "lock_configuration_drift")
            unlocked[key] = hashlib.sha256(data.replace(b"lock: backup\n", b"", 1)).hexdigest()
        else:
            require(not fenced and hashlib.sha256(data).hexdigest() == release[key], "unlocked_configuration_drift")
            continue
        line = ("net0: " + nic + "\n").encode("ascii")
        require(data.splitlines(keepends=True).count(line) == 1, "network_configuration_drift")
        if not fenced:
            data = data.replace(line, ("net0: " + nic + ",link_down=1\n").encode("ascii"), 1)
        require(hashlib.sha256(data).hexdigest() == r[key], "configuration_drift")
    if release and lock_state == "backup":
        require(not fenced and release == unlocked, "release_intent_mismatch")
    return fenced, active_nic, match.group(1).lower(), lock_state == "backup", unlocked

def check_disk():
    storage = output("pvesm", "status", "--storage", r["storageId"]).decode("ascii").splitlines()
    require(len(storage) == 2 and storage[1].split()[:3] == [r["storageId"], "lvmthin", "active"],
            "unsupported_storage")
    device = output("pvesm", "path", volume).decode("ascii").rstrip("\n")
    require(device == "/dev/" + r["volumeGroup"] + "/" + r["volumeName"], "device_path_mismatch")
    path = os.path.realpath(device)
    require(re.fullmatch(r"/dev/dm-[0-9]+", path), "device_path_mismatch")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as file:
        fd = file.fileno()
        info = os.fstat(fd)
        require(stat.S_ISBLK(info.st_mode), "device_not_block")
        dm = Path("/sys/dev/block", str(os.major(info.st_rdev)) + ":" + str(os.minor(info.st_rdev)), "dm/uuid")
        size = struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]
        require(dm.read_text().strip() == r["deviceMapperUuid"] and size == r["disk"]["bytes"], "disk_identity_mismatch")

def running_pid():
    require(output("qm", "status", vmid).strip() == b"status: running", "destination_not_running")
    pid = pidfile.read_text().strip()
    require(re.fullmatch(r"[1-9][0-9]{0,9}", pid), "destination_pid_invalid")
    return pid

def check_headroom():
    memory = re.findall(r"^memory: ([0-9]+)$", config.read_text(), re.M)
    available = re.findall(r"^MemAvailable:\s+([0-9]+) kB$", Path("/proc/meminfo").read_text(), re.M)
    pressure = re.findall(r"^full avg10=([0-9]+\.[0-9]+) ", Path("/proc/pressure/io").read_text(), re.M)
    require(len(memory) == 1 and 1024 <= int(memory[0]) <= 16384
            and len(available) == 1 and int(available[0]) >= (60 * 1024 + int(memory[0])) * 1024,
            "host_memory_headroom")
    require(len(pressure) == 1 and float(pressure[0]) <= 1.0, "host_io_pressure")

def check_expiry():
    require(time.time() < int(expires), "lease_expired")

def bridge_fence():
    tables = json.loads(output("nft", "-j", "list", "tables", "bridge"))["nftables"]
    ours = [entry["table"] for entry in tables if "table" in entry and entry["table"]["name"] == table]
    if not ours:
        return False
    entries = json.loads(output("nft", "-j", "list", "table", "bridge", table))["nftables"]
    expected = {"prerouting": "iifname", "postrouting": "oifname"}
    counts = {key: {"chain": 0, "rule": 0} for key in expected}
    for entry in entries:
        if "metainfo" in entry or "table" in entry:
            continue
        require(len(entry) == 1, "bridge_fence_mismatch")
        kind, row = next(iter(entry.items()))
        name = row.get("name" if kind == "chain" else "chain")
        require(kind in {"chain", "rule"} and name in expected and row["family"] == "bridge"
                and row["table"] == table, "bridge_fence_mismatch")
        counts[name][kind] += 1
        if kind == "chain":
            require(row["type"] == "filter" and row["hook"] == name and row["prio"] == -300
                    and row["policy"] == "accept", "bridge_fence_mismatch")
        else:
            match, drop = row["expr"]
            match = match["match"]
            require(match["op"] in {"==", "in"} and match["left"] == {"meta": {"key": expected[name]}}
                    and set(match["right"]["set"]) == {tap, firewall_port}
                    and drop == {"drop": None}, "bridge_fence_mismatch")
    require(all(value == {"chain": 1, "rule": 1} for value in counts.values()), "bridge_fence_mismatch")
    return True

def install_bridge_fence():
    rules = ["create table bridge " + table]
    for hook, direction in (("prerouting", "iifname"), ("postrouting", "oifname")):
        rules.append("add chain bridge " + table + " " + hook
                     + " { type filter hook " + hook + " priority -300; policy accept; }")
        rules.append("add rule bridge " + table + " " + hook + " " + direction
                     + ' { "' + tap + '", "' + firewall_port + '" } drop')
    subprocess.run(("nft", "-f", "-"), input=("\n".join(rules) + "\n").encode("ascii"),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12, check=True)
    require(bridge_fence(), "bridge_fence_missing")

def bridge_connected():
    require(Path("/sys/class/net", tap, "master", "bridge").is_dir(), "destination_tap_not_bridged")

def probe(mac, carrier, seconds):
    deadline = time.monotonic() + seconds
    while True:
        check_expiry()
        try:
            result = json.loads(output("qm", "guest", "exec", vmid, "--timeout", "10", "--",
                                       "/usr/bin/python3", "-I", "-c", guest, mac, str(carrier), p["ip"],
                                       seed.get("instanceId", ""), seed.get("gateway", ""), timeout=13))
            if type(result.get("exited")) in (bool, int) and result["exited"] == 1 \
                    and type(result.get("exitcode")) is int and result["exitcode"] == 0:
                proof = json.loads(result["out-data"])
                require(proof.get("machineId") == p["machineId"], "guest_machine_identity_mismatch")
                require(proof.get("instanceId") == seed.get("instanceId"), "guest_cloudinit_identity_mismatch")
                observed = proof.get("bootId")
                require(isinstance(observed, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", observed)
                        and observed != "00000000-0000-0000-0000-000000000000"
                        and (not expected_boot or observed == expected_boot), "guest_boot_identity_mismatch")
                connector = proof.get("connectorId")
                if carrier == 1:
                    require(isinstance(connector, str)
                            and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", connector)
                            and connector != "00000000-0000-0000-0000-000000000000", "connector_identity_missing")
                    require(not expected_connector or connector == expected_connector, "connector_identity_changed")
                else:
                    require(connector is None, "unexpected_connector_identity")
                return observed, connector
        except (KeyError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
            pass
        require(time.monotonic() < deadline, "guest_probe_failed")
        time.sleep(1)

def run():
    require(os.geteuid() == 0 and output("hostname", "-s").strip() == r["hostId"].encode("ascii"), "wrong_host")
    os.umask(0o077)
    with ExitStack() as stack:
        lock(stack, "hivra-computer-backup.lock")
        lock(stack, "hivra-vm-" + vmid + ".backup.lock")
        lock(stack, "hivra-vm-" + vmid + ".lock")
        fenced, nic, mac, locked, unlocked = check_config()
        check_disk()
        attempted = os.path.lexists(attempt_marker)
        if attempted or mode != "boot":
            require(private_bytes(attempt_marker) == attempt_wire, "boot_attempt_mismatch")
        if mode == "boot":
            require(fenced, "destination_nic_not_fenced")
            if attempted:
                require(bridge_fence(), "bridge_fence_missing")
            else:
                require(output("qm", "status", vmid).strip() == b"status: stopped"
                        and not os.path.lexists(pidfile)
                        and not any(os.path.lexists(Path("/sys/class/net", name)) for name in (tap, firewall_port)),
                        "destination_not_stopped_and_fenced")
                check_headroom()
                if managed:
                    require_host_cpu(managed["cpu"])
                if not bridge_fence():
                    install_bridge_fence()
                check_expiry()
                write_private_marker(attempt_marker, attempt_wire)
                check_expiry()
                output("qm", "start", vmid, "--skiplock", "1", timeout=35)
            pid = running_pid()
            bridge_connected()
            observed_boot, connector = probe(mac, 0, 35)
            require(bridge_fence(), "bridge_fence_missing")
        elif mode == "verify":
            require(fenced and bridge_fence(), "bridge_fence_missing")
            pid = running_pid()
            bridge_connected()
            observed_boot, connector = probe(mac, 0, 8)
            require(bridge_fence(), "bridge_fence_missing")
        elif mode == "enable":
            pid = running_pid()
            bridge_connected()
            bridge_fenced = bridge_fence()
            if fenced:
                require(bridge_fenced, "bridge_fence_missing")
                probe(mac, 0, 8)
                require(check_config()[:4] == (True, nic, mac, True) and running_pid() == pid
                        and bridge_fence(), "quarantine_changed")
                check_expiry()
                output("qm", "set", vmid, "--skiplock", "1", "--net0", nic)
            if bridge_fenced:
                require(check_config()[:4] == (False, nic, mac, True) and running_pid() == pid
                        and bridge_fence(), "quarantine_changed")
                probe(mac, 2, 8)
                check_expiry()
                output("nft", "delete", "table", "bridge", table)
            require(not bridge_fence(), "bridge_fence_still_active")
            observed_boot, connector = probe(mac, 1, 30)
        else:
            require(not fenced and not bridge_fence(), "destination_network_still_fenced")
            require(mode != "retirement-witness" or not locked, "destination_not_released")
            pid = running_pid()
            bridge_connected()
            observed_boot, connector = probe(mac, 1, 8)
            if locked:
                require(check_config() == (False, nic, mac, True, unlocked) and running_pid() == pid
                        and not bridge_fence(), "destination_changed_before_unlock")
                check_disk()
                check_expiry()
                if clear_managed_link_cache(nic):
                    require(running_pid() == pid and check_config() == (False, nic, mac, True, unlocked),
                            "destination_changed_after_cloudinit_cache_clear")
                    observed_boot, connector = probe(mac, 1, 8)
                if not os.path.lexists(release_marker):
                    write_private_marker(release_marker, (json.dumps(unlocked, separators=(",", ":")) + "\n").encode("ascii"))
                check_expiry()
                output("qm", "unlock", vmid)
            require(not check_config()[3] and (not managed or not config.read_bytes().endswith(tracked_link(nic))),
                    "destination_lock_or_cloudinit_cache_still_held")
        require(check_config()[:3] == (not post_commit, nic, mac)
                and running_pid() == pid, "runtime_changed")
        check_disk()
        require(bridge_fence() == (not post_commit), "bridge_fence_changed")
        check_expiry()
        state = {"enable": "destination_network_enabled", "release": "destination_lock_released",
                 "retirement-witness": "destination_lock_released"}.get(
            mode, "destination_quarantined")
        proof = {"state": state, "profileSha256": profile_hash, "bootId": observed_boot}
        if connector:
            proof["connectorId"] = connector
        print("HIVRA_KVM_PORTABLE_BOOT_V1 " + json.dumps(proof))

try:
    run()
except RuntimeError as error:
    sys.exit("portable KVM boot: " + str(error))
except (AttributeError, KeyError, OSError, TypeError, UnicodeError, ValueError, subprocess.SubprocessError):
    sys.exit("portable KVM boot: host or I/O check failed")
`;

export function buildPortableKvmDestinationRetirementWitness(
  profile: PortableKvmDestinationBootProfile, expectedBoot: string, expectedConnector: string, deadline: number,
) {
  const command = [destinationHost, serializePortableKvmDestinationBootProfile(profile),
    serializePortableKvmDestinationReservation(profile.reservation), "retirement-witness", bootId.parse(expectedBoot),
    z.string().uuid().parse(expectedConnector), String(Math.floor(deadline / 1000)), guestProbe].map(shellQuote).join(" ");
  return `exec timeout -k 3 65 python3 -I -c ${command}\n`;
}

export function parsePortableKvmDestinationRetirementWitness(
  stdout: string, profile: PortableKvmDestinationBootProfile, expectedBoot: string, expectedConnector: string,
) {
  const lines = stdout.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return false;
  try {
    const parsed = receiptSchema.safeParse(JSON.parse(lines[0].slice(prefix.length)));
    return parsed.success && parsed.data.state === "destination_lock_released"
      && parsed.data.profileSha256 === createHash("sha256").update(serializePortableKvmDestinationBootProfile(profile)).digest("hex")
      && parsed.data.bootId === expectedBoot && parsed.data.connectorId === expectedConnector;
  } catch { return false; }
}

async function runDestinationStep(
  ownerId: string,
  profile: PortableKvmDestinationBootProfile,
  mode: "boot" | "verify" | "enable" | "release",
  expectedBoot: string,
  adapter: PortableKvmDestinationBootAdapter,
  readiness?: { expectedConnector: string; verifyConnector: PortableKvmDestinationReleaseAdapter["verifyConnector"] },
) {
  const serialized = serializePortableKvmDestinationBootProfile(profile);
  const reservation = profile.reservation;
  const reservationWire = serializePortableKvmDestinationReservation(reservation);
  if (!isCanonicalGitCanaryDeployment() || !ownerId) {
    throw new Error("Portable KVM destination is outside the enabled pilot");
  }
  const authoritative = await adapter.readAuthority({ ownerId, agentId: reservation.agentId });
  const lease = leaseSchema.safeParse(authoritative?.lease);
  if (!authoritative || !lease.success) throw new Error("No authoritative portable KVM lease");
  const { agent } = authoritative;
  if (profile.managed && portableKvmAllocationOperationId.safeParse(agent.allocation_operation_id).data
    !== portableKvmAllocationOperationId.parse(profile.managed.allocationOperationId)) {
    throw new Error("Portable KVM destination allocation authority changed");
  }
  const pilot = resolvePortableKvmPilotPlacement(ownerId, agent, authoritative.pilot);
  const phase = { boot: "restore_claimed", verify: "destination_verified",
    enable: "placement_committed", release: "connector_verified" }[mode];
  const postCommit = mode === "enable" || mode === "release";
  const expires = Date.parse(lease.data.expires_at);
  const current = postCommit ? lease.data.destination : lease.data.source;
  const alternate = postCommit ? lease.data.source : lease.data.destination;
  const samePlacement = (a: typeof current, b: typeof current) =>
    a.hostId === b.hostId && a.vmid === b.vmid && a.ip === b.ip && a.bindingTag === b.bindingTag;
  if (!pilot || !samePlacement(pilot.current, current) || !samePlacement(pilot.alternate, alternate)
    || agent.id !== reservation.agentId || !isPortableKvmWakeClaimed(agent) || agent.sleep_state !== "waking"
    || agent.status !== "running" || agent.desired_state !== "running"
    || agent.operation_id !== reservation.operationId || agent.sleep_generation !== reservation.generation
    || lease.data.owner_id !== ownerId || lease.data.agent_id !== reservation.agentId
    || lease.data.operation_id !== reservation.operationId || lease.data.generation !== reservation.generation
    || lease.data.checkpoint_sha256 !== reservation.checkpointSha256 || lease.data.phase !== phase
    || !samePlacement(lease.data.destination, { hostId: reservation.hostId, vmid: reservation.vmid,
      ip: profile.ip, bindingTag: reservation.bindingTag })
    || !(expires > Date.now() + timeoutMs)) throw new Error("Portable KVM destination authority does not match the active pilot lease");
  if (mode !== "boot") {
    const proof = lease.data.destination_evidence;
    if (!proof || proof.bootId !== expectedBoot || proof.reservationSha256 !== createHash("sha256").update(reservationWire).digest("hex")
      || proof.checkpointSha256 !== reservation.checkpointSha256 || !samePlacement(proof.destination, lease.data.destination)) {
      throw new Error("Portable KVM boot identity does not match the verified lease evidence");
    }
  }
  if (mode === "release") {
    const proof = lease.data.connector_evidence;
    if (!readiness || !proof || proof.bootId !== expectedBoot || proof.connectorId !== readiness.expectedConnector
      || !samePlacement(proof.destination, lease.data.destination)) {
      throw new Error("Portable KVM connector identity does not match the verified lease evidence");
    }
    if (!await readiness.verifyConnector({ agentId: reservation.agentId,
      tunnelId: bootId.parse(agent.cf_tunnel_id), connectorId: readiness.expectedConnector })) {
      throw new Error("Portable KVM connector is not the unique ready edge connector");
    }
  }

  const command = [destinationHost, serialized, reservationWire,
    mode, expectedBoot, readiness?.expectedConnector ?? "", String(Math.floor(expires / 1000)), guestProbe].map(shellQuote).join(" ");
  const result = await adapter.runHostScript({ hostId: lease.data.destination.hostId,
    script: `exec timeout -k 5 115 python3 -I -c ${command}\n`, timeoutMs });
  const lines = result.stdout.split("\n").filter(line => line.startsWith(prefix));
  if (!result.ok || lines.length !== 1) throw new Error("Portable KVM destination observation failed");
  let json: unknown;
  try {
    json = JSON.parse(lines[0].slice(prefix.length));
  } catch {
    throw new Error("Portable KVM destination receipt is malformed");
  }
  const parsed = receiptSchema.safeParse(json);
  if (!parsed.success) throw new Error("Portable KVM destination receipt is malformed");
  const receipt = parsed.data;
  const state = mode === "enable" ? "destination_network_enabled"
    : mode === "release" ? "destination_lock_released" : "destination_quarantined";
  if (receipt.state !== state || receipt.profileSha256 !== createHash("sha256").update(serialized).digest("hex")
    || (expectedBoot && receipt.bootId !== expectedBoot) || postCommit !== (receipt.connectorId !== undefined)
    || (readiness && receipt.connectorId !== readiness.expectedConnector)) {
    throw new Error("Portable KVM destination receipt mismatch");
  }
  return receipt;
}

/**
 * Boot only a verified restore on the active pilot lease. A failure after the
 * start attempt preserves quarantine and the backup lock; retry can only
 * re-observe a still-running VM under the same private start intent.
 */
export async function bootPortableKvmDestination(input: {
  ownerId: string;
  profile: PortableKvmDestinationBootProfile;
  diskReceipt: PortableKvmDestinationDiskReceipt;
}, adapter: PortableKvmDestinationBootAdapter): Promise<PortableKvmDestinationBootReceipt> {
  const { reservation } = input.profile;
  const disk = input.diskReceipt;
  if (disk.state !== "disk_restored_verified"
    || serializePortableKvmDestinationReservation(disk.reservation) !== serializePortableKvmDestinationReservation(reservation)
    || disk.readback.bytes !== reservation.disk.bytes || disk.readback.sha256 !== reservation.disk.sha256) {
    throw new Error("Portable KVM destination disk was not verified for this reservation");
  }
  const receipt = await runDestinationStep(input.ownerId, input.profile, "boot", "", adapter);
  return { state: "destination_quarantined", bootId: receipt.bootId, profileSha256: receipt.profileSha256 };
}

type BootInput = {
  ownerId: string;
  profile: PortableKvmDestinationBootProfile;
  bootReceipt: PortableKvmDestinationBootReceipt;
};

function validatedBootId(input: BootInput) {
  const receipt = receiptSchema.parse(input.bootReceipt);
  const profileHash = createHash("sha256").update(serializePortableKvmDestinationBootProfile(input.profile)).digest("hex");
  if (receipt.state !== "destination_quarantined" || receipt.profileSha256 !== profileHash || receipt.connectorId !== undefined) {
    throw new Error("Portable KVM quarantine receipt does not match this reservation");
  }
  return receipt.bootId;
}

export async function verifyPortableKvmQuarantinedDestination(
  input: BootInput, adapter: PortableKvmDestinationBootAdapter,
): Promise<PortableKvmDestinationBootReceipt> {
  const receipt = await runDestinationStep(input.ownerId, input.profile, "verify", validatedBootId(input), adapter);
  return { state: "destination_quarantined", bootId: receipt.bootId, profileSha256: receipt.profileSha256 };
}

export async function enablePortableKvmDestinationNetwork(
  input: BootInput, adapter: PortableKvmDestinationBootAdapter,
): Promise<PortableKvmDestinationNetworkReceipt> {
  const receipt = await runDestinationStep(input.ownerId, input.profile, "enable", validatedBootId(input), adapter);
  if (!receipt.connectorId) throw new Error("Portable KVM destination connector identity was not observed");
  return { state: "destination_network_enabled", bootId: receipt.bootId, profileSha256: receipt.profileSha256,
    connectorId: receipt.connectorId };
}

export async function releasePortableKvmDestinationLock(input: {
  ownerId: string;
  profile: PortableKvmDestinationBootProfile;
  networkReceipt: PortableKvmDestinationNetworkReceipt;
}, adapter: PortableKvmDestinationReleaseAdapter): Promise<PortableKvmDestinationLockReceipt> {
  const receipt = receiptSchema.parse(input.networkReceipt);
  const profileHash = createHash("sha256").update(serializePortableKvmDestinationBootProfile(input.profile)).digest("hex");
  if (receipt.state !== "destination_network_enabled" || receipt.profileSha256 !== profileHash || !receipt.connectorId) {
    throw new Error("Portable KVM network receipt does not match this reservation");
  }
  const released = await runDestinationStep(input.ownerId, input.profile, "release", receipt.bootId, adapter, {
    expectedConnector: receipt.connectorId, verifyConnector: adapter.verifyConnector,
  });
  return { state: "destination_lock_released", bootId: released.bootId, profileSha256: released.profileSha256,
    connectorId: receipt.connectorId };
}
