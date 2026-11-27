#!/usr/bin/env python3
"""Verified whole-disk and exact-base checkpoint lanes for a disposable QA VM."""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

SHA = re.compile(r"[a-f0-9]{64}")
GENERATION = re.compile(r"[a-f0-9]{32}")
SNAPSHOT = re.compile(r"[a-f0-9]{64}")
FILES = {"whole": "whole.qcow2", "delta": "delta.qcow2"}
MAX_DISK = 16 * 1024 ** 3
CHUNK = 1024 * 1024
QEMU = "/usr/bin/qemu-img"
RESTIC = "/usr/bin/restic"


def private_directory(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("QA directory must be absolute and canonical")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("QA directory must be operator-owned and private")
    return path


def regular(path, maximum=MAX_DISK):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o022 or not 0 < info.st_size <= maximum):
        raise ValueError("Unexpected QA artifact")
    return info.st_size


def digest_file(path):
    regular(path)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def qemu(*args, capture=False):
    result = subprocess.run([QEMU, *map(str, args)], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, check=True, timeout=120)
    return result.stdout


def image_info(path, base=None):
    regular(path)
    metadata = json.loads(qemu("info", "-f", "qcow2", "--output=json", path, capture=True))
    details = metadata["format-specific"]["data"]
    if (metadata["format"] != "qcow2" or metadata.get("dirty-flag") is not False
            or not 0 < metadata["virtual-size"] <= MAX_DISK or details.get("corrupt")
            or details.get("data-file") or details.get("encrypt") or metadata.get("snapshots")):
        raise ValueError("Unsupported QA image format or state")
    backing = metadata.get("backing-filename")
    if base is None and backing is not None:
        raise ValueError("Whole image or base unexpectedly has a parent")
    if base is not None and (backing not in {str(base), base.name}
                             or metadata.get("full-backing-filename") != str(base)
                             or metadata.get("backing-filename-format") != "qcow2"):
        raise ValueError("Delta image is not pinned to the verified base")
    return metadata["virtual-size"]


def validate_manifest(value, generation):
    if not isinstance(value, dict) or set(value) != {"version", "generation", "base_sha256", "virtual_bytes", "artifacts"}:
        raise ValueError("Invalid checkpoint manifest")
    if (value["version"] != 1 or value["generation"] != generation
            or not SHA.fullmatch(str(value["base_sha256"])) or type(value["virtual_bytes"]) is not int
            or not 0 < value["virtual_bytes"] <= MAX_DISK):
        raise ValueError("Unexpected checkpoint identity")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, dict) or set(artifacts) != set(FILES):
        raise ValueError("Incomplete checkpoint")
    for lane, artifact in artifacts.items():
        if (not isinstance(artifact, dict) or set(artifact) != {"name", "bytes", "sha256"}
                or artifact["name"] != FILES[lane] or type(artifact["bytes"]) is not int
                or not 0 < artifact["bytes"] <= MAX_DISK or not SHA.fullmatch(str(artifact["sha256"]))):
            raise ValueError("Invalid checkpoint artifact")
    return value


