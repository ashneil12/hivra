#!/usr/bin/env python3
"""Secret-free, GitHub-hosted-only offline Ubuntu/systemd acceptance fixture.

Downloads public byte-pinned inputs, builds the frozen npm closure without
hooks, then boots it in unprivileged QEMU with no NIC, host mount or forwarding.
No provider, production, browser session or customer credentials are accepted.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid

IMAGE_URL = "https://cloud-images.ubuntu.com/releases/noble/release-20260826/ubuntu-24.04-server-cloudimg-amd64.img"
IMAGE_SHA = "d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30"
NODE_URL = "https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz"
NODE_SHA = "84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be"
ROOT = Path(__file__).resolve().parents[2]
GUEST = Path(__file__).with_name("deepseek-systemd-guest.py")
# The payload is the sealed release this revision ships: the committed VERSION
# and its provisioner-releases manifest. A hard-coded older release cannot be
# rebuilt from a newer tree, so the fixture would only ever fail closed.
RELEASE_VERSION_PATTERN = re.compile(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}")
STAGES = {"guest_preflight", "prepare_offline_payload", "actual_native_install", "native_http_and_synthetic_credentials",
          "real_service_stop_restart", "detached_cgroup_member_cleanup", "retained_native_replay", "provider_worker_cancellation", "complete"}
ERROR_CODES = {"root_fixture_required", "offline_guest_required", "fixture_identity_mismatch", "actual_systemd_required",
    "fresh_guest_required", "unexpected_existing_node", "credential_response_disclosure", "bootstrap_failed", "native_html_failed",
    "unauthenticated_native_access", "credential_set_failed", "credential_permissions_failed", "synthetic_credential_missing",
    "restart_generation_unchanged", "old_browser_session_survived_restart", "credential_restart_persistence_failed",
    "detached_fixture_not_ready", "detached_fixture_wrong_cgroup", "detached_fixture_survived", "replayed_mutable_base", "retained_replay_failed",
    "fresh_worker_required", "fixture_source_link", "fixture_source_count", "worker_stop_timeout", "worker_failure_not_separate",
    "native_cleanup_ignored_lifecycle_lock", "premature_native_cleanup_proof", "worker_cleanup_outcome_changed", "worker_cleanup_ack_recovery_failed",
    "native_fixture_not_enabled", "native_changed_under_lifecycle_lock", "worker_receipt_frame_invalid", "worker_receipt_identity_invalid",
    "actual_installer_failure_unverified", "worker_native_absence_unverified"}


def checked(condition, code):
    if not condition:
        raise RuntimeError(code)


def run(argv, *, timeout=120, **kwargs):
    return subprocess.run([str(arg) for arg in argv], check=True, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **kwargs).stdout


def download(url, digest, target):
    checksum = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, target.open("xb") as output:
        checked(response.status == 200, "public_artifact_download_failed")
        total = 0
        while block := response.read(1024 * 1024):
            total += len(block)
            checked(total <= 1024 * 1024 * 1024, "public_artifact_too_large")
            checksum.update(block)
            output.write(block)
    checked(checksum.hexdigest() == digest, "public_artifact_digest_mismatch")


def read_regular(path, limit):
    checked(path.resolve() == path, "fixture_file_link_rejected")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        checked(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, "fixture_file_shape_invalid")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        checked(len(raw) <= limit, "fixture_file_too_large")
        return raw
    finally:
        os.close(descriptor)


def git_bytes(relative):
    return run(["git", "-c", "safe.directory=" + str(ROOT), "show", "HEAD:" + relative], cwd=ROOT)


def bundle_version():
    version = git_bytes("dashboard/provisioner/VERSION").decode("ascii").strip()
    checked(RELEASE_VERSION_PATTERN.fullmatch(version), "fixture_bundle_version_invalid")
    return version


def snapshot_source(target):
    version = bundle_version()
    raw = git_bytes(f"dashboard/provisioner-releases/{version}.json")
    manifest = json.loads(raw)
    checked(manifest["schema"] == 1 and manifest["version"] == version and isinstance(manifest["files"], list)
            and len(manifest["files"]) > 0, "fixture_bundle_manifest_invalid")
    target.mkdir(mode=0o755)
    seen = set()
    for entry in manifest["files"]:
        name = entry["path"]
        checked(re.fullmatch(r"[a-zA-Z0-9._/-]+", name) and not name.startswith("/")
                and all(part not in ("", ".", "..") for part in name.split("/")) and name not in seen, "unsafe_bundle_member")
        seen.add(name)
        content = read_regular(ROOT / "dashboard/provisioner" / name, 2 * 1024 * 1024)
        checked(len(content) == entry["bytes"] and hashlib.sha256(content).hexdigest() == entry["sha256"], "fixture_source_digest_mismatch")
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        destination.chmod(0o644)
    checked((target / "VERSION").read_text().strip() == version, "fixture_source_version_mismatch")
    return manifest


def require_ci():
    checked(os.name == "posix" and os.uname().sysname == "Linux" and os.geteuid() == 0, "linux_root_ci_required")
    checked(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("GITHUB_REPOSITORY") == "ashneil12/hivra", "disposable_canary_ci_required")
    checked(Path(os.environ["GITHUB_WORKSPACE"]).resolve() == ROOT, "unexpected_checkout")
    # This command must never run on the persistent homelab runner.
    checked(os.environ.get("HIVRA_DISPOSABLE_CI") == "offline-native-systemd", "explicit_fixture_scope_required")


def build_payload(build, vmwork):
    inputs = build / "inputs"
    inputs.mkdir()
    payload = inputs / "hivra-test"
    payload.mkdir(mode=0o755)
    manifest = snapshot_source(payload / "source")
    # The guest checks its copied tree against exactly this release manifest.
    (payload / "source-release.json").write_text(json.dumps(manifest, sort_keys=True))
    download(NODE_URL, NODE_SHA, build / "node.tar.xz")
    with tarfile.open(build / "node.tar.xz") as archive:
        archive.extractall(payload, filter="data")
    (payload / "node-v24.14.1-linux-x64").rename(payload / "node")
    spec = importlib.util.spec_from_file_location("native_package", payload / "source/deepseek-harness/install-native.py")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    (inputs / "hivra").mkdir(mode=0o755)
    installer.RUNTIME = inputs / "hivra/deepseek-runtime"
    # Fixture-only executable relocation: the exact Node release is under our
    # root-owned scratch tree, never overwrite the CI runner's Node installation.
    # Recipe, no-hooks policy, publication and byte/tree validation are shipped code.
    def npm(package, install_home, user_config, global_config):
        run([payload / "node/bin/node", payload / "node/lib/node_modules/npm/bin/npm-cli.js", "ci",
             "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org",
             "--userconfig=" + str(user_config), "--globalconfig=" + str(global_config)],
            cwd=package, env={"PATH": str(payload / "node/bin") + ":/usr/bin:/bin", "HOME": str(install_home), "LANG": "C.UTF-8"},
            timeout=600, umask=0o022)
    installer.npm_install = npm
    package = installer.install_package(payload / "source/deepseek-harness")
    iso = build / "iso"
    iso.mkdir()
    driver = read_regular(GUEST, 128 * 1024)
    checked(driver == git_bytes("dashboard/scripts/deepseek-systemd-guest.py"), "fixture_driver_differs_from_revision")
    (iso / "guest.py").write_bytes(driver)
    run(["tar", "-cf", iso / "payload.tar", "-C", inputs, "hivra-test", "hivra"], timeout=180)
    run(["genisoimage", "-quiet", "-J", "-R", "-V", "HIVRA_TEST", "-o", vmwork / "payload.iso", iso], timeout=180)
    return package, manifest, hashlib.sha256(driver).hexdigest()


def guest_evidence(value, owner, package):
    """Only typed/allowlisted fixture data crosses into the public artifact."""
    checked(isinstance(value, dict) and value.get("owner") == owner, "guest_identity_mismatch")
    output = {"schema": value.get("schema") if type(value.get("schema")) is int else None, "owner": owner,
              "scope": "offline-ubuntu-native-systemd", "verdict": "FAIL",
              "stage": value.get("stage") if value.get("stage") in STAGES else "unknown"}
    if value.get("scope") == output["scope"] and value.get("verdict") in ("PASS", "FAIL"):
        output["verdict"] = value["verdict"]
    for key in ("nativeHtml", "syntheticCredentialPrivate", "oldSessionRevoked", "credentialRestartPersistence",
                "detachedCgroupMemberKilled", "retainedReplay", "workerFailedWithNativeAlive", "workerCancellationVerified",
                "workerOutcomePreserved", "workerLockPreservedNative", "retainedCleanupVerified", "fullBootstrapTested", "publicAccessTested", "modelReplyTested", "browserRenderingTested"):
        if type(value.get(key)) is bool:
            output[key] = value[key]
    for key in ("firstStop", "finalStop", "replayStop"):
        if isinstance(value.get(key), dict):
            output[key] = {field: value[key][field] for field in ("serviceCgroupEmpty", "listenersClosed", "wholeComputerCleanupVerified")
                           if type(value[key].get(field)) is bool}
    checked(value.get("package") is None or value["package"] == package, "guest_package_receipt_differs")
    if value.get("package") == package:
        output["package"] = package
    if value.get("node") == "v24.14.1":
        output["node"] = value["node"]
    for key, observed in (("firstGeneration", value.get("firstInstall", {}).get("service", {})), ("restart", value.get("restart", {}))):
        if isinstance(observed, dict):
            generation = {}
            for field, count in (("invocationId", 32), ("unitSha256", 64)):
                if isinstance(observed.get(field), str) and re.fullmatch("[a-f0-9]{" + str(count) + "}", observed[field]):
                    generation[field] = observed[field]
            if type(observed.get("supervisorPid")) is int and 0 < observed["supervisorPid"] < 2 ** 31:
                generation["supervisorPid"] = observed["supervisorPid"]
            for field in ("supervisorInOwnedCgroup", "wholeComputerCleanupVerified"):
                if type(observed.get(field)) is bool:
                    generation[field] = observed[field]
            if generation:
                output[key] = generation
    if value.get("errorType") in ("RuntimeError", "InstallError", "CalledProcessError", "TimeoutExpired", "KeyError", "FileNotFoundError", "PermissionError"):
        output["errorType"] = value["errorType"]
    if value.get("errorCode") in ERROR_CODES:
        output["errorCode"] = value["errorCode"]
    # Diagnostics are finite service-state vocabulary, never raw command/journal
    # text or arbitrary guest-provided strings.
    states = {"LoadState": {"loaded", "not-found", "error"}, "ActiveState": {"active", "inactive", "failed", "activating", "deactivating"},
              "SubState": {"running", "dead", "failed", "start", "auto-restart", "stop-sigterm", "stop-sigkill", "exited"},
              "NeedDaemonReload": {"yes", "no"}}
    if isinstance(value.get("serviceState"), str):
        output["serviceState"] = {}
        for line in value["serviceState"].splitlines():
            key, separator, observed = line.partition("=")
            if separator and key in states:
                output["serviceState"][key] = observed if observed in states[key] else "unexpected"
    return output


def cloud_config(owner):
    checked(len(owner) == 36 and str(uuid.UUID(owner)) == owner, "invalid_fixture_owner")
    return {
        "hostname": "hivra-offline-native-test", "ssh_pwauth": False,
        "disable_root": True, "ssh_deletekeys": True,
        "write_files": [{"path": "/etc/hivra-fixture-owner", "permissions": "0600", "content": owner + "\n"}],
        "runcmd": [["/bin/bash", "-c",
            "set -eu; mkdir /mnt/hivra-fixture; mount -o ro /dev/disk/by-label/HIVRA_TEST /mnt/hivra-fixture; "
            "exec /usr/bin/python3 -I -B /mnt/hivra-fixture/guest.py " + owner]],
    }


def qemu_args(work):
    # TCG is explicit: no requirement for nested virtualization and no device
    # permission changes on the host. This measures correctness, NOT latency.
    return ["/usr/bin/qemu-system-x86_64", "-machine", "q35,accel=tcg", "-cpu", "max", "-smp", "2", "-m", "3072",
            "-display", "none", "-monitor", "none", "-serial", "file:" + str(work / "console.log"),
            "-nic", "none", "-no-reboot", "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
            "-drive", f"file={work / 'guest.qcow2'},if=virtio,format=qcow2",
            "-drive", f"file={work / 'seed.img'},if=virtio,format=raw,readonly=on",
            "-drive", f"file={work / 'payload.iso'},media=cdrom,format=raw,readonly=on",
            "-device", "virtio-serial-pci", "-chardev", f"file,id=receipt,path={work / 'guest-receipt.json'}",
            "-device", "virtserialport,chardev=receipt,name=hivra.receipt"]


def safe_remove(path, identity):
    info = path.lstat()
    checked(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == identity, "fixture_cleanup_identity_changed")
    # Python's fd-based rmtree never traverses a symlink planted in this exact
    # generated tree. Never accept a caller-supplied deletion target.
    checked(shutil.rmtree.avoids_symlink_attacks, "safe_tree_cleanup_unavailable")
    shutil.rmtree(path)


class FixtureResources:
    def __init__(self):
        self.paths = {}
        self.process = None
        self.cancelled = False

    def cancel(self, *_):
        # Never raise across fork/exec -> Popen assignment. A signal at that
        # boundary must not orphan an acquired VM and report false cleanup.
        self.cancelled = True

    def checkpoint(self):
        if self.cancelled:
            raise InterruptedError("fixture_interrupted")

    def allocate(self, prefix, parent):
        self.checkpoint()
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
        self.paths[path] = (path.stat().st_dev, path.stat().st_ino)
        return path

    def start(self, argv, **kwargs):
        self.checkpoint()
        self.process = subprocess.Popen(argv, **kwargs)
        self.checkpoint()  # Process ownership is recorded before cancellation.

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            self.checkpoint()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("owned_qemu", timeout)
            try:
                return self.process.wait(timeout=min(5, remaining))
            except subprocess.TimeoutExpired:
                pass

    def cleanup(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=15)
            checked(self.process.poll() is not None, "qemu_survived")
        for path, identity in reversed(self.paths.items()):
            safe_remove(path, identity)


def accepted_guest(value, owner):
    checked(type(value.get("schema")) is int and value.get("schema") == 1 and value.get("owner") == owner and value.get("verdict") == "PASS"
            and value.get("scope") == "offline-ubuntu-native-systemd", "guest_verdict_failed")
    checked(value.get("node") == "v24.14.1" and isinstance(value.get("package"), dict), "guest_artifacts_unverified")
    for field in ("firstGeneration", "restart"):
        generation = value.get(field, {})
        checked(generation.get("supervisorInOwnedCgroup") is True and generation.get("wholeComputerCleanupVerified") is False
                and re.fullmatch(r"[a-f0-9]{32}", generation.get("invocationId", ""))
                and re.fullmatch(r"[a-f0-9]{64}", generation.get("unitSha256", ""))
                and type(generation.get("supervisorPid")) is int and generation["supervisorPid"] > 0, "guest_generation_unverified")
    checked(value["firstGeneration"]["invocationId"] != value["restart"]["invocationId"]
            and value["firstGeneration"]["unitSha256"] == value["restart"]["unitSha256"], "guest_restart_unverified")
    for field in ("nativeHtml", "syntheticCredentialPrivate", "oldSessionRevoked", "credentialRestartPersistence",
                  "detachedCgroupMemberKilled", "retainedReplay", "workerFailedWithNativeAlive",
                  "workerCancellationVerified", "workerOutcomePreserved", "workerLockPreservedNative", "retainedCleanupVerified"):
        checked(value.get(field) is True, "missing_guest_acceptance_" + field)
    for field in ("firstStop", "finalStop", "replayStop"):
        checked(value.get(field, {}).get("serviceCgroupEmpty") is True and value.get(field, {}).get("listenersClosed") is True,
                "missing_guest_cleanup_" + field)
    for field in ("fullBootstrapTested", "publicAccessTested", "modelReplyTested", "browserRenderingTested"):
        checked(value.get(field) is False, "fixture_scope_mislabelled")


def main():
    require_ci()
    owner = str(uuid.uuid4())
    output = Path(os.environ["RUNNER_TEMP"]) / "deepseek-systemd-result"
    output.mkdir(mode=0o755)  # Exact fresh output; never overwrite older evidence.
    result = {"schema": 1, "owner": owner, "sha": os.environ["GITHUB_SHA"], "scope": "offline-ubuntu-native-systemd",
              "verdict": "FAIL", "cleanupVerified": False, "imageSha256": IMAGE_SHA, "nodeSha256": NODE_SHA,
              "stage": "build_public_fixture", "network": "none", "acceleration": "tcg"}
    resources = FixtureResources()
    work = None
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, resources.cancel)
    try:
        build = resources.allocate("hivra-native-build-", "/root")
        work = resources.allocate("hivra-native-vm-", "/var/tmp")
        checked(run(["git", "-c", "safe.directory=" + str(ROOT), "rev-parse", "HEAD"], cwd=ROOT).decode().strip() == result["sha"], "revision_mismatch")
        runner = read_regular(Path(__file__).resolve(), 128 * 1024)
        checked(runner == git_bytes("dashboard/scripts/test-deepseek-systemd-vm.py"), "fixture_runner_differs_from_revision")
        result["runnerSha256"] = hashlib.sha256(runner).hexdigest()
        result["package"], result["sourceBundle"], result["guestDriverSha256"] = build_payload(build, work)
        resources.checkpoint()
        result["stage"] = "download_ubuntu"
        download(IMAGE_URL, IMAGE_SHA, work / "base.qcow2")
        resources.checkpoint()
        run(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", work / "base.qcow2", work / "guest.qcow2", "12G"])
        user = build / "user-data"
        user.write_text("#cloud-config\n" + json.dumps(cloud_config(owner)))
        meta = build / "meta-data"
        meta.write_text(json.dumps({"instance-id": owner, "local-hostname": "hivra-offline-native-test"}))
        net = build / "network-config"
        net.write_text(json.dumps({"version": 2, "ethernets": {}}))
        run(["cloud-localds", "--network-config=" + str(net), work / "seed.img", user, meta])
        unprivileged = pwd.getpwnam("nobody")
        checked(unprivileged.pw_uid > 0, "unprivileged_qemu_required")
        for target in (*work.iterdir(), work):
            os.chown(target, unprivileged.pw_uid, unprivileged.pw_gid)
        result["stage"] = "offline_vm"
        started = time.monotonic()
        with (work / "qemu.log").open("xb") as log:
            resources.start(qemu_args(work), user=unprivileged.pw_uid, group=unprivileged.pw_gid,
                extra_groups=[], cwd=work, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            # Parent retains the Popen identity; no lookup by PID file, process
            # name, user inventory or broad kill command is used for teardown.
            resources.wait(timeout=1500)
        result["vmSeconds"] = round(time.monotonic() - started, 2)
        checked(resources.process.returncode == 0, "qemu_failed")
        raw = read_regular(work / "guest-receipt.json", 32768)
        checked(0 < len(raw) <= 32768, "guest_receipt_size_invalid")
        result["guest"] = guest_evidence(json.loads(raw), owner, result["package"])
        accepted_guest(result["guest"], owner)
        result["verdict"] = "PASS"
        result["stage"] = "complete"
    except Exception as error:
        result["errorType"] = type(error).__name__
        if isinstance(error, RuntimeError):
            result["errorCode"] = str(error)[:120]
    finally:
        for name in (signal.SIGTERM, signal.SIGINT):
            signal.signal(name, signal.SIG_IGN)
        try:
            # Only system boot diagnostics, not native stdout or the package
            # download logs. No guest model/provider credentials are present.
            for name in ("console.log", "qemu.log"):
                file = work / name if work else None
                if file is not None and os.path.lexists(file):
                    try:
                        (output / name).write_bytes(read_regular(file, 2 * 1024 * 1024))
                    except (OSError, RuntimeError):
                        result["diagnosticOmitted"] = True
            resources.cleanup()
            result["cleanupVerified"] = True
        except Exception as error:
            result["cleanupError"] = type(error).__name__
            result["verdict"] = "FAIL"
        (output / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
        for file in output.iterdir():
            file.chmod(0o644)
        print(json.dumps({"verdict": result["verdict"], "stage": result["stage"], "cleanupVerified": result["cleanupVerified"]}), flush=True)
    return 0 if result["verdict"] == "PASS" and result["cleanupVerified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
