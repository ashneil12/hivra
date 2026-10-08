#!/usr/bin/python3 -IBS
"""One attached agent's life on its user's computer (design 5.3 to 5.5).

Runs as root inside the exact guest, sent by the attach worker through the
VMID-bound guest exec with its pinned helpers (run-attached-agent-bundle.py).

    activate  Write the root-owned registry, tokens, starting folder with the
              Computer Contract, helpers and units v2 (rendered here from the
              approved grants and checked against the digest Hivra recorded),
              start the workspace view, the network and DNS, run the
              enforcement probe, start Codex's chat instance, prove it answers
              on its socket and through the computer's gateway, read the
              contract back on the host and inside the unit, then enable it at
              boot. Journaled: a start is requested at most once.
    observe   Read-only: what is running now, for a worker that lost an answer.
    access    Change the ~/Hivra grant: Codex is stopped (empty cgroup) while
              its view changes; a failed change is put back and says so.
    state     Read-only: the grant, view and chat an access change left behind.
    remove    Remove: stop, lock the account, delete units, unmount the view,
              remove the network, delete the private home without following a
              link, the installation, the account and groups. Never writes to
              ~/Hivra. Also cleans up a failed attach.

Root never resolves a path the agent controls (5.3.1): everything it writes is
in root-owned folders, created with O_EXCL|O_NOFOLLOW and renamed into place.
"""
import grp
import hashlib
import http.client
import json
import os
import pwd
import re
import secrets
import socket
import stat
import subprocess
import time

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}
VIEWS = "/var/lib/hivra/agent-views"
HOMES = "/var/lib/hivra/agent-homes"
INSTALLS = "/opt/hivra/agent-installations"
ATTACHMENTS = "/etc/hivra/attachments"
HELPERS = "/usr/local/lib/hivra"
UNITS = "/etc/systemd/system"
JOURNAL = "/var/lib/hivra/attachment-activation-v2"
SOCKETS = "/run/hivra-attached"
GATEWAY = ("127.0.0.1", 8080)
PROTOCOL = "hivra-attached-agent-v1"
POLICY_VERSION = 2
HELPER_TARGETS = {"workspace": "attached-workspace", "network": "attached-network", "relay": "attached-dns-relay"}


# ---- units v2, byte-equal with attachment-service-units.ts ---------------------

def sandbox(installation, sid):
    return [
        "NoNewPrivileges=yes",
        "CapabilityBoundingSet=",
        "AmbientCapabilities=",
        "NetworkNamespacePath=/run/netns/hivra-" + sid,
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "TemporaryFileSystem=/var/lib/hivra:ro /etc/hivra:ro /var/log",
        "BindReadOnlyPaths=/etc/hivra/attachments/" + installation,
        "BindReadOnlyPaths=/etc/hivra/attachments/" + installation + "/resolv.conf:/etc/resolv.conf",
        "InaccessiblePaths=/run/dbus/system_bus_socket -/opt/hivra/remote-desktop -/run/snapd.socket -/run/snapd-snap.socket -/run/acpid.socket -/run/dhcpcd -/run/uuidd -/run/systemd/resolve/io.systemd.Resolve -/run/systemd/io.systemd.ManagedOOM -/run/systemd/io.system.ManagedOOM -/run/systemd/private",
        "PrivateTmp=yes",
        "PrivateDevices=yes",
        "PrivateIPC=yes",
        "ProtectProc=invisible",
        "ProcSubset=pid",
        "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes",
        "ProtectKernelLogs=yes",
        "ProtectControlGroups=yes",
        "ProtectClock=yes",
        "ProtectHostname=yes",
        "RestrictSUIDSGID=yes",
        "RestrictNamespaces=yes",
        "RestrictRealtime=yes",
        "LockPersonality=yes",
        "SystemCallArchitectures=native",
        "SystemCallFilter=@system-service",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        "IPAddressAllow=localhost",
        "IPAddressDeny=link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 198.18.0.0/15 fc00::/7",
    ]


