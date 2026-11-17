import base64
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("hivra-gvisor-adapter.py")
DOCKER_29_HELPER_INSPECT = Path(__file__).with_name("fixtures") / "helper-inspect-docker29.json"
SPEC = importlib.util.spec_from_file_location("hivra_gvisor_adapter", MODULE_PATH)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


def request(operation="status"):
    return {
        "operation": operation,
        "ownerHash": "a" * 64,
        "computerId": "11111111-1111-4111-8111-111111111111",
        "sandboxId": "22222222-2222-4222-8222-222222222222",
    }


def run_guest_wrapper(argv, timeout="2"):
    result = subprocess.run(
        [sys.executable, "-c", adapter.GUEST_EXEC_WRAPPER,
         str(adapter.EXEC_OUTPUT_LIMIT), timeout, *argv],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=8,
        check=True,
    )
    return json.loads(result.stdout)


class GuestExecSupervisorTests(unittest.TestCase):
    def test_host_collection_is_bounded_before_process_completion(self):
        result = adapter.run_bounded(
            [sys.executable, "-c", "import os;os.write(1,b'x'*70000);os.write(2,b'y'*70000)"],
            timeout=2,
            limit=1024,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stdout.encode()), 1024)
        self.assertEqual(len(result.stderr.encode()), 1024)

    def test_bounds_output_while_the_guest_process_is_running(self):
        payload = run_guest_wrapper([
            sys.executable,
            "-c",
            "import os; os.write(1,b'a'*70000); os.write(2,b'b'*70000)",
        ])

        self.assertEqual(payload["exitCode"], 0)
        self.assertEqual(len(base64.b64decode(payload["stdoutB64"])), adapter.EXEC_OUTPUT_LIMIT)
        self.assertEqual(len(base64.b64decode(payload["stderrB64"])), adapter.EXEC_OUTPUT_LIMIT)

    def test_timeout_kills_the_guest_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory, "escaped-child-finished")
            child = (
                "import pathlib,subprocess,sys,time;"
                "subprocess.Popen([sys.executable,'-c',"
                + repr("import pathlib,time;time.sleep(0.7);pathlib.Path(" + repr(str(marker)) + ").write_text('alive')")
                + "]);time.sleep(30)"
            )
            started = time.monotonic()
            payload = run_guest_wrapper([sys.executable, "-c", child], timeout="0.1")

            self.assertEqual(payload["exitCode"], 124)
            self.assertLess(time.monotonic() - started, 3)
            time.sleep(0.9)
            self.assertFalse(marker.exists())

    def test_exec_uses_the_pinned_nonroot_sandbox_supervisor(self):
        req = request("exec") | {"argv": ["python3", "-V"]}
        envelope = json.dumps({
            "exitCode": 0,
            "stdoutB64": base64.b64encode(b"Python 3.13\n").decode("ascii"),
            "stderrB64": "",
        })
        completed = subprocess.CompletedProcess(["docker"], 0, envelope, "")
        with mock.patch.object(adapter, "require_helper_absent"), \
                mock.patch.object(adapter, "inspect_container", return_value={"State": {"Running": True}}), \
                mock.patch.object(adapter, "docker", return_value=completed) as docker:
            with redirect_stdout(io.StringIO()):
                receipt = adapter.execute(req)

        self.assertEqual(receipt, {"exitCode": 0, "stdout": "Python 3.13\n", "stderr": ""})
        call = docker.call_args
        self.assertEqual(call.args[:6], ("exec", "--user", "65534:65534", "--workdir", "/workspace",
                                         adapter.names(req)[0]))
        self.assertEqual(call.args[6], "/usr/local/bin/python3")
        self.assertEqual(call.kwargs, {
            "check": False,
            "timeout": 70,
            "capture_limit": adapter.EXEC_ENVELOPE_LIMIT,
        })


