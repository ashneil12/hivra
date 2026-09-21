#!/usr/bin/env python3
"""Private host helper: send one pinned image over the existing attested SSH lane."""
import argparse
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys

ARCHIVE_SHA256 = "08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578"
ARCHIVE_BYTES = 4124832768


def open_archive(cache):
    if not cache.is_absolute() or ".." in cache.parts:
        raise RuntimeError("cache_path_invalid")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in cache.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                return None
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("cache_parent_unsafe")
        try:
            fd = os.open(ARCHIVE_SHA256 + ".tar", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        stream = os.fdopen(fd, "rb")
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            stream.close()
            raise RuntimeError("cache_archive_unsafe")
        return stream
    finally:
        os.close(directory)


def copy_image(cache, command):
    if not command or command[0] not in ("ssh", "/usr/bin/ssh"):
        raise RuntimeError("ssh_command_required")
    stream = open_archive(cache)
    if stream is None:
        return False
    with stream:
        signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        before = os.fstat(stream.fileno())
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
        if (before.st_size != ARCHIVE_BYTES or digest.hexdigest() != ARCHIVE_SHA256
                or signature(before) != signature(os.fstat(stream.fileno()))):
            raise RuntimeError("cache_archive_mismatch")
        stream.seek(0)
        # Do not reopen the pathname after hashing: a rename must never turn
        # this root read into disclosure of a different host file to the guest.
        result = subprocess.run(command, stdin=stream, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=600, check=False)
        if result.returncode != 0 or signature(before) != signature(os.fstat(stream.fileno())):
            raise RuntimeError("cache_transfer_failed")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        copy_image(args.cache, command)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        print("Prepared desktop image transfer failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
