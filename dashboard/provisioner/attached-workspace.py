#!/usr/bin/python3 -IBS
"""The ~/Hivra view of one attached agent (design 5.3 and 5.3.1).

    mount <id>        root: share /home/bux/Hivra with the agent through an
                      idmapped, non-recursive, nosuid,nodev view on the
                      root-owned mount point, or keep that mount point empty
                      (root 0000) when the grant is off.
    unmount <id>      root: detach the view; the empty mount point stays 0000.
    reassert <id>     root: owner bux and mode 0700 on /home/bux/Hivra, through
                      the no-follow directory fd (the agent can chmod its view).
    state <id>        root: the observed view as JSON, for receipts.
    verify <id>       the agent, inside its sandbox: the view is exactly what
                      its grant says; creates ~/Hivra -> view when nothing is there.
    remove-home <id>  root: delete the agent's private home. Opens it without
                      following links or crossing a mount, walks with directory
                      fds and only unlinks. Stops at any other filesystem.

Root never resolves a path the agent or a bux process can change: everything is
opened with openat2(RESOLVE_NO_SYMLINKS...) from a root-owned directory fd and
used only through fds (open_tree, mount_setattr, move_mount, fchown, fchmod).
"""
import ctypes
import json
import os
import platform
import pwd
import grp
import re
import signal
import stat
import struct
import sys

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
VIEWS = "/var/lib/hivra/agent-views"
HOMES = "/var/lib/hivra/agent-homes"
ATTACHMENTS = "/etc/hivra/attachments"
OWNER = "bux"
WORKSPACE = "Hivra"
MAX_ENTRIES = 250000
MAX_DEPTH = 128

# Unified syscall numbers (x86_64 and aarch64 share them for these calls).
SYS_OPEN_TREE, SYS_MOVE_MOUNT, SYS_OPENAT2, SYS_MOUNT_SETATTR = 428, 429, 437, 442
AT_EMPTY_PATH = 0x1000
OPEN_TREE_CLONE = 1
OPEN_TREE_CLOEXEC = os.O_CLOEXEC
MOVE_MOUNT_F_EMPTY_PATH, MOVE_MOUNT_T_EMPTY_PATH = 0x04, 0x40
MOUNT_ATTR_NOSUID, MOUNT_ATTR_NODEV, MOUNT_ATTR_IDMAP = 0x02, 0x04, 0x00100000
MS_PRIVATE = 1 << 18
RESOLVE_NO_XDEV, RESOLVE_NO_MAGICLINKS, RESOLVE_NO_SYMLINKS, RESOLVE_BENEATH = 0x01, 0x02, 0x04, 0x08
UMOUNT_NOFOLLOW = 0x08
CLONE_NEWUSER = 0x10000000
O_PATH = getattr(os, "O_PATH", 0o10000000)

_libc = None


def libc():
    global _libc
    if _libc is None:
        if platform.system() != "Linux" or platform.machine() not in ("x86_64", "aarch64"):
            raise ValueError("requires Linux on x86_64 or aarch64")
        _libc = ctypes.CDLL(None, use_errno=True)
        _libc.syscall.restype = ctypes.c_long
    return _libc


