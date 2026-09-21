#!/usr/bin/env python3
"""Private provider preparation, called with the original worker's locked journal.

The worker supplies read(name)/publish(name, value) backed
by its existing checked, write-once, fsynced journal, and the bounded command
runner. None of these callbacks comes from a request. An intent with an unknown
outcome NEVER permits another Docker create. Preparing a plan is not readiness.
No CLI is provided. Activation is a private original-worker operation; it does
not prove readiness or release the existing install/cleanup obligation.
The command runner must never log captured output: container inspection includes
private environment values. Only an environment digest enters the journal.
"""
import ctypes
import hashlib
import json
import os
import re
import tempfile

NAME = "hivra-selkies-desktop"
NETWORK = "hivra-remote-desktop"
WORKSPACE = "/home/bux/Hivra"
STATE = "/var/lib/hivra/remote-desktop"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DIGEST = re.compile(r"[0-9a-f]{64}")
DESKTOP_SETTINGS = {
    "SELKIES_ENABLE_BASIC_AUTH": "true", "SELKIES_ENABLE_HTTPS": "false",
    "SELKIES_MODE": "websockets", "SELKIES_WAYLAND": "false",
    "SELKIES_FRAMERATE": "60", "SELKIES_VIDEO_BITRATE": "25000",
    "SELKIES_SCALING_DPI": "96|locked",
    "SELKIES_FORCE_ALIGNED_RESOLUTION": "true|locked", "SELKIES_COMMAND_ENABLED": "false",
    "SELKIES_ENABLE_CLIPBOARD": "false", "SELKIES_ENABLE_BINARY_CLIPBOARD": "false",
    "SELKIES_AUDIO_ENABLED": "false", "SELKIES_MICROPHONE_ENABLED": "false",
    "SELKIES_GAMEPAD_ENABLED": "false", "SELKIES_WEBCAM_ENABLED": "false",
    "SELKIES_FILE_TRANSFERS": "none",
}


def reject():
    raise RuntimeError("Provider desktop preparation could not be verified") from None


def install_prepared_base(args, operation_id, journal, command, owner, guest):
    """Compose desktop phases once, after the original worker's base preparation.

    Private caller obligations: verified bundle/retained cleanup closure, original
    operation and install locks, fresh empty provider VM preflight, bounded run
    deadline and the prepare-only base installer already completed. This is not
    a recovery entry point: an interrupted preparation may have rotated secrets
    or started Docker even without container ownership. Keep its cleanup fence.
    Modules and callbacks are verified caller code, never request data.
    """
    try:
        if (os.geteuid() != 0 or args.computer_kind != "hivra-agent"
                or args.control_bypass_file is not None):
            reject()
        intent = {**network_intent(args.computer_id, operation_id),
                  "controlOrigin": guest.origin(args.control_origin),
                  "publicOrigin": guest.origin(args.public_origin)}
        def fence():
            if journal.read("cancel.json") is not None:
                reject()
        fence()
        # A partial predecessor is never a fresh invocation, even if its last
        # acknowledgement was lost. Do not infer no mutation from missing CID.
        for name in ("desktop-preparation-intent.json", "desktop-network-intent.json",
                     "desktop-network.json", "desktop-create-intent.json",
                     "desktop-ownership.json", "desktop-unit-intent.json",
                     "desktop-units.json", "desktop-activation.json", "desktop-ready.json"):
            if journal.read(name) is not None:
                reject()
        journal.publish("desktop-preparation-intent.json", intent)
        def checked_command(argv):
            fence()
            result = command(argv)
            fence()
            return result
        def network_preparer():
            fence()
            return prepare_network(args.computer_id, operation_id, journal, checked_command)
        fence()
        prepared = guest.prepare_guest(args, network_preparer=network_preparer)
        fence()
        # Use the actual network recorded by our callback, not only a module's
        # returned value. This also prevents managed preparation from entering.
        network = journal.read("desktop-network.json")
        if not isinstance(network, dict) or prepared.network_id != network.get("networkId") or not isinstance(prepared.network_id, str) or not DIGEST.fullmatch(prepared.network_id):
            reject()
        desktop_env = guest.read_provider_configuration(args)
        fence()
        result = prepare_services(args.computer_id, operation_id, prepared.runtime_image_id,
                                  prepared.node_binary, journal, checked_command, desktop_env=desktop_env)
        fence()
        publish_units(args.computer_id, operation_id, prepared.node_binary, journal, owner)
        fence()
        activate_units(args, operation_id, prepared.node_binary, journal, checked_command, owner, guest)
        fence()
        capability = guest.verify_guest(args, prepared, container_id=result["ownership"]["container"]["id"])
        fence()
        if (not isinstance(capability, dict) or capability.get("computerId") != args.computer_id
                or capability.get("computerKind") != args.computer_kind
                or capability.get("protocol") != "hivra-remote-desktop-installed-v1"):
            reject()
        # Bind only a receipt digest; private configuration and module handoff
        # never enter journal/log output. This is not a SQL lease-release proof.
        journal.publish("desktop-ready.json", {**intent, "ownership": result["ownership"],
                        "capabilitySha256": hashlib.sha256(encode(capability)).hexdigest()})
        return capability
    except Exception:
        reject()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")


