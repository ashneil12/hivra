#!/usr/bin/env python3
"""Root-only, identity-bound lifecycle adapter for Hivra gVisor computers."""

import base64
import fcntl
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

VERSION = "2026.09.15.1"
IMAGE = "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285"
PREFIX = "hivra-gvisor-"
LABEL = "cloud.hivra"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
EXEC_OUTPUT_LIMIT = 65536
EXEC_ENVELOPE_LIMIT = 192 * 1024
GUEST_EXEC_WRAPPER = r'''import base64,json,os,selectors,signal,subprocess,sys,time
limit=int(sys.argv[1]); timeout=float(sys.argv[2]); argv=sys.argv[3:]
process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
selector=selectors.DefaultSelector(); streams={process.stdout:bytearray(),process.stderr:bytearray()}
for stream in streams: selector.register(stream,selectors.EVENT_READ)
deadline=time.monotonic()+timeout; terminated_at=None; timed_out=False
while selector.get_map() or process.poll() is None:
    now=time.monotonic()
    if not timed_out and now>=deadline:
        timed_out=True; terminated_at=now
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
    if timed_out and process.poll() is None and now>=terminated_at+1:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
    if timed_out and now>=terminated_at+5: break
    events=selector.select(0.05) if selector.get_map() else []
    for key,_ in events:
        chunk=os.read(key.fileobj.fileno(),8192)
        if not chunk:
            selector.unregister(key.fileobj); continue
        target=streams[key.fileobj]
        if len(target)<limit: target.extend(chunk[:limit-len(target)])
for stream in streams:
    try: stream.close()
    except OSError: pass
if process.poll() is None:
    try: os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError: pass
try: returncode=process.wait(timeout=1)
except subprocess.TimeoutExpired: returncode=-signal.SIGKILL
if timed_out: exitcode=124
elif returncode<0: exitcode=min(255,128-returncode)
else: exitcode=min(255,returncode)
print(json.dumps({"exitCode":exitcode,"stdoutB64":base64.b64encode(streams[process.stdout]).decode("ascii"),"stderrB64":base64.b64encode(streams[process.stderr]).decode("ascii")},separators=(",",":")))
'''


def fail(message="gVisor computer operation failed"):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def run(argv, *, check=True, capture=True, timeout=120):
    return subprocess.run(argv, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
                          text=True, timeout=timeout, check=check)


def run_bounded(argv, *, timeout, limit):
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    for stream in streams:
        selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    timed_out = False
    timed_out_at = None
    while selector.get_map() or process.poll() is None:
        now = time.monotonic()
        if not timed_out and now >= deadline:
            timed_out = True
            timed_out_at = now
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        events = selector.select(0.05) if selector.get_map() else []
        for key, _ in events:
            chunk = os.read(key.fileobj.fileno(), 8192)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            target = streams[key.fileobj]
            if len(target) < limit:
                target.extend(chunk[:limit - len(target)])
        if timed_out and now >= timed_out_at + 2:
            for stream in list(selector.get_map().values()):
                selector.unregister(stream.fileobj)
                stream.fileobj.close()
            break
        if timed_out and process.poll() is not None and not selector.get_map():
            break
    selector.close()
    try:
        returncode = process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        returncode = process.wait(timeout=1)
    stdout = bytes(streams[process.stdout]).decode(errors="replace")
    stderr = bytes(streams[process.stderr]).decode(errors="replace")
    for stream in streams:
        stream.close()
    if timed_out:
        raise subprocess.TimeoutExpired(argv, timeout, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


def docker(*args, check=True, timeout=120, capture_limit=None):
    argv = ["/usr/bin/docker", *args]
    result = run_bounded(argv, timeout=timeout, limit=capture_limit) if capture_limit else run(
        argv, check=False, timeout=timeout)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, argv, result.stdout, result.stderr)
    return result


