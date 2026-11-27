import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "workspace_measurements", Path(__file__).with_name("workspace-measurements.py"))
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
NOW = 2_000_000
CLASSIC = "classic_hermes_backup_mirror_proxy"


def identity(index):
    return f"01234567-89ab-4cde-8f01-{index:012x}"


class WorkspaceMeasurementsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private-mirror-root"
        self.root.mkdir()
        self.args = SimpleNamespace(
            mirror_root=str(self.root), gvisor_volumes_root=None, activity_input=None,
            max_seconds=10, max_mirrors=64, max_entries=1000, stale_hours=48,
            compression_samples=0, compression_max_bytes=1024**2)

    def mirror(self, index):
        base = self.root / identity(index)
        (base / "webui-state").mkdir(parents=True)
        (base / "webui-workspace").mkdir()
        return base

    def collect(self, pressure=lambda: 0.0):
        return collector.collect_host(self.args, read_pressure=pressure, now=NOW)

    def test_counts_both_volumes_sparse_bytes_hardlinks_and_metadata_only_staleness(self):
        outside = Path(self.temp.name) / "outside-secret"
        outside.write_bytes(b"secret content")
        for i in (1, 2, 3):
            mirror = self.mirror(i)
            sparse = mirror / "webui-state" / "private-sparse-file"
            with sparse.open("wb") as f:
                f.truncate(i * 1024**2)
            os.link(sparse, mirror / "webui-workspace" / "same-inode")
            (mirror / "webui-workspace" / "external").symlink_to(outside)
            os.utime(sparse, (1, NOW - 3 * 86400))
        report = self.collect()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["workspaces_measured"], 3)
        self.assertEqual(report["distributions"]["inodes"]["p50"], 4)
        self.assertTrue(2 * 1024**2 <= report["distributions"]["apparent_bytes"]["p50"] < 2 * 1024**2 + 16384)
        self.assertLess(report["distributions"]["allocated_bytes"]["max"], 1024**2)
        self.assertEqual(report["workspaces_with_stale_file_mtime_proxy"], 3)
        self.assertIsNone(report["authoritative_workspace_freshness"])
        self.assertIsNone(report["restore_pack_coverage"])
        data = json.dumps(report)
        for private in (identity(1), "private-mirror-root", "private-sparse-file", "outside-secret", "secret content"):
            self.assertNotIn(private, data)

    def test_gvisor_scope_and_missing_mirrors_are_not_counted_as_measured(self):
        self.args.gvisor_volumes_root = str(self.root)
        (self.root / f"hivra-gvisor-workspace-{identity(1)}" / "_data").mkdir(parents=True)
        (self.root / f"hivra-gvisor-workspace-{identity(2)}").mkdir()
        (self.root / f"hivra-gvisor-workspace-{identity(3)}").symlink_to(self.mirror(4))
        report = self.collect()
        self.assertEqual(report["scope"], "gvisor_named_workspace_volume")
        self.assertEqual(report["workspaces_discovered"], 2)
        self.assertEqual(report["workspaces_measured"], 1)
        self.assertEqual(report["workspaces_missing_component"], 1)
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["distributions"]["inodes"]["max"])

    def test_special_file_invalidates_mirror_without_opening_it(self):
        os.mkfifo(self.mirror(1) / "webui-state" / "private-fifo")
        report = self.collect()
        self.assertEqual(report["workspaces_unusable"], 1)
        self.assertEqual(report["workspaces_measured"], 0)

    def test_never_follows_a_symlink_in_operator_root(self):
        alias = self.root.parent / "alias"
        alias.symlink_to(self.root)
        self.args.mirror_root = str(alias / "other")
        (self.root / "other").mkdir()
        self.assertEqual(self.collect()["status"], "unavailable")

    def test_entry_and_workspace_budgets_report_different_coverage(self):
        for i in range(1, 4):
            self.mirror(i)
        self.args.max_entries = 2
        report = self.collect()
        self.assertEqual(report["stop_reason"], "entry_limit")
        self.assertFalse(report["inventory_complete"])
        self.assertEqual(report["workspaces_discovered"], 2)
        self.args.max_entries = 1000
        self.args.max_mirrors = 1
        report = self.collect()
        self.assertEqual(report["stop_reason"], "workspace_limit")
        self.assertTrue(report["inventory_complete"])
        self.assertEqual(report["workspaces_measured"], 1)

    def test_pressure_stops_before_collection_and_mid_scan(self):
        self.assertEqual(self.collect(lambda: None)["stop_reason"], "pressure_unavailable")
        self.assertEqual(self.collect(lambda: 1.0)["stop_reason"], "io_pressure")
        state = self.mirror(1) / "webui-state"
        for i in range(260):
            (state / str(i)).touch()
        pressures = iter([0.0, 0.0, 1.01])
        report = self.collect(lambda: next(pressures))
        self.assertEqual(report["stop_reason"], "io_pressure")
        self.assertEqual(report["io_full_avg10_max_percent"], 1.01)
        self.assertEqual(report["workspaces_measured"], 0)

    @unittest.skipUnless(shutil.which("tar") and shutil.which("zstd"), "GNU tar and zstd are required")
    def test_real_compression_is_opt_in_bounded_and_leaves_no_archive_or_atime_changes(self):
        files = []
        for i in range(1, 5):
            file = self.mirror(i) / "webui-state" / "private-input"
            file.write_bytes(b"x" * 65536)
            os.utime(file, (1, 2))
            os.utime(file.parent, (1, 2))
            files.append(file)
        self.assertEqual(self.collect()["compression_attempted"], 0)
        self.args.compression_samples = 3
        self.args.compression_max_bytes = 1
        self.assertEqual(self.collect()["compression_over_byte_limit"], 4)
        self.args.compression_max_bytes = 1024**2
        report = self.collect()
        self.assertEqual(report["compression_attempted"], 3)
        self.assertEqual(report["compression_failed"], 0)
        self.assertEqual(report["distributions"]["zstd_bytes"]["samples"], 3)
        self.assertTrue(0 < report["distributions"]["zstd_bytes"]["max"] < 65536)
        for file in files:
            self.assertEqual(file.stat().st_atime, 1)
            self.assertEqual(file.parent.stat().st_atime, 1)
            self.assertEqual(list(file.parent.iterdir()), [file])

    def test_pressure_interruption_discards_incomplete_compression_sample(self):
        self.mirror(1)
        self.args.compression_samples = 1
        with patch.object(collector, "compressed_size", side_effect=collector.StopCollection("io_pressure")):
            report = self.collect()
        self.assertEqual(report["compression_attempted"], 1)
        self.assertEqual(report["compression_interrupted"], 1)
        self.assertEqual(report["distributions"]["zstd_bytes"]["samples"], 0)
        self.assertEqual(report["workspaces_measured"], 1)

    def test_activity_reports_partial_watermarks_and_aligned_concurrency_only(self):
        path = self.root / "local-observations"
        self.args.activity_input = str(path)
        owner = "a" * 64
        agents = [
            {"agent_id": identity(i), "owner_hash": owner, "reachable": reached,
             "observed_at_unix_seconds": stamp, "last_used_at_unix_seconds": last}
            for i, reached, stamp, last in (
                (1, True, NOW, NOW - 6), (2, True, NOW - 1, NOW - 2), (3, False, NOW, NOW - 3),
                (4, True, NOW - 90000, NOW - 91000), (5, True, NOW, None))
        ]
        document = {"schema_version": 1, "scope": CLASSIC, "agents": agents,
                    "aligned_run_count_snapshots": [
                        {"observed_at_unix_seconds": NOW - 1, "active_runs_by_agent": [1, None, None, None, 0]},
                        {"observed_at_unix_seconds": NOW, "active_runs_by_agent": [0, 2, None, None, None]},
                        {"observed_at_unix_seconds": NOW - 90000, "active_runs_by_agent": [5, 5, 5, 5, 5]}]}
        path.write_text(json.dumps(document))
        path.chmod(0o600)
        report = self.collect()["activity"]
        self.assertEqual(report["cohort_agents"], 5)
        self.assertEqual(report["agents_with_recent_reachable_reading"], 3)
        self.assertEqual(report["agents_with_observed_use_watermark"], 2)
        self.assertEqual(report["agents_observed_used"], 2)
        self.assertEqual(report["owners_observed_used"], 1)
        self.assertEqual(report["sampled_peak_observed_active_runs"], 2)
        self.assertEqual(report["agents_with_run_count_at_sampled_peak"], 2)
        self.assertEqual(report["sampled_peak_observed_active_agents"], 1)
        self.assertNotIn(owner, json.dumps(report))
        document["aligned_run_count_snapshots"] = []
        path.write_text(json.dumps(document))
        self.assertIsNone(self.collect()["activity"]["sampled_peak_observed_active_runs"])
        document["agents"].append(agents[0])
        path.write_text(json.dumps(document))
        self.assertEqual(self.collect()["activity"]["status"], "unavailable")

    def test_activity_input_missing_unreadable_and_empty_are_not_zero_observations(self):
        self.assertEqual(self.collect()["activity"]["status"], "not_configured")
        path = self.root / "local-observations"
        self.args.activity_input = str(path)
        self.assertEqual(self.collect()["activity"]["status"], "unavailable")
        path.write_text(json.dumps({"schema_version": 1, "scope": CLASSIC, "agents": [],
                                    "aligned_run_count_snapshots": []}))
        self.assertEqual(self.collect()["activity"]["status"], "unavailable")
        path.chmod(0o600)
        report = self.collect()["activity"]
        self.assertEqual(report["status"], "no_observations")
        self.assertIsNone(report["agents_observed_used"])
        self.assertIsNone(report["sampled_peak_observed_active_runs"])
        path.write_bytes(b"x" * (collector.ACTIVITY_MAX_BYTES + 1))
        self.assertEqual(self.collect()["activity"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
