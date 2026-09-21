"""Run only in an owned disposable root Linux container with no network/host mounts."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys

spec = importlib.util.spec_from_file_location("stage", "/tmp/stage-attached-codex.py")
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
archive = Path("/tmp/codex.tar.gz")
operation = "11111111-1111-4111-8111-111111111111"
installation = "22222222-2222-4222-8222-222222222222"
home = Path("/home/hivra-fixture-desktop")
home.mkdir(mode=0o700)
(home / ".codex").mkdir()
(home / ".codex/config.toml").write_text('model = "preserve-existing-model"\n')
(home / ".bashrc").write_text("# preserve the desktop shell\n")
(home / "important.txt").write_bytes(b"original user bytes\x00\xff")
before = {str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file in home.rglob("*") if file.is_file()}
global_cli = Path("/usr/local/bin/codex")
global_before = (global_cli.read_bytes() if global_cli.is_file() else None, os.path.islink(global_cli))


def rejected(installation_id, artifact=archive):
    try:
        stage.stage(operation, installation_id, str(artifact))
    except (ValueError, OSError):
        return
    raise AssertionError("expected staging refusal")


rejected("../../desktop")
link = Path("/tmp/linked-codex.tar.gz")
link.symlink_to(archive)
rejected(installation, link)
assert not Path("/opt/hivra/agent-installations").exists(), "artifact refusal must precede layout mutation"
os.umask(0o077)
receipt = stage.stage(operation, installation, str(archive))
assert receipt["state"] == "staged" and receipt["runtimeVersion"] == "0.149.1"
assert receipt["operationId"] == operation and receipt["installationId"] == installation
user = pwd.getpwnam(receipt["account"])
assert user.pw_uid != 0 and user.pw_shell == "/usr/sbin/nologin"
assert os.getgrouplist(user.pw_name, user.pw_gid) == [user.pw_gid], "no desktop/sudo/docker group membership"
assert Path(receipt["home"]).stat().st_mode & 0o777 == 0o700
assert Path(receipt["executable"]).stat().st_uid == 0
assert json.loads((Path(receipt["executable"]).parent / "installation.json").read_text()) == receipt
result = subprocess.run(["runuser", "-u", user.pw_name, "--", receipt["executable"], "--version"],
                        capture_output=True, text=True, check=True, timeout=15)
assert result.stdout.strip() == "codex-cli 0.149.1"
assert subprocess.run(["runuser", "-u", user.pw_name, "--", "cat", str(home / "important.txt")],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
rejected(installation)  # Never retry over an already created account/install.
parent = Path("/opt/hivra/agent-installations")
parent.chmod(0o700)
inaccessible = "44444444-4444-4444-8444-444444444444"
try:
    rejected(inaccessible)
    assert parent.stat().st_mode & 0o777 == 0o700, "never chmod an existing shared ancestor"
    assert not (parent / inaccessible).exists()
    try:
        pwd.getpwnam("hva_" + inaccessible.replace("-", "")[:24])
    except KeyError:
        pass
    else:
        raise AssertionError("account was created before rejecting inaccessible ancestor")
finally:
    parent.chmod(0o711)  # Restore this test-owned directory only.
collision = "33333333-3333-4333-8333-333333333333"
target = Path("/opt/hivra/agent-installations") / collision
target.symlink_to(home, target_is_directory=True)
rejected(collision)
assert target.is_symlink()
assert before == {str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file in home.rglob("*") if file.is_file()}
assert global_before == (global_cli.read_bytes() if global_cli.is_file() else None, os.path.islink(global_cli))
print(json.dumps({"result": "PASS", "runtime": "codex-cli 0.149.1", "architecture": receipt["architecture"],
                  "archiveSha256": receipt["archiveSha256"], "preservedFiles": len(before),
                  "privateHome": True, "serviceStarted": False, "modelCalled": False}, separators=(",", ":")))