def fence_receipt(path, generation):
    regular(path, 4096)
    payload = path.read_bytes()
    lines = payload.decode("ascii").splitlines()
    if len(lines) != 7 or lines[0] != "hivra-kvm-fence-v1" or not lines[1].startswith(generation + " "):
        raise ValueError("The source fence receipt does not match this run")
    deadline = datetime.strptime(lines[2], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    if deadline <= datetime.now(UTC) or not all(SHA.fullmatch(value) for value in lines[3:6]):
        raise ValueError("Fence proof is expired or invalid")
    return lines[3], lines[4], hashlib.sha256(payload).hexdigest()


def pack(source, stage, base, generation):
    base_sha, source_sha, _ = fence_receipt(source.parent / "fence.receipt", generation.id)
    if digest_file(source) != source_sha:
        raise ValueError("The fenced source image changed")
    if digest_file(base) != base_sha or base_sha != generation.base_sha256:
        raise ValueError("Unexpected local base digest")
    image_info(base)
    virtual_bytes = image_info(source, base)
    whole, delta = (stage / FILES[lane] for lane in ("whole", "delta"))
    if any(path.exists() for path in (whole, delta, stage / "manifest.json")):
        raise ValueError("Checkpoint stage is not fresh")
    qemu("convert", "-f", "qcow2", "-O", "qcow2", "-S", "64k", source, whole)
    qemu("compare", "-q", "-f", "qcow2", "-F", "qcow2", source, whole)
    with delta.open("xb") as output, source.open("rb") as original:
        shutil.copyfileobj(original, output, CHUNK)
        output.flush()
        os.fsync(output.fileno())
    value = {"version": 1, "generation": generation.id, "base_sha256": generation.base_sha256,
             "virtual_bytes": virtual_bytes, "artifacts": {
                 lane: {"name": name, "bytes": regular(stage / name), "sha256": digest_file(stage / name)}
                 for lane, name in FILES.items()}}
    with (stage / "manifest.json").open("x", encoding="ascii") as out:
        json.dump(value, out, sort_keys=True)
    return value


def checked_restic(generation):
    repo = os.environ.get("RESTIC_REPOSITORY")
    if repo != f"sftp:cold:hivr43-kvm-qa-{generation}":
        raise ValueError("Restic repository is outside the exact QA namespace")
    password = os.environ.get("RESTIC_PASSWORD_FILE")
    if not password:
        raise ValueError("Restic password must be supplied using a local file")
    info = Path(password).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Invalid Restic password file permissions")
    return [RESTIC, "--no-cache", "-o", "sftp.command=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes cold -s sftp"]


def checkpoint_folder(generation):
    return Path(f"/var/tmp/hivra-kvm-portable-{generation}") / "checkpoint"


def publish(stage, generation):
    if {path.name for path in stage.iterdir()} != {"manifest.json", *FILES.values()}:
        raise ValueError("Checkpoint directory contains unexpected files")
    regular(stage / "manifest.json", 4096)
    manifest = validate_manifest(json.loads((stage / "manifest.json").read_bytes()), generation)
    for artifact in manifest["artifacts"].values():
        image = stage / artifact["name"]
        if (regular(image), digest_file(image)) != (artifact["bytes"], artifact["sha256"]):
            raise ValueError("Checkpoint stage changed before publication")
    restic = checked_restic(generation)
    existing = subprocess.run([*restic, "snapshots", "--json"], check=True, timeout=20, capture_output=True)
    snapshots = json.loads(existing.stdout)
    if not snapshots:
        subprocess.run([*restic, "backup", "--quiet", "--tag", generation, str(stage)],
                       check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        listing = subprocess.run([*restic, "snapshots", "--json"], check=True, timeout=20, capture_output=True)
        snapshots = json.loads(listing.stdout)
    if (len(snapshots) != 1 or snapshots[0]["tags"] != [generation]
            or not SNAPSHOT.fullmatch(snapshots[0]["id"]) or snapshots[0]["paths"] != [str(stage)]):
        raise ValueError("Checkpoint repository contains an unexpected generation")
    snapshot = snapshots[0]["id"]
    readback = BytesIO()
    fetch(restic, snapshot, str(stage / "manifest.json"), readback, 4096)
    if validate_manifest(json.loads(readback.getvalue()), generation) != manifest:
        raise ValueError("Published checkpoint manifest did not match")
    for artifact in manifest["artifacts"].values():
        with open(os.devnull, "wb") as discard:
            size, digest, _ = fetch(restic, snapshot, str(stage / artifact["name"]), discard, artifact["bytes"])
        if (size, digest) != (artifact["bytes"], artifact["sha256"]):
            raise ValueError("Published checkpoint bytes did not match")
    return {"mode": "publish", "snapshot": snapshot}


def fetch(restic, snapshot, artifact, output, max_bytes):
    started = time.monotonic()
    h = hashlib.sha256()
    size = 0
    command = ["/usr/bin/timeout", "-k", "3", "120", *restic, "dump", "--quiet", snapshot, artifact]
    with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as read:
        try:
            while chunk := read.stdout.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("Remote checkpoint exceeds its recorded size")
                output.write(chunk)
                h.update(chunk)
            if read.wait(timeout=3) != 0:
                raise ValueError("Authenticated storage read failed")
        except BaseException:
            read.kill()
            raise
    return size, h.hexdigest(), round(1000 * (time.monotonic() - started))


def restore(target, base, generation, snapshot, lane):
    restic = checked_restic(generation)
    stage = checkpoint_folder(generation)
    manifest_bytes = BytesIO()
    fetch(restic, snapshot, str(stage / "manifest.json"), manifest_bytes, 4096)
    manifest = validate_manifest(json.loads(manifest_bytes.getvalue()), generation)
    artifact = manifest["artifacts"][lane]
    base_sha, source_sha, fence_sha = fence_receipt(target / "fence.receipt", generation)
    if base_sha != manifest["base_sha256"] or (lane == "delta" and source_sha != artifact["sha256"]):
        raise ValueError("Stored generation and fenced source did not match")
    if lane == "delta" and (digest_file(base) != base_sha or not image_info(base)):
        raise ValueError("The destination did not have the exact standalone base")
    final = target / "guest.qcow2"
    fd, temporary = tempfile.mkstemp(dir=target, prefix=".restore-", suffix=".qcow2")
    image = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as out:
            size, digest, transfer_ms = fetch(restic, snapshot, str(stage / artifact["name"]), out, artifact["bytes"])
            if (size, digest) != (artifact["bytes"], artifact["sha256"]):
                raise ValueError("Checkpoint bytes did not match the manifest")
            out.flush()
            os.fsync(out.fileno())
        if image_info(image, base if lane == "delta" else None) != manifest["virtual_bytes"]:
            raise ValueError("Restored image size did not match")
        os.link(image, final)
        with (target / "verified-wake.receipt").open("x", encoding="ascii") as receipt:
            receipt.write(f"hivra-kvm-verified-wake-v1\n{fence_sha}\n{lane}\n{digest}\n")
            receipt.flush()
            os.fsync(receipt.fileno())
        directory_fd = os.open(target, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        image.unlink()
    return {"lane": lane, "checkpoint_bytes": size, "read_verify_ms": transfer_ms}


def main(argv):
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("pack", "publish", "restore"))
    parser.add_argument("--generation", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--base-sha256")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--snapshot")
    parser.add_argument("--lane", choices=tuple(FILES))
    args = parser.parse_args(argv)
    if not GENERATION.fullmatch(args.generation):
        parser.error("invalid generation")
    root = private_directory(args.directory)
    if args.mode != "publish" and (args.base is None or not args.base.is_absolute() or args.base.resolve() != args.base):
        parser.error("invalid local base path")
    started = time.monotonic()
    if args.mode == "pack":
        if (root != checkpoint_folder(args.generation) or args.source != root.parent / "guest.qcow2"
                or args.base != root.parent / "base.img"):
            parser.error("pack requires a canonical fenced source")
        if not SHA.fullmatch(args.base_sha256 or "") or args.snapshot or args.lane:
            parser.error("pack requires an exact base digest")
        generation = argparse.Namespace(id=args.generation, base_sha256=args.base_sha256)
        receipt = pack(args.source, root, args.base, generation)
        result = {"mode": "pack", "artifact_bytes": {lane: value["bytes"] for lane, value in receipt["artifacts"].items()}}
    elif args.mode == "publish":
        if root != checkpoint_folder(args.generation) or args.source or args.snapshot or args.lane or args.base_sha256 or args.base:
            parser.error("publish requires only the exact isolated checkpoint directory")
        result = publish(root, args.generation)
    else:
        if (root != checkpoint_folder(args.generation).parent or args.base != root / "base.img"
                or not SNAPSHOT.fullmatch(args.snapshot or "") or not args.lane or args.source or args.base_sha256):
            parser.error("restore requires a pinned snapshot and lane")
        result = {"mode": "restore", **restore(root, args.base, args.generation, args.snapshot, args.lane)}
    print(json.dumps({**result, "total_ms": round((time.monotonic() - started) * 1000)}, sort_keys=True))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"KVM QA operation failed ({type(error).__name__}): no boot authorization", file=sys.stderr)
        raise SystemExit(1) from None
