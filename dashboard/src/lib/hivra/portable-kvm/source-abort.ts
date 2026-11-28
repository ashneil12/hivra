import { z } from "zod";
import { shellQuote } from "../proxmox-target";
import { backupUnitName } from "../computer-backups/scripts";
import { portableKvmPlacement } from "./pilot";
import { portableKvmSourceConfigurationPython } from "./source-configuration";
import { portableKvmAllocationOperationId } from "./destination-prepare";
import { portableKvmManagedResourcesSchema } from "./destination-disk";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const storageName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const scope = z.object({
  receiptId: z.string().uuid(),
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  source: portableKvmPlacement,
  allocationOperationId: portableKvmAllocationOperationId,
  resources: portableKvmManagedResourcesSchema,
  configuration: z.object({ raw: sha, current: sha, unlockedRaw: sha, unlockedCurrent: sha }).strict(),
  disk: z.object({ storage: storageName, vg: storageName, volume: storageName,
    uuid: z.string().regex(/^[A-Za-z0-9]{6}(?:-[A-Za-z0-9]{4}){5}-[A-Za-z0-9]{6}$/) }).strict(),
}).strict().superRefine((input, ctx) => {
  if (input.source.vmid === 9302 || !new RegExp(`^vm-${input.source.vmid}-disk-[0-9]{1,4}$`).test(input.disk.volume)) {
    ctx.addIssue({ code: "custom", message: "Invalid source disk identity" });
  }
});

export type PortableKvmSourceAbortInput = z.infer<typeof scope>;

