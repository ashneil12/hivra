#!/usr/bin/env python3
"""Durable, fail-closed staging fence; invoke only through the bound guest worker.

This is not dispatch authorization, runtime readiness, or permission to release
the database lease. Uncertain work and cross-boot results require reconciliation.
The single guest journal deliberately has no automatic reset/expiry path.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tempfile

ROOT = Path("/var/lib/hivra/attachment-staging")
STAGER_SHA256 = "77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
ID_FIELDS = {"operationId", "dispatchId", "installationId", "bindingId", "computerId", "sourceId"}
PINS = {
    "x86_64": ("e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278", "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba"),
    "aarch64": ("14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0", "2447e3fef519401ff6d6e90759ab1bf66082da48966fc6e4fe9a77108f9c20d8"),
}


def checked_identity(identity):
    if not isinstance(identity, dict) or set(identity) != ID_FIELDS | {"architecture"}:
        raise ValueError("invalid attachment identity shape")
    if any(not isinstance(identity[key], str) or not UUID.fullmatch(identity[key]) for key in ID_FIELDS):
        raise ValueError("invalid attachment identity")
    if identity["architecture"] not in PINS or identity["architecture"] != platform.machine():
        raise ValueError("attachment architecture mismatch")
    return identity


def secure_directory():
    current = Path("/")
    for part in ROOT.parts[1:]:
        current /= part
        mode = 0o700 if current == ROOT else 0o711
        try:
            current.mkdir(mode=mode)
            current.chmod(mode)  # Only newly created directories, never shared ones.
            parent = os.open(current.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        except FileExistsError:
            pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("unsafe journal directory")
        if current == ROOT and stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("journal directory must be private")


def checked_read(path, maximum, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o022 or info.st_size > maximum
                or (private and stat.S_IMODE(info.st_mode) != 0o600)):
            raise ValueError("unsafe staging input")
        value = source.read(maximum + 1)
        if len(value) > maximum:
            raise ValueError("oversized staging input")
        return value


def publish(record):
    fd, name = tempfile.mkstemp(prefix=".journal-", dir=ROOT)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(record, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, ROOT / "staging.json")
        directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)  # Only this invocation's unpublished temporary file.


def checked_receipt(receipt, identity):
    installation = identity["installationId"]
    archive, binary = PINS[identity["architecture"]]
    expected = {
        "version": 1, "state": "staged", "operationId": identity["operationId"],
        "installationId": installation, "runtimeId": "codex", "runtimeVersion": "0.149.1",
        "architecture": identity["architecture"], "archiveSha256": archive, "binarySha256": binary,
        "account": "hva_" + installation.replace("-", "")[:24],
        "home": "/var/lib/hivra/agent-homes/" + installation,
        "executable": "/opt/hivra/agent-installations/" + installation + "/codex",
    }
    if not isinstance(receipt, dict) or set(receipt) != set(expected) | {"uid", "gid"}:
        raise ValueError("invalid staging receipt shape")
    if any(type(receipt[key]) is not type(value) or receipt[key] != value for key, value in expected.items()):
        raise ValueError("staging receipt mismatch")
    if any(type(receipt[key]) is not int or not 0 < receipt[key] < 4294967295 for key in ("uid", "gid")):
        raise ValueError("invalid staging account")
    return receipt


def run(identity, stager_path, archive_path, expected_boot_id):
    if os.geteuid() != 0 or platform.system() != "Linux":
        raise ValueError("requires bound Linux guest root")
    checked_identity(identity)
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if not isinstance(expected_boot_id, str) or not UUID.fullmatch(expected_boot_id) or boot_id != expected_boot_id:
        raise ValueError("guest boot changed since dispatch observation")
    secure_directory()
    lock = os.open(ROOT / "installer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("unsafe staging lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            (ROOT / "staging.json").lstat()
        except FileNotFoundError:
            has_journal = False
        else:
            has_journal = True
        if has_journal:
            previous = json.loads(checked_read(ROOT / "staging.json", 16384, private=True))
            if (not isinstance(previous, dict) or set(previous) != {"version", "identity", "bootId", "phase", "receipt"}
                    or type(previous["version"]) is not int or previous["version"] != 1
                    or previous["identity"] != identity or previous["bootId"] != boot_id or previous["phase"] != "staged"):
                raise ValueError("existing attachment requires reconciliation; never redispatch")
            checked_receipt(previous["receipt"], identity)
            return previous
        # Execute exactly the reviewed bytes, not a pathname reopened by Python.
        source = checked_read(stager_path, 65536)
        if hashlib.sha256(source).hexdigest() != STAGER_SHA256:
            raise ValueError("unreviewed attachment installer")
        record = {"version": 1, "identity": identity, "bootId": boot_id, "phase": "started"}
        publish(record)  # Durable before spawn. Failures below intentionally retain it.
        with tempfile.TemporaryFile(dir=ROOT) as output:
            result = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", "-", "--operation-id", identity["operationId"],
                 "--installation-id", identity["installationId"], "--archive", str(archive_path)],
                input=source, stdout=output, stderr=subprocess.DEVNULL, timeout=300,
                pass_fds=(lock,), env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "HOME": "/root"})
            if result.returncode != 0 or output.tell() > 8192:
                raise ValueError("installer did not produce a bounded successful receipt")
            output.seek(0)
            receipt = checked_receipt(json.loads(output.read(8193)), identity)
        record.update(phase="staged", receipt=receipt)
        publish(record)
        return record
    finally:
        os.close(lock)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--stager", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--expected-boot-id", required=True)
    args = parser.parse_args()
    try:
        if len(args.identity) > 2048:
            raise ValueError("oversized identity")
        print(json.dumps(run(json.loads(args.identity), args.stager, args.archive, args.expected_boot_id), separators=(",", ":")))
    except Exception as error:
        raise SystemExit("Attachment worker refused (" + type(error).__name__ + "); preserve state for reconciliation.")