class WorkspaceHelperLifecycleTests(unittest.TestCase):
    def test_requires_nocopy_for_the_main_workspace_mount(self):
        _, volume, _ = adapter.names(request())
        mount = {
            "Type": "volume",
            "Source": volume,
            "Target": "/workspace",
            "VolumeOptions": {"NoCopy": True, "DriverConfig": {}},
        }

        self.assertTrue(adapter.has_nocopy_workspace_mount({"Mounts": [mount]}, volume))
        copied = copy.deepcopy(mount)
        copied["VolumeOptions"]["NoCopy"] = False
        self.assertFalse(adapter.has_nocopy_workspace_mount({"Mounts": [copied]}, volume))
        self.assertFalse(adapter.has_nocopy_workspace_mount({"Mounts": []}, volume))

    def test_accepts_docker_29_cap_prefix_from_captured_helper_inspect(self):
        item = json.loads(DOCKER_29_HELPER_INSPECT.read_text())[0]
        labels = item["Config"]["Labels"]
        req = {
            "operation": "create",
            "ownerHash": labels["cloud.hivra.owner"],
            "computerId": labels["cloud.hivra.computer"],
            "sandboxId": labels["cloud.hivra.sandbox"],
        }
        completed = subprocess.CompletedProcess(["docker"], 0, json.dumps([item]), "")

        with mock.patch.object(adapter, "docker", return_value=completed):
            inspected = adapter.inspect_helper(req, required=True)

        self.assertEqual(inspected["Id"], item["Id"])
        self.assertEqual(item["HostConfig"]["CapAdd"], ["CAP_CHOWN"])

    def test_rejects_extra_capability_in_captured_helper_inspect(self):
        item = json.loads(DOCKER_29_HELPER_INSPECT.read_text())[0]
        labels = item["Config"]["Labels"]
        req = {
            "operation": "create",
            "ownerHash": labels["cloud.hivra.owner"],
            "computerId": labels["cloud.hivra.computer"],
            "sandboxId": labels["cloud.hivra.sandbox"],
        }
        altered = copy.deepcopy(item)
        altered["HostConfig"]["CapAdd"].append("CAP_NET_ADMIN")
        completed = subprocess.CompletedProcess(["docker"], 0, json.dumps([altered]), "")

        with mock.patch.object(adapter, "docker", return_value=completed), \
                self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            adapter.inspect_helper(req, required=True)

    def test_workspace_helper_has_identity_and_resource_limits(self):
        req = request("create")
        _, volume, _ = adapter.names(req)
        with mock.patch.object(adapter, "docker") as docker, \
                mock.patch.object(adapter, "inspect_helper", return_value={}) as inspect_helper, \
                mock.patch.object(adapter, "require_helper_absent"):
            adapter.initialize_workspace(req, volume)

        run_call = docker.call_args_list[0]
        argv = run_call.args
        self.assertEqual(argv[:3], ("run", "--name", adapter.helper_name(req)))
        for required in (
            "--runtime=runsc", "--network=none", "--read-only", "--pids-limit",
            "32", "--cpus", "0.5", "--memory", "128m", "--memory-swap",
            "cloud.hivra.role=workspace-init",
        ):
            self.assertIn(required, argv)
        for key, value in adapter.expected_helper_labels(req).items():
            self.assertIn(f"{key}={value}", argv)
        inspect_helper.assert_called_once_with(req, required=True)

    def test_create_disables_volume_copy_up_after_workspace_initialization(self):
        req = request("create") | {"cpu": 1, "memoryMb": 512, "hostMemoryReserveMb": 512}
        _, volume, _ = adapter.names(req)
        with mock.patch.object(adapter, "inspect_container", side_effect=[None, {"State": {"Running": True}}]), \
                mock.patch.object(adapter, "inspect_helper", return_value=None), \
                mock.patch.object(adapter, "require_helper_absent"), \
                mock.patch.object(adapter, "host_capacity", return_value=(8, 8192, 7168, 0, 0)), \
                mock.patch.object(adapter, "inspect_resource", side_effect=[False, False]), \
                mock.patch.object(adapter, "initialize_workspace"), \
                mock.patch.object(adapter, "status", return_value={"status": "running"}), \
                mock.patch.object(adapter, "docker") as docker:
            adapter.create(req)

        create_call = next(call for call in docker.call_args_list if call.args[0] == "create")
        self.assertIn(
            f"type=volume,src={volume},dst=/workspace,volume-nocopy",
            create_call.args,
        )

    def test_create_does_not_remove_an_unowned_helper_name_collision(self):
        req = request("create") | {"cpu": 1, "memoryMb": 512, "hostMemoryReserveMb": 512}
        collision = subprocess.CompletedProcess(
            ["docker"], 0,
            json.dumps([{"Config": {"Labels": {"unowned": "true"}}, "HostConfig": {}}]), "")
        with mock.patch.object(adapter, "inspect_container", return_value=None), \
                mock.patch.object(adapter, "docker", return_value=collision) as docker:
            with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
                adapter.create(req)

        self.assertEqual(docker.call_count, 1)
        self.assertEqual(docker.call_args.args[:2], ("inspect", adapter.helper_name(req)))

    def test_status_rejects_an_interrupted_owned_helper(self):
        req = request("status")
        with mock.patch.object(adapter, "inspect_helper", return_value={"Id": "owned"}), \
                mock.patch.object(adapter, "inspect_container") as inspect_container:
            with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
                adapter.status(req)

        inspect_container.assert_not_called()

    def test_delete_inspects_helper_identity_before_mutating_resources(self):
        req = request("delete")
        with mock.patch.object(adapter, "inspect_container", return_value=None), \
                mock.patch.object(adapter, "inspect_helper", side_effect=SystemExit(1)), \
                mock.patch.object(adapter, "docker") as docker, \
                mock.patch.object(adapter, "inspect_resource") as inspect_resource:
            with self.assertRaises(SystemExit):
                adapter.delete(req)

        docker.assert_not_called()
        inspect_resource.assert_not_called()


