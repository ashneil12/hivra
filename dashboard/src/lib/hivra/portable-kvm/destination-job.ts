import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import {
  buildPortableKvmDestinationDiskScript,
  parsePortableKvmDestinationDiskReceipt,
  serializePortableKvmDestinationReservation,
  type PortableKvmDestinationDiskReceipt,
  type PortableKvmDestinationReservation,
} from "./destination-disk";

const prefix = "HIVRA_KVM_PORTABLE_DESTINATION_JOB_V1 ";
const hostOptions = { timeoutMs: 25_000, maxOutputBytes: 8_192 };

export type PortableKvmDestinationJob =
  | { state: "running" | "missing" | "failed" | "unavailable" }
  | { state: "succeeded"; receipt: PortableKvmDestinationDiskReceipt };

const worker = String.raw`
import os
import subprocess
import sys
from pathlib import Path

os.umask(0o077)
job = Path(sys.argv[1])
pending = job / "receipt.pending"
try:
    with pending.open("xb") as output:
        restore = subprocess.run(["/bin/bash", str(job / "restore.sh")],
                                 stdout=output, stderr=subprocess.DEVNULL)
        if restore.returncode != 0:
            sys.exit(1)
        output.flush()
        os.fsync(output.fileno())
    pending.rename(job / "receipt")
    fd = os.open(job, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
finally:
    pending.unlink(missing_ok=True)
`;

const hostProgram = String.raw`
import errno
import fcntl
import hashlib
import json
import os
import re
import resource
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

root = Path("/var/lib/hivra-sleep")
jobs = root / "portable-kvm-destination-jobs"
registry = root / "portable-kvm-destinations"
expected = sys.argv[2].encode("ascii")
reservation = json.loads(expected)
operation = reservation["operationId"]
job = jobs / operation
unit = "hivra-portable-kvm-destination-" + operation

def require(condition):
    if not condition:
        raise ValueError()

def private_dir(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)

def private_read(path, size):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600)
        data = file.read(size + 1)
        require(len(data) <= size)
        return data

def write_file(path, data):
    with path.open("xb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def host_command(args, timeout, capture=False):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          timeout=timeout)

def result(state, **fields):
    print("HIVRA_KVM_PORTABLE_DESTINATION_JOB_V1 " + json.dumps({
        "operationId": operation, "reservationSha256": hashlib.sha256(expected).hexdigest(),
        "state": state, **fields,
    }))

def verify_scope():
    require(os.geteuid() == 0)
    host = host_command(["hostname", "-s"], 3, capture=True)
    require(host.returncode == 0 and host.stdout.strip() == reservation["hostId"].encode("ascii"))
    private_dir(root)
    private_dir(registry)
    require(private_read(registry / str(reservation["vmid"]), len(expected)) == expected)

def read_receipt():
    try:
        receipt = private_read(job / "receipt", 4096).decode("ascii")
    except FileNotFoundError:
        return False
    result("succeeded", receipt=receipt)
    return True

def poll():
    try:
        private_dir(job)
    except FileNotFoundError:
        result("missing")
        return
    require(private_read(job / "identity", len(expected)) == expected)
    with os.fdopen(os.open(job / "identity", os.O_RDONLY | os.O_NOFOLLOW), "rb") as claim:
        try:
            fcntl.flock(claim, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            result("running")
            return
        if read_receipt():
            return
        status = host_command(["systemctl", "show", "--no-pager", "-p", "LoadState", "-p", "ActiveState",
                               unit + ".service"], 5, capture=True)
        fields = dict(line.split(b"=", 1) for line in status.stdout.splitlines())
        if read_receipt():
            return
        active = fields.get(b"ActiveState")
        load = fields.get(b"LoadState")
        if status.returncode == 0 and load == b"loaded" and active in {b"active", b"activating", b"deactivating"}:
            result("running")
        elif (status.returncode == 0 and load == b"loaded" and active in {b"inactive", b"failed"}
              or load == b"not-found" and active == b"inactive"):
            result("failed")
        else:
            result("unavailable")

def launch(password):
    with tempfile.TemporaryDirectory(prefix=".dispatch-", dir=jobs) as temp:
        pending = Path(temp) / "job"
        pending.mkdir()
        write_file(pending / "identity", expected)
        write_file(pending / "restore.sh", sys.argv[3].encode("ascii"))
        os.mkfifo(pending / "input", 0o600)
        with (pending / "identity").open("rb") as claim:
            fcntl.flock(claim, fcntl.LOCK_EX)
            sync_dir(pending)
            try:
                os.rename(pending, job)
            except OSError as error:
                if error.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                    raise
                poll()
                return
            sync_dir(jobs)

            fifo = job / "input"
            try:
                started = host_command(["systemd-run", "--quiet", "--collect", "--no-block", "--service-type=exec",
                   "--unit", unit, "--description=Hivra portable KVM destination restore",
                   "-p", "Nice=10", "-p", "IOSchedulingClass=idle", "-p", "RuntimeMaxSec=3615s",
                   "-p", "TimeoutStartSec=15s", "-p", "TimeoutStopSec=10s", "-p", "Restart=no",
                   "-p", "KillMode=control-group", "-p", "LimitCORE=0", "-p", "StandardOutput=null", "-p", "StandardError=null",
                   "-p", "StandardInput=file:" + str(fifo), "/usr/bin/python3", "-I", "-c", sys.argv[4], str(job)], 5)
                if started.returncode != 0:
                    result("unavailable")
                    return
                deadline = time.monotonic() + 6
                while True:
                    try:
                        fd = os.open(fifo, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        break
                    except OSError as error:
                        if error.errno != errno.ENXIO or time.monotonic() >= deadline:
                            raise
                        time.sleep(0.05)
                try:
                    require(os.write(fd, password) == len(password))
                finally:
                    os.close(fd)
                result("running")
            finally:
                fifo.unlink(missing_ok=True)

try:
    os.umask(0o077)
    verify_scope()
    dispatch = sys.argv[1] == "dispatch"
    if dispatch:
        jobs.mkdir(exist_ok=True)
        sync_dir(root)
    try:
        private_dir(jobs)
    except FileNotFoundError:
        result("missing")
    else:
        if dispatch and not os.path.lexists(job):
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            password = sys.stdin.buffer.readline(66)
            require(re.fullmatch(rb"[a-f0-9]{64}\n", password))
            launch(password)
        else:
            poll()
except (OSError, ValueError, subprocess.SubprocessError):
    result("unavailable")
`;

