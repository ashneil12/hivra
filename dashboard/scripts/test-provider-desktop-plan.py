#!/usr/bin/env python3
"""Run the private create-once preparation with simulated journal/Docker only."""
import copy
from contextlib import ExitStack
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/remote-desktop/provider-service-plan.py"
spec = importlib.util.spec_from_file_location("desktop_plan", SOURCE)
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)
CID = "a" * 64
COMPUTER = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
IMAGE = "sha256:" + "b" * 64
NODE = "/usr/bin/node"
NETWORK_ID = "c" * 64
NETWORK_INTENT = plan.network_intent(COMPUTER, OPERATION)
NETWORK_ROWS = {"desktop-network-intent.json": NETWORK_INTENT,
                "desktop-network.json": {**NETWORK_INTENT, "networkId": NETWORK_ID}}
OVERRIDES = {**plan.DESKTOP_SETTINGS, "SELKIES_BASIC_AUTH_USER": "hivra-" + "u" * 16,
             "SELKIES_BASIC_AUTH_PASSWORD": "p" * 43}
ENV_FILE = ("\n".join(key + "=" + value for key, value in OVERRIDES.items()) + "\n").encode()
BASE_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "SELKIES_ENABLE_BASIC_AUTH": "false"}
EXPECTED_ENV = {**BASE_ENV, **OVERRIDES}
INTENT = {"version": 3, "computerId": COMPUTER, "operationId": OPERATION, "imageId": IMAGE, "node": NODE, "networkId": NETWORK_ID,
          "environmentSha256": hashlib.sha256(plan.encode(EXPECTED_ENV)).hexdigest()}