def valid_input(document):
    if not isinstance(document, dict) or set(document) - {
        "operation", "ownerHash", "computerId", "sandboxId", "cpu", "memoryMb", "hostMemoryReserveMb", "argv"
    }:
        fail("Invalid gVisor computer request")
    operation = document.get("operation")
    if operation not in {"create", "status", "start", "stop", "resize", "exec", "delete"}:
        fail("Invalid gVisor computer operation")
    for key in ("computerId", "sandboxId"):
        if not isinstance(document.get(key), str) or not UUID.fullmatch(document[key]):
            fail("Invalid gVisor computer identity")
    if not isinstance(document.get("ownerHash"), str) or not DIGEST.fullmatch(document["ownerHash"]):
        fail("Invalid gVisor owner identity")
    if operation in {"create", "resize"}:
        cpu = document.get("cpu")
        memory = document.get("memoryMb")
        if not isinstance(cpu, (int, float)) or isinstance(cpu, bool) or cpu < 0.5 or cpu > 32:
            fail("Invalid gVisor CPU limit")
        if not isinstance(memory, int) or isinstance(memory, bool) or memory < 512 or memory > 131072:
            fail("Invalid gVisor memory limit")
    if operation in {"create", "start", "resize"}:
        reserve = document.get("hostMemoryReserveMb")
        if not isinstance(reserve, int) or isinstance(reserve, bool) or reserve < 512 or reserve > 1048576:
            fail("Invalid gVisor host memory reserve")
    if operation == "exec":
        argv = document.get("argv")
        if (not isinstance(argv, list) or not argv or len(argv) > 32
                or any(not isinstance(arg, str) or not arg or len(arg.encode()) > 4096 or "\x00" in arg for arg in argv)
                or sum(len(arg.encode()) for arg in argv) > 16384):
            fail("Invalid gVisor command")
    return document


def names(request):
    suffix = request["sandboxId"]
    return PREFIX + suffix, PREFIX + "workspace-" + suffix, PREFIX + "net-" + suffix


def expected_labels(request):
    return {
        f"{LABEL}.adapter": VERSION,
        f"{LABEL}.owner": request["ownerHash"],
        f"{LABEL}.computer": request["computerId"],
        f"{LABEL}.sandbox": request["sandboxId"],
    }


def helper_name(request):
    return names(request)[0] + "-workspace-init"


def expected_helper_labels(request):
    return {**expected_labels(request), f"{LABEL}.role": "workspace-init"}


def capability_set(values):
    """Return Docker capability names in their canonical prefix-free form."""
    if values is None:
        return set()
    if not isinstance(values, list):
        raise ValueError("invalid Docker capability evidence")
    capabilities = set()
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r"(?:CAP_)?[A-Z][A-Z0-9_]*", value):
            raise ValueError("invalid Docker capability evidence")
        capabilities.add(value[4:] if value.startswith("CAP_") else value)
    return capabilities


def has_nocopy_workspace_mount(host, volume):
    mounts = host.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != 1:
        return False
    mount = mounts[0]
    options = mount.get("VolumeOptions")
    return (mount.get("Type") == "volume"
            and mount.get("Source") == volume
            and mount.get("Target") == "/workspace"
            and isinstance(options, dict)
            and options.get("NoCopy") is True)


def inspect_container(name, request, *, required=True):
    result = docker("inspect", name, check=False)
    if result.returncode != 0:
        listed = docker("ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}", check=False)
        if listed.returncode != 0 or listed.stdout.strip():
            fail("The gVisor computer could not be inspected")
        if required:
            fail("The gVisor computer was not found")
        return None
    try:
        item = json.loads(result.stdout)[0]
        labels = item["Config"]["Labels"] or {}
        if any(labels.get(key) != value for key, value in expected_labels(request).items()):
            fail("The gVisor computer identity did not match")
        host = item["HostConfig"]
        _, volume, network = names(request)
        ports = item.get("NetworkSettings", {}).get("Ports") or {}
        mounts = item.get("Mounts") or []
        if (host.get("Runtime") != "runsc" or host.get("Privileged") is not False
                or host.get("ReadonlyRootfs") is not True or host.get("NetworkMode") != network
                or (host.get("Binds") or []) or (host.get("Devices") or [])
                or (host.get("DeviceCgroupRules") or []) or capability_set(host.get("CapAdd"))
                or (host.get("PortBindings") or {}) or ports
                or host.get("PidMode") not in {"", None} or host.get("UsernsMode") not in {"", None}
                or host.get("IpcMode") not in {"", "private", None} or host.get("UTSMode") not in {"", None}
                or host.get("CgroupnsMode") not in {"", "private", None}
                or item["Config"].get("User") != "65534:65534" or item["Config"].get("Image") != IMAGE
                or float(host.get("NanoCpus", 0)) <= 0 or int(host.get("Memory", 0)) <= 0
                or int(host.get("MemorySwap", 0)) != int(host.get("Memory", 0))
                or int(host.get("PidsLimit", 0)) != 256
                or capability_set(host.get("CapDrop")) != {"ALL"}
                or not any(value.startswith("no-new-privileges") for value in (host.get("SecurityOpt") or []))
                or (host.get("Tmpfs") or {}).get("/tmp") != "rw,noexec,nosuid,nodev,size=128m"
                or not has_nocopy_workspace_mount(host, volume)
                or len(mounts) != 1 or mounts[0].get("Type") != "volume"
                or mounts[0].get("Name") != volume or mounts[0].get("Destination") != "/workspace"
                or mounts[0].get("RW") is not True):
            fail("The gVisor computer isolation evidence did not match")
        return item
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        fail("The gVisor computer evidence was invalid")


