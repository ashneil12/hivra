#!/usr/bin/env python3
"""Runtime receipt coverage for the optional agent-run reporter; no host mutation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent.parent / "provisioner" / "hivra-runtime-receipt.py"
spec = importlib.util.spec_from_file_location("hivra_runtime_receipt", SOURCE)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)

SCRIPT = "/opt/hivra/agent-trace/hivra-agent-trace.py"
UNIT = "/etc/systemd/system/hivra-agent-trace.service"
SENTINEL = "hvra_otlp_v1.synthetic-never-read.receipt-sentinel"


class Runner:
    """Minimal fixture: only the reporter unit is loaded; every other probe is absent."""

    def __init__(self, reporter_active):
        self.reporter_active = reporter_active

    def __call__(self, arguments, user=None):
        if arguments[0] == "/usr/bin/dpkg-query":
            return b"bash\t5.1-6ubuntu1.1\tamd64\tbash\t5.1-6ubuntu1.1\tii \n"
        if arguments[0:2] == ["/usr/bin/systemctl", "show"] and arguments[-1] == "hivra-agent-trace.service":
            if self.reporter_active:
                return b"LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
            return b"LoadState=not-found\nActiveState=inactive\nUnitFileState=\n"
        return None


class AgentTraceReceiptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hivra-runtime-receipt-trace-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        (self.root / "usr/lib").mkdir(parents=True)
        (self.root / "usr/lib/os-release").write_text('ID=ubuntu\nVERSION_ID="22.04"\n')

    def collect(self, reporter_active):
        return receipt.collect_receipt(provisioner_version="2026.09.22.1", agent_kind="codex", substrate="proxmox-kvm",
                                       browser_enabled=False, root=self.root, runner=Runner(reporter_active))

    def test_computer_without_the_reporter_still_produces_a_receipt(self):
        value = self.collect(False)
        self.assertNotIn(SCRIPT, [artifact["path"] for artifact in value["artifacts"]])
        self.assertNotIn(UNIT, [artifact["path"] for artifact in value["artifacts"]])
        service = next(record for record in value["services"] if record["unit"] == "hivra-agent-trace.service")
        self.assertEqual(service, {"active": "inactive", "load": "not-found", "unit": "hivra-agent-trace.service", "unitFile": ""})
        receipt.build_installed_sbom(value, "a" * 64)

    def test_records_installed_reporter_identity_and_never_its_credential_or_state(self):
        files = {
            SCRIPT: b"#!/usr/bin/env python3\n# reporter fixture\n",
            UNIT: b"[Service]\nExecStart=/usr/bin/python3 -I -B /opt/hivra/agent-trace/hivra-agent-trace.py run\n",
            "/var/lib/hivra-agent-trace/credential.json": json.dumps({"token": SENTINEL}).encode(),
            "/var/lib/hivra-agent-trace/state.json": json.dumps({"offsets": {SENTINEL: 1}}).encode(),
        }
        for absolute, raw in files.items():
            path = self.root / absolute.lstrip("/")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            path.chmod(0o600 if absolute.startswith("/var/lib/") else 0o644)
        value = self.collect(True)
        artifacts = {artifact["path"]: artifact for artifact in value["artifacts"]}
        for absolute in (SCRIPT, UNIT):
            self.assertEqual(artifacts[absolute], {"mode": 0o644, "path": absolute,
                                                   "sha256": hashlib.sha256(files[absolute]).hexdigest(),
                                                   "size": len(files[absolute])})
        self.assertFalse([path for path in artifacts if path.startswith("/var/lib/hivra-agent-trace")])
        self.assertIn({"active": "active", "load": "loaded", "unit": "hivra-agent-trace.service", "unitFile": "enabled"},
                      value["services"])
        sbom = receipt.build_installed_sbom(value, "a" * 64)
        self.assertIn(SCRIPT, [component["name"] for component in sbom["components"]])
        for rendered in (receipt.encode(value), receipt.encode(sbom)):
            self.assertNotIn(SENTINEL, rendered.decode("ascii"))
            self.assertNotIn("credential.json", rendered.decode("ascii"))


if __name__ == "__main__":
    unittest.main()
