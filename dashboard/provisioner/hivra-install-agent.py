#!/usr/bin/env python3
"""Shared guest entry point; its caller owns the computer/lifecycle authority.

Read one bounded launch document from stdin, never from argv or a sourced env
file. This does not allocate capacity, choose a default agent, acquire a lease,
or certify public reachability. Both substrates run the existing guest runtime
installer. A provider VM requires exactly one pre-journaled access binding:
either the hosted named-tunnel credential or a standalone direct hostname.
"""
import ctypes
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


KINDS = {"claude", "codex", "aeon", "openclaw", "agent-zero"}
FIELDS = {"version", "agentKind", "computerSubstrate", "wantBrowser", "modelKey",
          "modelBaseUrl", "model", "tunnelToken", "accessHostname"}
LINUX_DESKTOP_FIELDS = FIELDS | {"publicOrigin", "computerId", "controlOrigin"}
# v4 is v1 plus the agent-run reporter credential, for the two runtimes whose
# transcripts it reads. Contract:
# docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md
ACTIVITY_TELEMETRY_KINDS = {"claude", "codex"}
ACTIVITY_TELEMETRY_FIELDS = {"endpoint", "resourceId", "token", "expiresAt"}
_ORIGIN_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
ACTIVITY_ENDPOINT = re.compile(r"https://(?:" + _ORIGIN_LABEL + r"\.)*" + _ORIGIN_LABEL
                               + r"(?::[0-9]{1,5})?/api/activity/ingest")
ACTIVITY_RESOURCE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ACTIVITY_TOKEN = re.compile(r"hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
ACTIVITY_EXPIRES_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3}|\.[0-9]{6})?Z")
ACTIVITY_REPORTER_TIMEOUT_SECONDS = 120
MAX_INPUT_BYTES = 32768
TOKEN_FILE = Path("/etc/hivra-cf-token.env")
UNIT_FILE = Path("/etc/systemd/system/hivra-cf-tunnel.service")
DIRECT_CONFIG_FILE = Path("/etc/hivra-direct-access.Caddyfile")
DIRECT_UNIT_FILE = Path("/etc/systemd/system/hivra-direct-access.service")
LOCK_FILE = Path("/run/hivra-agent-install.lock")
UNIT = b"""[Unit]
Description=Hivra CloudFlare named tunnel
After=network-online.target
[Service]
EnvironmentFile=/etc/hivra-cf-token.env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --protocol http2 run
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
"""
DIRECT_UNIT = b"""[Unit]
Description=Hivra standalone HTTPS access
After=network-online.target
Wants=network-online.target
[Service]
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy/config
ExecStart=/usr/local/bin/caddy run --config /etc/hivra-direct-access.Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/hivra-direct-access.Caddyfile
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/caddy
[Install]
WantedBy=multi-user.target
"""


