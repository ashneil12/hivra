import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys


LOCK = Path(__file__).with_name("bux-bake-lock.json")
MARKER = Path("/etc/hivra/bux-dependencies-bake.json")


def digest(path):
    with path.open("rb") as stream:
        result = hashlib.sha256()
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(data)
    return result.hexdigest()


def marker(lock):
    return (json.dumps({
        "schema": 1,
        "kind": "bux-dependencies",
        "baseImageSha256": lock["baseImageSha256"],
        "dependencyLockSha256": digest(LOCK),
    }, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def safe_root_path(path, require_executable=False):
    for entry in (path, *path.parents):
        info = entry.lstat()
        if entry == path:
            valid_type = stat.S_ISREG(info.st_mode)
            if require_executable:
                valid_type &= (info.st_mode & 0o111) == 0o111
        else:
            valid_type = stat.S_ISDIR(info.st_mode)
        if info.st_uid != 0 or info.st_mode & 0o022 or not valid_type:
            raise ValueError(f"untrusted baked path: {entry}")


def check_dependencies(lock):
    expected = lock["packages"]
    output = subprocess.check_output([
        "/usr/bin/dpkg-query", "-W", "-f=${Package} ${db:Status-Status} ${Version}\n",
        *sorted(expected),
    ], text=True)
    if sorted(output.splitlines()) != [f"{name} installed {expected[name]}" for name in sorted(expected)]:
        raise ValueError("locked bux package versions are missing or drifted")
    changes = subprocess.check_output(["/usr/bin/dpkg", "--verify", *sorted(expected)], text=True)
    if any(line[10:12] != "c " for line in changes.splitlines()):
        raise ValueError("installed bux package files are missing or changed")
    for entry, expected_hash in lock["executables"].items():
        path = Path(entry)
        safe_root_path(path, require_executable=True)
        if digest(path) != expected_hash:
            raise ValueError(f"baked executable mismatch: {path}")
    for entry in ("/usr/bin/npm", "/usr/bin/npx"):
        path = Path(entry).resolve(strict=True)
        if not path.is_relative_to("/usr/lib/node_modules/npm"):
            raise ValueError(f"unexpected NodeSource path: {entry}")
        safe_root_path(path, require_executable=True)


def patch_installer(lock, path):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != lock["installerSha256"]:
        raise ValueError("bux installer is not the exact reviewed upstream script")
    lines = raw.splitlines(keepends=True)
    for first, last in [(165, 179), (119, 130), (94, 103)]:
        del lines[first - 1:last]
    path.write_bytes(b"".join(lines))


def main():
    command, *args = sys.argv[1:]
    lock = json.loads(LOCK.read_bytes())
    if command == "assets" and not args:
        for asset in lock["assets"]:
            print(asset["url"], asset["sha256"], asset["name"], sep="\t")
    elif command == "auto-packages" and not args:
        print(" ".join(lock["autoPackages"]))
    elif command == "seal" and args == [lock["baseImageSha256"]]:
        check_dependencies(lock)
        MARKER.write_bytes(marker(lock))
        MARKER.chmod(0o444)
    elif command == "verify" and len(args) == 2 and args[0] == lock["buxRef"]:
        safe_root_path(MARKER)
        if MARKER.stat().st_size > 1024 or MARKER.read_bytes() != marker(lock):
            raise ValueError("bux bake marker doesn't match the dependency lock")
        subprocess.run(["/usr/bin/dpkg", "--compare-versions", lock["packages"]["gh"], "ge", args[1]], check=True)
        check_dependencies(lock)
    elif command == "patch" and len(args) == 1:
        patch_installer(lock, Path(args[0]))
    else:
        raise ValueError("unsupported bux bake operation or pin")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