def environment_map(value):
    if not isinstance(value, list) or len(value) > 256:
        reject()
    result = {}
    for item in value:
        if not isinstance(item, str) or len(item) > 8192 or "\0" in item or "=" not in item:
            reject()
        name, contents = item.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or name in result:
            reject()
        result[name] = contents
    return result


def desktop_overrides(raw):
    # Caller obtains these bytes from checked original private preparation,
    # never request input or a credential-rotating rerun. Reject env-file shell
    # shorthand, comments, duplicates and unsupported behavior switches.
    if not isinstance(raw, bytes) or len(raw) > 16384 or not raw.endswith(b"\n"):
        reject()
    result = environment_map(raw.decode("ascii").splitlines())
    keys = set(DESKTOP_SETTINGS) | {"SELKIES_BASIC_AUTH_USER", "SELKIES_BASIC_AUTH_PASSWORD"}
    if set(result) != keys or any(result[key] != value for key, value in DESKTOP_SETTINGS.items()):
        reject()
    if (not re.fullmatch(r"hivra-[A-Za-z0-9_-]{16}", result["SELKIES_BASIC_AUTH_USER"])
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", result["SELKIES_BASIC_AUTH_PASSWORD"])):
        reject()
    return result


def network_intent(computer_id, operation_id):
    if any(not isinstance(value, str) or not UUID.fullmatch(value) for value in (computer_id, operation_id)):
        reject()
    return {"version": 1, "computerId": computer_id, "operationId": operation_id}


def inspect_network(intent, command):
    found = command(["/usr/bin/docker", "network", "ls", "--no-trunc", "--filter", "name=^" + NETWORK + "$", "--format", "{{.ID}}"])
    if found == b"":
        return None
    if not re.fullmatch(rb"[0-9a-f]{64}\n", found):
        reject()
    identity = found.decode("ascii").strip()
    document = json.loads(command(["/usr/bin/docker", "network", "inspect", identity]))
    if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], dict):
        reject()
    value = document[0]
    required = {"Id": identity, "Name": NETWORK, "Driver": "bridge", "Scope": "local",
                "Internal": False, "Attachable": False, "Ingress": False, "EnableIPv6": False,
                "ConfigOnly": False, "ConfigFrom": {"Network": ""}, "Options": {}}
    if any(key not in value or type(value[key]) is not type(expected) or value[key] != expected for key, expected in required.items()):
        reject()
    labels = value.get("Labels")
    if (not isinstance(labels, dict) or labels.get("io.hivra.computer-id") != intent["computerId"]
            or labels.get("io.hivra.operation-id") != intent["operationId"]
            or labels.get("io.hivra.desktop-network-intent") != hashlib.sha256(encode(intent)).hexdigest()):
        reject()
    return identity


