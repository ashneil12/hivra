import base64
import copy
import importlib.util
import io
import json
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


if __name__ == "__main__":
    unittest.main()