class InstallError(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InstallError("duplicate launch field")
        result[key] = value
    return result


def parse_launch(raw, *, provider_desktop=False):
    try:
        if not raw or len(raw) > MAX_INPUT_BYTES:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError()
        version = value.get("version")
        if type(provider_desktop) is not bool or (provider_desktop and (version != 3 or value.get("computerSubstrate") != "provider-vm")):
            raise ValueError()
        expected_fields = (FIELDS if version == 1 else FIELDS | {"publicOrigin"} if version == 2
                           else LINUX_DESKTOP_FIELDS if version == 3 else FIELDS | {"activityTelemetry"})
        if type(version) is not int or version not in (1, 2, 3, 4) or set(value) != expected_fields:
            raise ValueError()
        if ((version == 1 and value["agentKind"] not in KINDS)
                or (version == 2 and value["agentKind"] != "deepseek-harness")
                or (version == 3 and value["agentKind"] != "linux-desktop")
                or (version == 4 and value["agentKind"] not in ACTIVITY_TELEMETRY_KINDS)):
            raise ValueError()
        # Agent-run reporting is verified only on Proxmox computers.
        if version == 4 and (value["computerSubstrate"] != "proxmox-kvm"
                             or not valid_activity_telemetry(value["activityTelemetry"])):
            raise ValueError()
        if value["computerSubstrate"] not in {"proxmox-kvm", "provider-vm"}:
            raise ValueError()
        if value["wantBrowser"] is not None and type(value["wantBrowser"]) is not bool:
            raise ValueError()
        for key, limit in (("modelKey", 8192), ("modelBaseUrl", 2048), ("model", 256)):
            text = value[key]
            if not isinstance(text, str) or len(text.encode("utf-8")) > limit:
                raise ValueError()
            if any(ord(char) < 32 or ord(char) == 127 for char in text):
                raise ValueError()
        token = value["tunnelToken"]
        if token is not None and (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9._=-]{1,8192}", token)):
            raise ValueError()
        hostname = value["accessHostname"]
        if hostname is not None and (not isinstance(hostname, str) or not re.fullmatch(r"(?:[0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io", hostname)):
            raise ValueError()
        if hostname is not None:
            octets = hostname.removesuffix(".sslip.io").split("-")
            if len(octets) != 4 or any(not part.isdigit() or not 0 <= int(part) <= 255 or (len(part) > 1 and part[0] == "0") for part in octets):
                raise ValueError()
        if value["computerSubstrate"] == "provider-vm" and ((token is None) == (hostname is None)):
            raise ValueError()
        if value["computerSubstrate"] != "provider-vm" and hostname is not None:
            raise ValueError()
        if version in (2, 3):
            # Native runtimes require one pre-journaled HTTPS authority. Provider
            # VMs may use named or direct access; Proxmox uses a named tunnel and
            # must never fall back to an unbound quick-tunnel hostname.
            if not canonical_origin(value["publicOrigin"]):
                raise ValueError()
            if value["computerSubstrate"] == "proxmox-kvm" and (token is None or hostname is not None):
                raise ValueError()
            if hostname is not None and value["publicOrigin"] != "https://" + hostname:
                raise ValueError()
            # Never silently discard launch-time secrets/settings. Native
            # Models UI owns these until typed key custody is implemented.
            if any(value[key] for key in ("modelKey", "modelBaseUrl", "model")):
                raise ValueError()
        if version == 3:
            if value["computerSubstrate"] != ("provider-vm" if provider_desktop else "proxmox-kvm") or value["wantBrowser"] is not None:
                raise ValueError()
            if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value["computerId"]):
                raise ValueError()
            if not canonical_origin(value["controlOrigin"]):
                raise ValueError()
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError, InstallError):
        # Never propagate parser exceptions containing input credentials.
        raise InstallError("invalid guest launch document") from None


def valid_activity_telemetry(value):
    if (not isinstance(value, dict) or set(value) != ACTIVITY_TELEMETRY_FIELDS
            or not all(isinstance(item, str) for item in value.values())):
        return False
    if len(value["endpoint"]) > 300 or not ACTIVITY_ENDPOINT.fullmatch(value["endpoint"]):
        return False
    if not ACTIVITY_RESOURCE_ID.fullmatch(value["resourceId"]):
        return False
    if len(value["token"].encode("utf-8")) > 4096 or not ACTIVITY_TOKEN.fullmatch(value["token"]):
        return False
    if not ACTIVITY_EXPIRES_AT.fullmatch(value["expiresAt"]):
        return False
    try:
        datetime.datetime.fromisoformat(value["expiresAt"][:-1])
    except ValueError:
        return False
    return True


def canonical_origin(value):
    if not isinstance(value, str) or len(value) > 261 or not value.startswith("https://"):
        return False
    hostname = value[8:]
    return ("." in hostname and bool(re.fullmatch(r"[a-z]{2,63}", hostname.split(".")[-1]))
            and all(not label.startswith("xn--") and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                    for label in hostname.split(".")))


def check_directory(directory, uid):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise InstallError("unsafe guest configuration directory")


