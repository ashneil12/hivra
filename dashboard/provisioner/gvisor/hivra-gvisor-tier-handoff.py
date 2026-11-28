"""Manual managed sandbox handoff on dedicated, prepared QA hosts."""

import contextlib
import json
import os
import stat
import time
from pathlib import Path


def record(path, identity):
    try:
        existing = json.loads(path.read_bytes())
    except FileNotFoundError:
        temporary = path.with_name("." + path.name)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as output:
            json.dump(identity, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    else:
        if existing != identity:
            raise ValueError("Managed sandbox handoff identity changed")


@contextlib.contextmanager
def storage(adapter, codec, config):
    import paramiko

    root = adapter.TIER_ROOT
    for filename in ("storage-known-hosts", "storage-key"):
        adapter.tier_file(root / filename)
    with paramiko.SSHClient() as client:
        client.load_host_keys(str(root / "storage-known-hosts"))
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        client.connect(config["host"], port=config["port"], username=config["user"],
                       key_filename=str(root / "storage-key"), allow_agent=False, look_for_keys=False,
                       timeout=4, banner_timeout=4, auth_timeout=4)
        client.get_transport().channel_timeout = 4
        with client.open_sftp() as sftp:
            sftp.get_channel().settimeout(8)
            yield codec.StorageBox(sftp, config["directory"])


def project_path(quota, workspace):
    proof = quota.verify(workspace)
    path = Path(proof.path)
    source = path.lstat()
    if (not stat.S_ISDIR(source.st_mode) or (source.st_uid, source.st_gid) != (65534, 65534)
            or (source.st_ino, source.st_dev) != (proof.inode, proof.device)):
        raise ValueError("Unexpected workspace root")
    return path


def checkpoint(adapter, request, identity, operation_record, publish):
    root = adapter.TIER_ROOT
    name, volume, network = adapter.names(request)
    adapter.require_helper_absent(request)
    if adapter.inspect_container(adapter.previous_name(request), request, required=False):
        raise ValueError("Pending update")
    adapter.inspect_resource("volume", volume, request, required=True)
    adapter.inspect_resource("network", network, request, required=True)
    item = adapter.inspect_container(name, request)
    if item["HostConfig"]["RestartPolicy"]["Name"] not in {"no", ""}:
        raise ValueError("Source restart policy can break fencing")
    quota = adapter.disk_admission({**request, "operation": "start"})
    if not quota:
        raise ValueError("Could not confirm source quota")
    path = project_path(*quota)
    users = adapter.docker("ps", "-aq", "--no-trunc", "--filter", f"volume={volume}").stdout.splitlines()
    if users != [item["Id"]]:
        raise ValueError("Source workspace has unexpected consumers")
    record(root / ("fenced-" + request["sandboxId"]), operation_record)
    if item["State"]["Running"]:
        adapter.docker("stop", "--time", "20", name)
    stopped = adapter.inspect_container(name, request)["State"]
    if stopped["Status"] not in {"exited", "created"} or stopped["Running"]:
        raise ValueError("Source writer was not stopped")
    return publish(path, identity)


def restore(adapter, request, identity, operation_record, unpack):
    root = adapter.TIER_ROOT
    sandbox = request["sandboxId"]
    if os.path.lexists(root / ("fenced-" + sandbox)):
        raise ValueError("Destination allocation was fenced")
    restoring = root / ("restoring-" + sandbox)
    ready = root / ("ready-" + sandbox)
    name, volume, network = adapter.names(request)
    adapter.require_helper_absent(request)
    if adapter.inspect_container(adapter.previous_name(request), request, required=False):
        raise ValueError("Pending update")
    item = adapter.inspect_container(name, request, required=False)
    has_volume = adapter.inspect_resource("volume", volume, request)
    has_network = adapter.inspect_resource("network", network, request)
    if not os.path.lexists(restoring) and (item or has_volume or has_network):
        raise ValueError("Destination is not a fresh allocation")
    record(restoring, operation_record)
    if os.path.lexists(ready):
        record(ready, operation_record)
        if item is None or not has_volume or not has_network:
            raise ValueError("Previously prepared destination is missing resources")
        if not item["State"]["Running"]:
            if not adapter.disk_admission({**request, "operation": "start"}):
                raise ValueError("Could not readmit destination")
            adapter.admit(name, request["cpu"], request["memoryMb"], request["hostMemoryReserveMb"])
            adapter.docker("start", name)
    else:
        if item and (item["State"]["Status"] != "created" or item["State"]["Running"]):
            raise ValueError("Uncommitted destination could have accepted writes")
        if item or has_volume or has_network:
            adapter.delete(request, emit=False)
        pull = adapter.prepare_image(local_only=True)
        quota = adapter.disk_admission({**request, "operation": "create"})
        if not quota:
            raise ValueError("Destination storage admission denied")
        adapter.create(request, pull_options=pull, workspace_policy=quota,
                       prepare_workspace=lambda: unpack(project_path(*quota), identity),
                       before_start=lambda: record(ready, operation_record), emit=False)
    item = adapter.inspect_container(name, request)
    if (item["HostConfig"]["NanoCpus"] != int(request["cpu"] * 1_000_000_000)
            or item["HostConfig"]["Memory"] != request["memoryMb"] * 1024 * 1024):
        raise ValueError("Destination execution limits did not match")
    adapter.docker("exec", "--user", "65534:65534", "--workdir", "/workspace", name,
                   "/usr/local/bin/python3", "-c", "import os; assert os.access('.', os.R_OK | os.W_OK)",
                   timeout=4)
    return adapter.status(request, emit=False)


def dispatch(adapter, codec, request):
    tier = request["tier"]
    config = json.loads(adapter.tier_file(adapter.TIER_ROOT / "qa-storage.json"))
    if (config.get("version") != 1 or set(config) != {
            "version", "host", "port", "user", "directory", "scratch", "scratchReserveBytes",
            "maxBytes", "maxEntries", "maxCiphertextBytes"}
            or type(config["scratchReserveBytes"]) is not int or config["scratchReserveBytes"] < 1):
        raise ValueError("Invalid QA Storage Box policy")
    operation_record = {**{field: request[field] for field in ("ownerHash", "computerId", "sandboxId")},
                        **{field: tier[field] for field in ("generation", "logicalSandboxId", "runtime")}}
    started = time.monotonic()
    if request["operation"] == "tier-retire":
        record(adapter.TIER_ROOT / ("retired-" + request["sandboxId"]), operation_record)
        emit(request, adapter.delete(request, emit=False), started)
        return
    scratch = Path(config["scratch"])
    info = scratch.lstat()
    if (not scratch.is_absolute() or scratch.resolve() != scratch or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0 or info.st_mode & 0o077):
        raise ValueError("Invalid tier scratch directory")
    limits = codec.GenerationLimits(config["maxBytes"], config["maxEntries"], config["maxCiphertextBytes"])
    available = os.statvfs(scratch)
    if available.f_bavail * available.f_frsize < config["scratchReserveBytes"] + 2 * limits.max_ciphertext_bytes:
        raise ValueError("Insufficient tier scratch capacity")
    identity = codec.GenerationIdentity(request["ownerHash"], request["computerId"],
                                        tier["logicalSandboxId"], tier["generation"], adapter.IMAGE, tier["runtime"])
    key = bytes.fromhex(tier["key"])
    if request["operation"] == "tier-checkpoint":
        if tier["logicalSandboxId"] != request["sandboxId"]:
            raise ValueError("Source identity is not enrolled for this pilot")

        def publish(path, identity):
            with storage(adapter, codec, config) as store:
                return codec.publish_generation(path, store, identity, key, limits, scratch_dir=scratch).to_dict()

        result = checkpoint(adapter, request, identity, operation_record, publish)
    else:
        receipt = codec.GenerationReceipt.from_dict(tier["receipt"])
        operation_record["receipt"] = receipt.to_dict()

        def unpack(path, identity):
            with storage(adapter, codec, config) as store:
                codec.restore_generation(path, store, identity, key, limits, receipt, scratch_dir=scratch)
            adapter.run(["/usr/bin/sync", "-f", str(path)], timeout=15)

        result = restore(adapter, request, identity, operation_record, unpack)
    emit(request, result, started)


def emit(request, result, started):
    payload = {"generation": request["tier"]["generation"], "computerId": request["computerId"],
               "sandboxId": request["sandboxId"], "result": result,
               "hostMs": round((time.monotonic() - started) * 1000)}
    print("HIVRA_GVISOR_TIER_V1 " + json.dumps(payload, separators=(",", ":")), flush=True)
