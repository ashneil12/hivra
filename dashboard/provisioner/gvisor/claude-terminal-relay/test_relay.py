import importlib.util
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import relay


FIXTURE = {
    "ownerHash": "a" * 64,
    "computerId": "11111111-1111-4111-8111-111111111111",
    "sandboxId": "22222222-2222-4222-8222-222222222222",
    "image": "sha256:" + "b" * 64,
}
DOCKER_ID = "c" * 64
RUNNING = {"Running": True, "Paused": False, "Restarting": False, "Dead": False,
           "Health": {"Status": "healthy"}}


class FixtureTests(unittest.TestCase):
    def test_reads_only_small_root_owned_files_of_exact_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory, "fixture")
            file.write_bytes(b"1234")
            symlink = Path(directory, "link")
            symlink.symlink_to(file)
            with self.assertRaises(OSError):
                relay.read_owned_file(symlink, 0o600, 4)
            for uid, mode in ((1, stat.S_IFREG | 0o600), (0, stat.S_IFREG | 0o640), (0, stat.S_IFDIR | 0o600)):
                with mock.patch.object(os, "fstat", return_value=SimpleNamespace(st_mode=mode, st_uid=uid)):
                    with self.subTest(uid=uid, mode=mode), self.assertRaises(relay.RelayError):
                        relay.read_owned_file(file, 0o600, 4)
            with mock.patch.object(os, "fstat", return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)):
                self.assertEqual(relay.read_owned_file(file, 0o600, 4), b"1234")
                with self.assertRaises(relay.RelayError):
                    relay.read_owned_file(file, 0o600, 3)

    def test_validates_binding_using_the_installed_adapter_contract(self):
        fixture_adapter = Path(__file__).resolve().parents[1] / "hivra-gvisor-adapter.py"
        spec = importlib.util.spec_from_file_location("fixture_adapter", fixture_adapter)
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        with mock.patch.object(relay, "read_owned_file", return_value=json.dumps(FIXTURE)):
            request = relay.fixture_request(adapter)
        self.assertEqual(request, {
            "operation": "status", "ownerHash": FIXTURE["ownerHash"], "computerId": FIXTURE["computerId"],
            "sandboxId": FIXTURE["sandboxId"], "workload": {"kind": "claude-terminal", "image": FIXTURE["image"]},
        })
        for value in ([], FIXTURE | {"address": "localhost"}, FIXTURE | {"ownerHash": "other"},
                      FIXTURE | {"computerId": "other"}, FIXTURE | {"sandboxId": "other"},
                      FIXTURE | {"image": "latest"}):
            with mock.patch.object(relay, "read_owned_file", return_value=json.dumps(value)), \
                    mock.patch.object(adapter, "fail", side_effect=SystemExit(1)), \
                    self.subTest(value=value), self.assertRaises((relay.RelayError, SystemExit)):
                relay.fixture_request(adapter)
        duplicate = json.dumps(FIXTURE)[:-1] + ', "image": "other"}'
        with mock.patch.object(relay, "read_owned_file", return_value=duplicate), self.assertRaises(relay.RelayError):
            relay.fixture_request(adapter)

    def setUp(self):
        self.adapter = mock.Mock()
        self.adapter.names.return_value = ("name", "volume", "network")
        self.adapter.previous_name.return_value = "previous"
        self.request = {"operation": "status"}

    def attest(self, *, state=RUNNING, container_id=DOCKER_ID, previous=None):
        self.adapter.inspect_container.side_effect = [previous, {"Id": container_id, "State": state}]
        return relay.verified_container_id(self.adapter, self.request)

    def test_attests_all_resources_and_returns_the_full_verified_id(self):
        self.assertEqual(self.attest(), DOCKER_ID)
        self.adapter.require_helper_absent.assert_called_once_with(self.request)
        self.assertEqual(self.adapter.inspect_container.call_args_list, [
            mock.call("previous", self.request, required=False), mock.call("name", self.request),
        ])
        self.assertEqual(self.adapter.inspect_resource.call_args_list, [
            mock.call("volume", "volume", self.request, required=True),
            mock.call("network", "network", self.request, required=True),
        ])

    def test_refuses_starting_unhealthy_paused_restarting_or_stopped_sandboxes(self):
        for changed in ({"Health": None}, {"Health": {"Status": "starting"}}, {"Health": {"Status": "unhealthy"}},
                        {"Paused": True}, {"Restarting": True}, {"Running": False}, {"Dead": True}):
            with self.subTest(changed=changed), self.assertRaises(relay.RelayError):
                self.attest(state=RUNNING | changed)

    def test_refuses_pending_replacement_and_short_or_untrusted_container_ids(self):
        with self.assertRaises(relay.RelayError):
            self.attest(previous={})
        for container_id in (DOCKER_ID[:12], "--privileged", "sha256:" + DOCKER_ID):
            with self.subTest(container_id=container_id), self.assertRaises(relay.RelayError):
                self.attest(container_id=container_id)

    def test_exec_uses_one_fixed_command_as_nonroot_with_no_tty_or_dynamic_address(self):
        argv = relay.docker_exec_argv(DOCKER_ID)
        self.assertEqual(argv[:-1], [
            "/usr/bin/docker", "exec", "--interactive", "--user", "65534:65534", "--workdir", "/workspace",
            DOCKER_ID, "/usr/local/bin/python3", "-I", "-B", "-c",
        ])
        self.assertEqual(argv[-1], relay.GUEST_RELAY)
        self.assertIn('upstream.connect("/tmp/hivra-claude-terminal.sock")', argv[-1])
        with self.assertRaises(relay.RelayError):
            relay.docker_exec_argv("-H tcp://other")

    def test_stdio_must_be_the_same_connected_unix_stream(self):
        first, second = socket.socketpair()
        with first, second:
            evidence = os.fstat(first.fileno())
            other = os.fstat(second.fileno())
            fd = os.dup(first.fileno())
            with mock.patch.object(os, "fstat", side_effect=[evidence, evidence]), \
                    mock.patch.object(os, "dup", return_value=fd):
                relay.require_connected_unix_socket()
            with mock.patch.object(os, "fstat", side_effect=[evidence, other]), self.assertRaises(relay.RelayError):
                relay.require_connected_unix_socket()

    def test_main_runs_exec_only_after_verification_under_the_lifecycle_lock(self):
        steps = []
        with mock.patch.object(sys, "argv", ["relay.py"]), mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.dict(os.environ, {"DOCKER_HOST": "tcp://wrong"}, clear=True), \
                mock.patch.object(relay, "require_connected_unix_socket"), \
                mock.patch.object(relay, "load_adapter", return_value=self.adapter), \
                mock.patch.object(relay, "fixture_request", return_value=self.request), \
                mock.patch.object(os, "open", return_value=3), mock.patch.object(os, "fdopen", mock.mock_open()), \
                mock.patch.object(os, "fstat", return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)), \
                mock.patch.object(relay.fcntl, "flock", side_effect=lambda *args: steps.append("lock")), \
                mock.patch.object(relay, "verified_container_id", side_effect=lambda *args: steps.append("verify") or DOCKER_ID), \
                mock.patch.object(os, "execve", side_effect=lambda *args: steps.append("exec")) as spawn:
            relay.main()
            self.assertEqual(os.environ["DOCKER_HOST"], "unix:///var/run/docker.sock")
        self.assertEqual(steps, ["lock", "verify", "exec"])
        spawn.assert_called_once_with(relay.DOCKER, relay.docker_exec_argv(DOCKER_ID), relay.ENV)

    def test_guest_relay_preserves_binary_bytes_and_write_half_close(self):
        payload = bytes(range(256)) * 400
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            path = str(Path(directory, "fixture.sock"))
            listener.bind(path)
            listener.listen()
            listener.settimeout(5)
            received = bytearray()

            def echo():
                with listener.accept()[0] as peer:
                    peer.settimeout(5)
                    while chunk := peer.recv(8192):
                        received.extend(chunk)
                    peer.sendall(received)

            server = threading.Thread(target=echo, daemon=True)
            server.start()
            program = relay.GUEST_RELAY.replace('"/tmp/hivra-claude-terminal.sock"', repr(path))
            result = subprocess.run([sys.executable, "-I", "-B", "-c", program],
                                    input=payload, capture_output=True, timeout=6, check=True)
            server.join(5)
            self.assertFalse(server.is_alive())
            self.assertEqual(received, payload)
            self.assertEqual(result.stdout, payload)


if __name__ == "__main__":
    unittest.main()
