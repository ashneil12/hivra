#!/usr/bin/env python3
import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import time


UUID_PATTERN = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
MIRROR_ID = re.compile(UUID_PATTERN)
GVISOR_VOLUME = re.compile("hivra-gvisor-workspace-" + UUID_PATTERN)
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NOATIME
ANCESTOR_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW
CLEAN_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
PSI_MAX = 1.0
ACTIVITY_MAX_BYTES = 256 * 1024
ACTIVITY_WINDOW_SECONDS = 86400


class StopCollection(Exception):
    pass


class UnusableMirror(Exception):
    pass


@contextmanager
def directory(path, parent=None):
    fd = os.open(path, DIR_FLAGS, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


@contextmanager
def absolute_parent(path):
    parts = path.split("/")
    if parts[0] or len(parts) < 2 or any(part in ("", ".", "..") for part in parts[1:]):
        raise ValueError
    with ExitStack() as stack:
        fd = os.open("/", ANCESTOR_FLAGS)
        stack.callback(os.close, fd)
        for part in parts[1:-1]:
            fd = os.open(part, ANCESTOR_FLAGS, dir_fd=fd)
            stack.callback(os.close, fd)
        yield fd, parts[-1]


def io_full_avg10():
    try:
        with open("/proc/pressure/io", encoding="ascii") as pressure:
            match = re.search(r"^full avg10=(\d{1,3}\.\d{2}) ", pressure.read(1024), re.M)
            if match and float(match[1]) <= 100:
                return float(match[1])
    except (OSError, UnicodeError):
        pass
    return None


class Budget:
    def __init__(self, seconds, entries, read_pressure):
        self.deadline = time.monotonic() + seconds
        self.entry_limit = entries
        self.entries = 0
        self.read_pressure = read_pressure
        self.pressure_samples = 0
        self.pressure_max = None

    def check(self, *, pressure=False):
        if time.monotonic() >= self.deadline:
            raise StopCollection("time_limit")
        if pressure:
            value = self.read_pressure()
            if value is None:
                raise StopCollection("pressure_unavailable")
            self.pressure_samples += 1
            self.pressure_max = max(self.pressure_max or 0, value)
            if value >= PSI_MAX:
                raise StopCollection("io_pressure")

    def visit(self):
        if self.entries >= self.entry_limit:
            raise StopCollection("entry_limit")
        self.entries += 1
        self.check(pressure=self.entries % 256 == 0)


def measure_mirror(mirror, components, device, budget):
    apparent = allocated = inodes = 0
    newest = None
    seen_links = set()

    def visit(parent, name, depth):
        nonlocal apparent, allocated, inodes, newest
        budget.visit()
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if depth > 64 or info.st_dev != device:
            raise UnusableMirror
        if stat.S_ISDIR(info.st_mode):
            with directory(name, parent) as child:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise UnusableMirror
                with os.scandir(child) as entries:
                    for entry in entries:
                        visit(child, entry.name, depth + 1)
        elif stat.S_ISREG(info.st_mode):
            newest = info.st_mtime if newest is None else max(newest, info.st_mtime)
        elif not stat.S_ISLNK(info.st_mode):
            raise UnusableMirror
        if not stat.S_ISDIR(info.st_mode) and info.st_nlink > 1:
            if info.st_ino in seen_links:
                return
            seen_links.add(info.st_ino)
        apparent += info.st_size
        allocated += info.st_blocks * 512
        inodes += 1

    for component in components:
        visit(mirror, component, 0)
    return apparent, allocated, inodes, newest


def compressed_size(workspace, components, budget):
    processes = []
    tar_cmd = ["tar", "--create", "--file=-", "--sparse", "--atime-preserve=system",
               "--one-file-system", "-C", f"/proc/self/fd/{workspace}", "--", *components]
    try:
        stream = None
        for command, descriptors in ((tar_cmd, (workspace,)), (["zstd", "-1", "-T1", "-c"], ()),
                                     (["wc", "-c"], ())):
            child = subprocess.Popen(command, stdin=stream or subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=CLEAN_ENV, pass_fds=descriptors)
            processes.append(child)
            if stream is not None:
                stream.close()
            stream = child.stdout
        while True:
            budget.check(pressure=True)
            try:
                output, _ = processes[-1].communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                continue
        for process in processes:
            process.wait(timeout=max(0.01, budget.deadline - time.monotonic()))
        if all(process.returncode == 0 for process in processes):
            return int(output)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
        for process in processes:
            process.stdout.close()
            try:
                process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                pass
    return None


def distribution(values):
    ordered = sorted(values)
    count = len(ordered)
    return {
        "samples": count,
        **{
            key: ordered[math.ceil(count * rank) - 1] if count >= 3 else None
            for key, rank in (("p50", 0.5), ("p90", 0.9), ("p99", 0.99), ("max", 1))
        },
    }


def read_activity(path, scope, now):
    result = {
        "status": "not_configured" if path is None else "unavailable",
        "window_seconds": ACTIVITY_WINDOW_SECONDS,
        "cohort_agents": None,
        "agents_with_recent_reachable_reading": None,
        "agents_with_observed_use_watermark": None,
        "agents_observed_used": None,
        "owners_observed_used": None,
        "concurrency_snapshots_with_coverage": None,
        "sampled_peak_observed_active_runs": None,
        "agents_with_run_count_at_sampled_peak": None,
        "sampled_peak_observed_active_agents": None,
        "agents_with_run_count_at_sampled_agent_peak": None,
    }
    if path is None:
        return result
    cutoff = now - ACTIVITY_WINDOW_SECONDS
    try:
        with absolute_parent(path) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOATIME | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > ACTIVITY_MAX_BYTES
                    or info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o077):
                raise ValueError
            raw = source.read(ACTIVITY_MAX_BYTES + 1)
        if len(raw) > ACTIVITY_MAX_BYTES:
            raise ValueError
        document = json.loads(raw)
        if (set(document) != {"schema_version", "scope", "agents", "aligned_run_count_snapshots"}
                or type(document["schema_version"]) is not int or document["schema_version"] != 1
                or document["scope"] != scope):
            raise ValueError
        agents, snapshots = document["agents"], document["aligned_run_count_snapshots"]
        if (not isinstance(agents, list) or len(agents) > 512
                or not isinstance(snapshots, list) or len(snapshots) > 96):
            raise ValueError
        cohort = []
        fresh = watermarks = observed = 0
        owners = set()
        all_active_owners_known = True
        for agent in agents:
            if set(agent) != {"agent_id", "owner_hash", "reachable", "observed_at_unix_seconds",
                              "last_used_at_unix_seconds"}:
                raise ValueError
            agent_id, owner = agent["agent_id"], agent["owner_hash"]
            reached, timestamp = agent["reachable"], agent["observed_at_unix_seconds"]
            used = agent["last_used_at_unix_seconds"]
            if (not MIRROR_ID.fullmatch(agent_id)
                    or (owner is not None and not re.fullmatch(r"[0-9a-f]{64}", owner))
                    or (reached is not None and type(reached) is not bool)
                    or (timestamp is not None and (type(timestamp) is not int or timestamp < 0))
                    or (used is not None and (type(used) is not int or used < 0))):
                raise ValueError
            cohort.append(agent_id)
            if reached is not True or timestamp is None or not cutoff <= timestamp <= now:
                continue
            fresh += 1
            if used is None or used > timestamp:
                continue
            watermarks += 1
            if used >= cutoff:
                observed += 1
                if owner is None:
                    all_active_owners_known = False
                else:
                    owners.add(owner)
        if len(set(cohort)) != len(cohort):
            raise ValueError
        peak_runs = peak_agents = None
        covered_snapshots = 0
        snapshot_times = set()
        for snapshot in snapshots:
            if set(snapshot) != {"observed_at_unix_seconds", "active_runs_by_agent"}:
                raise ValueError
            timestamp, counts = snapshot["observed_at_unix_seconds"], snapshot["active_runs_by_agent"]
            if (type(timestamp) is not int or timestamp < 0 or timestamp in snapshot_times
                    or not isinstance(counts, list) or len(counts) != len(cohort)
                    or any(value is not None and (type(value) is not int or not 0 <= value <= 1024)
                           for value in counts)):
                raise ValueError
            snapshot_times.add(timestamp)
            if not cutoff <= timestamp <= now:
                continue
            known = [value for value in counts if value is not None]
            if known:
                covered_snapshots += 1
                peak_runs = max(peak_runs or (0, 0), (sum(known), len(known)))
                peak_agents = max(peak_agents or (0, 0), (sum(value > 0 for value in known), len(known)))
        result.update(
            status="observed" if watermarks or covered_snapshots else "no_observations",
            cohort_agents=len(cohort),
            agents_with_recent_reachable_reading=fresh,
            agents_with_observed_use_watermark=watermarks,
            agents_observed_used=observed if watermarks else None,
            owners_observed_used=len(owners) if watermarks and all_active_owners_known else None,
            concurrency_snapshots_with_coverage=covered_snapshots,
            sampled_peak_observed_active_runs=peak_runs[0] if peak_runs else None,
            agents_with_run_count_at_sampled_peak=peak_runs[1] if peak_runs else None,
            sampled_peak_observed_active_agents=peak_agents[0] if peak_agents else None,
            agents_with_run_count_at_sampled_agent_peak=peak_agents[1] if peak_agents else None,
        )
    except (OSError, TypeError, ValueError, KeyError, RecursionError):
        pass
    return result


