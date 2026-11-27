#!/usr/bin/env python3
"""Socket-activated, host-local byte transport for one Claude terminal fixture."""

import fcntl
import json
import os
import re
import socket
import stat
import subprocess
import sys
from pathlib import Path
from types import ModuleType

ADAPTER = Path("/opt/hivra/gvisor-adapter/hivra-gvisor-adapter")
CONFIG = Path("/opt/hivra/gvisor-adapter/claude-terminal-relay.json")
LOCK = Path("/run/lock/hivra-gvisor-adapter.lock")
DOCKER = "/usr/bin/docker"
DOCKER_HOST = "unix:///var/run/docker.sock"
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/", "LC_ALL": "C", "DOCKER_HOST": DOCKER_HOST}
CONTAINER_ID = re.compile(r"[0-9a-f]{64}")
FIXTURE_FIELDS = {"ownerHash", "computerId", "sandboxId", "image"}

GUEST_RELAY = r"""
import os
import socket
import sys
import threading

def send_input(upstream):
    try:
        while chunk := os.read(0, 65536):
            upstream.sendall(chunk)
        upstream.shutdown(socket.SHUT_WR)
    except OSError:
        try:
            upstream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
        upstream.connect("/tmp/hivra-claude-terminal.sock")
        threading.Thread(target=send_input, args=(upstream,), daemon=True).start()
        while chunk := upstream.recv(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
except OSError:
    raise SystemExit(1)
"""


class RelayError(ValueError):
    pass


def read_owned_file(path, mode, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        evidence = os.fstat(stream.fileno())
        if not stat.S_ISREG(evidence.st_mode) or evidence.st_uid != 0 or stat.S_IMODE(evidence.st_mode) != mode:
            raise RelayError("Invalid trusted file")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise RelayError("Trusted file is too large")
    return data


def unique_fields(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise RelayError("Duplicate fixture field")
    return result


def load_adapter():
    adapter = ModuleType("hivra_gvisor_adapter")
    adapter.__file__ = str(ADAPTER)
    source = read_owned_file(ADAPTER, 0o700, 256 * 1024)
    exec(compile(source, str(ADAPTER), "exec"), adapter.__dict__)
    return adapter


def fixture_request(adapter):
    config = json.loads(read_owned_file(CONFIG, 0o600, 4096), object_pairs_hook=unique_fields)
    if not isinstance(config, dict) or config.keys() != FIXTURE_FIELDS:
        raise RelayError("Invalid fixture schema")
    return adapter.valid_input({
        "operation": "status", "ownerHash": config["ownerHash"], "computerId": config["computerId"],
        "sandboxId": config["sandboxId"], "workload": {"kind": "claude-terminal", "image": config["image"]},
    })


def verified_container_id(adapter, request):
    name, volume, network = adapter.names(request)
    adapter.require_helper_absent(request)
    if adapter.inspect_container(adapter.previous_name(request), request, required=False) is not None:
        raise RelayError("Pending replacement")
    item = adapter.inspect_container(name, request)
    adapter.inspect_resource("volume", volume, request, required=True)
    adapter.inspect_resource("network", network, request, required=True)
    state = item["State"]
    container_id = item["Id"]
    if (state.get("Running") is not True or state.get("Paused") is not False
            or state.get("Restarting") is not False or state.get("Dead") is not False
            or (state.get("Health") or {}).get("Status") != "healthy"
            or not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id)):
        raise RelayError("Fixture terminal is not ready")
    return container_id


def docker_exec_argv(container_id):
    if not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id):
        raise RelayError("Invalid container ID")
    return [DOCKER, "exec", "--interactive", "--user", "65534:65534", "--workdir", "/workspace",
            container_id, "/usr/local/bin/python3", "-I", "-B", "-c", GUEST_RELAY]


def require_connected_unix_socket():
    received, output = os.fstat(0), os.fstat(1)
    if (not stat.S_ISSOCK(received.st_mode)
            or (received.st_dev, received.st_ino) != (output.st_dev, output.st_ino)):
        raise RelayError("Expected one accepted socket on stdin and stdout")
    with socket.socket(fileno=os.dup(0)) as connection:
        if connection.family != socket.AF_UNIX or connection.type != socket.SOCK_STREAM:
            raise RelayError("Expected a Unix stream")
        connection.getpeername()


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0 or sys.platform != "linux":
        raise RelayError("Expected the root systemd socket service")
    require_connected_unix_socket()
    os.environ.clear()
    os.environ.update(ENV)
    adapter = load_adapter()
    request = fixture_request(adapter)
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RelayError("Invalid adapter lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        argv = docker_exec_argv(verified_container_id(adapter, request))
        os.execve(DOCKER, argv, ENV)


if __name__ == "__main__":
    try:
        main()
    except (AttributeError, KeyError, OSError, ValueError, RuntimeError, SyntaxError,
            TypeError, subprocess.SubprocessError):
        print("Claude terminal relay could not open the configured fixture", file=sys.stderr)
        raise SystemExit(1) from None
