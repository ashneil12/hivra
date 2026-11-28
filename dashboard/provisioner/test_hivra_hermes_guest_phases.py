import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class HermesGuestPhasesTest(unittest.TestCase):
    def run_markers(self, baked):
        source = Path(__file__).with_name("provision-claude-code-box.sh").read_text()
        marker = source.split('HERMES_GUEST_PHASE_START_CS=""\n', 1)[1].split('\nhermes_guest_phase start\n', 1)[0]
        with tempfile.TemporaryDirectory() as folder:
            clock = Path(folder) / "uptime"
            return subprocess.run(
                ["bash", "-euc", 'HERMES_GUEST_PHASE_START_CS=""\n' + marker.replace('/proc/uptime', '"$CLOCK"') + '''
printf '8001.02 0.00\\n' > "$CLOCK"
hermes_guest_phase base_ready
hermes_guest_phase start
printf '8002.13 0.00\\n' > "$CLOCK"
hermes_guest_phase base_ready
hermes_guest_phase 'unreviewed-phase-with-sensitive-payload'
printf 'garbage\\n' > "$CLOCK"
hermes_guest_phase native_gateway_started
printf '8000.99 0.00\\n' > "$CLOCK"
hermes_guest_phase local_ready
rm "$CLOCK"
hermes_guest_phase receipt_verified
'''],
                env={**os.environ, "CLOCK": str(clock), "HERMES_BAKED": baked},
                capture_output=True, text=True, check=True,
            )

    def test_baked_emits_only_elapsed_milliseconds_and_allowed_names(self):
        result = self.run_markers("1")
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.splitlines(), [
            "HIVRA_HERMES_GUEST_PHASE start 0",
            "HIVRA_HERMES_GUEST_PHASE base_ready 1110",
        ])

    def test_stock_emits_nothing(self):
        result = self.run_markers("0")
        self.assertEqual((result.stdout, result.stderr), ("", ""))


if __name__ == "__main__":
    unittest.main()
