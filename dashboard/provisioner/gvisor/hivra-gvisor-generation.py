"""Host-only codec and immutable SFTP transport for quiesced gVisor workspaces.

The caller owns the workspace lock, fencing, scoped key, host-key-verified
SFTP connection, quota allocation, and authoritative generation pointer.
"""

import gzip
import hashlib
import hmac
import json
import os
import posixpath
import re
import shutil
import stat
import struct
import tempfile
import time
import uuid
from contextlib import contextmanager, nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"HIVRAWG1"
NONCE_BYTES = 12
TAG_BYTES = 16
OVERHEAD = len(MAGIC) + NONCE_BYTES + TAG_BYTES
CHUNK = 1024 * 1024
MAX_HEADER = 32768
MAX_DEPTH = 64
MAX_PATH_BYTES = 64 * 1024 * 1024
GCM_MAX_BYTES = (1 << 36) - 32
SHA256 = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,128}")
PINNED_IMAGE = re.compile(r"[!-~]{1,256}@sha256:[0-9a-f]{64}")
RUNTIME = re.compile(r"[!-~]{1,256}")


class GenerationError(ValueError):
    pass


def bounded_int(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")


@dataclass(frozen=True)
class GenerationIdentity:
    owner_hash: str
    computer_id: str
    sandbox_id: str
    generation: str
    image: str
    runtime: str

    def __post_init__(self):
        if not (matches(SHA256, self.owner_hash) and matches(UUID, self.computer_id)
                and matches(UUID, self.sandbox_id) and matches(TOKEN, self.generation)
                and matches(PINNED_IMAGE, self.image) and matches(RUNTIME, self.runtime)):
            raise GenerationError("Invalid workspace generation identity")

    def object_name(self):
        scope = [self.owner_hash, self.computer_id, self.sandbox_id, self.generation]
        return hashlib.sha256(json_bytes(scope)).hexdigest() + ".hivra"


@dataclass(frozen=True)
class GenerationLimits:
    max_bytes: int
    max_entries: int
    max_ciphertext_bytes: int

    def __post_init__(self):
        if not (bounded_int(self.max_bytes, 0, GCM_MAX_BYTES)
                and bounded_int(self.max_entries, 1, 1_000_000)
                and bounded_int(self.max_ciphertext_bytes, OVERHEAD + 1, GCM_MAX_BYTES + OVERHEAD)):
            raise GenerationError("Invalid workspace generation limits")


@dataclass(frozen=True)
class GenerationReceipt:
    sha256: str
    ciphertext_bytes: int
    entries: int
    bytes: int

    def __post_init__(self):
        if not (matches(SHA256, self.sha256)
                and bounded_int(self.ciphertext_bytes, OVERHEAD + 1, GCM_MAX_BYTES + OVERHEAD)
                and bounded_int(self.entries, 1, 1_000_000)
                and bounded_int(self.bytes, 0, GCM_MAX_BYTES)):
            raise GenerationError("Invalid workspace generation receipt")

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict) or set(value) != {"sha256", "ciphertext_bytes", "entries", "bytes"}:
            raise GenerationError("Invalid workspace generation receipt")
        return cls(**value)


def read_exact(stream, size):
    result = stream.read(size)
    if len(result) != size:
        raise GenerationError("Truncated workspace generation")
    return result


def write_record(stream, record):
    data = json_bytes(record)
    if len(data) > MAX_HEADER:
        raise GenerationError("Workspace entry metadata exceeds the limit")
    stream.write(struct.pack(">I", len(data)))
    stream.write(data)


def read_record(stream):
    size, = struct.unpack(">I", read_exact(stream, 4))
    if not 0 < size <= MAX_HEADER:
        raise GenerationError("Invalid workspace entry metadata length")
    raw = read_exact(stream, size)
    try:
        record = json.loads(raw)
        if not isinstance(record, dict) or json_bytes(record) != raw:
            raise ValueError
        return record
    except (ValueError, RecursionError) as exc:
        raise GenerationError("Invalid workspace entry metadata") from exc


def path_parts(path):
    if not isinstance(path, str):
        raise GenerationError("Invalid workspace entry path")
    try:
        encoded = os.fsencode(path)
    except UnicodeError as exc:
        raise GenerationError("Invalid workspace entry path") from exc
    parts = encoded.split(b"/")
    if (len(encoded) > 4095 or b"\0" in encoded or len(parts) > MAX_DEPTH
            or any(part in (b"", b".", b"..") or len(part) > 255 for part in parts)):
        raise GenerationError("Invalid workspace entry path")
    return path.split("/")