class FakeDocker:
    """A small stateful Docker: just enough of create/inspect/rename/start/
    stop/rm, volumes and networks for the adapter's real update code."""

    def __init__(self, req, *, running=True, labels_version=None, fail_start_for=None):
        self.req = req
        name, volume, network = adapter.names(req)
        labels = adapter.expected_labels(req)
        if labels_version:
            labels = {**labels, "cloud.hivra.adapter": labels_version}
        self.volumes = {volume: dict(labels)}
        self.networks = {network: dict(labels)}
        self.containers = {}
        self.calls = []
        self.fail_start_for = fail_start_for
        self.serial = 0
        self.containers[name] = self.container(name, labels, 1.0, 1024, running)

    def container(self, name, labels, cpu, memory, running):
        self.serial += 1
        _, volume, network = adapter.names(self.req)
        return {
            "Id": f"id-{self.serial}", "Name": "/" + name,
            "State": {"Running": running},
            "Config": {"Labels": dict(labels), "User": "65534:65534", "Image": adapter.IMAGE},
            "HostConfig": {
                "Runtime": "runsc", "Privileged": False, "ReadonlyRootfs": True, "NetworkMode": network,
                "Binds": None, "Devices": None, "DeviceCgroupRules": None, "CapAdd": None, "CapDrop": ["ALL"],
                "PortBindings": {}, "PidMode": "", "UsernsMode": "", "IpcMode": "private", "UTSMode": "",
                "CgroupnsMode": "private", "NanoCpus": int(cpu * 1_000_000_000), "Memory": memory * 1024 * 1024,
                "MemorySwap": memory * 1024 * 1024, "PidsLimit": 256, "SecurityOpt": ["no-new-privileges"],
                "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=128m"},
                "Mounts": [{"Type": "volume", "Source": volume, "Target": "/workspace", "VolumeOptions": {"NoCopy": True}}],
            },
            "Mounts": [{"Type": "volume", "Name": volume, "Destination": "/workspace", "RW": True}],
            "NetworkSettings": {"Ports": {}},
        }

    def __call__(self, *args, check=True, timeout=120, capture_limit=None):
        self.calls.append(args)
        ok = lambda out="": subprocess.CompletedProcess(args, 0, out, "")
        bad = subprocess.CompletedProcess(args, 1, "", "error")
        def result(value):
            if value.returncode != 0 and check:
                raise subprocess.CalledProcessError(value.returncode, args)
            return value
        if args[0] == "inspect":
            item = self.containers.get(args[1])
            return result(ok(json.dumps([item])) if item else bad)
        if args[0] == "ps":
            wanted = args[args.index("--filter") + 1].split("^/")[1].rstrip("$")
            return ok(wanted + "\n" if wanted in self.containers else "")
        if args[0] in ("volume", "network"):
            store = self.volumes if args[0] == "volume" else self.networks
            if args[1] == "inspect":
                labels = store.get(args[2])
                return result(ok(json.dumps([{"Labels": labels}])) if labels is not None else bad)
            if args[1] == "ls":
                wanted = args[args.index("--filter") + 1].split("^")[1].rstrip("$")
                return ok(wanted + "\n" if wanted in store else "")
        if args[0] == "pull":
            return ok()
        if args[0] == "stop":
            self.containers[args[-1]]["State"]["Running"] = False
            return ok()
        if args[0] == "start":
            if args[1] == self.fail_start_for and self.containers[args[1]]["Id"] != "id-1":
                return result(bad)
            self.containers[args[1]]["State"]["Running"] = True
            return ok()
        if args[0] == "rename":
            if args[2] in self.containers:
                return result(bad)
            self.containers[args[2]] = self.containers.pop(args[1])
            self.containers[args[2]]["Name"] = "/" + args[2]
            return ok()
        if args[0] == "create":
            name = args[args.index("--name") + 1]
            if name in self.containers:
                return result(bad)
            labels = dict(value.split("=", 1) for flag, value in zip(args, args[1:]) if flag == "--label")
            cpu = float(args[args.index("--cpus") + 1])
            memory = int(args[args.index("--memory") + 1].rstrip("m"))
            self.containers[name] = self.container(name, labels, cpu, memory, False)
            at = args.index("--workdir") + 2
            while args[at] == "--label":
                at += 2
            self.containers[name]["Config"]["Image"] = args[at]
            self.containers[name]["Config"]["Cmd"] = list(args[at + 1:])
            return ok()
        if args[0] == "rm":
            self.containers.pop(args[-1], None)
            return ok()
        raise AssertionError(f"unexpected docker {args}")


