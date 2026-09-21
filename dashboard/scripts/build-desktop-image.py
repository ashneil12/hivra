#!/usr/bin/env python3
"""Build an unapproved desktop image candidate on a Linux Docker builder.

Never installs desktop services, copies a running guest, pushes an image, or
changes the release-owned approval catalog. Output must not exist beforehand.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/remote-desktop/install-guest.py"
spec = importlib.util.spec_from_file_location("desktop_image_builder_guest", SOURCE)
guest = importlib.util.module_from_spec(spec)
# Bind the receipt to the bytes actually executed, even if the checkout changes
# during a long build. Never hash a later version of the source as provenance.
SOURCE_BYTES = SOURCE.read_bytes()
SOURCE_SHA256 = hashlib.sha256(SOURCE_BYTES).hexdigest()
exec(compile(SOURCE_BYTES, str(SOURCE), "exec"), guest.__dict__)


def file_sha256(stream) -> str:
    digest = hashlib.sha256()
    stream.seek(0)
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def check_directory(output: Path, directory: int) -> None:
    expected, actual = os.fstat(directory), output.lstat()
    if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino):
        raise RuntimeError("desktop_candidate_output_replaced")


def save_archive(image_id: str, stream) -> None:
    try:
        subprocess.run(["/usr/bin/docker", "image", "save", image_id],
                       stdout=stream, stderr=subprocess.DEVNULL, check=True, timeout=900)
    except (subprocess.SubprocessError, OSError) as error:
        raise RuntimeError("desktop_candidate_image_save_failed") from error


def archive_signature(directory: int, stream) -> tuple:
    opened = os.fstat(stream.fileno())
    named = os.stat("desktop-image.tar", dir_fd=directory, follow_symlinks=False)
    if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
        raise RuntimeError("desktop_candidate_archive_replaced")
    return (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)


def build_candidate(uid: int, gid: int, output: Path) -> dict[str, object]:
    uid, gid = guest.checked_desktop_identity(uid, gid)
    # Exclusive creation keeps failed attempts and unrelated operator files
    # intact. An incomplete attempt never gets an approval-shaped receipt.
    output.mkdir(mode=0o700)
    directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        check_directory(output, directory)
        guest.run(["/usr/bin/docker", "pull", guest.IMAGE], stage="desktop_candidate_base_pull")
        check_directory(output, directory)
        identity = guest.build_identity_image(uid, gid)
        check_directory(output, directory)
        flags = os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_RDWR
        archive_fd = os.open("desktop-image.tar", flags, 0o600, dir_fd=directory)
        with os.fdopen(archive_fd, "w+b") as archive:
            save_archive(str(identity["runtimeImageId"]), archive)
            check_directory(output, directory)
            size = os.fstat(archive.fileno()).st_size
            if size == 0:
                raise RuntimeError("desktop_candidate_archive_invalid")
            signature = archive_signature(directory, archive)
            receipt = {
                "schemaVersion": 1,
                "status": "candidate-not-approved",
                "identity": identity,
                "installerSourceSha256": SOURCE_SHA256,
                "archive": {"file": "desktop-image.tar", "sha256": file_sha256(archive), "bytes": size},
            }
            check_directory(output, directory)
            if archive_signature(directory, archive) != signature:
                raise RuntimeError("desktop_candidate_archive_changed")
            receipt_fd = os.open("candidate.json", flags, 0o600, dir_fd=directory)
            with os.fdopen(receipt_fd, "w", encoding="utf-8") as stream:
                json.dump(receipt, stream, indent=2, sort_keys=True)
                stream.write("\n")
            check_directory(output, directory)
            if archive_signature(directory, archive) != signature:
                raise RuntimeError("desktop_candidate_archive_changed")
            return receipt
    finally:
        os.close(directory)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new private output directory; never overwritten")
    args = parser.parse_args()
    try:
        result = build_candidate(args.uid, args.gid, args.output.absolute())
    except (RuntimeError, OSError, ValueError):
        print("Desktop image candidate preparation failed. No approval was written; any partial output is retained.", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