def prepare_network(computer_id, operation_id, journal, command):
    """Original locked worker only. An unknown create acknowledgement is never retried."""
    try:
        intent = network_intent(computer_id, operation_id)
        previous = journal.read("desktop-network-intent.json")
        if journal.read("desktop-activation.json") is not None or (previous is not None and previous != intent):
            reject()
        created = None
        if previous is None:
            if journal.read("desktop-network.json") is not None:
                reject()
            found = command(["/usr/bin/docker", "network", "ls", "--no-trunc", "--filter", "name=^" + NETWORK + "$", "--format", "{{.ID}}"])
            if found != b"":
                reject()
            journal.publish("desktop-network-intent.json", intent)
            created = command(["/usr/bin/docker", "network", "create", "--driver", "bridge",
                               "--label", "io.hivra.computer-id=" + computer_id,
                               "--label", "io.hivra.operation-id=" + operation_id,
                               "--label", "io.hivra.desktop-network-intent=" + hashlib.sha256(encode(intent)).hexdigest(), NETWORK])
            if not re.fullmatch(rb"[0-9a-f]{64}\n", created):
                reject()
        identity = inspect_network(intent, command)
        if identity is None or (created is not None and created != (identity + "\n").encode("ascii")):
            reject()
        journal.publish("desktop-network.json", {**intent, "networkId": identity})
        return identity
    except Exception:
        reject()


def render_units(container_id, node):
    if not DIGEST.fullmatch(container_id) or node not in ("/usr/bin/node", "/usr/local/bin/node"):
        reject()
    return {
        "hivra-selkies-desktop.service": f"""[Unit]
Description=Hivra contained Selkies X11 desktop
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/docker start --attach {container_id}
ExecStop=/usr/bin/docker stop --time 10 {container_id}
Restart=always
RestartSec=3
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
""",
        "hivra-remote-desktop-broker.service": f"""[Unit]
Description=Hivra remote desktop session broker
After=network-online.target hivra-selkies-desktop.service
Requires=hivra-selkies-desktop.service

[Service]
Type=simple
User=hivra-desktop-broker
Group=hivra-desktop-broker
EnvironmentFile={STATE}/broker.env
ExecStart={node} /opt/hivra/remote-desktop/server.cjs
Restart=always
RestartSec=2
KillMode=control-group
TimeoutStopSec=20
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={STATE}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
""",
        "bux-hivra-chat.service": f"""[Unit]
Description=Hivra standalone computer access gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bux
Group=bux
WorkingDirectory=/opt/bux/hivra-chat
Environment=HOME=/home/bux
Environment=HIVRA_CHAT_PORT=8080
Environment=HIVRA_AGENT_KIND=linux-desktop
Environment=HIVRA_WORKSPACE_ROOT=/home/bux/Hivra
Environment=HIVRA_WORKSPACE_PROTOCOL=hivra-workspace-v1
EnvironmentFile={STATE}/broker.env
Environment=BUX_LOCAL_CDP_PORT=9222
Environment=PATH=/usr/local/bin:/home/bux/.bun/bin:/home/bux/.npm-global/bin:/home/bux/.local/bin:/usr/bin:/bin
ExecStart={node} /opt/bux/hivra-chat/server.js
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=20
StandardOutput=append:/var/log/bux/hivra-chat.log
StandardError=append:/var/log/bux/hivra-chat.log

[Install]
WantedBy=multi-user.target
""",
    }


def publish_exclusive(source, destination):
    # Same Linux exclusive-rename primitive as the original worker journal.
    # Unlike link/unlink, a crash cannot leave two links to a published unit.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        reject()
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        reject()