class SandboxUpdateTests(unittest.TestCase):
    def setUp(self):
        self.req = request("update") | {"hostMemoryReserveMb": 512}
        self.name, self.volume, self.network = adapter.names(self.req)

    def run_update(self, fake):
        with mock.patch.object(adapter, "docker", fake), \
                mock.patch.object(adapter, "host_capacity", return_value=(8, 8192, 7168, 0, 0)), \
                redirect_stdout(io.StringIO()) as out:
            adapter.update(self.req)
        return json.loads(out.getvalue().split("HIVRA_GVISOR_V1 ", 1)[1])

    def test_recreates_the_container_on_the_pinned_image_and_keeps_the_workspace(self):
        # The regression: a Linux Sandbox could never be updated; Start only
        # restarted the container it was created with.
        fake = FakeDocker(self.req, labels_version="2026.09.15.1")
        before = fake.containers[self.name]["Id"]
        receipt = self.run_update(fake)
        after = fake.containers[self.name]
        self.assertNotEqual(after["Id"], before)
        self.assertEqual(after["Config"]["Image"], adapter.IMAGE)
        self.assertEqual(after["Config"]["Labels"]["cloud.hivra.adapter"], adapter.VERSION)
        self.assertEqual(after["Mounts"][0]["Name"], self.volume)  # Same workspace volume.
        self.assertEqual(set(fake.volumes), {self.volume})  # Never recreated or copied.
        self.assertTrue(after["State"]["Running"])
        self.assertEqual(receipt["state"], "running")
        self.assertNotIn(adapter.previous_name(self.req), fake.containers)
        ops = [call[0] for call in fake.calls if call[0] in ("pull", "stop", "rename", "create", "start", "rm")]
        self.assertEqual(ops, ["pull", "stop", "rename", "create", "start", "rm"])
        self.assertFalse(any(call[:2] == ("volume", "rm") or call[:2] == ("volume", "create") for call in fake.calls))

    def test_keeps_a_stopped_sandbox_stopped(self):
        fake = FakeDocker(self.req, running=False)
        receipt = self.run_update(fake)
        self.assertEqual(receipt["state"], "stopped")
        self.assertFalse(any(call[0] in ("start", "stop") for call in fake.calls))

    def test_keeps_the_limits(self):
        fake = FakeDocker(self.req)
        fake.containers[self.name]["HostConfig"]["NanoCpus"] = 1_500_000_000
        receipt = self.run_update(fake)
        self.assertEqual((receipt["cpu"], receipt["memoryMb"]), (1.5, 1024))

    def test_puts_the_previous_container_back_when_the_new_one_fails(self):
        fake = FakeDocker(self.req, fail_start_for=self.name)
        before = fake.containers[self.name]["Id"]
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_update(fake)
        self.assertEqual(fake.containers[self.name]["Id"], before)
        self.assertTrue(fake.containers[self.name]["State"]["Running"])
        self.assertNotIn(adapter.previous_name(self.req), fake.containers)

    def test_settles_an_interrupted_update_before_any_other_operation(self):
        # Interrupted after the first rename: only the previous container exists.
        fake = FakeDocker(self.req)
        fake.containers[adapter.previous_name(self.req)] = fake.containers.pop(self.name)
        with mock.patch.object(adapter, "docker", fake):
            adapter.recover_update(self.req)
        self.assertIn(self.name, fake.containers)
        self.assertNotIn(adapter.previous_name(self.req), fake.containers)
        # Interrupted after the new container exists: keep it, drop the previous one.
        fake = FakeDocker(self.req)
        fake.containers[adapter.previous_name(self.req)] = fake.container(adapter.previous_name(self.req),
            adapter.expected_labels(self.req), 1.0, 1024, False)
        current = fake.containers[self.name]["Id"]
        with mock.patch.object(adapter, "docker", fake):
            adapter.recover_update(self.req)
        self.assertEqual(fake.containers[self.name]["Id"], current)
        self.assertNotIn(adapter.previous_name(self.req), fake.containers)

    def test_refuses_another_sandboxs_or_an_unknown_releases_resources(self):
        fake = FakeDocker(self.req, labels_version="2026.01.01.1")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.run_update(fake)
        self.assertFalse(any(call[0] in ("stop", "rename", "create", "rm") for call in fake.calls))

    def test_update_is_a_valid_operation_that_needs_the_host_reserve(self):
        self.assertEqual(adapter.valid_input(dict(self.req))["operation"], "update")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            adapter.valid_input(request("update"))


if __name__ == "__main__":
    unittest.main()


