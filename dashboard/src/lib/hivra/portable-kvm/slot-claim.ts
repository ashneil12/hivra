import { allocationLockAuditPython } from "@/lib/hivra/allocation-lock-audit";
import { isIPv4 } from "node:net";
import { z } from "zod";

import { shellQuote } from "../proxmox-target";

const placementSchema = z.object({
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999_999_999).refine(vmid => vmid !== 9302),
  ip: z.string().refine(ip => isIPv4(ip) && /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip)),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
}).strict();

export const portableKvmSlotPython = String.raw`
def slot_fields(vmid, ip, tag):
    return {"name": "hivra-slot-" + vmid, "tags": "hivra-slot-" + tag.removeprefix("hivra-bind-"),
            "onboot": "0", "lock": "backup", "ipconfig0": "ip=" + ip + "/24"}

def slot_digest(cfg, vmid, ip, tag):
    require(not cfg.is_symlink() and cfg.is_file(), "destination_slot_missing")
    raw = cfg.read_bytes()
    current = output("qm", "config", vmid, "--current", "1")
    observed = fields(raw)
    effective = fields(current)
    require(not observed.pop("boot", "").strip() and not effective.pop("boot", "").strip(), "destination_slot_not_diskless")
    require(observed == effective, "destination_slot_configuration_drift")
    require(output("qm", "status", vmid).strip() == b"status: stopped"
            and not os.path.lexists(Path("/run/qemu-server", vmid + ".pid")), "destination_slot_not_stopped")
    for key, value in slot_fields(vmid, ip, tag).items():
        require(observed.pop(key, None) == value, "destination_slot_binding_mismatch")
    require(set(observed) <= {"meta", "smbios1", "vmgenid"}
            and ("smbios1" not in observed or re.fullmatch(r"uuid=[a-f0-9-]{36}", observed["smbios1"]))
            and ("vmgenid" not in observed or re.fullmatch(r"[a-f0-9-]{36}", observed["vmgenid"])),
            "destination_slot_not_diskless")
    return hashlib.sha1(raw).hexdigest()
`;

const operator = String.raw`
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path

def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)

def fields(raw):
    result = {}
    for line in raw.decode("ascii").splitlines():
        if not line:
            continue
        key, sep, value = line.partition(": ")
        require(sep and key not in result, "invalid_slot_config")
        result[key] = value
    return result

${portableKvmSlotPython}

${allocationLockAuditPython}
def take(stack, path):
    fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "unsafe_allocation_lock")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

def run(action, slot):
    require(os.geteuid() == 0 and output("hostname", "-s").strip() == slot["hostId"].encode("ascii"), "wrong_slot_host")
    vmid, ip, tag = str(slot["vmid"]), slot["ip"], slot["bindingTag"]
    qemu = Path("/etc/pve/qemu-server")
    cfg = qemu / (vmid + ".conf")
    locks = Path("/run/lock")
    with ExitStack() as stack:
        take(stack, locks / "hivra-allocation.lock")
        allocation_lock_acquired("portable-slot-claim")
        vmids = locks / "hivra-vmids"
        vmids.mkdir(mode=0o755, exist_ok=True)
        info = vmids.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, "unsafe_vmid_locks")
        take(stack, vmids / (vmid + ".lock"))
        legacy = locks / "hermes-proxmox-provision.lock.d"
        legacy.mkdir(mode=0o755)
        stack.callback(legacy.rmdir)
        pid = legacy / "pid"
        stack.callback(pid.unlink, missing_ok=True)
        pid.write_text(str(os.getpid()) + "\n")
        volumes = output("lvs", "--noheadings", "-o", "lv_name").decode("ascii").split()
        require(not any(re.match(r"(?:snap_)?(?:vm|base)-" + vmid + "-", name) for name in volumes),
                "slot_already_has_volumes")
        require(not os.path.lexists(Path("/run/qemu-server", vmid + ".pid")), "slot_guest_process_present")
        ha = json.loads(output("pvesh", "get", "/cluster/ha/resources", "--output-format", "json"))
        require(isinstance(ha, list) and all(item["sid"] not in {"vm:" + vmid, "ct:" + vmid, "lxc:" + vmid}
                                           for item in ha), "slot_is_ha_managed")
        if action == "reserve":
            if not os.path.lexists(cfg):
                require(output("pvesh", "get", "/cluster/nextid", "--vmid", vmid).strip() == vmid.encode("ascii"), "slot_vmid_in_use")
                pattern = rb"^ipconfig[0-9]+:.*[ ,]ip=" + re.escape(ip.encode("ascii")) + rb"(?:[/,\s]|$)"
                require(not any(re.search(pattern, other.read_bytes(), re.M) for other in qemu.glob("*.conf")),
                        "slot_ip_in_use")
                for intent in Path("/var/lib/hivra/provision-operations").glob("operation-*.selected"):
                    claimed = intent.read_bytes().splitlines()
                    require(b"vmid=" + vmid.encode("ascii") not in claimed and b"ip=" + ip.encode("ascii") not in claimed,
                            "slot_provision_pending")
                for ledger in Path("/var/lib/hivra/vmid-references").glob("*.list"):
                    require(vmid.encode("ascii") not in ledger.read_bytes().splitlines(), "slot_vmid_referenced")
                args = [v for key, value in slot_fields(vmid, ip, tag).items() for v in ("--" + key, value)]
                output("qm", "create", vmid, "--start", "0", *args)
            slot_digest(cfg, vmid, ip, tag)
        elif action == "release":
            digest = slot_digest(cfg, vmid, ip, tag)
            remove = r"""
my ($vmid, $sha) = @ARGV;
PVE::QemuConfig->lock_config($vmid, sub {
    my $path = PVE::QemuConfig->config_file($vmid);
    die "slot changed" if Digest::SHA::sha1_hex(PVE::Tools::file_get_contents($path)) ne $sha
        || PVE::QemuServer::check_running($vmid);
    PVE::QemuConfig->destroy_config($vmid);
});
"""
            output("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Tools", "-MDigest::SHA",
                   "-e", remove, vmid, digest)
            require(not os.path.lexists(cfg), "slot_release_incomplete")
        else:
            slot_digest(cfg, vmid, ip, tag)
    print("HIVRA_PORTABLE_SLOT_V1 " + action)

try:
    run(sys.argv[1], json.loads(sys.argv[2]))
except RuntimeError as error:
    sys.exit("portable KVM slot: " + str(error))
except (KeyError, OSError, TypeError, ValueError, subprocess.SubprocessError):
    sys.exit("portable KVM slot: host admission or readback failed")
`;

export function buildPortableKvmSlotClaimScript(
  action: "reserve" | "verify" | "release",
  placement: z.input<typeof placementSchema>,
): string {
  return "exec timeout -k 5 85 python3 -I -c " + shellQuote(operator) + " "
    + shellQuote(z.enum(["reserve", "verify", "release"]).parse(action)) + " "
    + shellQuote(JSON.stringify(placementSchema.parse(placement))) + "\n";
}