def render_units(installation, account, home, executable, workspace, memory_max_mb):
    """Every unit and drop-in for one attachment, and the definition digest."""
    if not UUID.fullmatch(installation):
        raise ValueError("invalid installation identity")
    hexid = installation.replace("-", "")
    if (account != "hva_" + hexid[:24] or home != HOMES + "/" + installation
            or executable != INSTALLS + "/" + installation + "/codex" or type(workspace) is not bool
            or type(memory_max_mb) is not int or not 512 <= memory_max_mb <= 2048):
        raise ValueError("the attached service needs the exact staged account, home and executable")
    sid = hexid[:12]
    group = "hvc_" + hexid[:24]
    name = "hivra-attached-" + installation
    view = VIEWS + "/" + installation
    install = INSTALLS + "/" + installation

    def lines(*values):
        return "\n".join(values) + "\n"

    units = [
        (name + ".socket", UNITS + "/" + name + ".socket", lines(
            "[Unit]",
            "Description=Hivra attached Codex chat socket " + installation,
            "",
            "[Socket]",
            "ListenStream=/run/hivra-attached/" + installation + ".sock",
            "SocketUser=root",
            "SocketGroup=" + group,
            "SocketMode=0660",
            "DirectoryMode=0711",
            "RemoveOnStop=yes",
            "Accept=no",
            "Service=" + name + ".service",
            "",
            "[Install]",
            "WantedBy=sockets.target",
        )),
        (name + ".service", UNITS + "/" + name + ".service", lines(
            "[Unit]",
            "Description=Hivra attached Codex " + installation,
            "Requires=" + name + "-workspace.service " + name + "-network.service " + name + "-dns.socket " + name + ".socket",
            "After=" + name + "-workspace.service " + name + "-network.service " + name + "-dns.socket " + name + ".socket",
            "StartLimitIntervalSec=300",
            "StartLimitBurst=5",
            "",
            "[Service]",
            "Type=simple",
            "User=" + account,
            "Group=" + account,
            "Sockets=" + name + ".socket",
            "WorkingDirectory=" + home,
            "Environment=HOME=" + home,
            "Environment=CODEX_HOME=" + home + "/.codex",
            "Environment=CODEX_BIN=" + executable,
            "Environment=HIVRA_AGENT_KIND=codex",
            "Environment=HIVRA_ATTACHED_INSTALLATION_ID=" + installation,
            "Environment=HIVRA_AGENT_WORKDIR=" + view,
            "Environment=HIVRA_API_TOKEN_FILE=/etc/hivra/attachments/" + installation + "/instance-token",
            "Environment=PATH=" + install + ":/usr/local/bin:/usr/bin:/bin",
            "ExecStartPre=/usr/local/lib/hivra/attached-workspace verify " + installation,
            "ExecStartPre=/usr/local/lib/hivra/attached-network verify " + installation,
            "ExecStart=/usr/local/bin/node /opt/bux/hivra-chat/server.js",
            "UMask=0077",
            "Restart=on-failure",
            "RestartSec=5",
            "KillMode=control-group",
            "TimeoutStopSec=15",
            "OOMPolicy=continue",
            *sandbox(installation, sid),
            "BindPaths=" + home,
            "BindReadOnlyPaths=" + view + ":" + view + ":norbind",
            *(["BindPaths=" + view + "/Hivra:" + view + "/Hivra:norbind", "ReadWritePaths=" + view + "/Hivra"] if workspace else []),
            "ReadWritePaths=" + home,
            "MemoryMax=" + str(memory_max_mb) + "M",
            "CPUWeight=50",
            "IOWeight=50",
            "TasksMax=512",
            "",
            "[Install]",
            "WantedBy=multi-user.target",
        )),
        (name + "-probe.service", UNITS + "/" + name + "-probe.service", lines(
            "[Unit]",
            "Description=Hivra attached Codex network enforcement probe " + installation,
            "Requires=" + name + "-network.service " + name + "-dns.socket",
            "After=" + name + "-network.service " + name + "-dns.socket",
            "",
            "[Service]",
            "Type=oneshot",
            "User=" + account,
            "Group=" + account,
            "ExecStart=/usr/local/lib/hivra/attached-network probe " + installation,
            "TimeoutStartSec=60",
            *sandbox(installation, sid),
        )),
        (name + "-workspace.service", UNITS + "/" + name + "-workspace.service", lines(
            "[Unit]",
            "Description=Hivra attached Codex workspace view " + installation,
            "After=local-fs.target",
            "",
            "[Service]",
            "Type=oneshot",
            "RemainAfterExit=yes",
            "ExecStart=/usr/local/lib/hivra/attached-workspace mount " + installation,
            "ExecStop=/usr/local/lib/hivra/attached-workspace unmount " + installation,
            "",
            "[Install]",
            "WantedBy=multi-user.target",
        )),
        (name + "-network.service", UNITS + "/" + name + "-network.service", lines(
            "[Unit]",
            "Description=Hivra attached Codex network " + installation,
            "Wants=network-online.target",
            "After=network-online.target docker.service",
            "",
            "[Service]",
            "Type=oneshot",
            "RemainAfterExit=yes",
            "ExecStart=/usr/local/lib/hivra/attached-network up " + installation,
            "ExecStop=/usr/local/lib/hivra/attached-network down " + installation,
            "",
            "[Install]",
            "WantedBy=multi-user.target",
        )),
        (name + "-dns.socket", UNITS + "/" + name + "-dns.socket", lines(
            "[Unit]",
            "Description=Hivra attached Codex DNS " + installation,
            "Requires=" + name + "-network.service",
            "After=" + name + "-network.service",
            "",
            "[Socket]",
            "NetworkNamespacePath=/run/netns/hivra-" + sid,
            "ListenDatagram=127.0.0.53:53",
            "ListenStream=127.0.0.53:53",
            "FreeBind=yes",
            "IPAddressDeny=any",
            "IPAddressAllow=127.0.0.0/8",
            "Service=" + name + "-dns.service",
            "",
            "[Install]",
            "WantedBy=sockets.target",
        )),
        (name + "-dns.service", UNITS + "/" + name + "-dns.service", lines(
            "[Unit]",
            "Description=Hivra attached Codex DNS relay " + installation,
            "Requires=" + name + "-dns.socket",
            "After=" + name + "-dns.socket",
            "",
            "[Service]",
            "Type=simple",
            "ExecStartPre=+/usr/local/lib/hivra/attached-network relay-guard " + installation,
            "ExecStart=/usr/local/lib/hivra/attached-dns-relay",
            "ExecStopPost=+/usr/local/lib/hivra/attached-network relay-unguard " + installation,
            "DynamicUser=yes",
            "NoNewPrivileges=yes",
            "CapabilityBoundingSet=",
            "AmbientCapabilities=",
            "ProtectSystem=strict",
            "ProtectHome=yes",
            "PrivateTmp=yes",
            "PrivateDevices=yes",
            "PrivateIPC=yes",
            "ProtectProc=invisible",
            "ProcSubset=pid",
            "ProtectKernelTunables=yes",
            "ProtectKernelModules=yes",
            "ProtectKernelLogs=yes",
            "ProtectControlGroups=yes",
            "ProtectClock=yes",
            "ProtectHostname=yes",
            "RestrictSUIDSGID=yes",
            "RestrictNamespaces=yes",
            "RestrictRealtime=yes",
            "LockPersonality=yes",
            "SystemCallArchitectures=native",
            "SystemCallFilter=@system-service",
            "RestrictAddressFamilies=AF_INET",
            "IPAddressDeny=any",
            "IPAddressAllow=127.0.0.53/32",
            "MemoryMax=64M",
            "TasksMax=32",
        )),
        (name + "-watchdog.service", UNITS + "/" + name + "-watchdog.service", lines(
            "[Unit]",
            "Description=Hivra attached Codex protection watchdog " + installation,
            "",
            "[Service]",
            "Type=oneshot",
            "ExecStart=/usr/local/lib/hivra/attached-network watchdog " + installation,
        )),
        (name + "-watchdog.timer", UNITS + "/" + name + "-watchdog.timer", lines(
            "[Unit]",
            "Description=Hivra attached Codex protection watchdog " + installation,
            "",
            "[Timer]",
            "OnBootSec=90",
            "OnUnitActiveSec=60",
            "AccuracySec=10",
            "",
            "[Install]",
            "WantedBy=timers.target",
        )),
        ("bux-hivra-chat.service.d/" + name + ".conf", UNITS + "/bux-hivra-chat.service.d/" + name + ".conf", lines(
            "[Service]",
            "SupplementaryGroups=" + group,
        )),
    ]
    return units, group, sid


