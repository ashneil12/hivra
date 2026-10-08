"""Inside the offline disposable QEMU fixture only; never a deployment command.

Exercises the shipped native composition and real systemd on stock Ubuntu.
The base callback creates only a test user/token: it is deliberately NOT proof
of the full Bux bootstrap, provider delivery, public TLS or model inference.
"""
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import time
import urllib.parse

ORIGIN = "https://native.example.test"
TOKEN = "b" * 64  # Synthetic, isolated from every real Hivra instance.
SENTINEL = "not-a-real-api-key-offline-systemd-fixture"
SOURCE = Path("/opt/hivra-test/source")


def checked(condition, code):
    if not condition:
        raise RuntimeError(code)


def run(argv):
    return subprocess.run(argv, check=True, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45).stdout


def request(route, cookie=None, data=None, bootstrap=False):
    headers = {"Host": "native.example.test", "Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    if bootstrap:
        body = urllib.parse.urlencode({"token": TOKEN, "destination": "/"})
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps({"type": "client-request", "rpcId": "systemd-fixture",
                           "method": route.removeprefix("/api/"), "payload": {"args": data}})
        headers["Content-Type"] = "application/json"
    else:
        body = None
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
    try:
        connection.request("POST" if body else "GET", route, body, headers)
        response = connection.getresponse()
        raw = response.read(4 * 1024 * 1024)
        checked(SENTINEL.encode() not in raw, "credential_response_disclosure")
        return response.status, {name.lower(): value for name, value in response.getheaders()}, raw
    finally:
        connection.close()


def session():
    status, headers, _ = request("/auth/bootstrap", bootstrap=True)
    checked(status == 303 and "set-cookie" in headers, "bootstrap_failed")
    return headers["set-cookie"].split(";", 1)[0]


def native_html(cookie):
    status, _, body = request("/", cookie)
    checked(status == 200 and b'<base href="/"' in body, "native_html_failed")


def provider_cancellation(receipt, lifecycle_lock, native):
    """Actual worker/systemd failure, not a provider/account fixture. The held
    guest lock rejects the real installer before bootstrap/network mutation,
    while the already-installed native service remains alive independently."""
    spec = importlib.util.spec_from_file_location("fixture_provider_worker", SOURCE / "hivra-provider-worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    checked(not worker.ROOT.exists() and not worker.BUNDLE.exists(), "fresh_worker_required")
    worker.BUNDLE.mkdir(mode=0o700, parents=True)
    manifest = []
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file():
            continue
        checked(not path.is_symlink(), "fixture_source_link")
        name = str(path.relative_to(SOURCE))
        raw = path.read_bytes()
        target = worker.BUNDLE / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
        manifest.append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw), "mode": 0o600})
    release = json.loads(Path("/opt/hivra-test/source-release.json").read_text())
    checked(sorted((entry["path"], entry["sha256"], entry["bytes"]) for entry in release["files"])
            == sorted((entry["path"], entry["sha256"], entry["size"]) for entry in manifest), "fixture_source_count")
    rows = [[entry[key] for key in ("path", "sha256", "size", "mode")] for entry in manifest]
    bundle = {"version": 1, "state": "bundle_installed", "scopeSha256": "c" * 64,
              "bundleSha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode("ascii")).hexdigest(),
              "provisionerVersion": worker.NATIVE_VERSION}
    worker.publish(worker.BUNDLE / ".hivra-receipt.json", bundle)
    closure = [row for row in rows if row[0] in worker.NATIVE_FILES]
    identity = {"version": 2, "agentId": "11111111-1111-4111-8111-111111111111", "operationId": receipt["owner"],
                "bundle": bundle, "nativeCleanup": {"profile": worker.NATIVE_PROFILE,
                "closureSha256": hashlib.sha256(worker.encode(closure)).hexdigest()}}
    launch = {"version": 2, "agentKind": "deepseek-harness", "computerSubstrate": "provider-vm", "wantBrowser": False,
              "model": "", "modelKey": "", "modelBaseUrl": "", "tunnelToken": "synthetic-offline-token",
              "accessHostname": None, "publicOrigin": ORIGIN}
    def control(action):
        return worker.control({"action": action, "identity": identity, "clock": worker.guest_clock(),
                               **({"launch": launch, "manifest": manifest} if action == "start" else {})})
    control("start")
    deadline = time.monotonic() + 45
    while True:
        observed = control("status")
        if observed["stopped"]:
            break
        checked(time.monotonic() < deadline, "worker_stop_timeout")
        time.sleep(0.25)
    checked(observed["state"] == "failed" and observed["nativeCleanup"] == {"state": "pending"}, "worker_failure_not_separate")
    checked(worker.decode(worker.read_file(worker.ROOT / "result.json")) == {"identity": identity, "exitCode": 1}
            and worker.read_file(worker.ROOT / "installer.log") == b"Hivra guest installation failed; inspect the private provisioning log.\n",
            "actual_installer_failure_unverified")
    native.owner.verify_running()
    native_html(session())  # Worker absence demonstrably is not native absence.
    checked(native.owner.service("show", "--property=UnitFileState", "--value", native.owner.SERVICE) == b"enabled\n",
            "native_fixture_not_enabled")
    receipt["workerFailedWithNativeAlive"] = True
    original = worker.read_file(worker.ROOT / "stopped-outcome.json")
    try:
        control("cancel")
    except BlockingIOError:
        pass
    else:
        raise RuntimeError("native_cleanup_ignored_lifecycle_lock")
    checked(not (worker.native_proof_path()).exists(), "premature_native_cleanup_proof")
    native.owner.verify_running()
    native_html(session())
    checked(native.owner.service("show", "--property=UnitFileState", "--value", native.owner.SERVICE) == b"enabled\n",
            "native_changed_under_lifecycle_lock")
    receipt["workerLockPreservedNative"] = True
    fcntl.flock(lifecycle_lock, fcntl.LOCK_UN)
    # The original operation must retain its cleanup closure across preparation
    # changes. Rename only this fixture-created directory; no runtime reinstall.
    worker.BUNDLE.rename(worker.BUNDLE.with_name("retired-fixture"))
    def retained_control(action):
        worker.retained_native(identity)  # Verify all retained bytes before exec.
        # Actual fresh guest process, not the in-memory module used to set up
        # the fixture. Server/SSH v2 wrapper integration is a separate gate.
        process = subprocess.run(["/usr/bin/python3", "-I", "-B", str(worker.ROOT / "controller.py")],
            input=worker.encode({"action": action, "identity": identity, "clock": worker.guest_clock()}),
            env=worker.ENV, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45)
        prefix = b"HIVRA_PROVIDER_WORKER_V1 "
        checked(len(process.stdout) < 4096 and process.stdout.startswith(prefix) and process.stdout.count(b"\n") == 1,
                "worker_receipt_frame_invalid")
        result = json.loads(process.stdout[len(prefix):])
        checked(result["version"] == 2 and result["identity"] == identity, "worker_receipt_identity_invalid")
        return result
    stopped = retained_control("cancel")
    checked(stopped["state"] == "failed" and stopped["nativeCleanup"] == {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]}
            and worker.read_file(worker.ROOT / "stopped-outcome.json") == original, "worker_cleanup_outcome_changed")
    checked(retained_control("status") == stopped, "worker_cleanup_ack_recovery_failed")
    receipt["workerCancellationVerified"] = True
    receipt["workerOutcomePreserved"] = True
    receipt["retainedCleanupVerified"] = True
    after = native.owner.definition(allow_missing=True)
    checked(native.owner.empty(after) and native.owner.service("show", "--property=UnitFileState", "--value", native.owner.SERVICE) == b"disabled\n",
            "worker_native_absence_unverified")
    # Read-only oracle, not a fixture stop that could repair a false receipt.
    receipt["replayStop"] = {"serviceCgroupEmpty": True, "listenersClosed": True, "wholeComputerCleanupVerified": False}