def inspect_helper(request, *, required=False):
    name = helper_name(request)
    result = docker("inspect", name, check=False)
    if result.returncode != 0:
        listed = docker("ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}", check=False)
        if listed.returncode != 0 or listed.stdout.strip():
            fail("The gVisor workspace helper could not be inspected")
        if required:
            fail("The gVisor workspace helper was not found")
        return None
    try:
        item = json.loads(result.stdout)[0]
        labels = item["Config"]["Labels"] or {}
        host = item["HostConfig"]
        _, volume, _ = names(request)
        mounts = item.get("Mounts") or []
        if (labels != expected_helper_labels(request)
                or host.get("Runtime") != "runsc" or host.get("Privileged") is not False
                or host.get("ReadonlyRootfs") is not True or host.get("NetworkMode") != "none"
                or (host.get("Binds") or []) or (host.get("Devices") or [])
                or (host.get("DeviceCgroupRules") or []) or (host.get("PortBindings") or {})
                or capability_set(host.get("CapDrop")) != {"ALL"}
                or capability_set(host.get("CapAdd")) != {"CHOWN"}
                or not any(value.startswith("no-new-privileges") for value in (host.get("SecurityOpt") or []))
                or int(host.get("NanoCpus", 0)) != 500_000_000
                or int(host.get("Memory", 0)) != 128 * 1024 * 1024
                or int(host.get("MemorySwap", 0)) != 128 * 1024 * 1024
                or int(host.get("PidsLimit", 0)) != 32
                or item["Config"].get("Image") != IMAGE
                or item["Config"].get("Cmd") != ["/bin/chown", "65534:65534", "/workspace"]
                or len(mounts) != 1 or mounts[0].get("Type") != "volume"
                or mounts[0].get("Name") != volume or mounts[0].get("Destination") != "/workspace"
                or mounts[0].get("RW") is not True):
            fail("The gVisor workspace helper identity did not match")
        return item
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        fail("The gVisor workspace helper evidence was invalid")


def require_helper_absent(request):
    if inspect_helper(request, required=False) is not None:
        fail("The gVisor computer has an orphaned workspace helper")


def inspect_resource(kind, name, request, *, required=False):
    result = docker(kind, "inspect", name, check=False)
    if result.returncode != 0:
        listed = docker(kind, "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}", check=False)
        if listed.returncode != 0 or listed.stdout.strip():
            fail("The gVisor computer resource could not be inspected")
        if required:
            fail("The gVisor computer resource was not found")
        return False
    try:
        item = json.loads(result.stdout)[0]
        labels = item.get("Labels") or item.get("Config", {}).get("Labels") or {}
        if any(labels.get(key) != value for key, value in expected_labels(request).items()):
            fail("The gVisor computer resource identity did not match")
        return True
    except (IndexError, TypeError, json.JSONDecodeError):
        fail("The gVisor computer resource evidence was invalid")


def host_capacity(exclude_name=None):
    cpu_total = os.cpu_count() or 0
    memory_total = 0
    memory_available = 0
    with open("/proc/meminfo", encoding="ascii") as stream:
        for line in stream:
            if line.startswith("MemTotal:"):
                memory_total = int(line.split()[1]) // 1024
            elif line.startswith("MemAvailable:"):
                memory_available = int(line.split()[1]) // 1024
    if cpu_total < 1 or memory_total < 1024:
        fail("Host capacity is unavailable")
    committed_cpu = 0.0
    committed_memory = 0
    listed = docker("ps", "--format", "{{.Names}}")
    for name in listed.stdout.splitlines():
        if not name or name == exclude_name:
            continue
        try:
            item = json.loads(docker("inspect", name).stdout)[0]
            cpu_limit = float(item["HostConfig"].get("NanoCpus", 0)) / 1_000_000_000
            memory_limit = int(item["HostConfig"].get("Memory", 0)) // (1024 * 1024)
            if cpu_limit <= 0 or memory_limit <= 0:
                fail("Every existing Docker workload needs explicit CPU and memory limits before gVisor admission")
            committed_cpu += cpu_limit
            committed_memory += memory_limit
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
            fail("Existing gVisor capacity evidence was invalid")
    return cpu_total, memory_total, memory_available, committed_cpu, committed_memory


