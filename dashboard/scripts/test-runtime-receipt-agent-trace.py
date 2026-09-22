#!/usr/bin/env python3
"""The runtime receipt makes no claim about the agent-run reporter; no host mutation.

The receipt is collected inside the runtime bootstrap, before the fail-open
reporter install at launch and on every start (contract:
docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md). Any record
of the reporter there would describe a pre-install or stale state, so the
receipt neither lists its files nor probes its unit, whatever is installed.
"""
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
UNIT_NAME = "hivra-agent-trace.service"
SENTINEL = "hvra_otlp_v1.synthetic-never-read.receipt-sentinel"


class Runner:
    """Minimal fixture: every probe is absent except dpkg and, optionally, an active reporter unit."""

    def __init__(self, reporter_active):
        self.reporter_active = reporter_active
        self.calls = []

    def __call__(self, arguments, user=None):
        self.calls.append(list(arguments))
        if arguments[0] == "/usr/bin/dpkg-query":
            return b"bash\t5.1-6ubuntu1.1\tamd64\tbash\t5.1-6ubuntu1.1\tii \n"
        if arguments[0:2] == ["/usr/bin/systemctl", "show"] and arguments[-1] == UNIT_NAME:
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

    def collect(self, runner):
        return receipt.collect_receipt(provisioner_version="2026.09.22.1", agent_kind="codex", substrate="proxmox-kvm",
                                       browser_enabled=False, root=self.root, runner=runner)

    def assert_no_reporter_claim(self, value, runner):
        rendered = receipt.encode(value).decode("ascii")
        sbom = receipt.encode(receipt.build_installed_sbom(value, "a" * 64)).decode("ascii")
        for text in (rendered, sbom):
            self.assertNotIn("agent-trace", text)
            self.assertNotIn(SENTINEL, text)
        self.assertNotIn(UNIT_NAME, [record["unit"] for record in value["services"]])
        self.assertFalse([call for call in runner.calls if UNIT_NAME in call])

    def test_computer_without_the_reporter_still_produces_a_receipt(self):
        runner = Runner(reporter_active=False)
        value = self.collect(runner)
        self.assert_no_reporter_claim(value, runner)
        self.assertEqual(value["schemaVersion"], 2)

    def test_installed_reporter_is_not_recorded_because_the_receipt_predates_its_install(self):
        # Regression: the receipt listed the reporter's files and unit although
        # it is written before the launch installer (and every start) installs
        # the reporter, so launched computers showed a "not-found" reporter
        # that was running moments later.
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
        runner = Runner(reporter_active=True)
        value = self.collect(runner)
        self.assert_no_reporter_claim(value, runner)
        self.assertNotIn(SCRIPT, [artifact["path"] for artifact in value["artifacts"]])
        self.assertNotIn(UNIT, [artifact["path"] for artifact in value["artifacts"]])


if __name__ == "__main__":
    unittest.main()