def main(receipt):
    checked(os.geteuid() == 0, "root_fixture_required")
    checked(set(path.name for path in Path("/sys/class/net").iterdir()) == {"lo"}, "offline_guest_required")
    owner = Path("/etc/hivra-fixture-owner").read_text().strip()
    checked(owner == receipt["owner"], "fixture_identity_mismatch")
    checked(Path("/proc/1/comm").read_text().strip() == "systemd", "actual_systemd_required")
    checked(not Path("/opt/hivra").exists() and not Path("/home/bux").exists(), "fresh_guest_required")
    receipt["stage"] = "prepare_offline_payload"
    # The ISO contains only checksummed source/node/package artifacts generated
    # by the parent. No host mount, network, real credential or provider access.
    run(["tar", "-xf", "/mnt/hivra-fixture/payload.tar", "--no-same-owner", "-C", "/opt"])
    checked(not os.path.lexists("/usr/bin/node"), "unexpected_existing_node")
    Path("/usr/bin/node").symlink_to("/opt/hivra-test/node/bin/node")
    receipt["node"] = run(["/usr/bin/node", "--version"]).decode().strip()
    spec = importlib.util.spec_from_file_location("native_guest", SOURCE / "deepseek-harness/install-guest.py")
    guest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guest)
    # Runtime comes from the real pinned npm recipe, without lifecycle scripts.
    # Validate the actual bytes again after crossing the offline disk boundary.
    receipt["package"] = guest.files.verified_existing()
    receipt["systemd"] = run(["systemctl", "--version"]).decode().splitlines()[0]

    def base():
        run(["useradd", "--create-home", "--shell", "/bin/bash", "bux"])
        identity = pwd.getpwnam("bux")
        folder = Path("/home/bux/.hivra")
        folder.mkdir(mode=0o700)
        for name, value in (("api-token", TOKEN), ("agent-kind", "deepseek-harness")):
            target = folder / name
            target.write_text(value + "\n")
            target.chmod(0o600)
            os.chown(target, identity.pw_uid, identity.pw_gid)
        os.chown(folder, identity.pw_uid, identity.pw_gid)

    receipt["stage"] = "actual_native_install"
    launch = {"publicOrigin": ORIGIN, "computerSubstrate": "provider-vm", "wantBrowser": False}
    with open("/run/hivra-agent-install.lock", "x") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt["firstInstall"] = guest.install(launch, SOURCE, base)
        receipt["stage"] = "native_http_and_synthetic_credentials"
        checked(request("/")[0] == 401, "unauthenticated_native_access")
        cookie = session()
        native_html(cookie)
        status, _, raw = request("/api/credentials/set", cookie, {"ref": "DEEPSEEK_API_KEY", "value": SENTINEL})
        checked(status == 200 and json.loads(raw)["result"]["ok"] is True, "credential_set_failed")
        credential = Path("/home/bux/.hivra/deepseek/.dsh/.credentials.yaml")
        identity = pwd.getpwnam("bux")
        checked(credential.stat().st_uid == identity.pw_uid and credential.stat().st_mode & 0o777 == 0o600,
                "credential_permissions_failed")
        checked(SENTINEL in credential.read_text(), "synthetic_credential_missing")
        receipt["nativeHtml"] = True
        receipt["syntheticCredentialPrivate"] = True
        receipt["stage"] = "real_service_stop_restart"
        receipt["firstStop"] = guest.owner.stop_owned()
        guest.owner.service("start", guest.owner.SERVICE, timeout=30)
        restarted = guest.wait_ready()
        checked(restarted["invocationId"] != receipt["firstInstall"]["service"]["invocationId"], "restart_generation_unchanged")
        checked(request("/", cookie)[0] == 401, "old_browser_session_survived_restart")
        cookie = session()
        native_html(cookie)
        status, _, raw = request("/api/credentials/describe", cookie, {"refs": ["DEEPSEEK_API_KEY"]})
        checked(status == 200 and b'"configured":true' in raw and json.loads(raw)["result"]["ok"] is True,
                "credential_restart_persistence_failed")
        receipt["restart"] = restarted
        receipt["oldSessionRevoked"] = True
        receipt["credentialRestartPersistence"] = True
        # An actual detached non-root process in the owned service cgroup tests
        # systemd's outer kill boundary, independently of Node process groups.
        receipt["stage"] = "detached_cgroup_member_cleanup"
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-c",
            "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(600)"],
            user=identity.pw_uid, group=identity.pw_gid, extra_groups=[], start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            import select
            checked(bool(select.select([child.stdout], [], [], 5)[0]) and child.stdout.readline() == b"ready\n", "detached_fixture_not_ready")
            (guest.owner.CGROUP / "cgroup.procs").write_text(str(child.pid))
            checked(guest.owner.CGROUP_NAME in Path(f"/proc/{child.pid}/cgroup").read_text(), "detached_fixture_wrong_cgroup")
            receipt["finalStop"] = guest.owner.stop_owned()
            checked(child.wait(timeout=5) == -signal.SIGKILL, "detached_fixture_survived")
            receipt["detachedCgroupMemberKilled"] = True
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        receipt["stage"] = "retained_native_replay"
        def reject_base():
            raise RuntimeError("replayed_mutable_base")
        replay = guest.install(launch, SOURCE, reject_base)
        checked(replay["baseReused"] is True and SENTINEL in credential.read_text(), "retained_replay_failed")
        native_html(session())
        receipt["retainedReplay"] = True
        receipt["stage"] = "provider_worker_cancellation"
        provider_cancellation(receipt, lock, guest)
        receipt["stage"] = "complete"
        receipt["verdict"] = "PASS"


