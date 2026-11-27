"""Exercise the producer and the provisioner without creating a VM or starting Docker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
PROVISIONER = (SCRIPTS.parent / "provisioner" / "provision-claude-code-box.sh").read_text()
PRELOAD = (SCRIPTS / "bake-agent-zero-preload.sh").read_text()
PINS = dict(line.split("=", 1) for line in (SCRIPTS / "agent-zero-bake-pins.env").read_text().splitlines())
DIGEST = PINS["AGENT_ZERO_INDEX_DIGEST"]
ARCHIVE = b"fake verified archive"
ARCHIVE_SHA = hashlib.sha256(ARCHIVE).hexdigest()
spec = importlib.util.spec_from_file_location("runtime_bake", SCRIPTS / "test-runtime-image-bake.py")
runtime_bake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_bake)


class AgentZeroProducer(unittest.TestCase):
    def test_agent_zero_preloads_before_generalization_and_checks_published_receipt(self):
        fixture = runtime_bake.RuntimeImageBake()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        scripts = fixture.root / "scripts"
        scripts.mkdir()
        for name in ("bake-runtime-image.sh", "bake-runtime-guest.sh", "runtime-bake-pins.env",
                     "bake-fetch.sh", "bake-agent-zero-image.sh", "bake-agent-zero-guest.sh", "bake-agent-zero-preload.sh",
                     "bake-agent-zero-debs.sh", "agent-zero-debs.lock"):
            shutil.copy(SCRIPTS / name, scripts)
        (scripts / "agent-zero-bake-pins.env").write_text(
            f"AGENT_ZERO_INDEX_DIGEST={DIGEST}\nAGENT_ZERO_ARCHIVE_SHA256={ARCHIVE_SHA}\n")
        (scripts / "bake-agent-zero-container.sh").write_text(
            f'''printf %s "{ARCHIVE.decode()}" > "$2/agent-zero-linux-amd64-${{1#sha256:}}.oci.tar"\n''')
        for name, script in {
            "cloud-localds": 'cat "$2" "$3" > "$FIXTURE_SEED"; touch "$1"',
            "qemu-system-x86_64": 'printf "%s\n" "$@" > "$FIXTURE_QEMU"',
            "virt-customize": 'printf "%s\n" "$@" >> "$FIXTURE_CUSTOMIZE"',
        }.items():
            tool = fixture.root / "bin" / name
            tool.write_text("#!/bin/bash\nset -eu\n" + script + "\n")
            tool.chmod(0o755)
        marker = {"schema": 1, "kind": "agent-zero", "baseImageSha256": runtime_bake.BASE,
                  "imageDigest": DIGEST, "archiveSha256": ARCHIVE_SHA}
        env = {
            **fixture.env,
            "FIXTURE_INFO": json.dumps({"format": "qcow2", "virtual-size": 24 * 1024**3, "format-specific": {"data": {}}}),
            **{"FIXTURE_" + key: str(fixture.root / key) for key in ("QEMU", "SEED")},
        }
        command = ["bash", str(scripts / "bake-runtime-image.sh"), "agent-zero", str(fixture.output)]
        rejected = subprocess.run(command, capture_output=True, text=True, timeout=10,
                                  env={**env, "FIXTURE_MARKER": json.dumps({**marker, "imageDigest": "wrong"})})
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(list(fixture.output.iterdir()), [])
        built = subprocess.run(command, capture_output=True, text=True, timeout=10,
                               env={**env, "FIXTURE_MARKER": json.dumps(marker)})
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertIn("part-resize\n/dev/sda\n1\n50331614\n", (fixture.root / "GROW").read_text())
        qemu = (fixture.root / "QEMU").read_text().splitlines()
        self.assertEqual(qemu[qemu.index("-nic") + 1], "none")
        self.assertIn("readonly=on", "\n".join(qemu))
        self.assertIn("bake-agent-zero-preload.sh", (fixture.root / "SEED").read_text())
        customize = (fixture.root / "CUSTOMIZE").read_text()
        self.assertNotIn("\n--network\n", customize)
        self.assertEqual(customize.splitlines().count("--no-network"), 4)
        self.assertRegex(customize, r"bake-runtime-guest\.sh generalize\n--delete\n/root/hivra-image-bake")
        stem = fixture.output / f"hivra-agent-zero-{runtime_bake.DIGEST}"
        self.assertEqual(json.loads(stem.with_suffix(".json").read_text()),
                         {**marker, "format": "qcow2", "imageSha256": runtime_bake.DIGEST})
        self.assertEqual(len(list(fixture.output.iterdir())), 2)

    def test_guest_refuses_bad_deb_or_wrong_base_before_offline_apt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "debs").mkdir()
            deb = root / "debs/qemu-guest-agent_6.2+dfsg-2ubuntu6.31_amd64.deb"
            status = root / "status"
            status.write_bytes(b"pinned base")
            log = root / "apt.log"
            lock = (
                f"20261127T200000Z {hashlib.sha256(status.read_bytes()).hexdigest()}\n"
                f"{ARCHIVE_SHA} qemu-guest-agent 1:6.2+dfsg-2ubuntu6.31 pool/universe/q/qemu/{deb.name}\n"
            )
            (root / "agent-zero-debs.lock").write_text(lock)
            (root / "bake-agent-zero-debs.sh").write_text(
                (SCRIPTS / "bake-agent-zero-debs.sh").read_text().replace("/var/lib/dpkg/status", str(status))
            )
            commands = """