def read_existing(file, uid, mode):
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode or info.st_size > 16384:
            raise InstallError("unsafe guest configuration file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read(16385)
    finally:
        os.close(fd)


def create_exact(file, data, uid, mode):
    existing = read_existing(file, uid, mode)
    if existing is not None:
        if existing != data:
            raise InstallError("existing tunnel configuration differs; explicit repair required")
        return
    fd, temporary = tempfile.mkstemp(prefix=".hivra-install-", dir=file.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
        # Publish without replacement or a crash window with two hard links.
        publish_exclusive(temporary, file)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass  # Successful atomic rename consumed this exact temporary file.
    directory_fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def publish_exclusive(source, destination):
    # Ubuntu 22.04/glibc exposes Linux renameat2. Do not fall back to a racy
    # exists+replace or link+unlink publication if the syscall is unavailable.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise InstallError("atomic guest configuration publication is unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        raise OSError(ctypes.get_errno(), "exclusive guest configuration publication failed")


def check_named_tunnel(token, uid):
    # Validate both destinations before writing either. Existing credentials
    # and custom unit definitions are not silently rotated or overwritten.
    for directory in (TOKEN_FILE.parent, UNIT_FILE.parent.parent, UNIT_FILE.parent):
        check_directory(directory, uid)
    expected = b"TUNNEL_TOKEN=" + token.encode("ascii") + b"\n"
    for file, data, mode in ((TOKEN_FILE, expected, 0o600), (UNIT_FILE, UNIT, 0o644)):
        existing = read_existing(file, uid, mode)
        if existing is not None and existing != data:
            raise InstallError("existing tunnel configuration differs; explicit repair required")
    return expected


def service(arguments, capture=False):
    # A live terminal can keep cloudflared draining until systemd's Ubuntu
    # stop deadline (90s). Restart includes both stop and start jobs (90s each),
    # plus acknowledgement time. A 15s client timeout orphaned that valid job
    # and reported failure while systemd was still completing the restart.
    timeout = 195 if tuple(arguments) in (("restart", "hivra-cf-tunnel.service"),
                                          ("restart", "hivra-direct-access.service")) else 15
    try:
        return subprocess.run(["/usr/bin/systemctl", *arguments], check=True, timeout=timeout,
                              env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        # Do not print exception text: it can contain command/output data.
        print("Hivra tunnel service command exceeded its bounded deadline; inspect the service journal.", file=sys.stderr)
        raise


def check_effective_tunnel(allow_missing):
    actual = service(("show", "--property=FragmentPath", "--property=DropInPaths", "--property=LoadState",
                      "hivra-cf-tunnel.service"), True).stdout
    expected = {b"FragmentPath=" + os.fsencode(UNIT_FILE), b"DropInPaths=", b"LoadState=loaded"}
    absent = {b"FragmentPath=", b"DropInPaths=", b"LoadState=not-found"}
    if len(actual) > 16384 or len(actual.splitlines()) != 3:
        raise InstallError("unexpected tunnel service definition")
    if set(actual.splitlines()) != expected and not (allow_missing and set(actual.splitlines()) == absent):
        raise InstallError("custom tunnel service override requires explicit repair")


def configure_named_tunnel(token, uid):
    expected = check_named_tunnel(token, uid)
    # Inspect before publication too: a new /etc unit must not shadow a custom
    # same-name fragment under /run or /usr/lib and then look valid after reload.
    check_effective_tunnel(allow_missing=True)
    if not os.access("/usr/local/bin/cloudflared", os.X_OK):
        raise InstallError("cloudflared is missing")
    create_exact(TOKEN_FILE, expected, uid, 0o600)
    create_exact(UNIT_FILE, UNIT, uid, 0o644)
    # Do not pkill unrelated tunnels or discard a user's tmux sessions. Restart
    # only this unit: daemon-reload/is-active alone cannot prove a pre-existing
    # process actually consumed the exact configuration and token above.
    service(("daemon-reload",))
    check_effective_tunnel(allow_missing=False)
    for arguments in (("enable", "hivra-cf-tunnel.service"), ("restart", "hivra-cf-tunnel.service"),
                      ("is-active", "--quiet", "hivra-cf-tunnel.service")):
        service(arguments)


def direct_config(hostname):
    return (hostname + " {\n\treverse_proxy 127.0.0.1:8080\n}\n").encode("ascii")


def check_direct_access(hostname, uid):
    for directory in (DIRECT_CONFIG_FILE.parent, DIRECT_UNIT_FILE.parent.parent, DIRECT_UNIT_FILE.parent):
        check_directory(directory, uid)
    expected = direct_config(hostname)
    for file, data, mode in ((DIRECT_CONFIG_FILE, expected, 0o644), (DIRECT_UNIT_FILE, DIRECT_UNIT, 0o644)):
        existing = read_existing(file, uid, mode)
        if existing is not None and existing != data:
            raise InstallError("existing direct-access configuration differs; explicit repair required")
    return expected


def check_effective_direct_access(allow_missing):
    actual = service(("show", "--property=FragmentPath", "--property=DropInPaths", "--property=LoadState",
                      "hivra-direct-access.service"), True).stdout
    expected = {b"FragmentPath=" + os.fsencode(DIRECT_UNIT_FILE), b"DropInPaths=", b"LoadState=loaded"}
    absent = {b"FragmentPath=", b"DropInPaths=", b"LoadState=not-found"}
    if len(actual) > 16384 or len(actual.splitlines()) != 3:
        raise InstallError("unexpected direct-access service definition")
    if set(actual.splitlines()) != expected and not (allow_missing and set(actual.splitlines()) == absent):
        raise InstallError("custom direct-access service override requires explicit repair")


def configure_direct_access(hostname, uid):
    expected = check_direct_access(hostname, uid)
    check_effective_direct_access(allow_missing=True)
    if not os.access("/usr/local/bin/caddy", os.X_OK):
        raise InstallError("caddy is missing")
    create_exact(DIRECT_CONFIG_FILE, expected, uid, 0o644)
    create_exact(DIRECT_UNIT_FILE, DIRECT_UNIT, uid, 0o644)
    service(("daemon-reload",))
    check_effective_direct_access(allow_missing=False)
    for arguments in (("enable", "hivra-direct-access.service"), ("restart", "hivra-direct-access.service"),
                      ("is-active", "--quiet", "hivra-direct-access.service")):
        service(arguments)


def install_agent(launch, source, *, provider_desktop=None):
    # Only the original locked v3 worker may supply this in-process composition.
    # The stdin CLI never supplies it, nor does a request select executable code.
    owned_desktop = launch.get("agentKind") == "linux-desktop" and launch.get("computerSubstrate") == "provider-vm"
    if owned_desktop:
        if not callable(provider_desktop):
            raise InstallError("provider desktop requires owned worker composition")
        launch = parse_launch(json.dumps(launch).encode("utf8"), provider_desktop=True)
    elif provider_desktop is not None:
        raise InstallError("unexpected provider desktop composition")
    environment = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                   "HOME": "/root", "LANG": "C.UTF-8", "HIVRA_AGENT_KIND": launch["agentKind"],
                   "HIVRA_COMPUTER_SUBSTRATE": launch["computerSubstrate"],
                   "HIVRA_WANT_BROWSER": "" if launch["wantBrowser"] is None else str(int(launch["wantBrowser"])),
                   "HIVRA_MODEL_KEY": launch["modelKey"], "HIVRA_MODEL_BASE_URL": launch["modelBaseUrl"],
                   "HIVRA_HERMES_MODEL": launch["model"],
                   "HIVRA_ACCESS_HOSTNAME": launch["accessHostname"] or "",
                   "HIVRA_COMPUTER_ID": launch.get("computerId", ""),
                   "HIVRA_CONTROL_ORIGIN": launch.get("controlOrigin", ""),
                   "HIVRA_PUBLIC_ORIGIN": launch.get("publicOrigin", "")}
    if launch["tunnelToken"] is not None:
        check_named_tunnel(launch["tunnelToken"], 0)
        check_effective_tunnel(allow_missing=True)
    if launch["accessHostname"] is not None:
        check_direct_access(launch["accessHostname"], 0)
        check_effective_direct_access(allow_missing=True)
    # The existing enclosing lifecycle worker owns timeout/compensation. This
    # entrypoint is synchronous: no detached worker or unowned retry is created.
    def bootstrap():
        subprocess.run(["/bin/bash", str(source / "provision-claude-code-box.sh")],
                       check=True, env=environment, stdin=subprocess.DEVNULL)
    if owned_desktop:
        # Caller already holds once-only worker dispatch, the install lock,
        # fresh-base preflight and retained cleanup. Base completion is neither
        # desktop activation nor readiness, and cannot be replayed on error.
        environment["HIVRA_PROVIDER_DESKTOP_PREPARE_ONLY"] = "1"
        bootstrap()
        capability = provider_desktop()
        if (not isinstance(capability, dict) or capability.get("protocol") != "hivra-remote-desktop-installed-v1"
                or capability.get("computerId") != launch["computerId"] or capability.get("computerKind") != "hivra-agent"):
            raise InstallError("provider desktop readiness could not be verified")
        subprocess.run(["/usr/bin/python3", "-I", "-B", str(source / "hivra-runtime-receipt.py"),
                        "--provisioner-version", (source / "VERSION").read_text().strip(),
                        "--agent-kind", "linux-desktop", "--substrate", "provider-vm", "--browser-enabled", "0"],
                       check=True, timeout=120, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, stdin=subprocess.DEVNULL)
        configure_access(launch, source)
    elif launch["agentKind"] == "deepseek-harness":
        # Validate source ancestry BEFORE importing executable Python modules.
        for directory in reversed((source, *source.parents)):
            check_directory(directory, 0)
            if directory.resolve() != directory:
                raise InstallError("unsafe native guest source")
        native_source = source / "deepseek-harness"
        check_directory(native_source, 0)
        for name in ("install-guest.py", "service-owner.py", "install-native.py"):
            info = (native_source / name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
                raise InstallError("unsafe native guest source")
        spec = importlib.util.spec_from_file_location("hivra_native_guest", native_source / "install-guest.py")
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        environment["HIVRA_NATIVE_PREPARE_ONLY"] = "1"
        native.install(launch, source, bootstrap)
        # The base-only pass deliberately did not record a runtime receipt.
        try:
            subprocess.run(["/usr/bin/python3", "-I", "-B", str(source / "hivra-runtime-receipt.py"),
                            "--provisioner-version", (source / "VERSION").read_text().strip(),
                            "--agent-kind", launch["agentKind"], "--substrate", launch["computerSubstrate"],
                            "--browser-enabled", "1" if launch["wantBrowser"] else "0"],
                           check=True, timeout=120, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, stdin=subprocess.DEVNULL)
            configure_access(launch, source)
        except Exception:
            native.owner.stop_owned()
            raise
    else:
        bootstrap()
        if launch.get("version") == 4:
            # After bootstrap (bux and its home exist) and before access. The
            # reporter is optional: a failure is reported, never fatal.
            install_activity_reporter(launch, source)
        configure_access(launch, source)


def install_activity_reporter(launch, source):
    """Install the agent-run reporter; fail-open, with exactly one marker line.

    A credential that was not validated is still refused (the launch document
    parser already rejected malformed ones). Any failure to install or start
    the reporter only changes the marker: the computer continues to access
    setup and Activity shows its coverage as missing.
    """
    # Re-check here too: this function must never forward an unvalidated or
    # unsupported credential, whatever composed the launch document.
    telemetry = launch.get("activityTelemetry")
    if launch.get("agentKind") not in ACTIVITY_TELEMETRY_KINDS or not valid_activity_telemetry(telemetry):
        raise InstallError("invalid agent-run reporter credential")
    # The reporter's own idempotent installer owns the script, unit and 0600
    # credential file. The credential travels only on its stdin: never argv,
    # the environment, or the runtime bootstrap environment.
    credential = json.dumps({key: telemetry[key] for key in ("endpoint", "resourceId", "token", "expiresAt")},
                            separators=(",", ":")).encode("utf-8")
    try:
        completed = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(source / "hivra-agent-trace.py"), "install",
             "--source-dir", str(source)],
            input=credential, check=True, timeout=ACTIVITY_REPORTER_TIMEOUT_SECONDS,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.TimeoutExpired:
        # Do not print exception text: it can contain command/output data.
        print("Hivra agent-run reporter installation exceeded its bounded deadline.", file=sys.stderr)
        report_activity_collector("failed", "timeout")
        return
    except subprocess.CalledProcessError as error:
        relay_reporter_status(error.stderr, telemetry["token"])
        report_activity_collector("failed", "install_failed")
        return
    except Exception:
        # Fail-open for anything else too (a missing interpreter, an OS
        # error): the exception text is never printed, only the closed enum.
        report_activity_collector("failed", "install_failed")
        return
    relay_reporter_status(completed.stderr, telemetry["token"])
    report_activity_collector("installed")


def report_activity_collector(status, reason=None):
    # The one line the control plane records as this computer's reporter
    # install status: the host appends this stream to the provisioning log
    # the dashboard poll reads. A closed enum, never a message. One write of
    # the whole line with a leading newline, so it stays a line of its own even
    # when bootstrap output on the other stream ended without one.
    if status == "installed" and reason is None:
        line = "HIVRA_ACTIVITY_COLLECTOR status=installed"
    elif status == "failed" and isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,40}", reason):
        line = "HIVRA_ACTIVITY_COLLECTOR status=failed reason=" + reason
    else:
        raise InstallError("invalid agent-run reporter status")
    sys.stderr.write("\n" + line + "\n")
    sys.stderr.flush()


def relay_reporter_status(output, token):
    # The reporter prints one status line and never the credential. Relay only
    # a short plain line into the private provisioning log, and drop anything
    # that could carry credential material.
    if not isinstance(output, bytes):
        return
    lines = output[-4096:].decode("ascii", "replace").strip().splitlines()
    line = lines[-1].strip() if lines else ""
    if (not line or len(line) > 200 or token in line or "hvra_otlp_v1" in line
            or not re.fullmatch(r"[A-Za-z0-9 .,:;_()/=+-]+", line)):
        return
    print("Hivra agent-run reporter: " + line, file=sys.stderr)


def configure_access(launch, source):
    if launch["tunnelToken"] is not None:
        configure_named_tunnel(launch["tunnelToken"], 0)
    if launch["accessHostname"] is not None:
        configure_direct_access(launch["accessHostname"], 0)
        # Package inventory was recorded by the runtime installer. Refresh its
        # access artifacts only after the exact Caddy configuration is active.
        subprocess.run(["/usr/bin/python3", str(source / "hivra-runtime-receipt.py"),
                        "--provisioner-version", (source / "VERSION").read_text().strip(),
                        "--agent-kind", launch["agentKind"], "--substrate", launch["computerSubstrate"],
                        "--refresh-direct-access"], check=True, timeout=120,
                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, stdin=subprocess.DEVNULL)


def main():
    launch = parse_launch(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
    if os.geteuid() != 0 or not sys.platform.startswith("linux"):
        raise InstallError("guest installation requires Linux root authority")
    check_directory(LOCK_FILE.parent, 0)
    fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise InstallError("unsafe guest installation lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install_agent(launch, Path(__file__).resolve().parent)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Inner package/service diagnostics remain available through the
        # existing private provisioning log; do not print payload/exception data.
        print("Hivra guest installation failed; inspect the private provisioning log.", file=sys.stderr)
        sys.exit(1)
