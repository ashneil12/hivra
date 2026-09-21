"""Owned disposable-container entrypoint, never a host/guest deployment command."""
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("native_install", "/recipe/install-native.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

if os.geteuid() != 0 or installer.RUNTIME != Path("/opt/hivra/deepseek-runtime") or installer.RUNTIME.exists():
    raise RuntimeError("fresh disposable native package fixture required")
receipt = installer.install_package(Path("/recipe"))

def no_reinstall(*_):
    raise RuntimeError("verified immutable runtime must not reinstall")

installer.npm_install = no_reinstall
if installer.install_package(Path("/recipe")) != receipt:
    raise RuntimeError("native package reuse differs")
print(json.dumps({"install": receipt, "immutableReuseVerified": True}, separators=(",", ":")))