def definition_sha256(installation, workspace, memory_max_mb, units, helpers):
    """The same digest attachment-service-units.ts records (JSON.stringify byte order)."""
    definition = {"version": POLICY_VERSION, "installationId": installation, "grants": {"workspace": workspace},
                  "memoryMaxMb": memory_max_mb,
                  "units": [[path, hashlib.sha256(content.encode()).hexdigest()] for _, path, content in units],
                  "helpers": [[HELPERS + "/" + HELPER_TARGETS[key], helpers[key]] for key in ("workspace", "network", "relay")]}
    return hashlib.sha256(json.dumps(definition, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


# ---- root-owned filesystem, never following a link -----------------------------

def open_root_dir(path, create_mode=None, owner_gid=0):
    """Walk an absolute path from /, component by component, without following
    a link; every component must be a root-owned directory nobody else can
    write. Missing components are created only when create_mode is given."""
    parts = [part for part in path.split("/") if part]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                if create_mode is None:
                    raise
                mode = create_mode if last else 0o755
                os.mkdir(part, mode, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.fchown(child, 0, owner_gid if last else 0)
                os.fchmod(child, mode)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
                raise ValueError("unsafe root-owned directory")
        return fd
    except BaseException:
        os.close(fd)
        raise


def ensure_dir(parent_fd, name, mode, gid=0):
    try:
        os.mkdir(name, mode, dir_fd=parent_fd)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    info = os.fstat(fd)
    if info.st_uid != 0 or not stat.S_ISDIR(info.st_mode):
        os.close(fd)
        raise ValueError("unsafe root-owned directory")
    os.fchown(fd, 0, gid)
    os.fchmod(fd, mode)
    return fd


def write_file(dir_fd, name, data, mode, gid=0):
    """Temp file with O_EXCL|O_NOFOLLOW, fsync, then rename into place."""
    data = data.encode() if isinstance(data, str) else data
    temporary = "." + name + "." + secrets.token_hex(8)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dir_fd)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fchown(output.fileno(), 0, gid)
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.rename(temporary, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.fsync(dir_fd)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        raise


def read_file(dir_fd, name, limit=65536):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("unexpected file")
        return os.read(fd, limit + 1), info
    finally:
        os.close(fd)


def unlink_quiet(dir_fd, name):
    try:
        info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if stat.S_ISDIR(info.st_mode):
        raise ValueError("refusing to unlink a directory")
    os.unlink(name, dir_fd=dir_fd)
    return True


# ---- processes and services ---------------------------------------------------------

def run(args, timeout=60, check=True, stdin=None):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout, env=ENV, check=False)
    if check and result.returncode != 0:
        raise ValueError("command failed: " + os.path.basename(args[0]) + " " + (args[1] if len(args) > 1 else ""))
    return result


def probe(args, timeout=60):
    """A read-only command whose absence means there is nothing for it to report."""
    try:
        return run(args, timeout=timeout, check=False)
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, "", "")


def systemctl(*args, check=True, timeout=90):
    return run(["systemctl", *args], timeout=timeout, check=check)


def show(unit, *properties):
    output = systemctl("show", unit, "--property=" + ",".join(properties), check=False).stdout
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def unit_pids(unit):
    """Every process in the unit's cgroup (an empty list when it is gone)."""
    group = show(unit, "ControlGroup").get("ControlGroup", "")
    if not group:
        return []
    try:
        with open("/sys/fs/cgroup" + group + "/cgroup.procs", "r") as source:
            return [int(line) for line in source.read().split() if line.isdigit()]
    except FileNotFoundError:
        return []


def uid_processes(uid):
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


def stop_agent(installation, timeout=30):
    """Stop the chat socket and the agent, then observe an empty cgroup."""
    name = "hivra-attached-" + installation
    systemctl("stop", name + ".socket", name + ".service", check=False)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not unit_pids(name + ".service"):
            return True
        time.sleep(0.5)
    return False


# ---- HTTP over the chat socket and through the gateway ------------------------

class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


def get_json(connection, route, token):
    try:
        connection.request("GET", route, headers={"Authorization": "Bearer " + token, "Host": "localhost"})
        answer = connection.getresponse()
        body = answer.read(65537)
        if answer.status != 200 or len(body) > 65536:
            return None
        value = json.loads(body)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def instance_ready(installation, token):
    """Readiness (5.5): the instance answers /api/meta over its own socket.
    The answer is agent-controlled: it decides "Chat is ready", nothing else."""
    socket_path = SOCKETS + "/" + installation + ".sock"
    try:
        info = os.lstat(socket_path)
    except FileNotFoundError:
        return False
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o660:
        return False
    meta = get_json(UnixConnection(socket_path, 10), "/api/meta", token)
    return bool(meta and meta.get("agentKind") == "codex"
                and isinstance(meta.get("attachment"), dict) and meta["attachment"].get("installationId") == installation)


def computer_token():
    home = pwd.getpwnam("bux").pw_dir
    fd = open_root_dir("/home")
    try:
        data = None
        path_fd = os.open("bux/.hivra", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            data, _ = read_file(path_fd, "api-token", 256)
        finally:
            os.close(path_fd)
        token = data.decode().strip()
        if home != "/home/bux" or not HEX64.fullmatch(token):
            raise ValueError("the computer token is unavailable")
        return token
    finally:
        os.close(fd)


def gateway_meta():
    return get_json(http.client.HTTPConnection(*GATEWAY, timeout=10), "/api/meta", computer_token())


def gateway_reaches(installation):
    meta = get_json(http.client.HTTPConnection(*GATEWAY, timeout=15), "/agents/" + installation + "/api/meta", computer_token())
    return bool(meta and isinstance(meta.get("attachment"), dict) and meta["attachment"].get("installationId") == installation)


def restart_gateway():
    systemctl("restart", "bux-hivra-chat.service", timeout=120)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        meta = gateway_meta()
        if meta and meta.get("attachedAgents") == PROTOCOL:
            return True
        time.sleep(1)
    return False


# ---- packet validation ------------------------------------------------------------

def checked(packet, action):
    if not isinstance(packet, dict) or packet.get("version") != 1 or packet.get("action") != action:
        raise ValueError("invalid packet")
    installation = packet.get("installationId")
    operation = packet.get("operationId")
    if not isinstance(installation, str) or not UUID.fullmatch(installation) or not isinstance(operation, str) or not UUID.fullmatch(operation):
        raise ValueError("invalid identity")
    boot = packet.get("bootId")
    if boot is not None and (not isinstance(boot, str) or boot != open("/proc/sys/kernel/random/boot_id").read().strip()):
        raise ValueError("the computer restarted since this step was requested")
    return installation, operation


def staged_account(installation, uid, gid):
    hexid = installation.replace("-", "")
    account = "hva_" + hexid[:24]
    user = pwd.getpwnam(account)
    if user.pw_uid != uid or user.pw_gid != gid or user.pw_dir != HOMES + "/" + installation or user.pw_shell != "/usr/sbin/nologin":
        raise ValueError("the staged account does not match")
    groups = [group.gr_name for group in grp.getgrall() if account in group.gr_mem]
    if groups:
        raise ValueError("the agent account belongs to another group")
    return account


def grants_of(packet, key="grants"):
    grants = packet.get(key)
    if not isinstance(grants, dict) or set(grants) != {"workspace"} or type(grants["workspace"]) is not bool:
        raise ValueError("invalid grants")
    return grants["workspace"]


# ---- activate ---------------------------------------------------------------------

def journal(operation, create=False):
    root = open_root_dir(JOURNAL, create_mode=0o700 if create else None)
    try:
        if stat.S_IMODE(os.fstat(root).st_mode) != 0o700:
            raise ValueError("unsafe activation journal")
        if create:
            return ensure_dir(root, operation, 0o700)
        return os.open(operation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root)
    finally:
        os.close(root)


def journal_phase(operation):
    try:
        fd = journal(operation)
    except FileNotFoundError:
        return None
    try:
        data, _ = read_file(fd, "activation.json", 16384)
        return json.loads(data).get("phase")
    except FileNotFoundError:
        return None
    finally:
        os.close(fd)


def publish_phase(operation, record, phase):
    fd = journal(operation, create=True)
    try:
        write_file(fd, "activation.json", json.dumps(dict(record, phase=phase), separators=(",", ":")), 0o600)
    finally:
        os.close(fd)


def contract_readback(installation, pid):
    """Root reads AGENTS.md back on the host and inside the unit's mount
    namespace (through /proc/<pid>/root), and compares digest and inode."""
    views = open_root_dir(VIEWS + "/" + installation)
    try:
        data, info = read_file(views, "AGENTS.md", 65536)
    finally:
        os.close(views)
    host = {"sha256": hashlib.sha256(data).hexdigest(), "inode": info.st_ino, "device": info.st_dev,
            "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid}
    unit = None
    if pid:
        try:
            inner = os.open("/proc/%d/root" % pid, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                fd = os.open((VIEWS + "/" + installation + "/AGENTS.md").lstrip("/"),
                             os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=inner)
                try:
                    unit_info = os.fstat(fd)
                    unit_data = os.read(fd, 65537)
                finally:
                    os.close(fd)
            finally:
                os.close(inner)
            unit = {"sha256": hashlib.sha256(unit_data).hexdigest(), "inode": unit_info.st_ino, "device": unit_info.st_dev}
        except OSError:
            unit = None
    matched = bool(unit and unit["sha256"] == host["sha256"] and unit["inode"] == host["inode"]
                   and host["uid"] == 0 and host["mode"] == 0o444)
    return {"sha256": host["sha256"], "checked": matched}


def observation(record, state, phase, pid=None):
    result = {"version": 1, "state": state, "journalPhase": phase, "operationId": record["operationId"],
              "activationId": record["activationId"], "installationId": record["installationId"],
              "bootId": record["bootId"], "serviceDefinitionSha256": record["serviceDefinitionSha256"]}
    if pid:
        result["mainPid"] = pid
    return result


def current_observation(record, token):
    installation = record["installationId"]
    name = "hivra-attached-" + installation
    phase = journal_phase(record["operationId"]) or "preparing"
    properties = show(name + ".service", "ActiveState", "MainPID")
    pid = int(properties.get("MainPID", "0") or 0)
    if properties.get("ActiveState") == "active" and pid > 1 and phase in ("start_requested", "service_started"):
        if instance_ready(installation, token):
            return observation(record, "native_protocol_available", phase, pid), pid
        return observation(record, "process_running", phase, pid), pid
    if phase in ("start_requested", "service_started"):
        return observation(record, "service_inactive", phase), 0
    return observation(record, "activation_unresolved", phase), 0


def activate(packet, helpers):
    installation, operation = checked(packet, "activate")
    activation = packet.get("activationId")
    definition = packet.get("serviceDefinitionSha256")
    token = packet.get("instanceToken")
    agents_md = packet.get("agentsMd")
    computer_json = packet.get("computerJson")
    hosts = packet.get("hostAddresses")
    uid, gid, memory = packet.get("uid"), packet.get("gid"), packet.get("memoryMaxMb")
    if (not isinstance(activation, str) or not UUID.fullmatch(activation) or not isinstance(definition, str)
            or not HEX64.fullmatch(definition) or not isinstance(token, str) or not HEX64.fullmatch(token)
            or not isinstance(agents_md, str) or not 0 < len(agents_md.encode()) <= 16384
            or not isinstance(computer_json, dict) or not isinstance(hosts, list) or len(hosts) > 32
            or type(uid) is not int or type(gid) is not int or type(memory) is not int):
        raise ValueError("invalid activation packet")
    workspace = grants_of(packet)
    record = {"version": 1, "operationId": operation, "activationId": activation, "installationId": installation,
              "bootId": packet["bootId"], "serviceDefinitionSha256": definition}
    phase = journal_phase(operation)
    if phase in ("start_requested", "service_started", "start_failed"):
        # A start was already requested: observe only, never a second start.
        result, pid = current_observation(record, token)
        return {"observation": result, "contract": contract_readback(installation, pid) if pid else None}

    account = staged_account(installation, uid, gid)
    home = HOMES + "/" + installation
    executable = INSTALLS + "/" + installation + "/codex"
    home_info = os.lstat(home)
    exe_info = os.lstat(executable)
    if (not stat.S_ISDIR(home_info.st_mode) or home_info.st_uid != uid or stat.S_IMODE(home_info.st_mode) != 0o700
            or not stat.S_ISREG(exe_info.st_mode) or exe_info.st_uid != 0 or exe_info.st_gid != gid):
        raise ValueError("the staged installation does not match")
    meta = gateway_meta()
    if not meta or meta.get("resourceKind") != "computer" or meta.get("attachedAgents") != PROTOCOL:
        raise ValueError("computer_update_required")
    if workspace:
        owner = pwd.getpwnam("bux")
        source = os.lstat("/home/bux/Hivra")
        if not stat.S_ISDIR(source.st_mode) or source.st_uid != owner.pw_uid:
            raise ValueError("workspace_path_not_plain")
    units, group, _ = render_units(installation, account, home, executable, workspace, memory)
    if definition_sha256(installation, workspace, memory, units, {key: hashlib.sha256(helpers[key]).hexdigest() for key in helpers}) != definition:
        raise ValueError("the service definition does not match what Hivra recorded")

    publish_phase(operation, record, "preparing")
    try:
        grp.getgrnam(group)
    except KeyError:
        run(["groupadd", "--system", group])
    gateway_gid = grp.getgrnam(group).gr_gid
    if grp.getgrnam(group).gr_mem:
        raise ValueError("the gateway group has members")
    for deny in ("/etc/cron.deny", "/etc/at.deny"):
        etc = open_root_dir("/etc")
        try:
            name = os.path.basename(deny)
            try:
                existing, _ = read_file(etc, name, 1 << 20)
            except FileNotFoundError:
                existing = b""
            entries = existing.decode().splitlines()
            if account not in entries:
                write_file(etc, name, "\n".join(entries + [account]) + "\n", 0o644)
        finally:
            os.close(etc)

    views = open_root_dir(VIEWS, create_mode=0o711)
    try:
        if stat.S_IMODE(os.fstat(views).st_mode) != 0o711:
            os.fchmod(views, 0o711)
        view = ensure_dir(views, installation, 0o750, gid)
        try:
            try:
                os.mkdir("Hivra", 0, dir_fd=view)
            except FileExistsError:
                pass
            point = os.lstat(VIEWS + "/" + installation + "/Hivra")
            if not stat.S_ISDIR(point.st_mode) or point.st_uid != 0:
                raise ValueError("workspace_path_not_plain")
            write_file(view, "AGENTS.md", agents_md, 0o444)
        finally:
            os.close(view)
    finally:
        os.close(views)
    attachments = open_root_dir(ATTACHMENTS, create_mode=0o755)
    try:
        folder = ensure_dir(attachments, installation, 0o755)
        try:
            write_file(folder, "binding.json", json.dumps({"version": 1, "installationId": installation, "account": account,
                                                           "uid": uid, "gid": gid, "workspace": workspace,
                                                           "gatewayGid": gateway_gid}, separators=(",", ":")), 0o644)
            write_file(folder, "network.json", json.dumps({"version": 1, "installationId": installation,
                                                           "hostAddresses": hosts}, separators=(",", ":")), 0o644)
            write_file(folder, "computer.json", json.dumps(computer_json, separators=(",", ":"), sort_keys=True), 0o644)
            write_file(folder, "resolv.conf", "nameserver 127.0.0.53\noptions edns0 trust-ad\n", 0o644)
            write_file(folder, "instance-token", token, 0o440, gid)
            write_file(folder, "gateway-token", token, 0o440, gateway_gid)
        finally:
            os.close(folder)
    finally:
        os.close(attachments)
    helper_dir = open_root_dir(HELPERS, create_mode=0o755)
    try:
        for key, target in HELPER_TARGETS.items():
            write_file(helper_dir, target, helpers[key], 0o755)
    finally:
        os.close(helper_dir)
    unit_dir = open_root_dir(UNITS)
    try:
        dropins = ensure_dir(unit_dir, "bux-hivra-chat.service.d", 0o755)
        os.close(dropins)
        for name, path, content in units:
            parent = open_root_dir(os.path.dirname(path))
            try:
                write_file(parent, os.path.basename(path), content, 0o644)
            finally:
                os.close(parent)
    finally:
        os.close(unit_dir)
    systemctl("daemon-reload")

    publish_phase(operation, record, "start_requested")
    name = "hivra-attached-" + installation
    failure = None
    try:
        systemctl("start", name + "-workspace.service", name + "-network.service", name + "-dns.socket", timeout=120)
        verdict = json.loads(run([HELPERS + "/attached-network", "enforce", installation], timeout=180).stdout)
        if verdict.get("state") != "enforced":
            failure = "network_not_enforced"
        else:
            systemctl("start", name + ".socket")
            ready = False
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline and not ready:
                ready = instance_ready(installation, token)
                if not ready:
                    time.sleep(1)
            if not ready:
                failure = "chat_not_ready"
            elif not restart_gateway() or not gateway_reaches(installation):
                failure = "gateway_unreachable"
    except (ValueError, OSError, subprocess.TimeoutExpired):
        failure = failure or "start_failed"
    if failure:
        stop_agent(installation)
        systemctl("stop", name + "-dns.socket", name + "-dns.service", name + "-network.service", name + "-workspace.service",
                  check=False)
        publish_phase(operation, dict(record, failure=failure), "start_failed")
        return {"observation": observation(record, "service_inactive", "start_failed"), "contract": None, "failure": failure}
    systemctl("enable", name + ".socket", name + "-workspace.service", name + "-network.service", name + "-dns.socket",
              name + "-watchdog.timer", name + ".service")
    systemctl("start", name + "-watchdog.timer")
    publish_phase(operation, record, "service_started")
    result, pid = current_observation(record, token)
    return {"observation": result, "contract": contract_readback(installation, pid) if pid else None}


def observe(packet, helpers):
    installation, operation = checked(packet, "observe")
    token = packet.get("instanceToken")
    if not isinstance(token, str) or not HEX64.fullmatch(token):
        raise ValueError("invalid packet")
    record = {"operationId": operation, "activationId": packet.get("activationId"), "installationId": installation,
              "bootId": packet.get("bootId"), "serviceDefinitionSha256": packet.get("serviceDefinitionSha256")}
    result, pid = current_observation(record, token)
    return {"observation": result, "contract": contract_readback(installation, pid) if pid else None}


# ---- access ---------------------------------------------------------------------------

def rewrite_attachment(installation, workspace, units, agents_md):
    attachments = open_root_dir(ATTACHMENTS + "/" + installation)
    try:
        data, _ = read_file(attachments, "binding.json", 16384)
        record = json.loads(data)
        record["workspace"] = workspace
        write_file(attachments, "binding.json", json.dumps(record, separators=(",", ":")), 0o644)
    finally:
        os.close(attachments)
    view = open_root_dir(VIEWS + "/" + installation)
    try:
        write_file(view, "AGENTS.md", agents_md, 0o444)
    finally:
        os.close(view)
    for name, path, content in units:
        parent = open_root_dir(os.path.dirname(path))
        try:
            write_file(parent, os.path.basename(path), content, 0o644)
        finally:
            os.close(parent)
    systemctl("daemon-reload")


def view_mounted(installation):
    state = json.loads(run([HELPERS + "/attached-workspace", "state", installation]).stdout)
    return bool(state.get("mounted"))


def apply_view(installation, workspace):
    name = "hivra-attached-" + installation
    # The workspace unit's ExecStart reads the grant from binding.json.
    systemctl("restart", name + "-workspace.service", timeout=120)
    if view_mounted(installation) != workspace:
        raise ValueError("the view does not match the grant")


def access(packet, helpers):
    installation, operation = checked(packet, "access")
    token, agents_md, previous_md = packet.get("instanceToken"), packet.get("agentsMd"), packet.get("previousAgentsMd")
    uid, gid, memory = packet.get("uid"), packet.get("gid"), packet.get("memoryMaxMb")
    if (not isinstance(token, str) or not HEX64.fullmatch(token) or not isinstance(agents_md, str)
            or not isinstance(previous_md, str) or type(uid) is not int or type(gid) is not int or type(memory) is not int):
        raise ValueError("invalid access packet")
    workspace, previous = grants_of(packet), grants_of(packet, "previousGrants")
    account = staged_account(installation, uid, gid)
    home, executable = HOMES + "/" + installation, INSTALLS + "/" + installation + "/codex"
    new_units, _, _ = render_units(installation, account, home, executable, workspace, memory)
    old_units, _, _ = render_units(installation, account, home, executable, previous, memory)
    receipt = {"version": 1, "operationId": operation, "installationId": installation}
    if workspace:
        # Refuse before Codex stops: the helper opens both ends without
        # following a link and names what it found.
        checked_state = run([HELPERS + "/attached-workspace", "state", installation], check=False)
        source = os.lstat("/home/bux/Hivra")
        if (checked_state.returncode != 0 or not stat.S_ISDIR(source.st_mode)
                or source.st_uid != pwd.getpwnam("bux").pw_uid):
            reason = "workspace_path_not_plain" if "workspace_path_not_plain" in checked_state.stderr or checked_state.returncode == 0 \
                else "workspace_state_unavailable"
            return dict(receipt, state="refused", reason=reason)
    # Codex is never running while its view changes (5.5).
    if not stop_agent(installation):
        return dict(receipt, state="unresolved", reason="agent_did_not_stop")
    name = "hivra-attached-" + installation
    try:
        rewrite_attachment(installation, workspace, new_units, agents_md)
        apply_view(installation, workspace)
        systemctl("start", name + ".socket")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if instance_ready(installation, token):
                pid = int(show(name + ".service", "MainPID").get("MainPID", "0") or 0)
                return dict(receipt, state="ready", grants={"workspace": workspace}, viewMounted=view_mounted(installation),
                            contract=contract_readback(installation, pid) if pid > 1 else None)
            time.sleep(1)
        raise ValueError("chat_not_ready")
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        # Put the previous grant back and say what is observed now.
        stop_agent(installation)
        try:
            rewrite_attachment(installation, previous, old_units, previous_md)
            apply_view(installation, previous)
            systemctl("start", name + ".socket")
        except (ValueError, OSError, subprocess.TimeoutExpired):
            return dict(receipt, state="unresolved", reason="restore_failed")
        reason = str(error) if str(error) in ("chat_not_ready", "workspace_path_not_plain") else "change_failed"
        return dict(receipt, state="restored", reason=reason, viewMounted=view_mounted(installation))


# ---- state -----------------------------------------------------------------------

def state_action(packet, helpers):
    """Read-only: what an access change left behind, for a worker whose answer
    was lost. It never changes anything, so it is never a retry."""
    installation, operation = checked(packet, "state")
    token = packet.get("instanceToken")
    if token is not None and (not isinstance(token, str) or not HEX64.fullmatch(token)):
        raise ValueError("invalid packet")
    hexid = installation.replace("-", "")
    try:
        pwd.getpwnam("hva_" + hexid[:24])
        account = True
    except KeyError:
        account = False
    name = "hivra-attached-" + installation
    result = {"version": 1, "operationId": operation, "installationId": installation, "accountPresent": account,
              "unitsPresent": os.path.lexists(UNITS + "/" + name + ".service"), "workspace": None, "viewMounted": False,
              "agentActive": show(name + ".service", "ActiveState").get("ActiveState") == "active", "chatReady": False}
    if os.path.isdir(ATTACHMENTS + "/" + installation):
        folder = open_root_dir(ATTACHMENTS + "/" + installation)
        try:
            data, _ = read_file(folder, "binding.json", 16384)
        finally:
            os.close(folder)
        record = json.loads(data)
        result["workspace"] = record.get("workspace") if type(record.get("workspace")) is bool else None
        result["viewMounted"] = view_mounted(installation)
    if token and result["agentActive"]:
        result["chatReady"] = instance_ready(installation, token)
    return result


# ---- remove -----------------------------------------------------------------------------

def leftover_files(uid):
    """Files the account still owns anywhere on the root filesystem (never deleted here)."""
    result = run(["find", "/", "-xdev", "(", "-path", "/proc", "-o", "-path", "/sys", "-o", "-path", "/run", ")", "-prune",
                  "-o", "-uid", str(uid), "-print", "-quit"], timeout=300, check=False)
    return 1 if result.stdout.strip() else 0


def remove_tree(parent, name):
    """Delete a root-owned folder we created: no link is followed, no mount is crossed."""
    try:
        top = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:
        return
    device = os.fstat(top).st_dev
    stack = [(top, sorted(os.listdir(top)))]
    pending = []
    try:
        while stack:
            fd, names = stack[-1]
            if not names:
                stack.pop()
                os.close(fd)
                if stack:
                    os.rmdir(pending.pop(), dir_fd=stack[-1][0])
                continue
            entry = names.pop()
            info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            if info.st_dev != device:
                raise ValueError("detach_mount_found")
            if stat.S_ISDIR(info.st_mode):
                child = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                if os.fstat(child).st_dev != device:
                    os.close(child)
                    raise ValueError("detach_mount_found")
                pending.append(entry)
                stack.append((child, sorted(os.listdir(child))))
            else:
                os.unlink(entry, dir_fd=fd)
    finally:
        for fd, _ in stack:
            os.close(fd)
    os.rmdir(name, dir_fd=parent)


STAGING = "/var/lib/hivra/attachment-staging"


def clear_staging_journal(installation):
    """The staging worker keeps one journal per computer and never stages over
    it, so a later attach of a new agent needs this one gone. Only the journal
    of this installation is removed, under the stager's own lock."""
    import fcntl
    try:
        root = open_root_dir(STAGING)
    except FileNotFoundError:
        return True
    try:
        if stat.S_IMODE(os.fstat(root).st_mode) != 0o700:
            raise ValueError("unsafe staging journal")
        lock = os.open("installer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=root)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                data, _ = read_file(root, "staging.json", 16384)
            except FileNotFoundError:
                return True
            record = json.loads(data)
            identity = record.get("identity") if isinstance(record, dict) else None
            if not isinstance(identity, dict) or identity.get("installationId") != installation:
                return True
            os.unlink("staging.json", dir_fd=root)
            os.fsync(root)
            return True
        finally:
            os.close(lock)
    finally:
        os.close(root)


def remove(packet, helpers):
    installation, operation = checked(packet, "remove")
    hexid = installation.replace("-", "")
    account, group = "hva_" + hexid[:24], "hvc_" + hexid[:24]
    name = "hivra-attached-" + installation
    receipt = {"version": 1, "operationId": operation, "installationId": installation, "workspaceTouched": False}
    try:
        user = pwd.getpwnam(account)
    except KeyError:
        user = None
    if user and (user.pw_dir != HOMES + "/" + installation or user.pw_uid == 0):
        raise ValueError("unexpected agent account")
    # Activation writes this registry before any unit exists. Without it the
    # agent never ran here: only staging and the pinned `codex --version`
    # wrote to its home, and the gateway drop-in folder may never have been made.
    registered = os.path.isdir(ATTACHMENTS + "/" + installation)
    # 1. Stop everything and lock the account; no process of its uid may remain.
    stop_agent(installation)
    systemctl("stop", name + "-watchdog.timer", name + "-watchdog.service", name + "-probe.service", check=False)
    if user:
        run(["usermod", "--lock", "--expiredate", "1", account], check=False)
        deadline = time.monotonic() + 30
        while uid_processes(user.pw_uid) and time.monotonic() < deadline:
            run(["pkill", "-KILL", "-u", str(user.pw_uid)], check=False)
            time.sleep(0.5)
        if uid_processes(user.pw_uid):
            return dict(receipt, state="unresolved", reason="agent_processes_remain")
    # 2. The view: unmount only. Nothing on disk under ~/Hivra changes.
    systemctl("stop", name + "-workspace.service", check=False)
    view_path = VIEWS + "/" + installation + "/Hivra"
    if os.path.isdir(ATTACHMENTS + "/" + installation):
        try:
            run([HELPERS + "/attached-workspace", "unmount", installation], check=False)
        except FileNotFoundError:
            pass
    mounted = any(line.split()[4] == view_path or line.split()[4].startswith(view_path + "/")
                  for line in open("/proc/self/mountinfo").read().splitlines() if len(line.split()) > 4)
    receipt["viewUnmounted"] = not mounted
    if mounted:
        return dict(receipt, state="unresolved", reason="view_still_mounted")
    # 3. The network: namespace, veth, nftables table, DNS socket and relay.
    systemctl("stop", name + "-dns.socket", name + "-dns.service", name + "-network.service", check=False)
    if os.path.exists(HELPERS + "/attached-network") and os.path.isdir(ATTACHMENTS + "/" + installation):
        run([HELPERS + "/attached-network", "down", installation], check=False)
    # A computer without ip or nft has no namespace or table to remove.
    network = probe(["ip", "netns", "list"]).stdout
    table = probe(["nft", "list", "table", "inet", "hivra_attached_" + hexid[:12]]).returncode == 0
    receipt["networkRemoved"] = ("hivra-" + hexid[:12]) not in network and not table
    # 4. Units and the gateway drop-in.
    units, _, _ = render_units(installation, account, HOMES + "/" + installation, INSTALLS + "/" + installation + "/codex", False, 512)
    systemctl("disable", *[unit for unit, _, _ in units if not unit.startswith("bux-")], check=False)
    for _, path, _ in units:
        try:
            parent = open_root_dir(os.path.dirname(path))
        except FileNotFoundError:
            continue  # Its folder was never made, so neither was the unit.
        try:
            unlink_quiet(parent, os.path.basename(path))
        finally:
            os.close(parent)
    systemctl("daemon-reload")
    systemctl("reset-failed", check=False)
    receipt["unitsRemoved"] = not any(os.path.exists(path) for _, path, _ in units)
    restart_gateway()
    # 5. The private home, with the no-follow, no-cross-mount walker.
    if user and registered:
        home = run([HELPERS + "/attached-workspace", "remove-home", installation], check=False)
        if home.returncode != 0:
            return dict(receipt, state="unresolved", reason="home_not_removed")
    elif not registered:
        # Never activated: the helper has no binding to work from. The same
        # no-follow, no-cross-mount walk removes what staging left.
        try:
            homes = open_root_dir(HOMES)
        except FileNotFoundError:
            homes = None
        if homes is not None:
            try:
                remove_tree(homes, installation)
            finally:
                os.close(homes)
    receipt["homeRemoved"] = not os.path.lexists(HOMES + "/" + installation)
    # 6. Installation, registry, starting folder.
    for parent_path, entry in ((INSTALLS, installation), (ATTACHMENTS, installation), (VIEWS, installation)):
        try:
            parent = open_root_dir(parent_path)
        except FileNotFoundError:
            continue
        try:
            remove_tree(parent, entry)
        finally:
            os.close(parent)
    # 7. Account and groups (the home is gone; userdel never gets -r).
    uid = user.pw_uid if user else None
    if user:
        run(["userdel", account], check=False)
    for name_ in (account, group):
        try:
            grp.getgrnam(name_)
            run(["groupdel", name_], check=False)
        except KeyError:
            pass
    for deny in ("/etc/cron.deny", "/etc/at.deny"):
        etc = open_root_dir("/etc")
        try:
            try:
                existing, _ = read_file(etc, os.path.basename(deny), 1 << 20)
            except FileNotFoundError:
                continue
            entries = [entry for entry in existing.decode().splitlines() if entry != account]
            write_file(etc, os.path.basename(deny), ("\n".join(entries) + "\n") if entries else "", 0o644)
        finally:
            os.close(etc)
    try:
        pwd.getpwnam(account)
        account_gone = False
    except KeyError:
        account_gone = True
    groups_gone = True
    for name_ in (account, group):
        try:
            grp.getgrnam(name_)
            groups_gone = False
        except KeyError:
            pass
    receipt["accountRemoved"] = account_gone and groups_gone
    # 8. The stager's journal of this installation, so a new agent can be added later.
    receipt["stagingCleared"] = clear_staging_journal(installation)
    # 9. Anything else the uid still owns is held for review, never deleted.
    receipt["leftoverFiles"] = leftover_files(uid) if uid is not None else 0
    done = all(receipt.get(key) for key in ("viewUnmounted", "networkRemoved", "unitsRemoved", "homeRemoved", "accountRemoved",
                                            "stagingCleared"))
    receipt["state"] = "removed" if done and receipt["leftoverFiles"] == 0 else "unresolved"
    if receipt["state"] == "unresolved" and "reason" not in receipt:
        receipt["reason"] = "leftover_files" if receipt["leftoverFiles"] else "incomplete"
    return receipt


ACTIONS = {"activate": activate, "observe": observe, "access": access, "remove": remove, "state": state_action}


def main(packet, helpers):
    if os.geteuid() != 0:
        raise ValueError("requires the bound guest root")
    action = packet.get("action") if isinstance(packet, dict) else None
    if action not in ACTIONS:
        raise ValueError("invalid action")
    return ACTIONS[action](packet, helpers)