const prefix = "HIVRA_KVM_PORTABLE_SOURCE_ABORT_V1 ";
const program = String.raw`
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import re
import tempfile
from contextlib import ExitStack
from pathlib import Path

${portableKvmSourceConfigurationPython}

def require(ok):
    if not ok:
        raise ValueError()

def run(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)

def safe_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and not info.st_mode & 0o022 and info.st_size < 8192)
        return file.read()

def directory(path, modes):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) in modes)

def lock(stack, path):
    fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def digest(data):
    return hashlib.sha256(data).hexdigest()

native = r"""
use strict;
use warnings;
my ($vmid, $sha) = @ARGV;
PVE::QemuConfig->lock_config($vmid, sub {
    my $path = PVE::QemuConfig->config_file($vmid);
    die "source changed" if Digest::SHA::sha256_hex(PVE::Tools::file_get_contents($path)) ne $sha;
    my $conf = PVE::QemuConfig->load_config($vmid);
    die "source not stopped and fenced" if ($conf->{lock} // '') ne 'backup' || PVE::QemuServer::check_running($vmid);
    delete $conf->{lock};
    PVE::QemuConfig->write_config($vmid, $conf);
});
"""

def main(mode, data, unit):
    source = data["source"]
    disk = data["disk"]
    vmid = str(source["vmid"])
    operation = data["operationId"]
    require(os.geteuid() == 0 and run("hostname", "-s").decode("ascii").strip() == source["hostId"])
    config = Path("/etc/pve/qemu-server", vmid + ".conf")
    locks = Path("/run/lock")
    root = Path("/var/lib/hivra-sleep")
    directory(root, (0o700, 0o755))
    fences = root / "portable-kvm-fences"
    if os.path.lexists(fences):
        directory(fences, (0o700,))
    fence = fences / vmid
    registry = root / "portable-kvm-cleanup"
    intent = registry / (operation + ".source")
    expected_fence = {k: data[k] for k in ("agentId", "operationId", "generation")}
    expected_fence.update({k: source[k] for k in ("vmid", "hostId", "bindingTag")})
    intended = {"mode": "abort", "scope": data}

    def read_source():
        require(config.is_file() and not config.is_symlink())
        raw = config.read_bytes()
        current = run("qm", "config", vmid, "--current", "1").rstrip(b"\n") + b"\n"
        fields = source_configuration(raw.decode(), current.decode(), vmid, source["bindingTag"],
            {k: data[k] for k in ("allocationOperationId", "resources")})
        require(run("qm", "status", vmid).strip() == b"status: stopped"
                and not any(os.path.lexists(Path("/run/qemu-server", vmid + suffix)) for suffix in (".pid", ".qmp"))
                and fields.get("onboot", "0") == "0" and not {"vmstate", "template"} & fields.keys())
        require(safe_file(root / ("cold-" + vmid)).strip() == source["bindingTag"].encode("ascii")
                and not os.path.lexists(root / ("stored-" + vmid)))
        expected = data["configuration"]
        locked = fields.get("lock") == "backup"
        require((locked or "lock" not in fields)
                and (digest(raw), digest(current)) == ((expected["raw"], expected["current"]) if locked
                    else (expected["unlockedRaw"], expected["unlockedCurrent"])))
        if locked:
            line = b"lock: backup\n"
            require(raw.splitlines(keepends=True).count(line) == current.splitlines(keepends=True).count(line) == 1
                    and digest(raw.replace(line, b"", 1)) == expected["unlockedRaw"]
                    and digest(current.replace(line, b"", 1)) == expected["unlockedCurrent"])
        require(fields.get("scsi0", "").split(",")[0] == disk["storage"] + ":" + disk["volume"])
        device = "/dev/" + disk["vg"] + "/" + disk["volume"]
        require(run("pvesm", "path", disk["storage"] + ":" + disk["volume"]).decode("ascii").strip() == device)
        found = json.loads(run("lvs", "--reportformat", "json", "-o", "vg_name,lv_name,lv_uuid,lv_attr", device))["report"]
        volumes = [row for report in found for row in report["lv"]]
        require(len(volumes) == 1 and volumes[0]["vg_name"] == disk["vg"] and volumes[0]["lv_name"] == disk["volume"]
                and volumes[0]["lv_uuid"] == disk["uuid"] and len(volumes[0]["lv_attr"]) >= 6
                and volumes[0]["lv_attr"][5] == "-")
        require(config.read_bytes() == raw)
        return locked

    with ExitStack() as held:
        lock(held, locks / ("hivra-portable-" + operation + ".dispatch.lock"))
        lock(held, locks / "hivra-computer-backup.lock")
        lock(held, locks / ("hivra-vm-" + vmid + ".backup.lock"))
        lock(held, locks / ("hivra-vm-" + vmid + ".lock"))
        unit_data = run("systemctl", "show", unit, "--property=LoadState,ActiveState,Job").decode("ascii").splitlines()
        state = dict(line.split("=", 1) for line in unit_data)
        require(len(unit_data) == len(state) == 3 and state.get("LoadState") in ("not-found", "loaded")
                and state.get("ActiveState") in ("inactive", "failed") and state.get("Job") in ("", "0"))
        locked = read_source()
        has_fence = os.path.lexists(fence)
        if has_fence:
            require(json.loads(safe_file(fence)) == expected_fence)
        require(not locked or has_fence)
        if mode == "check":
            if os.path.lexists(intent):
                directory(registry, (0o700,))
                require(json.loads(safe_file(intent)) == intended)
            return
        if mode == "cleanup":
            registry.mkdir(mode=0o700, exist_ok=True)
            directory(registry, (0o700,))
            if not os.path.lexists(intent):
                with tempfile.NamedTemporaryFile(dir=registry) as file:
                    file.write(json.dumps(intended, separators=(",", ":")).encode("ascii"))
                    file.flush()
                    os.fsync(file.fileno())
                    os.link(file.name, intent)
                sync_dir(registry)
            require(json.loads(safe_file(intent)) == intended)
            if locked:
                run("/usr/bin/perl", "-MPVE::QemuServer", "-MPVE::QemuConfig", "-MPVE::Tools", "-MDigest::SHA",
                    "-e", native, vmid, data["configuration"]["raw"])
            require(not read_source())
            if has_fence:
                require(json.loads(safe_file(fence)) == expected_fence)
                fence.unlink()
                sync_dir(fences)
        else:
            directory(registry, (0o700,))
        require(json.loads(safe_file(intent)) == intended and not os.path.lexists(fence) and not read_source())

os.umask(0o077)
try:
    mode, document, unit = sys.argv[1:]
    main(mode, json.loads(document), unit)
    print("HIVRA_KVM_PORTABLE_SOURCE_ABORT_V1 " + json.dumps({"mode": mode, "authority": json.loads(document)}, separators=(",", ":")))
except (ValueError, OSError, KeyError, RuntimeError, TypeError, subprocess.SubprocessError):
    print("portable_source_abort_refused", file=sys.stderr)
    sys.exit(1)
`;

export function buildPortableKvmSourceAbortScript(mode: "check" | "cleanup" | "verify", input: PortableKvmSourceAbortInput) {
  const authority = scope.parse(input);
  return `set -eu\ntimeout -k 3 100 python3 -I -c ${shellQuote(program)} ${shellQuote(mode)} ${shellQuote(JSON.stringify(authority))} ${shellQuote(backupUnitName(authority.operationId) + ".service")}\n`;
}

export function parsePortableKvmSourceAbortReceipt(stdout: string, input: PortableKvmSourceAbortInput, mode: "check" | "verify" = "verify") {
  const lines = stdout.split("\n").filter(line => line.startsWith(prefix));
  try {
    if (lines.length !== 1) return null;
    const expected = JSON.stringify(scope.parse(input));
    const result = z.object({ mode: z.enum(["check", "cleanup", "verify"]), authority: scope }).strict()
      .parse(JSON.parse(lines[0].slice(prefix.length)));
    return result.mode === mode && JSON.stringify(result.authority) === expected
      ? { source: input.source, sourceDiskUnchanged: true as const, sourceStopped: true as const, sourceLegacyColdMarkerRestored: mode === "verify" }
      : null;
  } catch { return null; }
}