def publish_units(computer_id, operation_id, node, journal, owner):
    """Install only the original plan's files, without enabling/starting services.

    owner is the retained, verified cleanup module, not request-supplied code.
    The worker holds its original manager/install locks throughout this call.
    """
    try:
        if os.geteuid() != 0:
            reject()
        network_intent(computer_id, operation_id)  # Validate both identities.
        expected = owner.ownership(journal.read("desktop-ownership.json"))
        if expected["computerId"] != computer_id or expected["operationId"] != operation_id:
            reject()
        units = render_units(expected["container"]["id"], node)
        if {name: hashlib.sha256(value.encode()).hexdigest() for name, value in units.items()} != expected["units"]:
            reject()
        intent = {"version": 1, "ownership": expected}
        previous = journal.read("desktop-unit-intent.json")
        if journal.read("desktop-activation.json") is not None or journal.read("cancel.json") is not None:
            reject()
        owner.directory(owner.UNIT_ROOT)
        if previous is None:
            if journal.read("desktop-units.json") is not None:
                reject()
            states, container = owner.observed(expected)
            if any(state["LoadState"] != "not-found" for state in states.values()) or container is None:
                reject()
            if not owner.observe_stopped(expected):
                reject()
            journal.publish("desktop-unit-intent.json", intent)
        elif previous != intent:
            reject()
        # Preflight every existing file before writing any missing file. Only
        # the original intent permits recovery of partially published unit files.
        for name, contents in units.items():
            path = owner.UNIT_ROOT / name
            if os.path.lexists(path) and owner.read_regular(path, 16384, 0o644) != contents.encode():
                reject()
        for name, contents in units.items():
            if journal.read("cancel.json") is not None:
                reject()
            path = owner.UNIT_ROOT / name
            if os.path.lexists(path):
                continue
            fd, temporary = tempfile.mkstemp(prefix=".pending-desktop-", dir=owner.UNIT_ROOT)
            try:
                with os.fdopen(fd, "wb", closefd=False) as stream:
                    stream.write(contents.encode())
                    stream.flush()
                    os.fchmod(fd, 0o644)
                    os.fsync(fd)
                publish_exclusive(temporary, path)
            finally:
                os.close(fd)
                if os.path.lexists(temporary):
                    os.unlink(temporary)  # Only this call's mkstemp path.
        directory_fd = os.open(owner.UNIT_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        owner.command(["/usr/bin/systemctl", "daemon-reload"])
        states, container = owner.observed(expected)
        if (any(state["LoadState"] != "loaded" for state in states.values()) or container is None
                or container.get("Status") != "created" or not owner.observe_stopped(expected)):
            reject()
        journal.publish("desktop-units.json", intent)
        return {"unitsInstalled": True, "activationDispatched": False, "readinessVerified": False}
    except Exception:
        reject()


def activate_units(args, operation_id, node, journal, command, owner, guest):
    """Once-only activation under the original worker's retained cleanup fence.

    guest/owner are verified retained modules. The caller must retain both
    locks, the cancellation latch and original SQL operation; this function
    never declares ready, compensates or releases anything. Uncertain results
    leave the activation intent intact for observation/owned cleanup, not retry.
    """
    try:
        if os.geteuid() != 0 or journal.read("cancel.json") is not None or journal.read("desktop-activation.json") is not None:
            reject()
        expected = owner.ownership(journal.read("desktop-ownership.json"))
        if expected["computerId"] != args.computer_id or expected["operationId"] != operation_id:
            reject()
        intent = {"version": 1, "ownership": expected}
        if journal.read("desktop-unit-intent.json") != intent or journal.read("desktop-units.json") != intent:
            reject()
        # Read original private files freshly; no credential regeneration. Then
        # compare the actual created container, image, network and environment.
        desktop_env = guest.read_provider_configuration(args)
        prepared = prepare_services(args.computer_id, operation_id, expected["container"]["imageId"],
                                    node, journal, command, desktop_env=desktop_env)
        if prepared["ownership"] != expected:
            reject()
        states, container = owner.observed(expected)
        if (any(state["LoadState"] != "loaded" for state in states.values()) or container is None
                or container.get("Status") != "created" or not owner.observe_stopped(expected)):
            reject()
        if journal.read("cancel.json") is not None:
            reject()
        journal.publish("desktop-activation.json", intent)
        sequence = ("hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service")
        for verb in ("enable", "start"):
            for unit in sequence:
                if journal.read("cancel.json") is not None:
                    reject()
                owner.command(["/usr/bin/systemctl", verb, unit])
        return {"activationDispatched": True, "readinessVerified": False}
    except Exception:
        reject()


def create_arguments(intent):
    fingerprint = hashlib.sha256(encode(intent)).hexdigest()
    return ["/usr/bin/docker", "container", "create", "--name", NAME, "--network", intent["networkId"],
            "--publish", "127.0.0.1:8088:8080", "--env-file", STATE + "/selkies.env",
            "--cpus", "2", "--memory", "4g", "--shm-size", "2g", "--pids-limit", "2048",
            "--security-opt", "no-new-privileges", "--cgroup-parent", "system.slice", "--cgroupns", "private", "--restart", "no",
            "--ipc", "private", "--runtime", "runc", "--user", "ubuntu",
            "--label", "io.hivra.computer-id=" + intent["computerId"],
            "--label", "io.hivra.operation-id=" + intent["operationId"],
            "--label", "io.hivra.desktop-intent=" + fingerprint,
            "--mount", "type=bind,src=" + WORKSPACE + ",dst=/home/ubuntu/Hivra", intent["imageId"]]


def inspect_created(intent, command, expected_environment):
    found = command(["/usr/bin/docker", "container", "ls", "--all", "--no-trunc", "--filter",
                     "name=^/" + NAME + "$", "--format", "{{.ID}}"])
    if found == b"":
        return None
    if not re.fullmatch(rb"[0-9a-f]{64}\n", found):
        reject()
    identity = found.decode("ascii").strip()
    # Private captured output only; never return or log this document.
    fields = '[{{json .Id}},{{json .Name}},{{json .Image}},{{json .Config.User}},{{json .Config.Labels}},{{json .HostConfig}},{{json .Mounts}},{{json .State}},{{json .Config.Entrypoint}},{{json .Config.Cmd}},{{json .Config.WorkingDir}},{{json .NetworkSettings.Networks}},{{json .Config.Env}}]'
    value = json.loads(command(["/usr/bin/docker", "container", "inspect", "--format", fields, identity]))
    if not isinstance(value, list) or len(value) != 13:
        reject()
    cid, name, image, user, labels, host, mounts, state, entrypoint, cmd, workdir, networks, environment = value
    if environment_map(environment) != expected_environment:
        reject()
    # These are the same pinned base-image defaults enforced by install-guest.py.
    # Fresh private-file/container consistency must also be checked at activation.
    if (entrypoint != ["/etc/container-entrypoint.sh"] or cmd is not None or workdir != "/home/ubuntu"
            or not isinstance(networks, dict) or not set(networks).issubset({NETWORK})):
        reject()
    for endpoint in networks.values():
        if not isinstance(endpoint, dict):
            reject()
        if endpoint.get("NetworkID") == intent["networkId"]:
            continue
        # Docker create records the resolved network name before first start,
        # but fills NetworkID/addresses only when allocating the endpoint.
        # Accept this explicit unallocated form, never a different network ID.
        empty_endpoint = {"NetworkID": "", "EndpointID": "", "Gateway": "", "IPAddress": "",
                          "IPPrefixLen": 0, "IPv6Gateway": "", "GlobalIPv6Address": "",
                          "GlobalIPv6PrefixLen": 0, "MacAddress": "", "IPAMConfig": None}
        if any(key not in endpoint or type(endpoint[key]) is not type(expected) or endpoint[key] != expected
               for key, expected in empty_endpoint.items()):
            reject()
    if (cid != identity or name != "/" + NAME or image != intent["imageId"] or user != "ubuntu"
            or not isinstance(labels, dict) or labels.get("io.hivra.computer-id") != intent["computerId"]
            or labels.get("io.hivra.operation-id") != intent["operationId"]
            or labels.get("io.hivra.desktop-intent") != hashlib.sha256(encode(intent)).hexdigest()
            or not isinstance(host, dict) or not isinstance(state, dict)):
        reject()
    required = {"Privileged": False, "AutoRemove": False, "CgroupParent": "system.slice", "NetworkMode": intent["networkId"],
                "NanoCpus": 2_000_000_000, "Memory": 4 * 1024**3, "ShmSize": 2 * 1024**3, "PidsLimit": 2048,
                "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8088"}]},
                "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "SecurityOpt": ["no-new-privileges"],
                "PidMode": "", "CgroupnsMode": "private", "CapAdd": None, "Devices": [],
                "IpcMode": "private", "UTSMode": "", "UsernsMode": "", "DeviceRequests": None,
                "DeviceCgroupRules": None, "VolumesFrom": None, "Binds": None,
                "PublishAllPorts": False, "Runtime": "runc", "Isolation": ""}
    if any(key not in host or type(host[key]) is not type(expected) or host[key] != expected for key, expected in required.items()):
        reject()
    if (mounts != [{"Type": "bind", "Source": WORKSPACE, "Destination": "/home/ubuntu/Hivra", "Mode": "", "RW": True, "Propagation": "rprivate"}]
            or state.get("Status") != "created" or state.get("Running") is not False or state.get("Paused") is not False
            or state.get("Restarting") is not False or state.get("Dead") is not False or type(state.get("Pid")) is not int or state["Pid"] != 0):
        reject()
    return identity