def _check(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def openat2(dirfd, path, flags, resolve):
    how = struct.pack("QQQ", flags | os.O_CLOEXEC, 0, resolve)
    return _check(libc().syscall(SYS_OPENAT2, ctypes.c_int(dirfd), ctypes.c_char_p(os.fsencode(path)),
                                 ctypes.c_char_p(how), ctypes.c_size_t(len(how))))


def open_tree_clone(fd):
    return _check(libc().syscall(SYS_OPEN_TREE, ctypes.c_int(fd), ctypes.c_char_p(b""),
                                 ctypes.c_uint(OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)))


def mount_setattr(fd, attr_set, userns_fd):
    attr = struct.pack("QQQQ", attr_set, 0, MS_PRIVATE, userns_fd)
    _check(libc().syscall(SYS_MOUNT_SETATTR, ctypes.c_int(fd), ctypes.c_char_p(b""), ctypes.c_uint(AT_EMPTY_PATH),
                          ctypes.c_char_p(attr), ctypes.c_size_t(len(attr))))


def move_mount(from_fd, to_fd):
    _check(libc().syscall(SYS_MOVE_MOUNT, ctypes.c_int(from_fd), ctypes.c_char_p(b""), ctypes.c_int(to_fd),
                          ctypes.c_char_p(b""), ctypes.c_uint(MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH)))


def umount_nofollow(path):
    _check(libc().umount2(ctypes.c_char_p(os.fsencode(path)), ctypes.c_int(UMOUNT_NOFOLLOW)))


def checked_id(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("invalid installation identity")
    return value


def root_directory(path, mode=None, gid=None):
    """Walk an absolute root-owned path component by component, never following a link."""
    parts = path.strip("/").split("/")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for index, part in enumerate(parts):
            child = openat2(fd, part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            last = index == len(parts) - 1
            if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
                raise ValueError("unsafe root-owned directory")
            if last and mode is not None and stat.S_IMODE(info.st_mode) != mode:
                raise ValueError("unexpected root-owned directory mode")
            if last and gid is not None and info.st_gid != gid:
                raise ValueError("unexpected root-owned directory group")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_small(dirfd, name, maximum=16384):
    fd = openat2(dirfd, name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                 RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > maximum:
            raise ValueError("unsafe attachment file")
        data = os.read(fd, maximum + 1)
        if len(data) > maximum:
            raise ValueError("oversized attachment file")
        return data
    finally:
        os.close(fd)


def binding(installation):
    """The root-owned registry file names the account and the grant."""
    fd = root_directory(ATTACHMENTS + "/" + installation, mode=0o755)
    try:
        value = json.loads(read_small(fd, "binding.json"))
    finally:
        os.close(fd)
    hexid = installation.replace("-", "")
    expected_account = "hva_" + hexid[:24]
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("installationId") != installation
            or value.get("account") != expected_account or type(value.get("workspace")) is not bool
            or type(value.get("uid")) is not int or type(value.get("gid")) is not int
            or not 0 < value["uid"] < 4294967295 or not 0 < value["gid"] < 4294967295):
        raise ValueError("invalid attachment registry")
    return value


def owner_ids():
    user = pwd.getpwnam(OWNER)
    if user.pw_dir != "/home/" + OWNER or user.pw_uid == 0:
        raise ValueError("unexpected desktop owner account")
    return user.pw_uid, user.pw_gid


def open_source():
    """/home/bux/Hivra, opened with no link and no mount crossing from a root-owned /home fd."""
    home = root_directory("/home")
    try:
        fd = openat2(home, OWNER + "/" + WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    except OSError as error:
        raise ValueError("workspace_path_not_plain") from error
    finally:
        os.close(home)
    return fd


def reassert_source(fd):
    uid, gid = owner_ids()
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("workspace_path_not_plain")
    changed = False
    if (info.st_uid, info.st_gid) != (uid, gid):
        os.fchown(fd, uid, gid)
        changed = True
    if stat.S_IMODE(info.st_mode) != 0o700:
        os.fchmod(fd, 0o700)
        changed = True
    return changed


def view_directory(installation, gid):
    views = root_directory(VIEWS, mode=0o711)
    try:
        fd = openat2(views, installation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    finally:
        os.close(views)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o750:
        os.close(fd)
        raise ValueError("unsafe view directory")
    return fd


def mount_point(view_fd):
    """The empty, root-owned 0000 mount point, or None when something is mounted on it."""
    try:
        fd = openat2(view_fd, WORKSPACE, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW,
                     RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    except OSError as error:
        if error.errno == 18:  # EXDEV: a mount sits on the mount point.
            return None
        raise ValueError("workspace_path_not_plain") from error
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0:
        os.close(fd)
        raise ValueError("workspace_path_not_plain")
    return fd


def mounted_view(installation):
    """The host's mountinfo line for the view path, parsed; None when absent."""
    target = VIEWS + "/" + installation + "/" + WORKSPACE
    found = []
    with open("/proc/self/mountinfo", "rb") as source:
        for raw in source.read(4 * 1024 * 1024).split(b"\n"):
            fields = raw.split(b" ")
            if len(fields) < 10:
                continue
            point = fields[4].decode("utf-8", "surrogateescape").replace("\\040", " ")
            if point == target:
                separator = fields.index(b"-")
                found.append({"mountId": int(fields[0]), "options": fields[5].decode().split(","),
                              "fstype": fields[separator + 1].decode()})
    if len(found) > 1:
        raise ValueError("more than one mount on the view path")
    return found[0] if found else None


def idmap_userns(owner_uid, owner_gid, uid, gid):
    """A user namespace whose map shows the owner's files as the agent's, and back."""
    ready_read, ready_write = os.pipe()
    hold_read, hold_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_read)
            os.close(hold_write)
            if libc().unshare(CLONE_NEWUSER) != 0:
                os._exit(1)
            os.write(ready_write, b"1")
            os.read(hold_read, 1)
        finally:
            os._exit(0)
    os.close(ready_write)
    os.close(hold_read)
    try:
        if os.read(ready_read, 1) != b"1":
            raise ValueError("user namespace unavailable")
        with open("/proc/%d/uid_map" % pid, "w") as output:
            output.write("%d %d 1\n" % (owner_uid, uid))
        with open("/proc/%d/gid_map" % pid, "w") as output:
            output.write("%d %d 1\n" % (owner_gid, gid))
        return os.open("/proc/%d/ns/user" % pid, os.O_RDONLY | os.O_CLOEXEC)
    finally:
        os.close(ready_read)
        os.close(hold_write)
        os.waitpid(pid, 0)


def do_unmount(installation, record):
    if mounted_view(installation) is not None:
        umount_nofollow(VIEWS + "/" + installation + "/" + WORKSPACE)
    if mounted_view(installation) is not None:
        raise ValueError("view still mounted")
    view_fd = view_directory(installation, record["gid"])
    try:
        point = mount_point(view_fd)
        if point is None:
            raise ValueError("view still mounted")
        os.close(point)
    finally:
        os.close(view_fd)


def do_mount(installation):
    record = binding(installation)
    if not record["workspace"]:
        do_unmount(installation, record)
        return state(installation)
    existing = mounted_view(installation)
    if existing is not None:
        observed = state(installation)
        if not observed["idmapped"] or not observed["viewOwnedByAgent"]:
            raise ValueError("unexpected mount on the view path")
        return observed
    owner_uid, owner_gid = owner_ids()
    source = open_source()
    try:
        info = os.fstat(source)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid:
            raise ValueError("workspace_path_not_plain")
        reassert_source(source)
        view_fd = view_directory(installation, record["gid"])
        try:
            target = mount_point(view_fd)
            if target is None:
                raise ValueError("unexpected mount on the view path")
            try:
                tree = open_tree_clone(source)
                try:
                    userns = idmap_userns(owner_uid, owner_gid, record["uid"], record["gid"])
                    try:
                        mount_setattr(tree, MOUNT_ATTR_IDMAP | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV, userns)
                    finally:
                        os.close(userns)
                    move_mount(tree, target)
                finally:
                    os.close(tree)
            finally:
                os.close(target)
        finally:
            os.close(view_fd)
    finally:
        os.close(source)
    observed = state(installation)
    if not observed["mounted"] or not observed["idmapped"] or not observed["viewOwnedByAgent"]:
        raise ValueError("view did not mount as designed")
    return observed


def state(installation):
    record = binding(installation)
    line = mounted_view(installation)
    result = {"version": 1, "installationId": installation, "workspace": record["workspace"],
              "mounted": line is not None, "idmapped": False, "nosuid": False, "nodev": False,
              "viewOwnedByAgent": False, "mountPointEmpty": False, "sourceOwnerOk": False}
    if line is not None:
        result.update(idmapped="idmapped" in line["options"], nosuid="nosuid" in line["options"],
                      nodev="nodev" in line["options"])
        view_fd = view_directory(installation, record["gid"])
        try:
            fd = openat2(view_fd, WORKSPACE, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW,
                         RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)
            try:
                result["viewOwnedByAgent"] = os.fstat(fd).st_uid == record["uid"]
            finally:
                os.close(fd)
        finally:
            os.close(view_fd)
    else:
        view_fd = view_directory(installation, record["gid"])
        try:
            point = mount_point(view_fd)
            result["mountPointEmpty"] = point is not None
            if point is not None:
                os.close(point)
        finally:
            os.close(view_fd)
    try:
        source = open_source()
    except ValueError:
        return result
    try:
        info = os.fstat(source)
        owner_uid, owner_gid = owner_ids()
        result["sourceOwnerOk"] = (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (owner_uid, owner_gid, 0o700)
    finally:
        os.close(source)
    return result


def do_reassert(installation):
    binding(installation)
    source = open_source()
    try:
        return {"version": 1, "installationId": installation, "reasserted": reassert_source(source)}
    finally:
        os.close(source)


def do_verify(installation):
    """Runs as the agent inside its unit. Refuses to let the agent start unless the view matches its grant."""
    if os.geteuid() == 0:
        raise ValueError("verify runs as the agent, not as root")
    with open(ATTACHMENTS + "/" + installation + "/binding.json", "rb") as source:
        record = json.loads(source.read(16385))
    if record.get("installationId") != installation or os.getuid() != record.get("uid"):
        raise ValueError("this unit does not belong to that installation")
    view = VIEWS + "/" + installation + "/" + WORKSPACE
    lines = []
    with open("/proc/self/mountinfo", "rb") as source:
        for raw in source.read(4 * 1024 * 1024).split(b"\n"):
            fields = raw.split(b" ")
            if len(fields) >= 10 and fields[4].decode("utf-8", "surrogateescape") == view:
                lines.append(fields[5].decode().split(","))
    info = os.lstat(view)
    if record["workspace"]:
        if len(lines) != 1 or "idmapped" not in lines[0] or "nosuid" not in lines[0] or "nodev" not in lines[0]:
            raise ValueError("view_not_as_granted")
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("view_not_as_granted")
        home = os.environ.get("HOME", "")
        link = os.path.join(home, WORKSPACE)
        if home and not os.path.lexists(link):
            os.symlink(view, link)
    else:
        if lines or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0:
            raise ValueError("view_not_as_granted")
    return {"version": 1, "installationId": installation, "workspace": record["workspace"], "verified": True}


def agent_processes(uid):
    count = 0
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/" + name + "/status", "rb") as source:
                for line in source.read(8192).split(b"\n"):
                    if line.startswith(b"Uid:"):
                        if any(int(value) == uid for value in line.split()[1:]):
                            count += 1
                        break
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return count


def do_remove_home(installation):
    """Delete the agent's private home without following a link or crossing a mount."""
    record = binding(installation)
    if agent_processes(record["uid"]):
        raise ValueError("agent processes still exist")
    homes = root_directory(HOMES, mode=0o711)
    try:
        try:
            top = openat2(homes, installation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
        except FileNotFoundError:
            return {"version": 1, "installationId": installation, "removed": 0, "home": "absent"}
        except OSError as error:
            if error.errno == 18:
                raise ValueError("detach_mount_found") from error
            raise
        device = os.fstat(top).st_dev
        removed = 0
        # Iterative post-order walk over directory fds: (fd, names, depth).
        stack = [(top, sorted(os.listdir(top)), 0)]
        pending = []
        try:
            while stack:
                fd, names, depth = stack[-1]
                if not names:
                    stack.pop()
                    os.close(fd)
                    if stack:
                        parent_fd, _, _ = stack[-1]
                        os.rmdir(pending.pop(), dir_fd=parent_fd)
                        removed += 1
                    continue
                name = names.pop()
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if info.st_dev != device:
                    raise ValueError("detach_mount_found")
                if stat.S_ISDIR(info.st_mode):
                    if depth + 1 > MAX_DEPTH:
                        raise ValueError("home too deep to remove safely")
                    try:
                        child = openat2(fd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                        RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
                    except OSError as error:
                        if error.errno == 18:
                            raise ValueError("detach_mount_found") from error
                        raise
                    if os.fstat(child).st_dev != device:
                        os.close(child)
                        raise ValueError("detach_mount_found")
                    pending.append(name)
                    stack.append((child, sorted(os.listdir(child)), depth + 1))
                else:
                    # Links, hardlinks, FIFOs, sockets and devices are removed as names only.
                    os.unlink(name, dir_fd=fd)
                    removed += 1
                if removed > MAX_ENTRIES:
                    raise ValueError("home too large to remove safely")
        finally:
            for fd, _, _ in stack:
                os.close(fd)
        os.rmdir(installation, dir_fd=homes)
        return {"version": 1, "installationId": installation, "removed": removed + 1, "home": "removed"}
    finally:
        os.close(homes)


COMMANDS = {"mount": do_mount, "unmount": lambda i: (do_unmount(i, binding(i)), state(i))[1],
            "reassert": do_reassert, "state": state, "verify": do_verify, "remove-home": do_remove_home}


def main(argv):
    if len(argv) != 3 or argv[1] not in COMMANDS:
        raise SystemExit("usage: attached-workspace {" + "|".join(sorted(COMMANDS)) + "} <installation-id>")
    installation = checked_id(argv[2])
    if argv[1] != "verify" and os.geteuid() != 0:
        raise SystemExit("attached-workspace " + argv[1] + " requires root")
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    print(json.dumps(COMMANDS[argv[1]](installation), separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except SystemExit:
        raise
    except Exception as error:
        # Name the refusal; never echo paths or bytes an agent could plant.
        code = str(error) if str(error) in ("workspace_path_not_plain", "detach_mount_found", "view_not_as_granted") \
            else type(error).__name__
        raise SystemExit("attached-workspace refused (" + code + ")")