if __name__ == "__main__":
    result = {"schema": 1, "owner": sys.argv[1], "scope": "offline-ubuntu-native-systemd",
              "verdict": "FAIL", "stage": "guest_preflight", "fullBootstrapTested": False,
              "publicAccessTested": False, "modelReplyTested": False, "browserRenderingTested": False}
    try:
        main(result)
    except Exception as error:
        # Error classes and known local assertion codes only. Never export
        # native stdout/journal or exception payloads that could contain tokens.
        result["errorType"] = type(error).__name__
        if isinstance(error, RuntimeError):
            result["errorCode"] = str(error)[:120]
        try:
            result["serviceState"] = run(["systemctl", "show", "bux-hivra-chat.service",
                "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup,InvocationID,NeedDaemonReload,ExecStart,FragmentPath,DropInPaths,User,Group,KillMode,TimeoutStopUSec,SendSIGKILL,FinalKillSignal,Delegate,ProtectControlGroups,LimitCORE,LimitCORESoft,UMask,Restart,Type,WorkingDirectory,Transient"]).decode()[:8192]
        except Exception:
            pass
    finally:
        with open("/dev/virtio-ports/hivra.receipt", "w") as channel:
            channel.write(json.dumps(result, separators=(",", ":")) + "\n")
        subprocess.run(["systemctl", "poweroff"], check=False)