def admit(name, cpu, memory, host_memory_reserve):
    total_cpu, total_memory, available_memory, used_cpu, used_memory = host_capacity(name)
    # Every reservation equals its enforced ceiling. Keep host capacity for the
    # kernel, Docker and the adapter rather than promising balloon-style floors.
    allowed_memory = max(0, total_memory - host_memory_reserve)
    live_memory_headroom = max(0, available_memory - host_memory_reserve)
    if (used_cpu + cpu > total_cpu or used_memory + memory > allowed_memory
            or memory > live_memory_headroom):
        fail("The connected host does not have enough uncommitted capacity")


def initialize_workspace(request, volume):
    helper = helper_name(request)
    helper_labels = expected_helper_labels(request)
    helper_label_args = [value for pair in helper_labels.items()
                         for value in ("--label", f"{pair[0]}={pair[1]}")]
    docker("run", "--name", helper, "--runtime=runsc", "--network=none",
           "--cap-drop=ALL", "--cap-add=CHOWN", "--security-opt=no-new-privileges",
           "--read-only", "--pids-limit", "32", "--cpus", "0.5",
           "--memory", "128m", "--memory-swap", "128m", *helper_label_args,
           "--mount", f"type=volume,src={volume},dst=/workspace", IMAGE,
           "/bin/chown", "65534:65534", "/workspace")
    inspect_helper(request, required=True)
    docker("rm", helper)
    require_helper_absent(request)


def create(request):
    name, volume, network = names(request)
    if inspect_container(name, request, required=False):
        return status(request)
    stale_helper = inspect_helper(request, required=False)
    if stale_helper is not None:
        docker("rm", "-f", helper_name(request))
        require_helper_absent(request)
    cpu, memory = float(request["cpu"]), int(request["memoryMb"])
    admit(name, cpu, memory, int(request["hostMemoryReserveMb"]))
    labels = expected_labels(request)
    label_args = [value for pair in labels.items() for value in ("--label", f"{pair[0]}={pair[1]}")]
    created_volume = False
    created_network = False
    try:
        docker("pull", "--platform", "linux/amd64", IMAGE, timeout=300)
        if not inspect_resource("volume", volume, request):
            docker("volume", "create", *label_args, volume)
            created_volume = True
        if not inspect_resource("network", network, request):
            docker("network", "create", "--driver", "bridge", *label_args, network)
            created_network = True
        initialize_workspace(request, volume)
        docker("create", "--name", name, "--runtime=runsc", "--init", "--read-only",
               "--user", "65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges",
               "--pids-limit", "256", "--cpus", str(cpu), "--memory", f"{memory}m",
               "--memory-swap", f"{memory}m", "--network", network,
               "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m",
               "--mount", f"type=volume,src={volume},dst=/workspace,volume-nocopy",
               "--workdir", "/workspace", *label_args, IMAGE,
               "/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600; done")
        docker("start", name)
        return status(request)
    except BaseException:
        owned_helper = inspect_helper(request, required=False)
        if owned_helper is not None:
            docker("rm", "-f", helper_name(request), check=False)
        owned_container = inspect_container(name, request, required=False)
        if owned_container is not None:
            docker("rm", "-f", name, check=False)
        if created_network:
            docker("network", "rm", network, check=False)
        if created_volume:
            docker("volume", "rm", volume, check=False)
        raise