class FreeSandboxInputTests(unittest.TestCase):
    """Free sandboxes: pack, release, restore and enroll, a CPU overcommit and a file quota, all checked on input."""

    def check(self, document):
        with redirect_stderr(io.StringIO()):
            return adapter.valid_input(document)

    def refused(self, document):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.valid_input(document)

    def test_new_operations_and_their_fields(self):
        sha = "b" * 64
        self.check(request("pack"))
        self.check(request("release") | {"archiveSha256": sha})
        self.check(request("restore") | {"archiveSha256": sha, "cpu": 0.5, "memoryMb": 512,
                                         "hostMemoryReserveMb": 512, "storageMb": 1024, "cpuOvercommit": 4})
        self.check(request("enroll") | {"enrollCode": "abcDEF_123-x", "serverUrl": "https://agents.example:8443"})
        self.check(request("create") | {"cpu": 0.5, "memoryMb": 512, "hostMemoryReserveMb": 512,
                                        "storageMb": 1024, "cpuOvercommit": 2.5})

    def test_refuses_what_does_not_fit(self):
        sha = "b" * 64
        self.refused(request("release"))
        self.refused(request("release") | {"archiveSha256": "B" * 64})
        self.refused(request("pack") | {"archiveSha256": sha})
        self.refused(request("restore") | {"archiveSha256": sha, "hostMemoryReserveMb": 512})
        self.refused(request("enroll") | {"enrollCode": "short", "serverUrl": "https://a.example"})
        self.refused(request("enroll") | {"enrollCode": "abcDEF_123-x", "serverUrl": "http://a.example"})
        self.refused(request("enroll") | {"enrollCode": "abc DEF;rm -rf", "serverUrl": "https://a.example"})
        self.refused(request("status") | {"enrollCode": "abcDEF_123-x"})
        base = request("create") | {"cpu": 0.5, "memoryMb": 512, "hostMemoryReserveMb": 512}
        self.refused(base | {"cpuOvercommit": 9})
        self.refused(base | {"cpuOvercommit": 0.5})
        self.refused(base | {"cpuOvercommit": True})
        self.refused(base | {"storageMb": 100})
        self.refused(request("stop") | {"storageMb": 1024})


class FreeSandboxClassTests(unittest.TestCase):
    """A free sandbox runs the pinned free image with the image's own command (the runner), never the base image."""

    FREE = "free@sha256:" + "f" * 64

    def test_the_class_is_free_only_and_only_where_a_container_is_made(self):
        base = request("create") | {"cpu": 0.5, "memoryMb": 1024, "hostMemoryReserveMb": 512}
        with redirect_stderr(io.StringIO()):
            adapter.valid_input(base | {"sandboxClass": "free"})
            adapter.valid_input(request("restore") | {"archiveSha256": "b" * 64, "cpu": 0.5, "memoryMb": 1024,
                                                      "hostMemoryReserveMb": 512, "sandboxClass": "free"})
            for bad in (base | {"sandboxClass": "paid"}, request("start") | {"hostMemoryReserveMb": 512,
                                                                              "sandboxClass": "free"}):
                with self.assertRaises(SystemExit):
                    adapter.valid_input(bad)

    def test_refuses_a_free_sandbox_until_a_free_image_is_pinned_before_touching_docker(self):
        docker = mock.Mock()
        req = request("create") | {"cpu": 0.5, "memoryMb": 1024, "hostMemoryReserveMb": 512, "sandboxClass": "free"}
        with mock.patch.object(adapter, "FREE_IMAGE", ""), mock.patch.object(adapter, "docker", docker), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.create(req)
        docker.assert_not_called()

    def test_creates_on_the_free_image_with_its_own_command(self):
        req = request("create") | {"cpu": 0.5, "memoryMb": 1024, "hostMemoryReserveMb": 512, "sandboxClass": "free"}
        docker = mock.Mock()
        with mock.patch.object(adapter, "FREE_IMAGE", self.FREE), mock.patch.object(adapter, "docker", docker):
            adapter.create_container(req, 0.5, 1024)
        args = docker.call_args.args
        self.assertEqual(args[-1], self.FREE)
        self.assertNotIn("/bin/sh", args)
        self.assertIn("65534:65534", args)
        self.assertIn("--read-only", args)

    def test_a_paid_sandbox_still_runs_the_base_image(self):
        docker = mock.Mock()
        with mock.patch.object(adapter, "FREE_IMAGE", self.FREE), mock.patch.object(adapter, "docker", docker):
            adapter.create_container(request("create"), 1, 1024)
        args = docker.call_args.args
        self.assertIn(adapter.IMAGE, args)
        self.assertNotIn(self.FREE, args)

    def test_update_keeps_a_free_sandbox_on_the_free_image(self):
        req = request("update") | {"hostMemoryReserveMb": 512}
        name, _, _ = adapter.names(req)
        fake = FakeDocker(req)
        fake.containers[name]["Config"]["Image"] = self.FREE
        with mock.patch.object(adapter, "FREE_IMAGE", self.FREE), mock.patch.object(adapter, "docker", fake), \
                mock.patch.object(adapter, "host_capacity", return_value=(8, 8192, 7168, 0, 0)), \
                redirect_stdout(io.StringIO()):
            adapter.update(req)
        self.assertEqual(fake.containers[name]["Config"]["Image"], self.FREE)
        self.assertEqual(fake.containers[name]["Config"]["Cmd"], [])
        self.assertIn(("pull", "--platform", "linux/amd64", self.FREE), [c[:4] for c in fake.calls])