set -euo pipefail
apt-get() { printf '%s\n' "$@" > "$PWD/apt.log"; }
dpkg-query() { echo 'installed 1:6.2+dfsg-2ubuntu6.31'; }
systemctl() { :; }
chown() { :; }
"""
            guest = (SCRIPTS / "bake-agent-zero-guest.sh").read_text().replace("/etc/docker", "$PWD/docker").replace("-o root -g root ", "")
            (root / "agent-zero.oci.tar").touch()
            for base, payload, matches in ((b"wrong base", ARCHIVE, False), (b"pinned base", b"tampered", False),
                                           (b"pinned base", ARCHIVE, True)):
                with self.subTest(base=base, payload=payload):
                    status.write_bytes(base)
                    deb.write_bytes(payload)
                    result = subprocess.run(["bash", "-c", commands + guest], cwd=root,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode == 0, matches, result.stderr)
                    self.assertEqual(log.exists(), matches)
            self.assertIn("Dir::Etc::sourcelist=/dev/null", log.read_text().splitlines())
            self.assertIn("--no-remove", log.read_text().splitlines())
            self.assertIn(str(deb), log.read_text().splitlines())
            self.assertFalse(deb.exists())

    def test_preload_hashes_before_docker_and_requires_clean_disk_and_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("= '0:0:400' ]", PRELOAD)
            root = Path(tmp)
            (root / "etc" / "hivra").mkdir(parents=True)
            (root / "runtime-bake-pins.env").write_text(f"BASE_IMAGE_SHA256={runtime_bake.BASE}\n")
            (root / "agent-zero-bake-pins.env").write_text(
                f"AGENT_ZERO_INDEX_DIGEST={DIGEST}\nAGENT_ZERO_ARCHIVE_SHA256={ARCHIVE_SHA}\n")
            archive = root / "agent-zero.oci.tar"
            log = root / "docker.log"
            script = '''
systemctl() { printf 'systemctl:%s\n' "$*" >> "$FIXTURE_LOG"; }
stat() { printf '%s\n' '0:0:400'; }
install() { :; }
df() { printf '%s\n' "$FIXTURE_FREE"; }
docker() {
  printf '%s\n' "$*" >> "$FIXTURE_LOG"
  case "$*" in
    'info --format'*) printf '%s\n' 'io.containerd.snapshotter.v1' ;;
    'image ls -aq') printf '%s' "$FIXTURE_PREEXISTING" ;;
    'image inspect'*) printf '%s %s\n' "$FIXTURE_DIGEST" "$FIXTURE_PLATFORM" ;;
    'container ls -aq'|'volume ls -q'|'load --input'*) ;;
    *) return 97 ;;
  esac
}
timeout() { shift 2; "$@"; }
rm() {
  case "$*" in
    *'/var/lib/docker'*) return 0 ;;
  esac
  command rm "$@"
}
''' + PRELOAD.replace("cd /root/hivra-image-bake", 'cd "$FIXTURE_ROOT"').replace(
                "/etc/hivra", "$FIXTURE_ROOT/etc/hivra").replace(
                '[ ! -e /opt/a0 ]', '[ ! -e "$FIXTURE_ROOT/opt/a0" ]').replace(
                '[ ! -e /home/bux ]', '[ ! -e "$FIXTURE_ROOT/home/bux" ]').replace(
                '[ ! -e /etc/systemd/system/hivra-agent-zero.service ]',
                '[ ! -e "$FIXTURE_ROOT/hivra-agent-zero.service" ]')
            for payload, free, preexisting, platform, expected_load, success in (
                (b"tampered", "6000000", "", "linux/amd64", False, False),
                (ARCHIVE, "6000000", "already present", "linux/amd64", False, False),
                (ARCHIVE, "6000000", "", "linux/arm64", True, False),
                (ARCHIVE, "1000000", "", "linux/amd64", True, False),
                (ARCHIVE, "6000000", "", "linux/amd64", True, True),
            ):
                with self.subTest(payload=payload, free=free, preexisting=preexisting, platform=platform):
                    archive.write_bytes(payload)
                    log.write_text("")
                    check = subprocess.run(["bash", "-c", script], timeout=10, capture_output=True, text=True,
                                           env={**os.environ, "FIXTURE_ROOT": tmp, "FIXTURE_LOG": str(log),
                                                "FIXTURE_FREE": free, "FIXTURE_PREEXISTING": preexisting,
                                                "FIXTURE_PLATFORM": platform, "FIXTURE_DIGEST": DIGEST})
                    self.assertEqual(check.returncode == 0, success, check.stderr)
                    self.assertEqual("load --input" in log.read_text(), expected_load)
                    self.assertNotIn("pull ", log.read_text())
                    self.assertEqual((root / "etc/hivra/agent-zero-bake.json").is_file(), success)
                    self.assertEqual(archive.exists(), not expected_load)


class AgentZeroProvisioner(unittest.TestCase):
    def test_explicit_bake_path_checks_local_content_never_pulls_and_refuses_stale_rollback(self):
        check = PROVISIONER[PROVISIONER.index('case "$AGENT_ZERO_BAKED" in'):].split('\n[[ "$CDP_PORT"', 1)[0]
        store = PROVISIONER[PROVISIONER.index('A0_REPO="agent0ai/agent-zero"'):].split('ok "Agent Zero image', 1)[0]
        pull = PROVISIONER[PROVISIONER.index("# Pull the image by digest so the unit"):].split("record_agent_app", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "marker.json"
            marker.write_text(json.dumps({"schema": 1, "kind": "agent-zero", "baseImageSha256": runtime_bake.BASE,
                                          "imageDigest": DIGEST, "archiveSha256": ARCHIVE_SHA}))
            unit = Path(tmp) / "unit"
            script = '''
set -euo pipefail
die() { echo "$*" >&2; exit 1; }
ok() { :; }
systemctl() { :; }
docker() {
  printf '%s\n' "$*" >> "$FIXTURE_LOG"
  case "$1" in
    --version|pull) ;;
    image) printf '%s %s\n' "$FIXTURE_DIGEST" "$FIXTURE_PLATFORM" ;;
    *) return 97 ;;
  esac
}
''' + check.replace("/etc/hivra/agent-zero-bake.json", '"$FIXTURE_MARKER"').replace(
                "/etc/systemd/system/hivra-agent-zero.service", '"$FIXTURE_UNIT"').replace(
                "info.st_uid != 0", "info.st_uid != os.getuid()") + "\n" + store + "\n" + pull.replace("/tmp/az-pull.log", tmp + "/pull.log") + '\nprintf "%s" "$A0_PULL_POLICY"'
            log = Path(tmp) / "docker.log"
            for baked, mode, pin, platform, stale, success, expected_pull in (
                ("1", 0o644, "", "linux/amd64", False, True, False),
                ("1", 0o644, DIGEST, "linux/arm64", False, False, False),
                ("1", 0o644, "sha256:" + "1" * 64, "linux/amd64", False, False, False),
                ("1", 0o666, "", "linux/amd64", False, False, False),
                ("1", 0o644, "", "linux/amd64", True, False, False),
                ("0", 0o644, DIGEST, "linux/amd64", False, True, True),
            ):
                with self.subTest(baked=baked, mode=mode, pin=pin, platform=platform, stale=stale):
                    marker.chmod(mode)
                    unit.unlink(missing_ok=True)
                    if stale:
                        unit.write_text("ExecStart=docker run agent0ai/agent-zero@sha256:" + "1" * 64 + "\n")
                    log.write_text("")
                    result = subprocess.run(["bash", "-c", script], timeout=10, capture_output=True, text=True,
                                            env={**os.environ, "AGENT_ZERO_BAKED": baked, "AGENT_KIND": "agent-zero",
                                                 "COMPUTER_SUBSTRATE": "proxmox-kvm", "AGENT_ZERO_IMAGE_DIGEST": pin,
                                                 "FIXTURE_DIGEST": DIGEST, "FIXTURE_PLATFORM": platform,
                                                 "FIXTURE_UNIT": str(unit), "FIXTURE_MARKER": str(marker),
                                                 "FIXTURE_LOG": str(log)})
                    self.assertEqual(result.returncode == 0, success, result.stderr)
                    self.assertEqual("pull " in log.read_text(), expected_pull)
                    if success:
                        self.assertEqual(result.stdout, "--pull=never " if baked == "1" else "")
            self.assertIn("info.st_uid != 0", PROVISIONER)
            self.assertIn('docker run ${A0_PULL_POLICY}--rm --name hivra-agent-zero', PROVISIONER)


if __name__ == "__main__":
    unittest.main()
