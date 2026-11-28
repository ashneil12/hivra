import { shellQuote } from "../proxmox-target";
import type { PortableKvmDestinationPrepareInput } from "./destination-prepare";
import { portableKvmPlacement, type PortableKvmPlacement } from "./pilot";

const inspect = String.raw`
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).decode().strip()

def effective_machine(fields):
    if "machine" in fields and fields["machine"] != "pc":
        return fields["machine"]
    command = shlex.split(output("qm", "showcmd", vmid))
    machine = command[command.index("-machine") + 1]
    match = re.search(r"(?:^|,)type=(pc(?:-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?)?)(\+pve[0-9]+)?(?:,|$)", machine)
    if not match:
        return None
    version, suffix = match.groups()
    if version == "pc":
        alias = re.search(r"^pc\s+.*\(alias of (pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?)\)\s*$",
                          output("qemu-system-x86_64", "-machine", "help"), re.M)
        if not alias:
            return None
        version = alias.group(1)
    return version + (suffix or "")

def managed_shape(fields, managed):
    if (fields.get("serial0") != "socket" or fields.get("vga") != "serial0" or fields.get("cpu") != "host"
        or float(fields.get("cpulimit", "nan")) != managed["cpuLimit"]):
        return False
    vol = fields.get("ide2", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(?:vm-" + vmid +
                        r"-cloudinit|" + vmid + r"/vm-" + vmid + r"-cloudinit\.qcow2),media=cdrom(?:,size=[0-9]+[KMGT]?)?", vol):
        return False
    cloud = managed["cloudInit"]
    if (fields.get("ciuser") != "ubuntu" or fields.get("citype", "nocloud") != "nocloud"
        or fields.get("ciupgrade", "0") != "0" or fields.get("nameserver") != " ".join(cloud["nameservers"])
        or fields.get("ipconfig0") != "ip=" + where["ip"] + "/24,gw=" + cloud["gateway"]):
        return False
    custom = fields.get("cicustom")
    return custom is None or re.fullmatch(
        r"(?:vendor=local:snippets/hivra-qga-" + vmid + r"-|meta=local:snippets/hivra-portable-meta-)"
        r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.yaml", custom) is not None

def check():
    if output("hostname", "-s") != where["hostId"] or output("qm", "status", vmid) != "status: stopped":
        return False
    conf = Path("/etc/pve/qemu-server", vmid + ".conf").read_text()
    root = Path("/var/lib/hivra-sleep")
    marker = root / ("cold-" + vmid)
    if (re.search(r"^\s*\[", conf, re.M) or os.path.lexists("/run/qemu-server/" + vmid + ".pid")
        or os.path.lexists(root / ("stored-" + vmid)) or marker.is_symlink()
        or marker.stat().st_uid != 0 or marker.read_text().strip() != where["bindingTag"]):
        return False
    fields = {}
    for line in output("qm", "config", vmid, "--current", "1").splitlines():
        key, sep, value = line.partition(": ")
        if not sep or key in fields:
            return False
        fields[key] = value
    required = {"boot": "order=scsi0", "cores": str(profile["cores"]),
                "memory": str(profile["memoryMb"]), "ostype": "l26",
                "scsihw": "virtio-scsi-single"}
    optional = {"agent", "arch", "bios", "cpu", "description", "machine", "meta", "name", "net0", "onboot", "scsi0", "sockets",
                "smbios1", "tags", "vmgenid"}
    managed = profile.get("managed")
    if managed:
        optional |= {"cpulimit", "cicustom", "citype", "ciupgrade", "ciuser", "ide2", "ipconfig0", "nameserver", "serial0", "sshkeys", "vga"}
    elif fields.get("cpu") != "x86-64-v2-AES":
        return False
    tags = fields.get("tags", "").split(";")
    if (set(fields) - required.keys() - optional or any(fields.get(key) != value for key, value in required.items())
        or [tag for tag in tags if tag.startswith("hivra-bind-")] != [where["bindingTag"]]
        or (managed and [tag for tag in tags if tag.startswith("hivra-op-")] !=
            ["hivra-op-" + managed["allocationOperationId"].replace("-", "")])
        or fields.get("arch", "x86_64") != "x86_64"
        or fields.get("bios", "seabios") != "seabios" or effective_machine(fields) != profile["machine"]
        or (managed and not managed_shape(fields, managed))
        or fields.get("sockets", "1") != "1" or fields.get("onboot", "0") != "0"
        or fields.get("agent") not in {"1", "enabled=1"}):
        return False
    net_parts = fields.get("net0", "").split(",")
    net = dict(pair.split("=", 1) for pair in net_parts)
    n = profile["network"]
    expected_net = {"virtio": n["macAddress"], "bridge": n["bridge"], "firewall": "1"}
    admitted_nics = [expected_net, {**expected_net, "link_down": "0"}]
    if managed:
        admitted_nics.append({key: value for key, value in expected_net.items() if key != "firewall"})
    if len(net) != len(net_parts) or net not in admitted_nics:
        return False
    volume, *options = fields["scsi0"].split(",")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}:vm-" + vmid + r"-disk-[0-9]{1,4}", volume):
        return False
    if not all(re.fullmatch(r"(?:discard=(?:on|ignore)|(?:ssd|iothread|backup|replicate)=[01]|size=[0-9]+[KMGT]?)", option)
               for option in options):
        return False
    opts = dict(option.split("=", 1) for option in options)
    return len(opts) == len(options) and {
        "discard": opts.get("discard") == "on", "ssd": opts.get("ssd") == "1", "ioThread": opts.get("iothread") == "1",
    } == profile["attachment"]

where, profile = json.loads(sys.argv[1])
vmid = str(where["vmid"])
try:
    if check():
        print("HIVRA_KVM_PORTABLE_SOURCE_PROFILE_V1 eligible")
except (KeyError, OSError, ValueError, subprocess.SubprocessError):
    pass
`;

export function buildPortableKvmSourceProfileCheck(placement: PortableKvmPlacement, profile: PortableKvmDestinationPrepareInput["profile"]) {
  return `exec timeout -k 5 35 python3 -I -c ${shellQuote(inspect)} ${shellQuote(JSON.stringify([
    portableKvmPlacement.parse(placement), profile,
  ]))}\n`;
}

export function isPortableKvmSourceProfileEligible(stdout: string): boolean {
  return stdout.trim() === "HIVRA_KVM_PORTABLE_SOURCE_PROFILE_V1 eligible";
}