def collect_host(args, *, read_pressure=io_full_avg10, now=None):
    now = time.time() if now is None else now
    budget = Budget(args.max_seconds, args.max_entries, read_pressure)
    if args.gvisor_volumes_root:
        root_path = args.gvisor_volumes_root
        scope = "gvisor_named_workspace_volume"
        candidate_pattern = GVISOR_VOLUME
        components = ("_data",)
    else:
        root_path = args.mirror_root
        scope = "classic_hermes_backup_mirror_proxy"
        candidate_pattern = MIRROR_ID
        components = ("webui-state", "webui-workspace")
    report = {
        "event": "workspace_measurements",
        "schema_version": 1,
        "scope": scope,
        "observed_at_unix_seconds": int(now),
        "status": "complete",
        "stop_reason": None,
        "inventory_complete": False,
        "workspaces_discovered": 0,
        "workspaces_attempted": 0,
        "workspaces_measured": 0,
        "workspaces_missing_component": 0,
        "workspaces_unusable": 0,
        "restore_pack_coverage": None,
        "authoritative_workspace_freshness": None,
        "filesystem_free_bytes_for_unprivileged": None,
        "filesystem_free_inodes_for_unprivileged": None,
        "compression_attempted": 0,
        "compression_failed": 0,
        "compression_interrupted": 0,
        "compression_over_byte_limit": 0,
        "newest_file_mtime_stale_after_seconds": args.stale_hours * 3600,
        "workspaces_with_stale_file_mtime_proxy": 0,
    }
    metrics = {name: [] for name in (
        "apparent_bytes", "allocated_bytes", "inodes", "zstd_bytes",
        "newest_regular_file_mtime_age_seconds",
    )}
    try:
        budget.check(pressure=True)
        with absolute_parent(root_path) as (parent, name), directory(name, parent) as root:
            try:
                fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise StopCollection("collector_busy") from None
            device = os.fstat(root).st_dev
            filesystem = os.fstatvfs(root)
            report["filesystem_free_bytes_for_unprivileged"] = filesystem.f_bavail * filesystem.f_frsize
            report["filesystem_free_inodes_for_unprivileged"] = filesystem.f_favail if filesystem.f_files else None
            candidates = []
            with os.scandir(root) as entries:
                for entry in entries:
                    budget.visit()
                    if candidate_pattern.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False):
                        candidates.append(entry.name)
                        report["workspaces_discovered"] += 1
            report["inventory_complete"] = True
            day = str(int(now // 86400))
            candidates.sort(key=lambda name: hashlib.sha256((day + name).encode()).digest())
            for name in candidates[:args.max_mirrors]:
                budget.check(pressure=True)
                report["workspaces_attempted"] += 1
                try:
                    with directory(name, root) as mirror:
                        if os.fstat(mirror).st_dev != device:
                            raise UnusableMirror
                        for volume in components:
                            try:
                                with directory(volume, mirror) as component:
                                    if os.fstat(component).st_dev != device:
                                        raise UnusableMirror
                            except FileNotFoundError:
                                report["workspaces_missing_component"] += 1
                                break
                        else:
                            apparent, allocated, inodes, newest = measure_mirror(mirror, components, device, budget)
                            report["workspaces_measured"] += 1
                            for metric, value in (("apparent_bytes", apparent), ("allocated_bytes", allocated),
                                                  ("inodes", inodes)):
                                metrics[metric].append(value)
                            if newest is not None and newest <= now:
                                age = int(now - newest)
                                metrics["newest_regular_file_mtime_age_seconds"].append(age)
                                if age >= report["newest_file_mtime_stale_after_seconds"]:
                                    report["workspaces_with_stale_file_mtime_proxy"] += 1
                            if report["compression_attempted"] < args.compression_samples:
                                if apparent > args.compression_max_bytes:
                                    report["compression_over_byte_limit"] += 1
                                    continue
                                budget.check(pressure=True)
                                report["compression_attempted"] += 1
                                try:
                                    compressed = compressed_size(mirror, components, budget)
                                except StopCollection:
                                    report["compression_interrupted"] += 1
                                    raise
                                if compressed is None:
                                    report["compression_failed"] += 1
                                else:
                                    metrics["zstd_bytes"].append(compressed)
                except (OSError, UnusableMirror):
                    report["workspaces_unusable"] += 1
            if len(candidates) > args.max_mirrors:
                raise StopCollection("workspace_limit")
    except StopCollection as error:
        report.update(status="partial", stop_reason=error.args[0])
    except (OSError, ValueError):
        report.update(status="unavailable", stop_reason="workspace_inventory_unavailable")
    if report["status"] == "complete" and (report["workspaces_missing_component"] or report["workspaces_unusable"]):
        report.update(status="partial", stop_reason="incomplete_workspaces")
    report["distributions"] = {name: distribution(values) for name, values in metrics.items()}
    report["io_full_avg10_samples"] = budget.pressure_samples
    report["io_full_avg10_max_percent"] = budget.pressure_max
    report["activity"] = read_activity(args.activity_input, scope, int(now))
    return report


def bounded_int(minimum, maximum):
    def parse(value):
        try:
            result = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError("expected an integer within bounds") from None
        if not minimum <= result <= maximum:
            raise argparse.ArgumentTypeError("expected an integer within bounds")
        return result
    return parse


def main():
    parser = argparse.ArgumentParser(description="Read-only host-local workspace measurements")
    roots = parser.add_mutually_exclusive_group()
    roots.add_argument("--mirror-root", default="/var/lib/hermes-restic-src")
    roots.add_argument("--gvisor-volumes-root")
    parser.add_argument("--activity-input")
    parser.add_argument("--max-seconds", type=bounded_int(1, 120), default=40)
    parser.add_argument("--max-entries", type=bounded_int(1, 1_000_000), default=200_000)
    parser.add_argument("--max-mirrors", type=bounded_int(1, 256), default=64)
    parser.add_argument("--compression-samples", type=bounded_int(0, 16), default=0)
    parser.add_argument("--compression-max-bytes", type=bounded_int(1, 5 * 1024**3), default=2 * 1024**3)
    parser.add_argument("--stale-hours", type=bounded_int(1, 720), default=48)
    args = parser.parse_args()
    os.nice(10)
    try:
        subprocess.run(["ionice", "-c3", "-p", str(os.getpid())], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, env=CLEAN_ENV, check=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({"event": "workspace_measurements", "schema_version": 1,
                          "status": "unavailable", "stop_reason": "io_priority_unavailable"}))
        return
    print(json.dumps(collect_host(args), separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
