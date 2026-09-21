#!/usr/bin/env python3
"""Stage a private Codex CLI without modifying an existing desktop installation.

No network, package manager, service activation, login or model call. Run only
inside the exact guest under the attachment worker's durable execution fence.
Partial failure is retained for explicit reconciliation, never retried in place.
"""
import argparse
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile

VERSION = "0.149.1"
# Official openai/codex rust-v0.149.1 release asset digests, verified 2026-09-06.
ARTIFACTS = {
    "x86_64": ("codex-x86_64-unknown-linux-musl", "e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278", 99479490),
    "aarch64": ("codex-aarch64-unknown-linux-musl", "14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0", 91899352),
}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


def checked_id(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("invalid operation or installation identity")
    return value


def private_parent(path):
    """Create/inspect root-owned ancestors, never follow symlinks."""
    current = Path("/")
    for part in Path(path).parts[1:]:
        current /= part
        try:
            current.mkdir(mode=0o711)
            # Only newly owned directories: a restrictive worker umask must
            # not make the future dedicated account unable to traverse them.
            current.chmod(0o711)
        except FileExistsError:
            pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o001:
            raise ValueError("unsafe installation parent")
    return current


def open_artifact(path, architecture):
    """Validate a pinned artifact through one root-owned, non-symlink FD."""
    if architecture not in ARTIFACTS:
        raise ValueError("unsupported architecture")
    member, digest, size = ARTIFACTS[architecture]
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = os.fdopen(fd, "rb")
    try:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size != size:
            raise ValueError("unsafe or unexpected artifact")
        actual = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            actual.update(block)
        if actual.hexdigest() != digest:
            raise ValueError("artifact digest mismatch")
        stream.seek(0)
        archive = tarfile.open(fileobj=stream, mode="r:gz")
        entries = archive.getmembers()
        if len(entries) != 1 or entries[0].name != member or not entries[0].isreg() or not 0 < entries[0].size < 512 * 1024 * 1024:
            archive.close()
            raise ValueError("unexpected archive layout")
        return stream, archive, entries[0], digest
    except BaseException:
        stream.close()
        raise


def stage(operation_id, installation_id, archive_path):
    checked_id(operation_id)
    checked_id(installation_id)
    if os.geteuid() != 0 or platform.system() != "Linux":
        raise ValueError("requires the bound Linux guest root")
    architecture = platform.machine()
    account = "hva_" + installation_id.replace("-", "")[:24]
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(account)
        except KeyError:
            continue
        raise ValueError("installation account collision")
    useradd = shutil.which("useradd", path="/usr/sbin:/usr/bin:/sbin:/bin")
    runuser = shutil.which("runuser", path="/usr/sbin:/usr/bin:/sbin:/bin")
    if not useradd or not runuser:
        raise ValueError("guest account utilities unavailable")
    source, archive, member, digest = open_artifact(archive_path, architecture)
    try:
        install_parent = private_parent("/opt/hivra/agent-installations")
        home_parent = private_parent("/var/lib/hivra/agent-homes")
        install = install_parent / installation_id
        home = home_parent / installation_id
        if os.path.lexists(install) or os.path.lexists(home):
            raise ValueError("installation path collision; reconcile instead of retrying")
        install.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        subprocess.run([useradd, "--system", "--user-group", "--no-create-home",
                        "--home-dir", str(home), "--shell", "/usr/sbin/nologin", account],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
        user = pwd.getpwnam(account)
        if user.pw_dir != str(home) or user.pw_uid == 0 or user.pw_gid == 0:
            raise ValueError("unexpected installation account")
        os.chown(home, user.pw_uid, user.pw_gid)
        os.chmod(home, 0o700)
        os.chown(install, 0, user.pw_gid)
        os.chmod(install, 0o750)
        # Test actual account traversal/write access, including ancestor ACLs.
        # Permission bits alone do not prove the newly owned home is usable.
        probe = """import os,sys
os.chdir(sys.argv[1])
fd=os.open('.hivra-staging-write-check',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
 os.write(fd,b'private-home-check'); os.fsync(fd)
finally:
 os.close(fd); os.unlink('.hivra-staging-write-check')
"""
        subprocess.run([runuser, "-u", account, "--", sys.executable, "-I", "-B", "-c", probe, str(home)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
                       env={"PATH": "/usr/bin:/bin", "HOME": str(home), "LANG": "C"})
        executable = install / "codex"
        fd = os.open(executable, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
        binary_digest = hashlib.sha256()
        with os.fdopen(fd, "wb") as target, archive.extractfile(member) as binary:
            for block in iter(lambda: binary.read(1024 * 1024), b""):
                target.write(block)
                binary_digest.update(block)
            os.fchown(target.fileno(), 0, user.pw_gid)
            os.fchmod(target.fileno(), 0o550)
            target.flush()
            os.fsync(target.fileno())
        result = subprocess.run([runuser, "-u", account, "--", str(executable), "--version"],
                                check=True, capture_output=True, text=True, timeout=15,
                                env={"PATH": "/usr/bin:/bin", "HOME": str(home), "CODEX_HOME": str(home / ".codex"), "LANG": "C"})
        if result.stdout.strip() != "codex-cli " + VERSION:
            raise ValueError("installed version mismatch")
        receipt = {"version": 1, "state": "staged", "operationId": operation_id,
                   "installationId": installation_id, "runtimeId": "codex", "runtimeVersion": VERSION,
                   "architecture": architecture, "archiveSha256": digest, "binarySha256": binary_digest.hexdigest(),
                   "account": account, "uid": user.pw_uid, "gid": user.pw_gid,
                   "home": str(home), "executable": str(executable)}
        receipt_path = install / "installation.json"
        fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(receipt, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        directory = os.open(install, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return receipt
    finally:
        archive.close()
        source.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--installation-id", required=True)
    parser.add_argument("--archive", required=True)
    arguments = parser.parse_args()
    try:
        print(json.dumps(stage(arguments.operation_id, arguments.installation_id, arguments.archive), separators=(",", ":")))
    except Exception as error:
        # Do not dump command output or paths supplied by a caller. Existing
        # partial state must be inspected by the same operation, not overwritten.
        raise SystemExit("Attachment staging failed (" + type(error).__name__ + "); preserve state for reconciliation.")
