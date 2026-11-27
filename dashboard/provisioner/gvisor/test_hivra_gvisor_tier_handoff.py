import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


def load(filename):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter = load("hivra-gvisor-adapter.py")
handoff = load("hivra-gvisor-tier-handoff.py")


class TierHandoffTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.request = {"computerId": "11111111-1111-4111-8111-111111111111",
                        "sandboxId": "22222222-2222-4222-8222-222222222222",
                        "ownerHash": "e" * 64, "cpu": 1, "memoryMb": 1024, "hostMemoryReserveMb": 1024}
        self.host = Mock(TIER_ROOT=self.root)
        self.host.names.return_value = ("container", "volume", "network")
        self.host.previous_name.return_value = "previous"
        self.item = {"HostConfig": {"RestartPolicy": {"Name": "no"}, "NanoCpus": 1_000_000_000,
                                    "Memory": 1024 ** 3},
                     "Id": "container-id", "State": {"Running": True, "Status": "running"}}
        self.stopped = {**self.item, "State": {"Running": False, "Status": "exited"}}
        self.host.docker.return_value.stdout = "container-id\n"
        self.host.disk_admission.return_value = (Mock(), Mock())

    def test_source_fence_exists_before_stop_and_survives_publish_failure(self):
        self.host.inspect_container.side_effect = [None, self.item, self.stopped]
        fence = self.root / ("fenced-" + self.request["sandboxId"])

        def docker(*args):
            if args[0] == "stop":
                self.assertTrue(fence.is_file())
            return SimpleNamespace(stdout="container-id\n")

        self.host.docker.side_effect = docker
        with patch.object(handoff, "project_path", return_value=self.root), self.assertRaises(OSError):
            handoff.checkpoint(self.host, self.request, "identity", {"id": "generation"},
                               Mock(side_effect=OSError))
        with patch.object(adapter, "TIER_ROOT", self.root):
            for operation in ("create", "exec", "start", "delete"):
                with self.subTest(operation=operation), self.assertRaises(SystemExit):
                    adapter.dispatch_tier_guard({**self.request, "operation": operation})

    def test_failed_stop_does_not_publish(self):
        self.host.inspect_container.side_effect = [None, self.item, self.item]
        publish = Mock()
        with patch.object(handoff, "project_path", return_value=self.root), self.assertRaises(ValueError):
            handoff.checkpoint(self.host, self.request, "identity", {}, publish)
        publish.assert_not_called()

    def test_retry_does_not_replace_a_started_destination(self):
        self.host.inspect_container.side_effect = [None, self.item, self.item]
        sandbox = self.request["sandboxId"]
        identity = {"generation": "same"}
        handoff.record(self.root / ("restoring-" + sandbox), identity)
        handoff.record(self.root / ("ready-" + sandbox), identity)
        unpack = Mock()
        handoff.restore(self.host, self.request, "identity", identity, unpack)
        self.host.create.assert_not_called()
        self.host.delete.assert_not_called()
        unpack.assert_not_called()

    def test_conflicting_retry_cannot_replace_the_fence(self):
        record = self.root / "record"
        handoff.record(record, {"generation": "original"})
        with self.assertRaises(ValueError):
            handoff.record(record, {"generation": "different"})
        handoff.record(record, {"generation": "original"})

    def test_retired_destination_refuses_a_stale_restore(self):
        handoff.record(self.root / ("retired-" + self.request["sandboxId"]), {})
        with patch.object(adapter, "TIER_ROOT", self.root), patch.object(adapter, "dispatch_tier") as dispatch:
            with self.assertRaises(SystemExit):
                adapter.dispatch_tier_guard({**self.request, "operation": "tier-restore"})
            dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