def status(request):
    name, volume, network = names(request)
    require_helper_absent(request)
    item = inspect_container(name, request, required=False)
    if item is None:
        if (inspect_resource("volume", volume, request)
                or inspect_resource("network", network, request)):
            fail("The gVisor computer has orphaned owned resources")
        result = {"version": 1, "computerId": request["computerId"],
                  "sandboxId": request["sandboxId"], "state": "absent"}
        print("HIVRA_GVISOR_V1 " + json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
        return result
    inspect_resource("volume", volume, request, required=True)
    inspect_resource("network", network, request, required=True)
    state = item["State"]
    config = item["HostConfig"]
    result = {
        "version": 1, "adapterVersion": VERSION, "computerId": request["computerId"],
        "sandboxId": request["sandboxId"], "state": "running" if state.get("Running") else "stopped",
        "isolationDriver": "gvisor-runsc", "isolationClass": "application-kernel",
        "outerHostBoundary": "operator-owned-host", "runtime": config.get("Runtime"),
        "cpu": float(config.get("NanoCpus", 0)) / 1_000_000_000,
        "memoryMb": int(config.get("Memory", 0)) // (1024 * 1024),
        "image": item["Config"]["Image"], "workspace": volume, "network": network,
        "publicPorts": [], "reservationEqualsMaximum": True,
    }
    print("HIVRA_GVISOR_V1 " + json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
    return result


def execute(request):
    name, _, _ = names(request)
    require_helper_absent(request)
    item = inspect_container(name, request)
    if not item["State"].get("Running"):
        fail("Start this gVisor computer before opening its terminal")
    result = docker(
        "exec", "--user", "65534:65534", "--workdir", "/workspace", name,
        "/usr/local/bin/python3", "-c", GUEST_EXEC_WRAPPER,
        str(EXEC_OUTPUT_LIMIT), "60", *request["argv"],
        check=False, timeout=70, capture_limit=EXEC_ENVELOPE_LIMIT,
    )
    if result.returncode != 0:
        fail("The gVisor terminal command supervisor failed")
    try:
        envelope = json.loads(result.stdout)
        if set(envelope) != {"exitCode", "stdoutB64", "stderrB64"}:
            raise ValueError
        exit_code = envelope["exitCode"]
        if not isinstance(exit_code, int) or isinstance(exit_code, bool) or not 0 <= exit_code <= 255:
            raise ValueError
        stdout_bytes = base64.b64decode(envelope["stdoutB64"], validate=True)
        stderr_bytes = base64.b64decode(envelope["stderrB64"], validate=True)
        if len(stdout_bytes) > EXEC_OUTPUT_LIMIT or len(stderr_bytes) > EXEC_OUTPUT_LIMIT:
            raise ValueError
    except (TypeError, ValueError, KeyError, json.JSONDecodeError):
        fail("The gVisor terminal command evidence was invalid")
    receipt = {
        "exitCode": exit_code,
        "stdout": stdout_bytes.decode(errors="replace"),
        "stderr": stderr_bytes.decode(errors="replace"),
    }
    print("HIVRA_GVISOR_EXEC_V1 " + json.dumps(receipt, separators=(",", ":")), flush=True)
    return receipt


def delete(request):
    name, volume, network = names(request)
    item = inspect_container(name, request, required=False)
    helper = inspect_helper(request, required=False)
    volume_exists = inspect_resource("volume", volume, request)
    network_exists = inspect_resource("network", network, request)
    if helper:
        docker("rm", "-f", helper_name(request))
    if item:
        docker("rm", "-f", name)
    if network_exists:
        docker("network", "rm", network)
    if volume_exists:
        docker("volume", "rm", volume)
    if (inspect_container(name, request, required=False)
            or inspect_helper(request, required=False)
            or inspect_resource("network", network, request)
            or inspect_resource("volume", volume, request)):
        fail("gVisor computer deletion is unconfirmed")
    result = {"version": 1, "computerId": request["computerId"],
              "sandboxId": request["sandboxId"], "state": "absent"}
    print("HIVRA_GVISOR_V1 " + json.dumps(result, separators=(",", ":")), flush=True)
    return result


def main():
    if os.geteuid() != 0 or os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        fail("Unsupported gVisor host")
    try:
        request = valid_input(json.load(sys.stdin))
    except (json.JSONDecodeError, UnicodeDecodeError):
        fail("Invalid gVisor computer request")
    Path("/run/lock").mkdir(parents=True, exist_ok=True)
    with open("/run/lock/hivra-gvisor-adapter.lock", "a+", encoding="ascii") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        name, volume, network = names(request)
        operation = request["operation"]
        if operation == "create":
            create(request)
        elif operation == "status":
            status(request)
        elif operation == "start":
            require_helper_absent(request)
            item = inspect_container(name, request)
            admit(name, float(item["HostConfig"]["NanoCpus"]) / 1_000_000_000,
                  int(item["HostConfig"]["Memory"]) // (1024 * 1024), int(request["hostMemoryReserveMb"]))
            docker("start", name); status(request)
        elif operation == "stop":
            require_helper_absent(request)
            inspect_container(name, request); docker("stop", "--time", "20", name); status(request)
        elif operation == "resize":
            require_helper_absent(request)
            inspect_container(name, request)
            cpu, memory = float(request["cpu"]), int(request["memoryMb"])
            admit(name, cpu, memory, int(request["hostMemoryReserveMb"]))
            docker("update", "--cpus", str(cpu), "--memory", f"{memory}m", "--memory-swap", f"{memory}m", name)
            status(request)
        elif operation == "exec":
            execute(request)
        elif operation == "delete":
            delete(request)


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        fail()
