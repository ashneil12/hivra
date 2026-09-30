"""Deterministic guards for the offline VM fixture; no QEMU/downloads here."""
import importlib.util
import http.client
import io
import json
import hashlib
from pathlib import Path
import tempfile
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location("offline_vm", Path(__file__).with_name("test-deepseek-systemd-vm.py"))
vm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vm)
GUEST_SPEC = importlib.util.spec_from_file_location("offline_guest", Path(__file__).with_name("deepseek-systemd-guest.py"))
guest = importlib.util.module_from_spec(GUEST_SPEC)
GUEST_SPEC.loader.exec_module(guest)
# Must contain a letter: the contract test asserts that OWNER.upper() is REJECTED
# as a non-canonical UUID. An all-digit placeholder round-trips through .upper()
# unchanged, so it silently stopped testing that rejection (commit 5084c91c4).
OWNER = "00000000-0000-4000-8000-00000000000a"


class OfflineVmContract(unittest.TestCase):
    def test_cancellation_during_child_acquisition_still_reaps_the_child(self):
        resources = vm.FixtureResources()
        real_popen = subprocess.Popen
        children = []
        def acquired(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            resources.cancel()  # At the old fork/exec -> assignment race.
            return child
        try:
            with patch.object(vm.subprocess, "Popen", side_effect=acquired), self.assertRaises(InterruptedError):
                resources.start([sys.executable, "-I", "-c", "import time; time.sleep(60)"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        finally:
            resources.cleanup()
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertIs(resources.process, children[0])

    def test_partial_scratch_setup_is_inside_the_cleanup_scope(self):
        if not vm.shutil.rmtree.avoids_symlink_attacks:
            self.skipTest("fd-based cleanup only")
        resources = vm.FixtureResources()
        with tempfile.TemporaryDirectory() as folder:
            first = resources.allocate("first-", folder)
            with patch.object(vm.tempfile, "mkdtemp", side_effect=OSError("fixture allocation failure")), self.assertRaises(OSError):
                resources.allocate("second-", folder)
            resources.cleanup()
            self.assertFalse(first.exists())

    def test_guest_reads_are_bounded_and_do_not_follow_links(self):
        with tempfile.TemporaryDirectory() as folder:
            # resolve() removes macOS's /var -> /private/var alias in this fixture.
            root = Path(folder).resolve()
            file = root / "value"
            file.write_bytes(b"12345")
            self.assertEqual(vm.read_regular(file, 5), b"12345")
            with self.assertRaises(RuntimeError):
                vm.read_regular(file, 4)
            link = root / "link"
            link.symlink_to(file)
            with self.assertRaises(RuntimeError):
                vm.read_regular(link, 10)

    def test_guest_evidence_never_exports_unknown_or_untyped_payloads(self):
        package = {"version": "pinned"}
        raw = {"owner": OWNER, "scope": "offline-ubuntu-native-systemd", "verdict": "FAIL", "schema": 1,
               "stage": "actual_native_install", "errorType": "RuntimeError", "errorCode": "sensitive value",
               "serviceState": "LoadState=loaded\nEnvironment=sensitive value\nActiveState=sensitive value\n",
               "nativeHtml": "sensitive value", "extra": {"key": "sensitive value"}, "package": package}
        result = vm.guest_evidence(raw, OWNER, package)
        self.assertNotIn("sensitive value", json.dumps(result))
        self.assertEqual(result["serviceState"], {"LoadState": "loaded", "ActiveState": "unexpected"})
        self.assertNotIn("nativeHtml", result)
        with self.assertRaises(RuntimeError):
            vm.guest_evidence({**raw, "package": {"version": "changed"}}, OWNER, package)

    def test_source_snapshot_uses_only_manifest_bytes_and_rejects_drift_or_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            source = root / "dashboard/provisioner"
            source.mkdir(parents=True)
            version = "2026.01.02.3"
            entries = []
            # Any sealed release size: the payload is whatever the manifest lists.
            for name in ["VERSION", *[f"file-{number}" for number in range(4)]]:
                content = version.encode() if name == "VERSION" else b"reviewed"
                (source / name).write_bytes(content)
                entries.append({"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            (source / "not-reviewed").write_text("do not copy")
            manifest = {"schema": 1, "version": version, "files": entries}
            committed = {"dashboard/provisioner/VERSION": (version + "\n").encode(),
                         f"dashboard/provisioner-releases/{version}.json": json.dumps(manifest).encode()}
            with patch.object(vm, "ROOT", root), patch.object(vm, "git_bytes", side_effect=committed.__getitem__):
                self.assertEqual(vm.snapshot_source(root / "snapshot"), manifest)
                self.assertFalse((root / "snapshot/not-reviewed").exists())
                (source / "file-0").write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "source_digest_mismatch"):
                    vm.snapshot_source(root / "bad-snapshot")
                (source / "file-0").unlink()
                (source / "file-0").symlink_to(source / "file-1")
                with self.assertRaisesRegex(RuntimeError, "link_rejected"):
                    vm.snapshot_source(root / "link-snapshot")

    def test_source_snapshot_tracks_the_committed_release_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / "dashboard/provisioner").mkdir(parents=True)
            requested = []
            def committed(relative):
                requested.append(relative)
                if relative == "dashboard/provisioner/VERSION":
                    return b"2026.01.02.3\n"
                return json.dumps({"schema": 1, "version": "2026.01.02.2", "files": []}).encode()
            with patch.object(vm, "ROOT", root), patch.object(vm, "git_bytes", side_effect=committed), \
                    self.assertRaisesRegex(RuntimeError, "bundle_manifest_invalid"):
                vm.snapshot_source(root / "snapshot")
            self.assertEqual(requested, ["dashboard/provisioner/VERSION", "dashboard/provisioner-releases/2026.01.02.3.json"])
            for bad in (b"", b"../2026.01.02.3", b"2026.01.02.3;id"):
                with self.subTest(bad=bad), patch.object(vm, "git_bytes", return_value=bad), \
                        self.assertRaisesRegex(RuntimeError, "bundle_version_invalid"):
                    vm.bundle_version()

    def test_actual_revision_release_manifest_matches_the_committed_version(self):
        # The fixture only runs from this public repository. Its committed
        # VERSION must name a sealed release manifest that exists at HEAD.
        version = vm.bundle_version()
        manifest = json.loads(vm.git_bytes(f"dashboard/provisioner-releases/{version}.json"))
        self.assertEqual(manifest["version"], version)
        self.assertIn("deepseek-harness/native-broker.cjs", [entry["path"] for entry in manifest["files"]])

    def test_real_http_header_casing_does_not_break_bootstrap(self):
        # Node normalizes response headers; Python HTTPResponse preserves the
        # actual Set-Cookie spelling emitted by the shipped gateway.
        socket = Mock()
        socket.makefile.return_value = io.BytesIO(b"HTTP/1.1 303 See Other\r\nSet-Cookie: __Host-hivra_auth=fixture; Path=/; Secure\r\nContent-Length: 0\r\n\r\n")
        response = http.client.HTTPResponse(socket)
        response.begin()
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(guest.http.client, "HTTPConnection", return_value=connection):
            self.assertEqual(guest.session(), "__Host-hivra_auth=fixture")
        connection.close.assert_called_once()

    def test_vm_has_no_network_or_host_share_and_readonly_input_disks(self):
        arguments = vm.qemu_args(Path("/var/tmp/owned-fixture"))
        self.assertEqual(arguments[arguments.index("-nic") + 1], "none")
        self.assertNotIn("hostfwd", " ".join(arguments))
        self.assertNotIn("-virtfs", arguments)
        self.assertNotIn("-netdev", arguments)
        self.assertIn("q35,accel=tcg", arguments)
        drives = [arguments[index + 1] for index, value in enumerate(arguments) if value == "-drive"]
        self.assertEqual(len(drives), 3)
        self.assertTrue(all("readonly=on" in entry for entry in drives[1:]))
        self.assertIn("spawn=deny", arguments[arguments.index("-sandbox") + 1])

    def test_cloud_seed_does_not_authorize_remote_access_or_arbitrary_owner_commands(self):
        config = vm.cloud_config(OWNER)
        self.assertTrue(config["disable_root"])
        self.assertFalse(config["ssh_pwauth"])
        self.assertNotIn("ssh_authorized_keys", json.dumps(config))
        self.assertEqual(config["write_files"][0]["content"], OWNER + "\n")
        for bad in (OWNER + ";id", "../other", "", OWNER.upper()):
            with self.subTest(bad=bad), self.assertRaises((ValueError, RuntimeError)):
                vm.cloud_config(bad)

    def test_partial_success_and_broader_claims_are_not_accepted(self):
        good = {"schema": 1, "owner": OWNER, "scope": "offline-ubuntu-native-systemd", "verdict": "PASS"}
        good.update(node="v24.14.1", package={"version": "0.1.2-alpha.2"})
        good["firstGeneration"] = {"invocationId": "a" * 32, "unitSha256": "c" * 64, "supervisorPid": 123,
                                   "supervisorInOwnedCgroup": True, "wholeComputerCleanupVerified": False}
        good["restart"] = {**good["firstGeneration"], "invocationId": "b" * 32}
        for key in ("nativeHtml", "syntheticCredentialPrivate", "oldSessionRevoked", "credentialRestartPersistence", "detachedCgroupMemberKilled", "retainedReplay",
                    "workerFailedWithNativeAlive", "workerCancellationVerified", "workerOutcomePreserved", "workerLockPreservedNative", "retainedCleanupVerified"):
            good[key] = True
        for key in ("firstStop", "finalStop", "replayStop"):
            good[key] = {"serviceCgroupEmpty": True, "listenersClosed": True}
        for key in ("fullBootstrapTested", "publicAccessTested", "modelReplyTested", "browserRenderingTested"):
            good[key] = False
        vm.accepted_guest(good, OWNER)
        for key in good:
            bad = {**good}
            del bad[key]
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                vm.accepted_guest(bad, OWNER)
        with self.assertRaises(RuntimeError):
            vm.accepted_guest({**good, "publicAccessTested": True}, OWNER)
        with self.assertRaises(RuntimeError):
            vm.accepted_guest({**good, "schema": True}, OWNER)
        with self.assertRaises(RuntimeError):
            vm.accepted_guest({**good, "finalStop": {"serviceCgroupEmpty": True, "listenersClosed": False}}, OWNER)

    def test_download_requires_exact_public_artifact_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            response = io.BytesIO(b"wrong bytes")
            response.status = 200
            with patch.object(vm.urllib.request, "urlopen", return_value=response), self.assertRaisesRegex(RuntimeError, "digest_mismatch"):
                vm.download(vm.IMAGE_URL, vm.IMAGE_SHA, Path(folder) / "download")

    def test_cleanup_rejects_another_identity_and_preserves_outside_symlinks(self):
        if not vm.shutil.rmtree.avoids_symlink_attacks:
            self.skipTest("fd-based cleanup only")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            owned = root / "owned"
            owned.mkdir()
            outside = root / "keep"
            outside.write_text("preserve")
            (owned / "link").symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "identity_changed"):
                vm.safe_remove(owned, (0, 0))
            vm.safe_remove(owned, (owned.stat().st_dev, owned.stat().st_ino))
            self.assertEqual(outside.read_text(), "preserve")

    def test_ci_gate_rejects_local_and_self_hosted_execution(self):
        with patch.dict(vm.os.environ, {}, clear=True), self.assertRaises(RuntimeError):
            vm.require_ci()
        hosted = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "ashneil12/hivra",
                  "GITHUB_WORKSPACE": str(vm.ROOT), "HIVRA_DISPOSABLE_CI": "offline-native-systemd"}
        with patch.object(vm.os, "geteuid", return_value=0), \
             patch.object(vm.os, "uname", return_value=SimpleNamespace(sysname="Linux")):
            with patch.dict(vm.os.environ, hosted, clear=True):
                vm.require_ci()
            # Self-hosted runners and the retired private repository never qualify.
            for override in ({"RUNNER_ENVIRONMENT": "self-hosted"}, {"GITHUB_REPOSITORY": "ashneil12/hermesdeploy-canary"}):
                with self.subTest(override=override), patch.dict(vm.os.environ, {**hosted, **override}, clear=True), \
                     self.assertRaisesRegex(RuntimeError, "disposable_canary_ci_required"):
                    vm.require_ci()
        workflow = vm.ROOT / ".github/workflows/deepseek-systemd-fixture.yml"
        text = workflow.read_text()
        self.assertIn("runs-on: ubuntu-24.04", text)
        self.assertNotIn("secrets.", text)
        self.assertNotIn("self-hosted", text)
        self.assertNotIn("pull_request", text)
        self.assertNotIn("schedule:", text)
        self.assertIn("persist-credentials: false", text)
        self.assertIn("contents: read", text)


if __name__ == "__main__":
    unittest.main()
