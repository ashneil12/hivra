import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest


SOURCE = Path(__file__).parent
GENERATION = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
BINDING = "hivra-bind-" + "3" * 32
VMID = "9304"
IP = "10.251.20.42"
IMAGE = b"offline fixture, not a VM image"
DIGEST = hashlib.sha256(IMAGE).hexdigest()

MOCK = r'''#!/usr/bin/env python3
import base64, fcntl, json, os, sys
from pathlib import Path

name = Path(sys.argv[0]).name
args = sys.argv[1:]
action = args[0] if args else ""
root = Path(os.environ["MOCK_ROOT"])
conf = root / "pve" / "9304.conf"
running = root / "running"
with (root / "events").open("a") as out:
    print(name, action if name != "ssh" else args[-1], file=out)

def require_locked(path):
    with path.open("r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        sys.exit("expected allocation fence was not held")

if name == "qm":
    if action == "list":
        print("VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID")
        if conf.exists():
            print("9304 standby running 1024 40 900")
    elif action == "config":
        print(conf.read_text(), end="")
    elif action == "status":
        assert conf.exists()
        status = os.environ.get("MOCK_QMP") or ("running" if running.exists() else "stopped")
        print("status:", status)
        if "--verbose" in args:
            print("qmpstatus:", status)
    elif action in ("create", "set", "disk"):
        data = dict(line.split(": ", 1) for line in conf.read_text().splitlines()) if conf.exists() else {}
        if action == "create" or "--tags" in args:
            require_locked(root / "locks" / "hivra-allocation.lock")
            require_locked(root / "locks" / "hivra-vmids" / "9304.lock")
        if action == "create":
            assert not conf.exists()
        if action == "disk":
            data["scsi0"] += ",size=" + args[-1]
        else:
            for key, value in zip(args[2::2], args[3::2]):
                data[key[2:]] = "local-lvm:vm-9304-disk-0,discard=on,ssd=1" if key == "--scsi0" else value
        conf.write_text("".join(f"{key}: {value}\n" for key, value in data.items()))
    elif action == "start":
        require_locked(root / "locks" / "hivra-allocation.lock")
        assert not Path("/proc/self/fd/8").exists()
        assert not Path("/proc/self/fd/9").exists()
        running.touch()
    elif action == "guest":
        key = "ssh-ed25519 " + base64.b64encode(b"\0\0\0\x0bssh-ed25519\0\0\0\x20" + b"a"*32).decode()
        is_proof = "/bin/sh" in args
        fields = ("a"*32, os.environ.get("MOCK_BOOT", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                  key, os.environ.get("MOCK_IP", "10.251.20.42/24"))
        print(json.dumps({"exited": 1, "exitcode": int(is_proof and os.environ.get("MOCK_DIRTY") == "1"),
                          "out-data": "\n".join(fields) if is_proof else key}))
    elif action == "stop":
        running.unlink()
    elif action == "destroy":
        conf.unlink()
    else:
        sys.exit("unexpected qm action")
elif name == "pvesh":
    print(json.dumps([{"vmid": 9304, "node": "fixture-standby-host", "type": "qemu"}] if conf.exists() else []))
elif name == "pvesm":
    if action == "status":
        print("local-lvm lvmthin active 200000000 100000000 90000000 50")
    else:
        print("Volid Format Type Size VMID")
elif name == "qemu-img":
    print(json.dumps({"format": "qcow2", "virtual-size": 8 * 1024**3}))
elif name == "ssh":
    if args[-1].endswith("cloud-init status"):
        assert "StrictHostKeyChecking=yes" in args
        assert any(arg.startswith("UserKnownHostsFile=") for arg in args)
        print(os.environ.get("MOCK_CLOUD_INIT", "status: done"))
    elif args[-1].endswith("hivra-install-agent.py"):
        assert not os.environ.get("HIVRA_MODEL_KEY")
        (root / "guest-launch.json").write_text(sys.stdin.read())
    elif "api-token" in args[-1]:
        print("c"*64)
    else:
        sys.exit("unexpected network handoff")
elif name == "hostname":
    print("fixture-standby-host")
elif name == "perl":
    if conf.exists():
        state = "running" if running.exists() else "stopped"
        print("9304", state, base64.b64encode(conf.read_bytes()).decode(), sep="\t")
elif name == "nproc":
    print("8")
elif name not in ("scp", "curl"):
    sys.exit("unexpected command")
'''


class StandbyTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name in ("pve", "locks", "bin", "run", "state", "images", "candidate"):
            (self.root / name).mkdir()
        self.bundle = self.root / "candidate"
        self.script = self.bundle / "hivra-provision-on-host.sh"
        self.conf = self.root / "pve" / f"{VMID}.conf"
        self.events = self.root / "events"
        self.selected = self.root / "state/provision-operations"
        self.slot = self.selected / "hermes-standby.slot"
        self.receipt = self.selected / f"operation-{OPERATION}.warm-claimed"
        self.allocated = self.root / "run" / f"{VMID}.allocated"
        self.ledger = self.root / "state/vmid-references/hivra-standby.hivra.list"
        self.document = self.root / "guest-launch.json"
        self.secret = self.root / "run" / f"{VMID}.env"
        self.meminfo = self.root / "meminfo"
        self.meminfo.write_text("MemTotal:    4194304 kB\n")
        paths = {
            "/etc/pve/qemu-server": self.root / "pve",
            "/root/hivra-provisioner-canary": self.bundle,
            "/run/lock": self.root / "locks",
            "/run/hivra-provision": self.root / "run",
            "/run/hivra-ci-keys": self.root / "run/hivra-ci-keys",
            "/run/hivra-guest-ssh-identity": self.root / "run/hivra-guest-ssh-identity",
            "/var/lib/hivra": self.root / "state",
            "/var/lib/vz/template/iso": self.root / "images",
        }
        uid, gid = os.getuid(), os.getgid()
        for script in ("hivra-provision-on-host.sh", "hivra-hermes-standby.sh", "hivra-host-capacity-admission"):
            text = (SOURCE / script).read_text()
            for original, fixture in paths.items():
                text = text.replace(original, str(fixture))
            text = text.replace('"$EUID" = 0', f'"$EUID" = {uid}')
            text = text.replace("-o root -g root ", "")
            text = re.sub(r"(?:0:0|root:root):(600|644|444):1", rf"{uid}:{gid}:\1:1", text)
            text = text.replace('"600:root:root"', '"600:' + subprocess.check_output(
                ["id", "-un"], text=True).strip() + ':' + subprocess.check_output(["id", "-gn"], text=True).strip() + '"')
            (self.bundle / script).write_text(text)
        (self.bundle / "hivra-install-agent.py").touch()
        mock = self.root / "mock"
        mock.write_text(MOCK)
        mock.chmod(0o700)
        for name in ("qm", "pvesh", "pvesm", "qemu-img", "ssh", "scp", "curl", "hostname", "nproc", "perl"):
            (self.root / "bin" / name).symlink_to(mock)
        key = self.root / "orchestrator"
        key.touch()
        key.with_suffix(".pub").write_text("fixture orchestrator key\n")
        image = self.root / "images" / f"hivra-hermes-{DIGEST}.qcow2"
        image.write_bytes(IMAGE)
        image.chmod(0o444)
        self.env = {
            "PATH": f"{self.root}/bin:/usr/bin:/bin",
            "MOCK_ROOT": str(self.root),
            "HIVRA_PROV_DIR": str(self.bundle),
            "HIVRA_VM_SSH_KEY_PATH": str(key),
            "HIVRA_HERMES_IMAGE_SHA256": DIGEST,
            "HIVRA_HERMES_STANDBY_CLAIM_GENERATION": GENERATION,
            "HIVRA_HERMES_STANDBY_HOST": "fixture-standby-host",
            "HIVRA_HERMES_STANDBY_BOOT_PROVEN_SHA256": DIGEST,
            "HIVRA_HERMES_STANDBY_RESERVE_MB": "512",
            "HIVRA_HERMES_STANDBY_ENFORCE_CEILINGS": "1",
            "HIVRA_HERMES_STANDBY_CPU_DENSITY_MILLI": "1000",
            "HIVRA_HERMES_STANDBY_MEMORY_DENSITY_MILLI": "1000",
            "HIVRA_HERMES_STANDBY_STORAGE_HEADROOM_GB": "1",
            "HIVRA_CAPACITY_MEMINFO_PATH": str(self.meminfo),
            "HIVRA_PROVISION_OPERATIONS_DIR": str(self.selected),
            "CLOUD_INIT_KEEP_DIR": str(self.root),
        }

    def call(self, mode, **override):
        args = [str(self.script), VMID, "42", "2", "1024", "hermes", "2"]
        env = {**self.env, "HIVRA_HERMES_STANDBY_ACTION": mode}
        if mode in ("claim", ""):
            env.update(HIVRA_OPERATION_ID=OPERATION, HIVRA_BINDING_TAG=BINDING)
        if mode == "claim":
            env["HIVRA_ALLOCATION_LOCK_FD"] = "8"
            env["MOCK_ALLOCATION_LOCK"] = str(self.root / "locks/hivra-allocation.lock")
            args = ["-c", 'exec 8>"$MOCK_ALLOCATION_LOCK"; flock -n 8; bash "$@"', "fixture", *args]
        if mode == "":
            env["HIVRA_SECRET_ENV_FILE"] = str(self.secret)
        return subprocess.run(["bash", *args], env={**env, **override}, text=True, capture_output=True, timeout=30)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)

    def fixture_secrets(self):
        secrets = {"TUNNEL_TOKEN": "fixture-tunnel-token", "TUNNEL_URL": "https://fixture.example.test",
                   "MODEL_KEY": "fixture-model-key", "MODEL_BASE_URL": "", "HERMES_MODEL": ""}
        self.secret.write_text("".join(
            f"HIVRA_{key}_B64={base64.b64encode(value.encode()).decode()}\n" for key, value in secrets.items()))
        self.secret.chmod(0o600)

    def test_stage_and_claim_then_one_typed_continuation_without_a_second_vm(self):
        stage = self.call("stage")
        self.assert_ok(stage)
        self.assertEqual(json.loads(stage.stdout.splitlines()[-1])["generation"], GENERATION)
        self.assertIn("onboot: 0", self.conf.read_text())
        self.assertEqual(self.slot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.ledger.read_text(), VMID + "\n")
        self.assertFalse(self.allocated.exists())
        self.assertFalse(self.document.exists())
        early = self.call("")
        self.assertEqual(early.returncode, 1)
        self.assertFalse(self.document.exists())
        self.assert_ok(self.call("claim"))
        self.assertEqual(self.receipt.stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.allocated.exists())
        self.assertEqual(dict(line.split("=", 1) for line in self.receipt.read_text().splitlines()), {
            "operation_id": OPERATION, "binding_tag": BINDING, "vmid": VMID, "ip": IP, "generation": GENERATION})
        self.assertFalse(list(self.selected.glob("*.selected")))
        self.assertFalse(self.document.exists())
        self.assert_ok(self.call("claim"))
        self.assertEqual(self.call("retire").returncode, 1)
        self.fixture_secrets()
        self.assert_ok(self.call(""))
        self.assertEqual(json.loads(self.document.read_text())["modelKey"], "fixture-model-key")
        self.assertTrue(json.loads(self.document.read_text())["hermesBaked"])
        self.assertFalse(self.secret.exists())
        self.fixture_secrets()
        self.assertEqual(self.call("").returncode, 1)
        events = self.events.read_text().splitlines()
        self.assertEqual(events.count("qm create"), 1)
        self.assertEqual(events.count("qm start"), 1)
        self.assertEqual(sum("hivra-install-agent.py" in event for event in events), 1)
        self.assertNotIn("qm destroy", events)

    def test_stage_checks_capacity_before_creation_and_continues_to_count_running_standby(self):
        self.meminfo.write_text("MemTotal:    1258291 kB\n")
        refused = self.call("stage")
        self.assertNotEqual(refused.returncode, 0)
        self.assertNotIn("qm create", self.events.read_text())
        self.assertFalse(self.ledger.exists())
        self.meminfo.write_text("MemTotal:    2097152 kB\n")
        self.assert_ok(self.call("stage"))
        args = [str(self.bundle / "hivra-host-capacity-admission"), "-", "1024", "1024", "2", "512", "1", "1000", "1000"]
        run = lambda: subprocess.run(["bash", *args], env=self.env, text=True, capture_output=True)
        self.assertIn("active memory floors", run().stderr)
        self.assert_ok(self.call("claim"))
        self.assertIn("active memory floors", run().stderr)
        self.meminfo.write_text("MemTotal:    4194304 kB\n")
        self.assertIn("active_floor_mb=1024 active_max_mb=1024 active_max_cpu_milli=2000", run().stdout)

    def test_ambiguous_or_expired_slots_never_retag_or_receive_credentials(self):
        self.assert_ok(self.call("stage"))
        original = self.conf.read_text()
        for override in (
            {"MOCK_BOOT": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}, {"MOCK_IP": "10.251.20.43/24"},
            {"MOCK_DIRTY": "1"}, {"MOCK_QMP": "paused"}, {"MOCK_CLOUD_INIT": "status: running"},
            {"HIVRA_HERMES_STANDBY_CLAIM_GENERATION": OPERATION},
            {"HIVRA_HERMES_IMAGE_SHA256": "f" * 64}, {"HIVRA_MODEL_KEY": "fixture-unexpected"},
        ):
            result = self.call("claim", **override)
            self.assertNotEqual(result.returncode, 0, override)
            self.assertEqual(self.conf.read_text(), original)
            self.assertFalse(self.receipt.exists())
        (self.selected / "operation-fixture.selected").write_text(f"vmid={VMID}\nip={IP}\n")
        self.assertIn("conflicts with a pending operation", self.call("claim").stderr)
        (self.selected / "operation-fixture.selected").unlink()
        record = self.slot.read_text().splitlines()
        record[12] = str(int(time.time()) - 1)
        self.slot.write_text("\n".join(record) + "\n")
        self.assertIn("reservation expired", self.call("claim").stderr)
        self.assertFalse(self.document.exists())
        self.assert_ok(self.call("retire"))
        self.assertFalse(self.conf.exists())
        self.assertFalse(self.ledger.exists())


if __name__ == "__main__":
    unittest.main()