def prepare_services(computer_id, operation_id, image_id, node, journal, command, *, desktop_env):
    try:
        if (not isinstance(computer_id, str) or not UUID.fullmatch(computer_id)
                or not isinstance(operation_id, str) or not UUID.fullmatch(operation_id)
                or not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
                or node not in ("/usr/bin/node", "/usr/local/bin/node")):
            reject()
        overrides = desktop_overrides(desktop_env)
        net_intent = network_intent(computer_id, operation_id)
        network = journal.read("desktop-network.json")
        if (journal.read("desktop-network-intent.json") != net_intent or not isinstance(network, dict)
                or set(network) != set(net_intent) | {"networkId"}
                or any(network[key] != value for key, value in net_intent.items())
                or not isinstance(network["networkId"], str) or not DIGEST.fullmatch(network["networkId"])):
            reject()
        if inspect_network(net_intent, command) != network["networkId"]:
            reject()
        base = environment_map(json.loads(command(["/usr/bin/docker", "image", "inspect", "--format", "{{json .Config.Env}}", image_id])))
        expected_environment = {**base, **overrides}
        intent = {"version": 3, "computerId": computer_id, "operationId": operation_id, "imageId": image_id, "node": node,
                  "networkId": network["networkId"],
                  "environmentSha256": hashlib.sha256(encode(expected_environment)).hexdigest()}
        previous = journal.read("desktop-create-intent.json")
        if journal.read("desktop-activation.json") is not None:
            reject()
        if previous is None and journal.read("desktop-ownership.json") is not None:
            reject()
        if previous is not None and previous != intent:
            reject()
        driver = command(["/usr/bin/docker", "info", "--format", "{{.CgroupDriver}}/{{.CgroupVersion}}"])
        if driver != b"systemd/2\n":
            reject()
        if previous is None:
            existing = command(["/usr/bin/docker", "container", "ls", "--all", "--no-trunc", "--filter",
                                "name=^/" + NAME + "$", "--format", "{{.ID}}"])
            if existing != b"":
                reject()  # Never adopt or replace a computer by name.
            journal.publish("desktop-create-intent.json", intent)
            created = command(create_arguments(intent))
            if not re.fullmatch(rb"[0-9a-f]{64}\n", created):
                reject()
        else:
            created = None  # Lost acknowledgement: inspect only, never recreate.
        identity = inspect_created(intent, command, expected_environment)
        if identity is None or (created is not None and created != (identity + "\n").encode("ascii")):
            reject()
        units = render_units(identity, node)
        ownership = {"version": 1, "computerId": computer_id, "operationId": operation_id,
                     "container": {"id": identity, "imageId": image_id},
                     "units": {name: hashlib.sha256(text.encode("utf8")).hexdigest() for name, text in units.items()}}
        journal.publish("desktop-ownership.json", ownership)
        return {"ownership": ownership, "units": units}
    except Exception:
        reject()