class CpuOvercommitTests(unittest.TestCase):
    def admit(self, cpu, overcommit):
        with mock.patch.object(adapter, "host_capacity", return_value=(4, 16384, 16000, 4.0, 1024)), \
                redirect_stderr(io.StringIO()):
            adapter.admit("x", cpu, 512, 1024, overcommit)

    def test_cpu_past_the_cores_only_when_the_caller_asks(self):
        with self.assertRaises(SystemExit):
            self.admit(0.5, 1.0)
        self.admit(0.5, 2.0)
        with self.assertRaises(SystemExit):
            self.admit(4.5, 2.0)

    def test_memory_is_never_overcommitted(self):
        with mock.patch.object(adapter, "host_capacity", return_value=(4, 4096, 4000, 0.0, 3072)), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.admit("x", 0.5, 512, 1024, 8.0)


def tar_bytes(members):
    """A tar stream built from (TarInfo kwargs, payload) pairs."""
    buffer = io.BytesIO()
    with adapter.tarfile.open(fileobj=buffer, mode="w") as archive:
        for fields, payload in members:
            info = adapter.tarfile.TarInfo(fields.pop("name"))
            for key, value in fields.items():
                setattr(info, key, value)
            if payload is not None:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            else:
                archive.addfile(info)
    buffer.seek(0)
    return buffer


class SafeExtractTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.dest = Path(self.dir.name, "workspace")
        self.dest.mkdir()
        self.owners = mock.patch.multiple(adapter.os, lchown=mock.DEFAULT, fchown=mock.DEFAULT)
        self.owners.start()

    def tearDown(self):
        self.owners.stop()
        self.dir.cleanup()

    def extract(self, members):
        with redirect_stderr(io.StringIO()):
            return adapter.extract_tar_stream(tar_bytes(members), self.dest)

    def test_unpacks_files_folders_and_links_without_set_id_bits(self):
        skipped = self.extract([
            ({"name": "./", "type": adapter.tarfile.DIRTYPE, "mode": 0o755}, None),
            ({"name": "./notes", "type": adapter.tarfile.DIRTYPE, "mode": 0o755}, None),
            ({"name": "./notes/a.txt", "mode": 0o4755}, b"hello"),
            ({"name": "./notes/link", "type": adapter.tarfile.SYMTYPE, "linkname": "a.txt"}, None),
            ({"name": "./dev", "type": adapter.tarfile.CHRTYPE, "devmajor": 1, "devminor": 3}, None),
        ])
        self.assertEqual((self.dest / "notes" / "a.txt").read_bytes(), b"hello")
        self.assertEqual((self.dest / "notes" / "a.txt").stat().st_mode & 0o7777, 0o755)
        self.assertEqual(os.readlink(self.dest / "notes" / "link"), "a.txt")
        self.assertFalse((self.dest / "dev").exists())
        self.assertEqual(skipped, 1)

    def test_refuses_absolute_and_parent_paths(self):
        for name in ("/etc/passwd", "../outside", "./a/../../outside"):
            with self.assertRaises(SystemExit):
                self.extract([({"name": name}, b"x")])
        self.assertFalse(Path(self.dir.name, "outside").exists())

    def test_never_writes_through_a_link_an_earlier_member_made(self):
        outside = Path(self.dir.name, "outside")
        outside.mkdir()
        with self.assertRaises(SystemExit):
            self.extract([
                ({"name": "./escape", "type": adapter.tarfile.SYMTYPE, "linkname": str(outside)}, None),
                ({"name": "./escape/owned.txt"}, b"x"),
            ])
        self.assertEqual(list(outside.iterdir()), [])

    def test_never_replaces_an_existing_file_or_follows_a_link_at_the_target(self):
        target = Path(self.dir.name, "victim")
        target.write_text("keep")
        os.symlink(target, self.dest / "same")
        with self.assertRaises(OSError):
            self.extract([({"name": "./same"}, b"overwrite")])
        self.assertEqual(target.read_text(), "keep")