def check_symlink(path, target):
    if not isinstance(target, str):
        raise GenerationError("Invalid workspace symlink")
    try:
        target_bytes = os.fsencode(target)
    except UnicodeError as exc:
        raise GenerationError("Invalid workspace symlink") from exc
    if not target or target.startswith("/") or len(target_bytes) > 4095 or b"\0" in target_bytes:
        raise GenerationError("Invalid workspace symlink")
    depth = len(path_parts(path)) - 1
    descended = False
    for part in target.split("/"):
        if part == "..":
            if descended or depth == 0:
                raise GenerationError("Workspace symlink may escape or traverse another symlink")
            depth -= 1
        elif part not in ("", "."):
            descended = True


def cipher_for(key, header, identity, *, decrypt_tag=None):
    if type(key) is not bytes or len(key) != 32:
        raise GenerationError("A 32-byte scoped workspace key is required")
    nonce = header[len(MAGIC):]
    cipher = Cipher(algorithms.AES(key), modes.GCM(nonce, decrypt_tag))
    context = cipher.encryptor() if decrypt_tag is None else cipher.decryptor()
    context.authenticate_additional_data(header + json_bytes(asdict(identity)))
    return context


class EncryptedWriter:
    def __init__(self, output, identity, key, limit):
        self.output = output
        self.limit = limit
        self.header = MAGIC + os.urandom(NONCE_BYTES)
        self.context = cipher_for(key, self.header, identity)
        self.hasher = hashlib.sha256()
        self.size = 0
        self._write(self.header)

    def _write(self, ciphertext):
        self.size += len(ciphertext)
        if self.size > self.limit:
            raise GenerationError("Workspace generation exceeds the ciphertext limit")
        self.hasher.update(ciphertext)
        self.output.write(ciphertext)

    def write(self, plaintext):
        self._write(self.context.update(plaintext))
        return len(plaintext)

    def finish(self, entries, total):
        self._write(self.context.finalize())
        self._write(self.context.tag)
        return GenerationReceipt(self.hasher.hexdigest(), self.size, entries, total)


def pack_workspace(workspace, stream, limits):
    entries = total = path_bytes = 0
    hardlinks = {}
    with _directory(workspace) as root:
        device = os.fstat(root).st_dev

        def walk(parent, name, path, info):
            nonlocal entries, total, path_bytes
            entries += 1
            if entries > limits.max_entries:
                raise GenerationError("Workspace generation exceeds the entry limit")
            if info.st_dev != device:
                raise GenerationError("Workspace contains a separate filesystem")
            if path:
                path_parts(path)
                path_bytes += len(os.fsencode(path))
                if path_bytes > MAX_PATH_BYTES:
                    raise GenerationError("Workspace paths exceed the metadata limit")
            mode = stat.S_IMODE(info.st_mode) & 0o777
            record = {"path": path, "mode": mode, "mtime": info.st_mtime_ns}
            if stat.S_ISDIR(info.st_mode):
                with _directory(name, dir_fd=parent) as child:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise GenerationError("Workspace changed during checkpoint")
                    write_record(stream, {**record, "type": "directory"})
                    with os.scandir(child) as children:
                        for entry in children:
                            entry_path = f"{path}/{entry.name}" if path else entry.name
                            walk(child, entry.name, entry_path, entry.stat(follow_symlinks=False))
                return
            if stat.S_ISLNK(info.st_mode):
                if info.st_nlink != 1:
                    raise GenerationError("Workspace contains a hardlinked symlink")
                target = os.readlink(name, dir_fd=parent)
                check_symlink(path, target)
                write_record(stream, {**record, "type": "symlink", "target": target})
                return
            if not stat.S_ISREG(info.st_mode):
                raise GenerationError("Workspace contains an unsupported entry")
            link = hardlinks.get(info.st_ino)
            if link is not None:
                if link[2] != info.st_nlink:
                    raise GenerationError("Workspace changed during checkpoint")
                link[1] += 1
                write_record(stream, {"type": "hardlink", "path": path, "target": link[0]})
                return
            if info.st_nlink > 1:
                hardlinks[info.st_ino] = [path, 1, info.st_nlink]
            total += info.st_size
            if total > limits.max_bytes:
                raise GenerationError("Workspace generation exceeds the byte limit")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(fd, "rb") as source:
                opened = os.fstat(source.fileno())
                if (opened.st_dev, opened.st_ino, opened.st_ctime_ns) != (info.st_dev, info.st_ino, info.st_ctime_ns):
                    raise GenerationError("Workspace changed during checkpoint")
                write_record(stream, {**record, "type": "file", "size": info.st_size})
                remaining = info.st_size
                while remaining:
                    data = read_exact(source, min(remaining, CHUNK))
                    stream.write(data)
                    remaining -= len(data)
                if os.fstat(source.fileno()).st_ctime_ns != info.st_ctime_ns:
                    raise GenerationError("Workspace changed during checkpoint")

        root_info = os.fstat(root)
        walk(root, ".", "", root_info)
        if any(seen != expected for _, seen, expected in hardlinks.values()):
            raise GenerationError("Workspace contains a hardlink outside its boundary")
    write_record(stream, {"type": "manifest", "entries": entries, "bytes": total})
    return entries, total


