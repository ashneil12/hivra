#!/usr/bin/env python3
"""Local phase-boundary checks; never run the root installer."""
import argparse
import ast
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/remote-desktop/install-guest.py"
spec = importlib.util.spec_from_file_location("desktop_guest_phases", SOURCE)
guest = importlib.util.module_from_spec(spec)
# Preserve the existing capability/installation tests' unregistered import path.
spec.loader.exec_module(guest)


class GuestPhasesTest(unittest.TestCase):
    def test_managed_entrypoint_preserves_order_and_exact_handoff(self):
        args = argparse.Namespace()
        prepared, receipt = object(), object()
        events = []
        def prepare(actual):
            self.assertIs(actual, args)
            events.append("prepare")
            return prepared
        def activate(actual, actual_prepared):
            self.assertIs(actual, args)
            self.assertIs(actual_prepared, prepared)
            events.append("activate")
            return receipt
        with patch.object(guest, "prepare_guest", side_effect=prepare), patch.object(guest, "activate_managed_guest", side_effect=activate):
            self.assertIs(guest.install(args), receipt)
        self.assertEqual(events, ["prepare", "activate"])

    def test_preparation_failure_never_activates(self):
        with patch.object(guest, "prepare_guest", side_effect=RuntimeError("prepare failed")), patch.object(guest, "activate_managed_guest") as activate:
            with self.assertRaisesRegex(RuntimeError, "prepare failed"):
                guest.install(argparse.Namespace())
            activate.assert_not_called()

    def test_preparation_rejects_nonroot_before_any_command(self):
        with patch.object(guest.os, "geteuid", return_value=1000), patch.object(guest, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "installer must run as root"):
                guest.prepare_guest(argparse.Namespace())
            command.assert_not_called()

    def test_private_handoff_repr_does_not_print_credentials(self):
        fields = {name: None for name in guest.PreparedGuest.__slots__}
        fields["basic_pair"] = "fixture-private-credential"
        self.assertNotIn(fields["basic_pair"], repr(guest.PreparedGuest(**fields)))

    def test_preparation_cannot_publish_readiness_or_start_desktop_services(self):
        tree = ast.parse(SOURCE.read_text())
        prepare = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "prepare_guest")
        literals = {node.value for node in ast.walk(prepare) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        for forbidden in ("capability.json", "hivra-remote-desktop-installed-v1", "desktop-activation.json",
                          "hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service"):
            self.assertNotIn(forbidden, literals)
        self.assertIsInstance(prepare.body[-1], ast.Return)
        self.assertEqual(prepare.body[-1].value.func.id, "PreparedGuest")

    def test_provider_network_failure_never_falls_back_to_managed_create(self):
        with patch.object(guest, "run") as command:
            def unknown():
                raise RuntimeError("original network outcome unknown")
            with self.assertRaisesRegex(RuntimeError, "original network outcome unknown"):
                guest.prepare_guest_network(unknown)
            for bad in (None, "short", "D" * 64):
                with self.assertRaisesRegex(RuntimeError, "provider network identity"):
                    guest.prepare_guest_network(lambda: bad)
            command.assert_not_called()

    def test_provider_network_id_is_retained_and_cannot_enter_managed_activation(self):
        with patch.object(guest, "run") as command:
            self.assertEqual(guest.prepare_guest_network(lambda: "d" * 64), "d" * 64)
            with self.assertRaisesRegex(RuntimeError, "owned activation path"):
                guest.activate_managed_guest(argparse.Namespace(), SimpleNamespace(network_id="d" * 64))
            command.assert_not_called()

    def test_managed_network_behavior_remains_inspect_then_create_if_absent(self):
        for exists in (True, False):
            with patch.object(guest, "run", return_value=SimpleNamespace(returncode=0 if exists else 1)) as command:
                self.assertIsNone(guest.prepare_guest_network(None))
                self.assertEqual(command.call_args_list[0].args[0], ["/usr/bin/docker", "network", "inspect", guest.NETWORK])
                self.assertEqual(command.call_count, 1 if exists else 2)
                if not exists:
                    self.assertEqual(command.call_args_list[1].args[0], ["/usr/bin/docker", "network", "create", "--driver", "bridge", "--label", "hivra.remote-desktop=v1", guest.NETWORK])


class ProviderConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(computer_kind="hivra-agent", computer_id="11111111-1111-4111-8111-111111111111",
            control_origin="https://canary.example.test", public_origin="https://computer.example.test", control_bypass_file=None)
        self.username, self.password = "hivra-" + "u" * 16, "p" * 43
        tree = ast.parse(SOURCE.read_text())
        prepare = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "prepare_guest")
        broker_expression = next(node.value for node in ast.walk(prepare) if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "broker_environment" for target in node.targets))
        desktop_expression = next(node.args[1] for node in ast.walk(prepare) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == "write_private"
            and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == "docker_env_path")
        scope = {"args": self.args, "control_origin": self.args.control_origin, "public_origin": self.args.public_origin,
                 "basic_path": guest.STATE / "basic-auth.b64", "state_path": guest.STATE / "sessions.json",
                 "isolation_path": guest.ROOT / "input-isolation", "username": self.username, "password": self.password}
        def evaluate(node):
            return eval(compile(ast.Expression(body=node), str(SOURCE), "eval"), {"__builtins__": {}}, scope)
        self.files = {"desktop": evaluate(desktop_expression).encode(), "broker": ("\n".join(evaluate(broker_expression)) + "\n").encode(),
            "basic": base64.b64encode((self.username + ":" + self.password).encode()) + b"\n"}

    def read(self):
        with patch.object(guest, "read_provider_files", return_value=self.files), patch.object(guest.os.path, "lexists", return_value=False):
            return guest.read_provider_configuration(self.args)

    def test_actual_installer_configuration_agrees_without_rotation(self):
        with patch.object(guest, "run") as command, patch.object(guest, "write_private") as write:
            self.assertEqual(self.read(), self.files["desktop"])
            command.assert_not_called()
            write.assert_not_called()

    def test_mismatched_basic_credential_and_broker_identity_fail_privately(self):
        for key, changed in (("basic", b"wrong\n"),
                             ("broker", self.files["broker"].replace(b"https://computer.example.test", b"https://foreign.example.test")),
                             ("broker", self.files["broker"].replace(self.args.computer_id.encode(), b"foreign")),
                             ("broker", self.files["broker"] + b"FOREIGN_OPTION=true\n"),
                             ("desktop", self.files["desktop"] + b"SELKIES_BASIC_AUTH_PASSWORD=other\n")):
            old = self.files[key]
            self.files[key] = changed
            with self.assertRaisesRegex(RuntimeError, "^Provider desktop configuration could not be verified$") as raised:
                self.read()
            self.assertNotIn(self.password, str(raised.exception))
            self.files[key] = old

    def test_protection_bypass_material_is_not_accepted(self):
        for argument, exists in (("some-path", False), (None, True)):
            self.args.control_bypass_file = argument
            with patch.object(guest, "read_provider_files") as read, patch.object(guest.os.path, "lexists", return_value=exists):
                with self.assertRaises(RuntimeError): guest.read_provider_configuration(self.args)
                read.assert_not_called()

    def test_real_private_file_reader_rejects_links_modes_and_wrong_owner(self):
        with tempfile.TemporaryDirectory(prefix="hivra-private-read-test-") as directory:
            path = Path(directory) / "fixture.env"
            path.write_bytes(b"PRIVATE=fixture\n")
            path.chmod(0o600)
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                uid, gid = path.stat().st_uid, path.stat().st_gid
                self.assertEqual(guest.read_private_at(descriptor, path.name, uid, gid, 0o600), b"PRIVATE=fixture\n")
                with self.assertRaises(RuntimeError): guest.read_private_at(descriptor, path.name, uid + 1, gid, 0o600)
                with self.assertRaises(RuntimeError): guest.read_private_at(descriptor, path.name, uid, gid, 0o640)
                os.symlink(path.name, Path(directory) / "symlink.env")
                with self.assertRaises(OSError): guest.read_private_at(descriptor, "symlink.env", uid, gid, 0o600)
                os.link(path, Path(directory) / "linked.env")
                with self.assertRaises(RuntimeError): guest.read_private_at(descriptor, path.name, uid, gid, 0o600)
            finally:
                os.close(descriptor)