@unittest.skipUnless(Path("/opt/homebrew/bin/zstd").exists() or Path("/usr/bin/zstd").exists(), "needs zstd")
class PackReleaseRestoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.source = root / "workspace"
        (self.source / "chats").mkdir(parents=True)
        (self.source / "chats" / "today.md").write_text("a memory worth keeping")
        zstd = "/opt/homebrew/bin/zstd" if Path("/opt/homebrew/bin/zstd").exists() else "/usr/bin/zstd"
        self.patches = [
            mock.patch.object(adapter, "ARCHIVE_DIR", root / "archives"),
            mock.patch.object(adapter, "ZSTD", zstd),
            mock.patch.object(adapter, "require_helper_absent", lambda request: None),
            mock.patch.object(adapter, "workspace_source", lambda request: self.source),
            mock.patch.object(adapter, "quota_bytes", lambda request: None),
            mock.patch.object(adapter, "inspect_container",
                              lambda name, request, required=True: {"State": {"Running": False}}),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.dir.cleanup()

    def pack(self):
        with redirect_stdout(io.StringIO()):
            return adapter.pack(request("pack"))

    def test_pack_writes_a_verified_archive_and_its_manifest_last(self):
        receipt = self.pack()
        archive, manifest = adapter.archive_paths(request("pack"))
        self.assertEqual(adapter.file_sha256(archive), receipt["sha256"])
        document = json.loads(manifest.read_text())
        self.assertEqual(document["sha256"], receipt["sha256"])
        self.assertEqual(document["sandboxId"], request()["sandboxId"])
        self.assertTrue((self.source / "chats" / "today.md").exists())

    def test_pack_refuses_a_running_sandbox(self):
        with mock.patch.object(adapter, "inspect_container",
                               lambda name, request, required=True: {"State": {"Running": True}}), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.pack()

    def test_release_only_after_the_local_copy_reads_back_to_the_named_digest(self):
        receipt = self.pack()
        delete = mock.Mock()
        with mock.patch.object(adapter, "delete", delete), redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            adapter.release(request("release") | {"archiveSha256": "c" * 64})
        delete.assert_not_called()
        archive, _ = adapter.archive_paths(request())
        with open(archive, "ab") as stream:
            stream.write(b"tampered")
        with mock.patch.object(adapter, "delete", delete), redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            adapter.release(request("release") | {"archiveSha256": receipt["sha256"]})
        delete.assert_not_called()

    def test_release_removes_the_sandbox_and_local_copy_once_verified(self):
        receipt = self.pack()
        delete = mock.Mock()
        with mock.patch.object(adapter, "delete", delete), redirect_stdout(io.StringIO()):
            adapter.release(request("release") | {"archiveSha256": receipt["sha256"]})
        delete.assert_called_once()
        archive, manifest = adapter.archive_paths(request())
        self.assertFalse(archive.exists() or manifest.exists())

    def test_restore_refuses_an_archive_that_does_not_match_before_touching_docker(self):
        self.pack()
        docker = mock.Mock()
        with mock.patch.object(adapter, "docker", docker), redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            adapter.restore(request("restore") | {"archiveSha256": "d" * 64, "cpu": 0.5, "memoryMb": 512,
                                                  "hostMemoryReserveMb": 512})
        docker.assert_not_called()

    def test_an_archive_round_trips_through_the_safe_unpacker(self):
        self.pack()
        archive, _ = adapter.archive_paths(request())
        dest = Path(self.dir.name, "restored")
        dest.mkdir()
        unpack = subprocess.Popen([adapter.ZSTD, "-q", "-d", "-c", str(archive)], stdout=subprocess.PIPE)
        with mock.patch.multiple(adapter.os, lchown=mock.DEFAULT, fchown=mock.DEFAULT):
            adapter.extract_tar_stream(unpack.stdout, dest)
        unpack.stdout.close()
        self.assertEqual(unpack.wait(), 0)
        self.assertEqual((dest / "chats" / "today.md").read_text(), "a memory worth keeping")


class EnrollTests(unittest.TestCase):
    def test_the_code_goes_to_the_shim_on_stdin_only(self):
        seen = {}

        def fake_run(argv, **kwargs):
            seen["argv"], seen["input"] = argv, kwargs.get("input")
            return subprocess.CompletedProcess(argv, 0, None, None)

        req = request("enroll") | {"enrollCode": "secretCODE_123", "serverUrl": "https://agents.example"}
        with mock.patch.object(adapter, "require_helper_absent", lambda request: None), \
                mock.patch.object(adapter, "FREE_IMAGE", "free@sha256:" + "e" * 64), \
                mock.patch.object(adapter, "inspect_container",
                                  lambda name, request, required=True: {"State": {"Running": True},
                                                                        "Config": {"Image": "free@sha256:" + "e" * 64}}), \
                mock.patch.object(adapter.subprocess, "run", fake_run), redirect_stdout(io.StringIO()) as out:
            adapter.enroll(req)
        self.assertNotIn("secretCODE_123", " ".join(seen["argv"]))
        self.assertEqual(seen["input"], "secretCODE_123\n")
        self.assertIn(adapter.ENROLL_SHIM, seen["argv"])
        self.assertIn("--user", seen["argv"])
        self.assertNotIn("secretCODE_123", out.getvalue())

    def test_refuses_a_stopped_sandbox(self):
        req = request("enroll") | {"enrollCode": "secretCODE_123", "serverUrl": "https://agents.example"}
        with mock.patch.object(adapter, "require_helper_absent", lambda request: None), \
                mock.patch.object(adapter, "FREE_IMAGE", "free@sha256:" + "e" * 64), \
                mock.patch.object(adapter, "inspect_container",
                                  lambda name, request, required=True: {"State": {"Running": False},
                                                                        "Config": {"Image": "free@sha256:" + "e" * 64}}), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.enroll(req)

    def test_refuses_every_sandbox_until_a_free_image_is_pinned(self):
        req = request("enroll") | {"enrollCode": "secretCODE_123", "serverUrl": "https://agents.example"}
        run = mock.Mock()
        with mock.patch.object(adapter, "require_helper_absent", lambda request: None), \
                mock.patch.object(adapter, "inspect_container",
                                  lambda name, request, required=True: {"State": {"Running": True},
                                                                        "Config": {"Image": adapter.IMAGE}}), \
                mock.patch.object(adapter.subprocess, "run", run), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.enroll(req)
        run.assert_not_called()


class ReviewFixTests(unittest.TestCase):
    """What the adversarial review found: half-made quotas, restore cleanup, sparse files, hard links."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.patches = [
            mock.patch.object(adapter, "QUOTA_DIR", root / "quota"),
            mock.patch.object(adapter, "MOUNT_DIR", root / "mnt"),
            mock.patch.object(adapter, "ARCHIVE_DIR", root / "archives"),
            mock.patch.object(adapter, "is_mounted", lambda path: False),
            mock.patch.multiple(adapter.os, lchown=mock.DEFAULT, fchown=mock.DEFAULT),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.dir.cleanup()

    def test_a_quota_that_fails_half_way_leaves_nothing_behind(self):
        def run(argv, **kwargs):
            if "mkfs.ext4" in argv[0]:
                raise subprocess.CalledProcessError(1, argv)
            if "truncate" in argv[0]:
                Path(argv[-1]).write_bytes(b"x")
            return subprocess.CompletedProcess(argv, 0, "", "")
        with mock.patch.object(adapter, "run", run), self.assertRaises(subprocess.CalledProcessError):
            adapter.create_quota_volume(request("create"), "vol", 1024, [])
        image, mountpoint = adapter.quota_paths(request())
        self.assertFalse(image.exists() or mountpoint.exists())

    def test_restore_refuses_where_a_workspace_image_is_already_on_the_host(self):
        image, _ = adapter.quota_paths(request())
        image.parent.mkdir(parents=True)
        image.write_bytes(b"newer workspace")
        req = request("restore") | {"archiveSha256": "f" * 64, "cpu": 0.5, "memoryMb": 512, "hostMemoryReserveMb": 512}
        docker = mock.Mock()
        with mock.patch.object(adapter, "verified_archive", lambda request, sha: Path("/nonexistent")), \
                mock.patch.object(adapter, "require_helper_absent", lambda request: None), \
                mock.patch.object(adapter, "inspect_container", lambda name, request, required=True: None), \
                mock.patch.object(adapter, "inspect_resource", lambda kind, name, request, required=False: False), \
                mock.patch.object(adapter, "docker", docker), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.restore(req)
        docker.assert_not_called()
        self.assertEqual(image.read_bytes(), b"newer workspace")

    def test_unpacking_stops_at_the_storage_limit(self):
        dest = Path(self.dir.name, "dest")
        dest.mkdir()
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.extract_tar_stream(tar_bytes([({"name": "./a"}, b"x" * 60), ({"name": "./b"}, b"y" * 60)]),
                                       dest, max_bytes=100)

    def test_hard_links_point_only_at_files_this_archive_unpacked(self):
        dest = Path(self.dir.name, "dest")
        dest.mkdir()
        adapter.extract_tar_stream(tar_bytes([
            ({"name": "./a.txt"}, b"same"),
            ({"name": "./b.txt", "type": adapter.tarfile.LNKTYPE, "linkname": "./a.txt"}, None),
        ]), dest)
        self.assertEqual((dest / "b.txt").read_bytes(), b"same")
        self.assertEqual((dest / "a.txt").stat().st_ino, (dest / "b.txt").stat().st_ino)
        for linkname in ("../outside", "/etc/passwd", "./missing"):
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                adapter.extract_tar_stream(tar_bytes([
                    ({"name": "./c.txt", "type": adapter.tarfile.LNKTYPE, "linkname": linkname}, None),
                ]), dest)

    def test_pack_refuses_a_workspace_whose_files_would_not_fit_back(self):
        source = Path(self.dir.name, "workspace")
        source.mkdir()
        with open(source / "sparse", "wb") as stream:
            stream.truncate(10 * 1024 * 1024)
        with mock.patch.object(adapter, "require_helper_absent", lambda request: None), \
                mock.patch.object(adapter, "inspect_container",
                                  lambda name, request, required=True: {"State": {"Running": False}}), \
                mock.patch.object(adapter, "workspace_source", lambda request: source), \
                mock.patch.object(adapter, "quota_bytes", lambda request: 1024 * 1024), \
                redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            adapter.pack(request("pack"))
        self.assertFalse(adapter.ARCHIVE_DIR.exists())