@contextmanager
def _directory(path, *, dir_fd=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dir_fd)
    try:
        yield fd
    finally:
        os.close(fd)


def validate_entry(record, entries):
    kind = record.get("type")
    path = record.get("path")
    if entries == 1:
        if kind != "directory" or path != "":
            raise GenerationError("Workspace generation has no root directory")
    else:
        path_parts(path)
    fields = {"type", "path", "mode", "mtime"}
    if kind == "hardlink":
        if set(record) != {"type", "path", "target"}:
            raise GenerationError("Invalid workspace hardlink metadata")
        path_parts(record["target"])
    else:
        if kind == "file":
            fields.add("size")
        elif kind == "symlink":
            fields.add("target")
        elif kind != "directory":
            raise GenerationError("Unsupported workspace entry type")
        if (set(record) != fields or not bounded_int(record["mode"], 0, 0o777)
                or not bounded_int(record["mtime"], -(1 << 63), (1 << 63) - 1)):
            raise GenerationError("Invalid workspace entry metadata")
    return kind, path


def unpack_workspace(stage, stream, limits, receipt=None, uid=None, gid=None):
    entries = total = path_bytes = 0
    paths = {}
    directories = []
    max_entries = min(limits.max_entries, receipt.entries) if receipt is not None else limits.max_entries
    max_bytes = min(limits.max_bytes, receipt.bytes) if receipt is not None else limits.max_bytes
    while True:
        record = read_record(stream)
        if record.get("type") == "manifest":
            expected = {"type": "manifest", "entries": entries, "bytes": total}
            if (not entries or json_bytes(record) != json_bytes(expected) or stream.read(1)
                    or (receipt is not None and (entries != receipt.entries or total != receipt.bytes))):
                raise GenerationError("Workspace generation manifest did not match")
            break
        entries += 1
        if entries > max_entries:
            raise GenerationError("Workspace generation exceeds the entry limit")
        kind, path = validate_entry(record, entries)
        path_bytes += len(os.fsencode(path))
        if path_bytes > MAX_PATH_BYTES:
            raise GenerationError("Workspace paths exceed the metadata limit")
        if path in paths or (path and paths.get(posixpath.dirname(path)) != "directory"):
            raise GenerationError("Workspace entry has an invalid or duplicate destination")
        destination = stage / path if stage is not None else None
        if kind == "directory":
            if destination is not None:
                if path:
                    destination.mkdir(mode=0o700)
                directories.append((destination, record))
        elif kind == "hardlink":
            if paths.get(record["target"]) != "file":
                raise GenerationError("Workspace hardlink must target a preceding regular file")
            if destination is not None:
                os.link(stage / record["target"], destination, follow_symlinks=False)
        else:
            if kind == "symlink":
                check_symlink(path, record["target"])
                if destination is not None:
                    destination.symlink_to(record["target"])
            else:
                size = record["size"]
                if not bounded_int(size, 0, max_bytes - total):
                    raise GenerationError("Workspace generation exceeds the byte limit")
                total += size
                with destination.open("xb") if destination is not None else nullcontext() as target:
                    remaining = size
                    while remaining:
                        data = read_exact(stream, min(remaining, CHUNK))
                        if target is not None:
                            target.write(data)
                        remaining -= len(data)
            if destination is not None:
                restore_metadata(destination, record, uid, gid)
        paths[path] = kind
    for destination, record in reversed(directories):
        restore_metadata(destination, record, uid, gid)
    return entries, total


