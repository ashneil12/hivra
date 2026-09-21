"""Fault injection in the same owned disposable container as the stage test."""
import importlib.util
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("stage", "/tmp/stage-attached-codex.py")
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
installation = "55555555-5555-4555-8555-555555555555"
original_run = stage.subprocess.run
denial_observed = False


def deny_home(command, **kwargs):
    global denial_observed
    if "-c" in command and "private-home-check" in command[command.index("-c") + 1]:
        # Inject lost home access immediately before the real non-root probe.
        # Do not mock its result: the kernel must deny the actual account.
        Path(command[-1]).chmod(0o000)
        denial_observed = True
    return original_run(command, **kwargs)


stage.subprocess.run = deny_home
try:
    stage.stage("66666666-6666-4666-8666-666666666666", installation, "/tmp/codex.tar.gz")
except subprocess.CalledProcessError:
    pass
else:
    raise AssertionError("inaccessible home must refuse staging")
finally:
    stage.subprocess.run = original_run
target = Path("/opt/hivra/agent-installations") / installation
assert denial_observed and target.is_dir(), "retain the exact partial installation for reconciliation"
assert not (target / "codex").exists() and not (target / "installation.json").exists()
print("PASS actual-account home denial prevents binary write and staging receipt")