function buildJobScript(reservation: PortableKvmDestinationReservation, action: "dispatch" | "poll"): string {
  const args = [hostProgram, action, serializePortableKvmDestinationReservation(reservation)];
  if (action === "dispatch") args.push(buildPortableKvmDestinationDiskScript(reservation), worker);
  return `exec timeout -k 2 20 python3 -I -c ${args.map(shellQuote).join(" ")}\n`;
}

const envelope = z.object({
  state: z.enum(["missing", "running", "failed", "unavailable", "succeeded"]),
  operationId: z.string(),
  reservationSha256: z.string(),
  receipt: z.string().max(4096).optional(),
}).strict();

function parseJob(stdout: string, reservation: PortableKvmDestinationReservation): PortableKvmDestinationJob {
  const lines = stdout.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return { state: "unavailable" };
  try {
    const parsed = envelope.safeParse(JSON.parse(lines[0].slice(prefix.length)));
    if (!parsed.success) return { state: "unavailable" };
    const { operationId, reservationSha256, state, receipt } = parsed.data;
    const expected = serializePortableKvmDestinationReservation(reservation);
    if (operationId !== reservation.operationId
      || reservationSha256 !== createHash("sha256").update(expected).digest("hex")) return { state: "unavailable" };
    if (state === "succeeded") {
      const verified = receipt && parsePortableKvmDestinationDiskReceipt(receipt, reservation);
      return verified ? { state, receipt: verified } : { state: "unavailable" };
    }
    return receipt === undefined ? { state } : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

export async function pollPortableKvmDestinationJob(
  reservation: PortableKvmDestinationReservation, env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<PortableKvmDestinationJob> {
  const script = buildJobScript(reservation, "poll");
  const result = await runProxmoxHostScript(script, env, hostOptions).catch(() => null);
  return result?.ok ? parseJob(result.stdout, reservation) : { state: "unavailable" };
}

/** Uses a private FIFO to hand off the key to the detached worker without writing it to disk. */
export async function dispatchPortableKvmDestinationJob(
  reservation: PortableKvmDestinationReservation, password: string, env: Parameters<typeof runProxmoxHostScriptWithStdin>[2],
): Promise<PortableKvmDestinationJob> {
  if (password.length !== 64 || !/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid portable KVM repository password");
  const script = buildJobScript(reservation, "dispatch");
  const result = await runProxmoxHostScriptWithStdin(script, password + "\n", env, hostOptions).catch(() => null);
  return result?.ok ? parseJob(result.stdout, reservation) : { state: "unavailable" };
}
