#!/usr/bin/env python3
"""Private native-package installer; not a launch or lifecycle API.

The shared guest installer must hold its existing installation/lifecycle lock,
validate the journaled origin, and stop/verify the native service before calling
this module. Only the private v2 guest path composes this with service ownership.
No npm lifecycle scripts, operator configuration or model secrets are consumed.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

RUNTIME = Path("/opt/hivra/deepseek-runtime")
RECEIPT = ".hivra-native-install.json"
PINS = {
    "package.json": "d881c21f3ed5b42dffb5d5d951c527304b86ba52d8b41ee66ad007d0157f3381",
    "package-lock.json": "1e0c3ad2505f33eedb2f1cbb2cb4cc7aea70cdfdf4e92e6ac6ba0741598446bf",
}
HELPER = "node_modules/node-pty/prebuilds/linux-x64/spawn-helper"
VERSION = "0.1.2-alpha.2"
MAX_FILE = 128 * 1024 * 1024


class InstallError(Exception):
    pass


def reject(code):
    raise InstallError("DeepSeek native installation: " + code)


def canonical(data):
    return (json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n").encode()


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or path.resolve() != path:
        reject("unsafe directory")


def ancestors(path):
    for parent in reversed((path, *path.parents)):
        directory(parent)


def read_regular(path, limit, root_owned=True):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit
                or (root_owned and (info.st_uid != 0 or info.st_mode & 0o022))):
            reject("unsafe file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            reject("oversized file")
        return raw
    finally:
        os.close(fd)


def recipe(source):
    # Byte pins are reviewed with the source bundle. Even an altered lockfile
    # with internally consistent package metadata must not select new code.
    values = {name: read_regular(source / name, 1024 * 1024, False) for name in PINS}
    if any(hashlib.sha256(values[name]).hexdigest() != digest for name, digest in PINS.items()):
        reject("recipe pin mismatch")
    return values


def exclusive_file(path, data, mode=0o644):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)


def publish(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        reject("exclusive publication unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        raise OSError(ctypes.get_errno(), "exclusive native publication failed")
    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def tree_digest(root):
    """Hash actual installed bytes/modes/links, not just the declared npm lock.

    Only a root-owned tree under canonical non-writable ancestors is accepted.
    No symlink traversal or chmod/chown walk through dependency-controlled links.
    npm's relative .bin links may resolve only to regular files inside this tree.
    """
    ancestors(root)
    if stat.S_IMODE(root.stat().st_mode) != 0o755:
        reject("package root is not readable")
    digest = hashlib.sha256()
    count = 0
    for current, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(current) / name
            relative = path.relative_to(root).as_posix()
            if relative == RECEIPT:
                continue
            info = path.lstat()
            if info.st_uid != 0:
                reject("package owner mismatch")
            mode = stat.S_IMODE(info.st_mode)
            record = {"path": relative, "mode": mode}
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                resolved = path.resolve(strict=True)
                if os.path.isabs(target) or not resolved.is_relative_to(root) or not resolved.is_file():
                    reject("package link escape")
                record.update(type="link", target=target)
            elif stat.S_ISDIR(info.st_mode):
                if mode not in (0o555, 0o755):
                    reject("unsafe package directory")
                record.update(type="directory")
            elif stat.S_ISREG(info.st_mode):
                if mode not in (0o444, 0o555, 0o644, 0o755):
                    reject("unsafe package file")
                raw = read_regular(path, MAX_FILE)
                record.update(type="file", size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            else:
                reject("special package file")
            digest.update(canonical(record))
            count += 1
            if count > 100000:
                reject("oversized package tree")
        directories.sort()
    return {"sha256": digest.hexdigest(), "entries": count}


def inspect_helper(root):
    helper = root / HELPER
    if not os.path.lexists(helper):
        return {"path": HELPER, "present": False}
    ancestors(helper.parent)
    raw = read_regular(helper, MAX_FILE)
    if stat.S_IMODE(helper.lstat().st_mode) != 0o755:
        reject("native helper mode mismatch")
    return {"path": HELPER, "present": True, "sha256": hashlib.sha256(raw).hexdigest(), "mode": 0o755}


def repair_helper(root):
    # This is the only reviewed effect of subprocess-local's postinstall hook.
    # Do not enable all dependency scripts or make the runtime agent-writable.
    helper = root / HELPER
    if not os.path.lexists(helper):
        # Linux versions can use pty.node directly, with no spawn-helper. Actual
        # PTY execution is still mandatory acceptance; absence is not success.
        return inspect_helper(root)
    ancestors(helper.parent)
    fd = os.open(helper, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o7022:
            reject("unsafe native helper")
        before = read_regular(helper, MAX_FILE)
        os.fchmod(fd, 0o755)
        after = read_regular(helper, MAX_FILE)
        if before != after:
            reject("native helper bytes changed")
        return inspect_helper(root)
    finally:
        os.close(fd)


def verified_existing():
    ancestors(RUNTIME)
    raw = read_regular(RUNTIME / RECEIPT, 4096)
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {"schema", "version", "pins", "tree", "helper"}
            or type(value["schema"]) is not int or value["schema"] != 1 or value["version"] != VERSION or value["pins"] != PINS
            or raw != canonical(value) or value["tree"] != tree_digest(RUNTIME) or value["helper"] != inspect_helper(RUNTIME)):
        reject("existing package differs; explicit repair required")
    for name, digest in PINS.items():
        if hashlib.sha256(read_regular(RUNTIME / name, 1024 * 1024)).hexdigest() != digest:
            reject("installed recipe differs")
    return value


def npm_install(package, install_home, user_config, global_config):
    # Absolute root-owned executables, no shell, clean HOME/environment and
    # explicit empty npm config. Dependencies cannot run install scripts.
    for executable in (Path("/usr/bin/node").resolve(strict=True), Path("/usr/bin/npm").resolve(strict=True)):
        ancestors(executable.parent)
        read_regular(executable, MAX_FILE)
    result = subprocess.run(["/usr/bin/npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
        "--registry=https://registry.npmjs.org", "--userconfig=" + str(user_config), "--globalconfig=" + str(global_config)],
        cwd=package, env={"PATH": "/usr/bin:/bin", "HOME": str(install_home), "LANG": "C.UTF-8"},
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600, check=False,
        umask=0o022)
    if result.returncode != 0:
        reject("pinned dependency installation failed")


def install_package(source):
    if not sys.platform.startswith("linux") or os.geteuid() != 0 or os.uname().machine != "x86_64":
        reject("Linux amd64 root authority required")
    values = recipe(source)
    # Parent is prepared by the existing root installer, never selected by API
    # input. An existing destination is validated, never silently overwritten.
    ancestors(RUNTIME.parent)
    if os.path.lexists(RUNTIME):
        return verified_existing()
    stage = Path(tempfile.mkdtemp(prefix=".deepseek-install-", dir=RUNTIME.parent))
    try:
        package = stage / "package"
        package.mkdir(mode=0o755)
        package.chmod(0o755)  # The enclosing provider worker deliberately uses umask 077.
        install_home = stage / "npm-home"
        install_home.mkdir(mode=0o700)
        user_config = stage / "empty-user-npmrc"
        global_config = stage / "empty-global-npmrc"
        # npm rejects a single file loaded at two different config levels.
        exclusive_file(user_config, b"", 0o600)
        exclusive_file(global_config, b"", 0o600)
        for name, raw in values.items():
            exclusive_file(package / name, raw)
        npm_install(package, install_home, user_config, global_config)
        # Verify before fixing the one reviewed mode: never follow a dependency
        # symlink or touch a custom destination while running as root.
        tree_digest(package)
        helper = repair_helper(package)
        expected = json.loads(read_regular(package / "node_modules/@deepseek-ai/dsh/package.json", 1024 * 1024))
        if expected.get("name") != "@deepseek-ai/dsh" or expected.get("version") != VERSION:
            reject("installed package pin mismatch")
        value = {"schema": 1, "version": VERSION, "pins": PINS, "tree": tree_digest(package), "helper": helper}
        exclusive_file(package / RECEIPT, canonical(value))
        publish(package, RUNTIME)
        return verified_existing()
    finally:
        # This exact root-only temporary directory was created by this call.
        # Never remove the published runtime or an unknown/custom destination.
        shutil.rmtree(stage)