def restore_metadata(path, record, uid, gid):
    os.chown(path, uid, gid, follow_symlinks=False)
    if record["type"] != "symlink":
        path.chmod(record["mode"])
    os.utime(path, ns=(record["mtime"], record["mtime"]), follow_symlinks=False)


def checked_scratch(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise GenerationError("Workspace generation scratch directory is not private")
    return path


@contextmanager
def decode_generation(encrypted, size, identity, key, scratch_dir):
    encrypted.seek(0)
    header = read_exact(encrypted, len(MAGIC) + NONCE_BYTES)
    if not header.startswith(MAGIC):
        raise GenerationError("Unsupported workspace generation format")
    encrypted.seek(size - TAG_BYTES)
    tag = read_exact(encrypted, TAG_BYTES)
    encrypted.seek(len(header))
    cipher = cipher_for(key, header, identity, decrypt_tag=tag)
    remaining = size - OVERHEAD
    with tempfile.TemporaryFile(dir=scratch_dir) as plain:
        while remaining:
            data = read_exact(encrypted, min(remaining, CHUNK))
            plain.write(cipher.update(data))
            remaining -= len(data)
        try:
            plain.write(cipher.finalize())
        except InvalidTag as exc:
            raise GenerationError("Workspace generation authentication failed") from exc
        plain.seek(0)
        with gzip.GzipFile(fileobj=plain, mode="rb") as decompressed:
            yield decompressed


def publish_generation(workspace, store, identity, key, limits, *, scratch_dir):
    """Checkpoint a stopped/fenced source; recover an exact authenticated retry."""
    scratch_dir = checked_scratch(scratch_dir)
    if type(key) is not bytes or len(key) != 32:
        raise GenerationError("A 32-byte scoped workspace key is required")
    name = identity.object_name()
    with tempfile.TemporaryFile(dir=scratch_dir) as encrypted:
        existing = store.recover(name, encrypted, limits.max_ciphertext_bytes)
        if existing is not None:
            digest, size = existing
            with decode_generation(encrypted, size, identity, key, scratch_dir) as decompressed:
                entries, total = unpack_workspace(None, decompressed, limits)
            return GenerationReceipt(digest, size, entries, total)
        writer = EncryptedWriter(encrypted, identity, key, limits.max_ciphertext_bytes)
        with gzip.GzipFile(fileobj=writer, mode="wb", compresslevel=1, mtime=0) as compressed:
            entries, total = pack_workspace(workspace, compressed, limits)
        receipt = writer.finish(entries, total)
        encrypted.seek(0)
        store.publish(name, encrypted, receipt)
        return receipt


def restore_generation(stage, store, identity, key, limits, receipt, *, scratch_dir, uid=65534, gid=65534):
    """Restore to an existing, empty, quota-inheriting stage with no attached writer.

    The caller provides a daemon-private parent and retains the original stage
    inode on failure. This function never promotes or attaches the stage.
    """
    stage = Path(stage)
    scratch_dir = checked_scratch(scratch_dir)
    parent = stage.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022
            or not bounded_int(uid, 0, (1 << 32) - 2) or not bounded_int(gid, 0, (1 << 32) - 2)):
        raise GenerationError("Workspace stage must have a daemon-private parent and valid owner")
    if (receipt.ciphertext_bytes > limits.max_ciphertext_bytes or receipt.entries > limits.max_entries
            or receipt.bytes > limits.max_bytes):
        raise GenerationError("Workspace receipt exceeds restore limits")
    if type(key) is not bytes or len(key) != 32:
        raise GenerationError("A 32-byte scoped workspace key is required")
    with _directory(stage) as root, tempfile.TemporaryFile(dir=scratch_dir) as encrypted:
        with os.scandir(root) as entries:
            if next(entries, None) is not None:
                raise GenerationError("Workspace restore stage is not empty")
        original = os.fstat(root)
        store.download(identity.object_name(), encrypted, receipt)
        with decode_generation(encrypted, receipt.ciphertext_bytes, identity, key, scratch_dir) as decompressed:
            try:
                unpack_workspace(stage, decompressed, limits, receipt, uid, gid)
            except BaseException:
                os.fchmod(root, 0o700)
                for directory, children, _ in os.walk(stage, topdown=True, followlinks=False):
                    for child in children:
                        path = Path(directory) / child
                        if not path.is_symlink():
                            path.chmod(0o700)
                with os.scandir(root) as entries:
                    for entry in entries:
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(stage / entry.name)
                        else:
                            os.unlink(entry.name, dir_fd=root)
                os.fchown(root, original.st_uid, original.st_gid)
                os.fchmod(root, stat.S_IMODE(original.st_mode))
                os.utime(root, ns=(original.st_atime_ns, original.st_mtime_ns))
                raise