class GuestReadinessTest(unittest.TestCase):
    def setUp(self):
        self.cid, self.network = "c" * 64, "d" * 64
        self.image = "sha256:" + "a" * 64
        self.args = SimpleNamespace(computer_kind="hivra-agent", computer_id="11111111-1111-4111-8111-111111111111",
            control_origin="https://canary.example.test", public_origin="https://computer.example.test", control_bypass_file=None)
        self.environment = b"SELKIES_BASIC_AUTH_USER=hivra-uuuuuuuuuuuuuuuu\nSELKIES_BASIC_AUTH_PASSWORD=" + b"p" * 43 + b"\n"
        self.basic = base64.b64encode(b"hivra-uuuuuuuuuuuuuuuu:" + b"p" * 43).decode()
        self.prepared = SimpleNamespace(network_id=self.network, source=SOURCE.parent,
            broker_source=SOURCE.parent / "broker.cjs", server_source=SOURCE.parent / "server.cjs",
            runtime_image_id=self.image, image_identity={}, public_origin=self.args.public_origin,
            broker_gid=101, isolation_path=guest.ROOT / "input-isolation", basic_pair=self.basic)
        self.container = {"Id": self.cid, "Name": "/" + guest.CONTAINER, "Image": self.image,
            "Config": {"Image": self.image, "User": "ubuntu"},
            "HostConfig": {"Privileged": False, "NetworkMode": self.network},
            "NetworkSettings": {"Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8088"}]},
                                "Networks": {guest.NETWORK: {"NetworkID": self.network}}},
            "State": {"Running": True, "Paused": False, "Restarting": False, "Dead": False},
            "Mounts": [{"Type": "bind", "Source": str(guest.WORKSPACE), "Destination": "/home/ubuntu/Hivra", "Mode": "", "RW": True, "Propagation": "rprivate"}]}
        self.calls = []
        self.unauthorized_status = "401"
        self.authenticated_status = "200"
        self.stop_during_http = False
        self.fail_final_service = False

    def run_command(self, argv, **kwargs):
        self.calls.append(argv)
        stage = kwargs.get("stage", "")
        output = ""
        if argv[:2] == ["/usr/bin/docker", "inspect"]:
            output = json.dumps([self.container])
        elif argv[:2] == ["/usr/bin/id", "-nG"]:
            output = "bux"
        elif stage == "selkies_unauthorized_probe":
            output = self.unauthorized_status
        elif stage == "selkies_authenticated_probe":
            output = self.authenticated_status
            self.assertIn(self.basic, kwargs["input_text"])
            if self.stop_during_http:
                self.container["State"]["Running"] = False
        elif stage == "provider_final_service_active" and self.fail_final_service:
            raise RuntimeError("service is inactive")
        elif argv[:2] != ["/usr/bin/systemctl", "is-active"] and stage != "broker_health":
            self.fail("unexpected readiness command")
        self.assertNotIn(self.basic, " ".join(argv))
        return SimpleNamespace(returncode=0, stdout=output)

    def verify(self, writes, *, provider=True):
        with patch.object(guest.os, "geteuid", return_value=0), patch.object(guest, "run", side_effect=self.run_command), \
             patch.object(guest, "read_provider_configuration", return_value=self.environment), \
             patch.object(guest, "write_private", side_effect=lambda *args, **kwargs: writes.append((args, kwargs))):
            return guest.verify_guest(self.args, self.prepared, container_id=self.cid if provider else None)

    def test_provider_readiness_uses_exact_id_and_requires_authenticated_access(self):
        writes = []
        capability = self.verify(writes)
        self.assertIn(["/usr/bin/docker", "inspect", self.cid], self.calls)
        self.assertEqual(capability["computerId"], self.args.computer_id)
        self.assertEqual(capability["protocol"], "hivra-remote-desktop-installed-v1")
        self.assertEqual([entry[0][0] for entry in writes], [self.prepared.isolation_path, guest.ROOT / "capability.json"])
        self.assertNotIn(self.basic, json.dumps(capability))
        self.assertEqual(self.calls.count(["/usr/bin/docker", "inspect", self.cid]), 2)

    def test_container_stopping_during_http_cannot_publish_capability(self):
        self.stop_during_http = True
        writes = []
        with self.assertRaisesRegex(RuntimeError, "provider running desktop identity"):
            self.verify(writes)
        self.assertEqual(self.calls.count(["/usr/bin/docker", "inspect", self.cid]), 2)
        self.assertEqual([entry[0][0] for entry in writes], [self.prepared.isolation_path])

    def test_service_stopping_during_http_cannot_publish_capability(self):
        self.fail_final_service = True
        writes = []
        with self.assertRaisesRegex(RuntimeError, "service is inactive"):
            self.verify(writes)
        self.assertEqual([entry[0][0] for entry in writes], [self.prepared.isolation_path])

    def test_managed_readiness_preserves_named_container_path(self):
        self.prepared.network_id = None
        self.container["HostConfig"]["NetworkMode"] = guest.NETWORK
        self.verify([], provider=False)
        self.assertIn(["/usr/bin/docker", "inspect", guest.CONTAINER], self.calls)

    def test_foreign_identity_endpoint_or_isolation_never_publishes_capability(self):
        original = copy.deepcopy(self.container)
        variants = [
            {**original, "Id": "e" * 64},
            {**original, "State": {**original["State"], "Paused": True}},
            {**original, "HostConfig": {**original["HostConfig"], "Privileged": True}},
            {**original, "NetworkSettings": {**original["NetworkSettings"], "Networks": {guest.NETWORK: {"NetworkID": ""}}}},
            {**original, "NetworkSettings": {**original["NetworkSettings"], "Networks": {guest.NETWORK: {"NetworkID": self.network}, "foreign": {}}}},
        ]
        for candidate in variants:
            self.container = candidate
            writes = []
            with self.assertRaises(RuntimeError): self.verify(writes)
            self.assertEqual(writes, [])

    def test_unprotected_desktop_http_never_publishes_capability(self):
        self.unauthorized_status = "200"
        writes = []
        with patch.object(guest.time, "monotonic", side_effect=[0, 0, 121]):
            with self.assertRaisesRegex(RuntimeError, "selkies_readiness_timeout"):
                self.verify(writes)
        self.assertEqual([entry[0][0] for entry in writes], [self.prepared.isolation_path])

    def test_provider_identity_is_required_before_any_guest_command(self):
        with patch.object(guest.os, "geteuid", return_value=0), patch.object(guest, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "readiness identity"):
                guest.verify_guest(self.args, self.prepared)
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