class CompositionTest(unittest.TestCase):
    def test_gateway_workspace_uses_the_original_broker_identity_environment(self):
        unit = plan.render_units(CID, NODE)["bux-hivra-chat.service"]
        self.assertIn("Environment=HIVRA_WORKSPACE_PROTOCOL=hivra-workspace-v1\n", unit)
        self.assertIn("EnvironmentFile=/var/lib/hivra/remote-desktop/broker.env\n", unit)
        self.assertIn("User=bux\n", unit)
        self.assertIn("Environment=HIVRA_WORKSPACE_ROOT=/home/bux/Hivra\n", unit)

    def setUp(self):
        self.rows, self.events = {}, []
        self.fail_at = self.cancel_at = None
        self.args = SimpleNamespace(computer_kind="hivra-agent", computer_id=COMPUTER,
            control_origin="https://canary.example.test", public_origin="https://desktop.example.test",
            control_bypass_file=None)
        self.ownership = {"container": {"id": CID, "imageId": IMAGE}}
        self.capability = {"computerId": COMPUTER, "computerKind": "hivra-agent",
            "protocol": "hivra-remote-desktop-installed-v1"}
        self.prepared = SimpleNamespace(network_id=NETWORK_ID, runtime_image_id=IMAGE, node_binary=NODE)
        def publish(name, value):
            self.assertNotIn(name, self.rows)
            self.rows[name] = copy.deepcopy(value)
        self.journal = SimpleNamespace(read=self.rows.get, publish=publish)
        self.command = Mock(side_effect=AssertionError("unexpected raw command"))
        self.owner = object()
        self.guest = SimpleNamespace(origin=lambda value: value,
            prepare_guest=self.prepare, read_provider_configuration=self.configuration,
            verify_guest=self.verify)

    def step(self, name):
        self.assertIn("desktop-preparation-intent.json", self.rows)
        self.events.append(name)
        if self.cancel_at == name:
            self.rows["cancel.json"] = {"cancelled": True}
        if self.fail_at == name:
            raise RuntimeError("private failure with credential that must not escape")

    def prepare(self, args, *, network_preparer):
        self.assertIs(args, self.args)
        self.step("prepare")
        self.assertEqual(network_preparer(), NETWORK_ID)
        return self.prepared

    def network(self, computer, operation, journal, command):
        self.assertEqual((computer, operation), (COMPUTER, OPERATION))
        self.step("network")
        self.rows.update(copy.deepcopy(NETWORK_ROWS))
        return NETWORK_ID

    def configuration(self, args):
        self.step("configuration")
        return ENV_FILE

    def services(self, computer, operation, image, node, journal, command, *, desktop_env):
        self.assertEqual((computer, operation, image, node, desktop_env), (COMPUTER, OPERATION, IMAGE, NODE, ENV_FILE))
        self.step("services")
        return {"ownership": self.ownership}

    def units(self, *args):
        self.step("units")

    def activate(self, *args):
        self.step("activate")

    def verify(self, args, prepared, *, container_id):
        self.assertIs(prepared, self.prepared)
        self.assertEqual(container_id, CID)
        self.step("verify")
        return self.capability

    def install(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(plan.os, "geteuid", return_value=0))
            for name, function in (("prepare_network", self.network), ("prepare_services", self.services),
                                   ("publish_units", self.units), ("activate_units", self.activate)):
                stack.enter_context(patch.object(plan, name, side_effect=function))
            return plan.install_prepared_base(self.args, OPERATION, self.journal, self.command, self.owner, self.guest)

    def test_order_exact_identity_and_no_private_material_in_journal(self):
        self.assertEqual(self.install(), self.capability)
        self.assertEqual(self.events, ["prepare", "network", "configuration", "services", "units", "activate", "verify"])
        receipt = self.rows["desktop-ready.json"]
        self.assertEqual(receipt["ownership"], self.ownership)
        self.assertEqual(receipt["capabilitySha256"], hashlib.sha256(plan.encode(self.capability)).hexdigest())
        self.assertNotIn(OVERRIDES["SELKIES_BASIC_AUTH_PASSWORD"], json.dumps(self.rows))
        before = self.events[:]
        with self.assertRaises(RuntimeError): self.install()
        self.assertEqual(self.events, before)

    def test_failure_at_every_phase_retains_intent_and_never_reruns(self):
        for phase in ("prepare", "network", "configuration", "services", "units", "activate", "verify"):
            with self.subTest(phase=phase):
                self.setUp()
                self.fail_at = phase
                with self.assertRaisesRegex(RuntimeError, "^Provider desktop preparation could not be verified$"):
                    self.install()
                self.assertNotIn("desktop-ready.json", self.rows)
                self.assertIn("desktop-preparation-intent.json", self.rows)
                before = self.events[:]
                self.fail_at = None
                with self.assertRaises(RuntimeError): self.install()
                self.assertEqual(self.events, before)

    def test_cancel_between_phases_never_publishes_ready(self):
        for phase in ("prepare", "network", "configuration", "services", "units", "activate", "verify"):
            with self.subTest(phase=phase):
                self.setUp()
                self.cancel_at = phase
                with self.assertRaises(RuntimeError): self.install()
                self.assertNotIn("desktop-ready.json", self.rows)
                self.assertEqual(self.events[-1], phase)

    def test_existing_partial_phase_and_bypass_rejected_before_preparation(self):
        for name in ("cancel.json", "desktop-network.json", "desktop-activation.json", "desktop-ready.json"):
            self.setUp()
            self.rows[name] = {}
            with self.assertRaises(RuntimeError): self.install()
            self.assertEqual(self.events, [])
        self.setUp()
        self.args.control_bypass_file = "/private/bypass"
        with self.assertRaises(RuntimeError): self.install()
        self.assertEqual(self.rows, {})

    def test_returned_network_and_capability_must_match_original(self):
        self.prepared.network_id = "d" * 64
        with self.assertRaises(RuntimeError): self.install()
        self.assertNotIn("services", self.events)
        self.setUp()
        self.capability["computerId"] = OPERATION
        with self.assertRaises(RuntimeError): self.install()
        self.assertNotIn("desktop-ready.json", self.rows)


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.rows = copy.deepcopy(NETWORK_ROWS)
        self.network_present = True
        self.network_creates = 0
        self.lose_network_ack = False
        self.network_document = {"Id": NETWORK_ID, "Name": plan.NETWORK, "Driver": "bridge", "Scope": "local",
            "Internal": False, "Attachable": False, "Ingress": False, "EnableIPv6": False,
            "ConfigOnly": False, "ConfigFrom": {"Network": ""}, "Options": {},
            "Labels": {"io.hivra.computer-id": COMPUTER, "io.hivra.operation-id": OPERATION,
                       "io.hivra.desktop-network-intent": hashlib.sha256(plan.encode(NETWORK_INTENT)).hexdigest()}}
        self.created = 0
        self.present = False
        self.lose_ack = False
        self.lose_container = False
        self.commands = []
        # Darwin lacks renameat2. Files/modes/inodes remain real test-owned
        # state; replace only the Linux exclusive publication syscall.
        def publish_exclusive(source, destination):
            if os.path.lexists(destination):
                raise FileExistsError()
            os.rename(source, destination)
        self.exclusive = publish_exclusive
        exclusive_patch = patch.object(plan, "publish_exclusive", side_effect=publish_exclusive)
        exclusive_patch.start()
        self.addCleanup(exclusive_patch.stop)
        self.document = [CID, "/" + plan.NAME, IMAGE, "ubuntu", {
            "io.hivra.computer-id": COMPUTER, "io.hivra.operation-id": OPERATION,
            "io.hivra.desktop-intent": hashlib.sha256(plan.encode(INTENT)).hexdigest(),
        }, {"Privileged": False, "AutoRemove": False, "CgroupParent": "system.slice", "NetworkMode": NETWORK_ID,
            "NanoCpus": 2_000_000_000, "Memory": 4 * 1024**3, "ShmSize": 2 * 1024**3, "PidsLimit": 2048,
            "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8088"}]},
            "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "SecurityOpt": ["no-new-privileges"],
            "PidMode": "", "CgroupnsMode": "private", "CapAdd": None, "Devices": [],
            "IpcMode": "private", "UTSMode": "", "UsernsMode": "", "DeviceRequests": None,
            "DeviceCgroupRules": None, "VolumesFrom": None, "Binds": None,
            "PublishAllPorts": False, "Runtime": "runc", "Isolation": ""},
            [{"Type": "bind", "Source": plan.WORKSPACE, "Destination": "/home/ubuntu/Hivra", "Mode": "", "RW": True, "Propagation": "rprivate"}],
            {"Status": "created", "Running": False, "Paused": False, "Restarting": False, "Dead": False, "Pid": 0},
            ["/etc/container-entrypoint.sh"], None, "/home/ubuntu", {plan.NETWORK: {
                "NetworkID": "", "EndpointID": "", "Gateway": "", "IPAddress": "", "IPPrefixLen": 0,
                "IPv6Gateway": "", "GlobalIPv6Address": "", "GlobalIPv6PrefixLen": 0,
                "MacAddress": "", "IPAMConfig": None}},
            [key + "=" + value for key, value in EXPECTED_ENV.items()]]

    def read(self, key):
        return copy.deepcopy(self.rows.get(key))

    def publish(self, key, value):
        if key in self.rows and self.rows[key] != value:
            raise RuntimeError("immutable journal differs")
        self.rows[key] = copy.deepcopy(value)

    def command(self, argv):
        self.commands.append(argv)
        if argv[:3] == ["/usr/bin/docker", "network", "ls"]:
            return (NETWORK_ID + "\n").encode() if self.network_present else b""
        if argv[:3] == ["/usr/bin/docker", "network", "inspect"]:
            self.assertEqual(argv[-1], NETWORK_ID)
            return json.dumps([self.network_document]).encode()
        if argv[:3] == ["/usr/bin/docker", "network", "create"]:
            self.assertEqual(self.rows["desktop-network-intent.json"], NETWORK_INTENT)
            self.network_creates += 1
            self.network_present = True
            if self.lose_network_ack:
                raise subprocess.TimeoutExpired("network create", 10)
            return (NETWORK_ID + "\n").encode()
        if argv[:3] == ["/usr/bin/docker", "image", "inspect"]:
            self.assertEqual(argv[-1], IMAGE)
            return json.dumps([key + "=" + value for key, value in BASE_ENV.items()]).encode()
        if argv[:2] == ["/usr/bin/docker", "info"]:
            return b"systemd/2\n"
        if argv[:3] == ["/usr/bin/docker", "container", "ls"]:
            return (CID + "\n").encode() if self.present else b""
        if argv[:3] == ["/usr/bin/docker", "container", "create"]:
            self.assertEqual(self.rows.get("desktop-create-intent.json"), INTENT)
            self.assertNotIn("desktop-ownership.json", self.rows)
            self.created += 1
            self.present = not self.lose_container
            self.assertNotIn("--rm", argv)
            self.assertEqual(argv[argv.index("--cgroup-parent") + 1], "system.slice")
            self.assertEqual(argv[argv.index("--cgroupns") + 1], "private")
            self.assertEqual(argv[argv.index("--ipc") + 1], "private")
            self.assertEqual(argv[argv.index("--runtime") + 1], "runc")
            self.assertEqual(argv[argv.index("--user") + 1], "ubuntu")
            self.assertEqual(argv[argv.index("--network") + 1], NETWORK_ID)
            if self.lose_ack:
                raise subprocess.TimeoutExpired("docker create", 10)
            return (CID + "\n").encode()
        if argv[:3] == ["/usr/bin/docker", "container", "inspect"]:
            self.assertEqual(argv[-1], CID)
            return json.dumps(self.document).encode()
        self.fail("Unexpected mutation/command: " + repr(argv))

    def prepare(self):
        return plan.prepare_services(COMPUTER, OPERATION, IMAGE, NODE, self, self.command, desktop_env=ENV_FILE)

    def test_records_intent_then_exact_owned_plan_without_activation(self):
        result = self.prepare()
        self.assertEqual(self.created, 1)
        self.assertEqual(self.rows["desktop-ownership.json"], result["ownership"])
        self.assertEqual(result["ownership"]["container"]["id"], CID)
        for unit, contents in result["units"].items():
            self.assertEqual(result["ownership"]["units"][unit], hashlib.sha256(contents.encode()).hexdigest())
        selkies = result["units"]["hivra-selkies-desktop.service"]
        self.assertIn("ExecStart=/usr/bin/docker start --attach " + CID, selkies)
        self.assertIn("ExecStop=/usr/bin/docker stop --time 10 " + CID, selkies)
        self.assertNotIn("ExecStartPre", selkies)
        self.assertNotIn("--rm", selkies)
        self.assertNotIn("desktop-activation.json", self.rows)
        self.assertFalse(any(argv[0] == "/usr/bin/systemctl" for argv in self.commands))

    def test_recovers_lost_create_ack_without_another_create(self):
        self.lose_ack = True
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertNotIn("desktop-ownership.json", self.rows)
        self.lose_ack = False
        result = self.prepare()
        self.assertEqual(result["ownership"]["container"]["id"], CID)
        self.assertEqual(self.created, 1)

    def test_unknown_intent_without_container_never_recreates(self):
        self.rows["desktop-create-intent.json"] = INTENT
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.created, 0)

    def test_refuses_existing_name_before_recording_or_creating(self):
        self.present = True
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.rows, NETWORK_ROWS)
        self.assertEqual(self.created, 0)

    def test_replay_keeps_the_same_identity_and_unit_hashes(self):
        first = self.prepare()
        self.assertEqual(self.prepare(), first)
        self.assertEqual(self.created, 1)

    def test_different_or_incomplete_original_journal_never_creates(self):
        for rows in ({"desktop-create-intent.json": {**INTENT, "node": "/foreign"}},
                     {"desktop-activation.json": INTENT}, {"desktop-ownership.json": {"container": CID}}):
            with self.subTest(rows=rows):
                self.rows = copy.deepcopy(rows)
                with self.assertRaises(RuntimeError): self.prepare()
                self.assertEqual(self.created, 0)

    def test_recovered_foreign_identity_is_not_owned(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        for index, value in ((0, "c" * 64), (1, "/foreign"), (2, "sha256:" + "c" * 64), (3, "root"), (4, {})):
            with self.subTest(index=index):
                before = self.document[index]
                self.document[index] = value
                with self.assertRaises(RuntimeError): self.prepare()
                self.assertNotIn("desktop-ownership.json", self.rows)
                self.document[index] = before
        self.assertEqual(self.created, 0)

    def test_recovery_rejects_weakened_isolation_before_ownership_publication(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        for key, value in (("Privileged", True), ("AutoRemove", True), ("CgroupParent", "foreign.slice"),
                           ("NetworkMode", "host"), ("CgroupnsMode", "host"), ("Memory", 0),
                           ("IpcMode", "host"), ("UTSMode", "host"), ("UsernsMode", "host"),
                           ("DeviceRequests", [{"Count": -1, "Capabilities": [["gpu"]]}]),
                           ("DeviceCgroupRules", ["c *:* rwm"]), ("VolumesFrom", ["foreign"]),
                           ("Binds", ["/:/host"]), ("PublishAllPorts", True), ("Runtime", "foreign"),
                           ("Isolation", "hyperv"),
                           ("SecurityOpt", []), ("PortBindings", {"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8088"}]})):
            with self.subTest(key=key):
                old = self.document[5][key]
                self.document[5][key] = value
                with self.assertRaises(RuntimeError): self.prepare()
                self.assertNotIn("desktop-ownership.json", self.rows)
                self.document[5][key] = old
        self.assertEqual(self.created, 0)

    def test_running_or_differently_mounted_container_is_not_prepared(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        self.document[7]["Running"] = True
        with self.assertRaises(RuntimeError): self.prepare()
        self.document[7]["Running"] = False
        self.document[6][0]["Source"] = "/foreign"
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertNotIn("desktop-ownership.json", self.rows)

    def test_recovery_rejects_command_overrides_and_extra_networks(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        for index, value in ((8, ["/bin/sh"]), (9, ["-c", "sleep infinity"]),
                             (10, "/tmp"), (11, {plan.NETWORK: {}, "foreign": {}})):
            with self.subTest(index=index):
                old = self.document[index]
                self.document[index] = value
                with self.assertRaises(RuntimeError): self.prepare()
                self.assertNotIn("desktop-ownership.json", self.rows)
                self.document[index] = old
        self.assertEqual(self.created, 0)

    def test_missing_nullable_isolation_field_is_not_assumed_default(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        del self.document[5]["DeviceRequests"]
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertNotIn("desktop-ownership.json", self.rows)
        self.assertEqual(self.created, 0)

    def test_invalid_input_has_no_commands_or_journal_effects(self):
        with self.assertRaises(RuntimeError): plan.prepare_services(COMPUTER, OPERATION, IMAGE, "/tmp/node", self, self.command, desktop_env=ENV_FILE)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.rows, NETWORK_ROWS)

    def test_failed_intent_publication_does_not_create(self):
        with patch.object(self, "publish", side_effect=RuntimeError("journal unavailable")):
            with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.created, 0)
        self.assertFalse(self.present)

    def test_intent_without_returned_container_retains_unknown_outcome(self):
        self.lose_container = True
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.created, 1)
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.created, 1)
        self.assertNotIn("desktop-ownership.json", self.rows)

    def test_matches_actual_installer_generated_security_environment(self):
        tree = ast.parse((SOURCE.parent / "install-guest.py").read_text())
        prepare = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "prepare_guest")
        write = next(node for node in ast.walk(prepare) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name) and node.func.id == "write_private"
                     and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == "docker_env_path")
        expression = ast.Expression(body=write.args[1])
        generated = eval(compile(expression, str(SOURCE), "eval"), {"__builtins__": {}}, {
            "username": OVERRIDES["SELKIES_BASIC_AUTH_USER"], "password": OVERRIDES["SELKIES_BASIC_AUTH_PASSWORD"],
        })
        self.assertEqual(plan.desktop_overrides(generated.encode()), OVERRIDES)

    def test_network_create_once_recovers_lost_ack_without_recreation(self):
        self.rows = {}
        self.network_present = False
        self.lose_network_ack = True
        with self.assertRaises(RuntimeError):
            plan.prepare_network(COMPUTER, OPERATION, self, self.command)
        self.assertNotIn("desktop-network.json", self.rows)
        self.lose_network_ack = False
        self.assertEqual(plan.prepare_network(COMPUTER, OPERATION, self, self.command), NETWORK_ID)
        self.assertEqual(self.rows, NETWORK_ROWS)
        self.assertEqual(self.network_creates, 1)
        self.prepare()
        self.assertEqual(self.created, 1)

    def test_unknown_missing_network_is_never_recreated(self):
        self.rows = {"desktop-network-intent.json": NETWORK_INTENT}
        self.network_present = False
        with self.assertRaises(RuntimeError):
            plan.prepare_network(COMPUTER, OPERATION, self, self.command)
        self.assertEqual(self.network_creates, 0)

    def test_existing_network_is_never_adopted_without_original_intent(self):
        self.rows = {}
        with self.assertRaises(RuntimeError):
            plan.prepare_network(COMPUTER, OPERATION, self, self.command)
        self.assertEqual(self.rows, {})
        self.assertEqual(self.network_creates, 0)

    def test_network_identity_and_authority_rechecked_before_container_creation(self):
        for key, value in (("Id", "d" * 64), ("Driver", "host"), ("Scope", "swarm"),
                           ("Internal", True), ("Attachable", True), ("Ingress", True),
                           ("Options", {"com.docker.network.bridge.name": "foreign"}), ("Labels", {})):
            with self.subTest(key=key):
                old = self.network_document[key]
                self.network_document[key] = value
                with self.assertRaises(RuntimeError): self.prepare()
                self.assertNotIn("desktop-create-intent.json", self.rows)
                self.network_document[key] = old
        self.assertEqual(self.created, 0)

    def test_unjournaled_or_replaced_network_never_allows_container_creation(self):
        del self.rows["desktop-network-intent.json"]
        with self.assertRaises(RuntimeError): self.prepare()
        self.rows = copy.deepcopy(NETWORK_ROWS)
        self.rows["desktop-network.json"]["networkId"] = "d" * 64
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertEqual(self.created, 0)

    def test_container_endpoint_must_reference_the_original_network(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        self.document[11] = {plan.NETWORK: {"NetworkID": "d" * 64}}
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertNotIn("desktop-ownership.json", self.rows)
        self.document[11] = {plan.NETWORK: {"NetworkID": NETWORK_ID}}
        self.prepare()
        self.assertEqual(self.created, 0)

    def test_unallocated_endpoint_rejects_foreign_addresses_and_missing_fields(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        endpoint = self.document[11][plan.NETWORK]
        for key, value in (("NetworkID", "d" * 64), ("EndpointID", "d" * 64),
                           ("IPAddress", "10.251.0.20"), ("IPPrefixLen", 24),
                           ("IPAMConfig", {"IPv4Address": "10.251.0.20"})):
            old = endpoint[key]
            endpoint[key] = value
            with self.assertRaises(RuntimeError): self.prepare()
            endpoint[key] = old
        del endpoint["EndpointID"]
        with self.assertRaises(RuntimeError): self.prepare()
        self.assertNotIn("desktop-ownership.json", self.rows)
        self.assertEqual(self.created, 0)

    def test_network_preparation_rejects_activated_or_corrupt_original_journal(self):
        for change in ({"desktop-activation.json": {}}, {"desktop-network-intent.json": {}}):
            self.rows = {**copy.deepcopy(NETWORK_ROWS), **change}
            with self.assertRaises(RuntimeError):
                plan.prepare_network(COMPUTER, OPERATION, self, self.command)
        self.assertEqual(self.network_creates, 0)

    def test_changed_private_environment_never_reuses_original_intent(self):
        self.prepare()
        before = copy.deepcopy(self.rows)
        changed = ENV_FILE.replace(b"p" * 43, b"q" * 43)
        with self.assertRaisesRegex(RuntimeError, "^Provider desktop preparation could not be verified$"):
            plan.prepare_services(COMPUTER, OPERATION, IMAGE, NODE, self, self.command, desktop_env=changed)
        self.assertEqual(self.created, 1)
        self.assertEqual(self.rows, before)

    def test_recovery_checks_exact_effective_environment_without_logging_it(self):
        self.rows["desktop-create-intent.json"] = INTENT
        self.present = True
        original = list(self.document[12])
        candidates = [original + ["FOREIGN_OVERRIDE=1"], original + ["PATH=/foreign"],
                      [item for item in original if not item.startswith("LANG=")],
                      [item.replace("p" * 43, "q" * 43) for item in original],
                      [item.replace("SELKIES_ENABLE_BASIC_AUTH=true", "SELKIES_ENABLE_BASIC_AUTH=false") for item in original]]
        for candidate in candidates:
            self.document[12] = candidate
            with self.assertRaises(RuntimeError) as raised:
                self.prepare()
            self.assertNotIn("desktop-ownership.json", self.rows)
            self.assertNotIn("p" * 43, str(raised.exception))
        self.assertEqual(self.created, 0)

    def test_private_settings_fail_before_commands_and_are_not_journaled(self):
        candidates = [ENV_FILE + b"FOREIGN_OVERRIDE=1\n", ENV_FILE + b"SELKIES_MODE=websockets\n",
                      ENV_FILE.replace(b"SELKIES_COMMAND_ENABLED=false", b"SELKIES_COMMAND_ENABLED=true"),
                      ENV_FILE.replace(b"p" * 43, b"short"), b"not-ascii-\xff\n"]
        for candidate in candidates:
            with self.assertRaises(RuntimeError):
                plan.prepare_services(COMPUTER, OPERATION, IMAGE, NODE, self, self.command, desktop_env=candidate)
        self.assertEqual(self.commands, [])
        result = self.prepare()
        self.assertNotIn("p" * 43, json.dumps({"result": result, "journal": self.rows, "argv": self.commands}))

    def unit_owner(self, directory):
        root = Path(directory)
        commands = []
        def read_regular(path, limit, mode):
            info = path.lstat()
            if path.is_symlink() or info.st_nlink != 1 or info.st_mode & 0o777 != mode:
                raise RuntimeError("unsafe test unit")
            return path.read_bytes()
        def observed(expected):
            states = {name: {"LoadState": "loaded" if (root / name).exists() else "not-found"} for name in expected["units"]}
            return states, {"Status": "created"}
        return SimpleNamespace(UNIT_ROOT=root, ownership=lambda value: value,
            directory=lambda path: self.assertEqual(path, root), read_regular=read_regular,
            observed=observed, observe_stopped=lambda expected: True, command=commands.append, commands=commands)

    def test_publishes_exact_unit_files_without_activation(self):
        prepared = self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            result = plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            self.assertEqual(result, {"unitsInstalled": True, "activationDispatched": False, "readinessVerified": False})
            for name, contents in prepared["units"].items():
                self.assertEqual((Path(directory) / name).read_text(), contents)
                self.assertEqual((Path(directory) / name).stat().st_mode & 0o777, 0o644)
            self.assertEqual(owner.commands, [["/usr/bin/systemctl", "daemon-reload"]])
            self.assertNotIn("desktop-activation.json", self.rows)
            self.assertEqual({path.name for path in Path(directory).iterdir()}, set(prepared["units"]))

    def test_existing_unit_is_never_adopted_before_unit_intent(self):
        prepared = self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            name = next(iter(prepared["units"]))
            path = Path(directory) / name
            path.write_text(prepared["units"][name])
            with self.assertRaises(RuntimeError): plan.publish_units(COMPUTER, OPERATION, NODE, self, self.unit_owner(directory))
            self.assertNotIn("desktop-unit-intent.json", self.rows)
            self.assertEqual(path.read_text(), prepared["units"][name])

    def test_recovers_partial_unit_publication_without_overwriting(self):
        self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            calls = []
            def interrupted(source, destination):
                calls.append(destination)
                if len(calls) == 2:
                    raise OSError("interrupted publication")
                return self.exclusive(source, destination)
            with patch.object(plan, "publish_exclusive", side_effect=interrupted):
                with self.assertRaises(RuntimeError): plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            first = calls[0]
            identity = first.stat().st_ino
            self.assertNotIn("desktop-units.json", self.rows)
            self.assertEqual(owner.commands, [])
            plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            self.assertEqual(first.stat().st_ino, identity)
            self.assertEqual(len(list(Path(directory).iterdir())), 3)

    def test_cancellation_and_activation_markers_prevent_unit_publication(self):
        self.prepare()
        for marker in ("cancel.json", "desktop-activation.json"):
            with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
                self.rows[marker] = {}
                with self.assertRaises(RuntimeError): plan.publish_units(COMPUTER, OPERATION, NODE, self, self.unit_owner(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])
                del self.rows[marker]

    def test_foreign_file_on_partial_recovery_is_preserved(self):
        prepared = self.prepare()
        self.rows["desktop-unit-intent.json"] = {"version": 1, "ownership": prepared["ownership"]}
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            path = Path(directory) / next(iter(prepared["units"]))
            path.write_text("foreign unit")
            path.chmod(0o644)
            owner = self.unit_owner(directory)
            with self.assertRaises(RuntimeError): plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            self.assertEqual(path.read_text(), "foreign unit")
            self.assertEqual(len(list(Path(directory).iterdir())), 1)
            self.assertEqual(owner.commands, [])

    def test_activation_is_once_only_and_follows_durable_intent(self):
        self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            def dispatch(argv):
                self.assertIn("desktop-activation.json", self.rows)
                owner.commands.append(argv)
            owner.command = dispatch
            args = SimpleNamespace(computer_id=COMPUTER)
            guest = SimpleNamespace(read_provider_configuration=lambda value: ENV_FILE)
            result = plan.activate_units(args, OPERATION, NODE, self, self.command, owner, guest)
            self.assertEqual(result, {"activationDispatched": True, "readinessVerified": False})
            sequence = ["hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service"]
            self.assertEqual(owner.commands[1:], [["/usr/bin/systemctl", verb, unit] for verb in ("enable", "start") for unit in sequence])
            with self.assertRaises(RuntimeError): plan.activate_units(args, OPERATION, NODE, self, self.command, owner, guest)
            self.assertEqual(len(owner.commands), 7)

    def test_lost_activation_ack_never_dispatches_again(self):
        self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            def unknown(argv):
                owner.commands.append(argv)
                raise subprocess.TimeoutExpired("systemctl enable", 10)
            owner.command = unknown
            args = SimpleNamespace(computer_id=COMPUTER)
            guest = SimpleNamespace(read_provider_configuration=lambda value: ENV_FILE)
            for _ in range(2):
                with self.assertRaises(RuntimeError): plan.activate_units(args, OPERATION, NODE, self, self.command, owner, guest)
            self.assertEqual(len(owner.commands), 2)  # reload, one uncertain enable
            self.assertIn("desktop-activation.json", self.rows)

    def test_changed_configuration_or_running_services_prevent_activation(self):
        self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            args = SimpleNamespace(computer_id=COMPUTER)
            guest = SimpleNamespace(read_provider_configuration=lambda value: ENV_FILE.replace(b"p" * 43, b"q" * 43))
            with self.assertRaises(RuntimeError): plan.activate_units(args, OPERATION, NODE, self, self.command, owner, guest)
            guest.read_provider_configuration = lambda value: ENV_FILE
            owner.observe_stopped = lambda value: False
            with self.assertRaises(RuntimeError): plan.activate_units(args, OPERATION, NODE, self, self.command, owner, guest)
            self.assertNotIn("desktop-activation.json", self.rows)
            self.assertEqual(len(owner.commands), 1)

    def test_cancellation_after_activation_intent_prevents_first_enable(self):
        self.prepare()
        with tempfile.TemporaryDirectory(prefix="hivra-unit-plan-test-") as directory, patch.object(plan.os, "geteuid", return_value=0):
            owner = self.unit_owner(directory)
            plan.publish_units(COMPUTER, OPERATION, NODE, self, owner)
            original = self.publish
            def cancel_after_intent(key, value):
                original(key, value)
                if key == "desktop-activation.json":
                    self.rows["cancel.json"] = {}
            guest = SimpleNamespace(read_provider_configuration=lambda value: ENV_FILE)
            with patch.object(self, "publish", side_effect=cancel_after_intent):
                with self.assertRaises(RuntimeError):
                    plan.activate_units(SimpleNamespace(computer_id=COMPUTER), OPERATION, NODE, self, self.command, owner, guest)
            self.assertEqual(len(owner.commands), 1)
            self.assertIn("desktop-activation.json", self.rows)


if __name__ == "__main__":
    unittest.main()