class StorageBox:
    """Use a dedicated, pre-existing SFTP directory and pinned SSH connection.

    The caller also configures connect/channel timeouts. The operation timeout
    bounds progress loops; an in-flight request is bounded by the channel.
    """

    def __init__(self, sftp, directory, *, timeout_seconds=900):
        if not isinstance(directory, str) or not re.fullmatch(r"/?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", directory):
            raise GenerationError("Invalid workspace store directory")
        if any(part in (".", "..") for part in directory.split("/")):
            raise GenerationError("Invalid workspace store directory")
        if not bounded_int(timeout_seconds, 1, 3600):
            raise GenerationError("Invalid workspace store timeout")
        self.sftp = sftp
        self.directory = directory
        self.timeout = timeout_seconds

    def _path(self, name):
        if not isinstance(name, str) or not re.fullmatch(r"[0-9a-f]{64}\.hivra", name):
            raise GenerationError("Invalid workspace object name")
        return posixpath.join(self.directory, name)

    def _transfer(self, path, output, deadline, max_bytes, receipt=None, *, missing_ok=False):
        hasher = hashlib.sha256()
        position = 0
        try:
            handle = self.sftp.open(path, "rb")
        except FileNotFoundError:
            if missing_ok:
                return None
            raise
        with handle as remote:
            info = remote.stat()
            size = info.st_size
            if (not stat.S_ISREG(info.st_mode) or not bounded_int(size, OVERHEAD + 1, max_bytes)
                    or (receipt is not None and size != receipt.ciphertext_bytes)):
                raise GenerationError("Workspace object size or type did not match")
            remaining = size
            while remaining:
                if time.monotonic() >= deadline:
                    raise GenerationError("Workspace store read timed out")
                count = min(remaining, CHUNK)
                offsets = [(position + offset, min(32768, count - offset)) for offset in range(0, count, 32768)]
                for (_, size), data in zip(offsets, remote.readv(offsets), strict=True):
                    if len(data) != size:
                        raise GenerationError("Truncated workspace store object")
                    hasher.update(data)
                    if output is not None:
                        output.write(data)
                    position += size
                    remaining -= size
            remote.seek(position)
            digest = hasher.hexdigest()
            if remote.read(1) or (receipt is not None and not hmac.compare_digest(digest, receipt.sha256)):
                raise GenerationError("Workspace object digest did not match")
            return digest, position

    def publish(self, name, source, receipt):
        final = self._path(name)
        temporary = final + "." + uuid.uuid4().hex + ".part"
        deadline = time.monotonic() + self.timeout
        created = False
        try:
            with self.sftp.open(temporary, "wx") as remote:
                created = True
                remote.set_pipelined()
                remaining = receipt.ciphertext_bytes
                while remaining:
                    if time.monotonic() >= deadline:
                        raise GenerationError("Workspace store write timed out")
                    data = read_exact(source, min(remaining, CHUNK))
                    remote.write(data)
                    remaining -= len(data)
            self._transfer(temporary, None, deadline, receipt.ciphertext_bytes, receipt)
            self.sftp.rename(temporary, final)
            created = False
            self._transfer(final, None, deadline, receipt.ciphertext_bytes, receipt)
        finally:
            if created:
                try:
                    self.sftp.remove(temporary)
                except OSError:
                    pass

    def download(self, name, output, receipt):
        self._transfer(self._path(name), output, time.monotonic() + self.timeout, receipt.ciphertext_bytes, receipt)

    def recover(self, name, output, max_bytes):
        return self._transfer(self._path(name), output, time.monotonic() + self.timeout, max_bytes, missing_ok=True)
