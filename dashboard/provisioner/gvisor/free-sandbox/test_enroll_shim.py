"""The free sandbox's enroll shim: the code reaches the runner only through a 0600 file, never argv or env."""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SHIM = Path(__file__).with_name("enroll-shim")

FAKE_RUNNER = """#!/bin/sh
# Records how it was called and what the code file held, as the real runner would read it.
out="$HOME/fake-runner.log"
printf 'argv:%s\\n' "$*" > "$out"
file=""
while [ $# -gt 0 ]; do [ "$1" = "--enroll-file" ] && file="$2"; shift; done
printf 'mode:%s\\n' "$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")" >> "$out"
printf 'code:%s\\n' "$(cat "$file")" >> "$out"
env | grep -c 'enrollsecret' >> "$out" || true
mkdir -p "$HOME/.agentes-runner" && echo '{}' > "$HOME/.agentes-runner/config.json"
"""


class EnrollShimTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)
        self.runner = self.home / "fake-runner"
        self.runner.write_text(FAKE_RUNNER)
        self.runner.chmod(0o755)

    def tearDown(self):
        self.dir.cleanup()

    def shim(self, server, stdin):
        env = {"PATH": os.environ["PATH"], "HIVRA_RUNNER_HOME": str(self.home), "AGENTES_RUNNER": str(self.runner)}
        return subprocess.run([str(SHIM), server], input=stdin, text=True, capture_output=True, env=env, timeout=20)

    def test_hands_the_code_to_the_runner_through_a_private_file_only(self):
        result = self.shim("https://agents.example", "enrollsecret_ABC123\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        log = (self.home / "fake-runner.log").read_text()
        self.assertIn("argv:pair --server https://agents.example --enroll-file", log)
        self.assertNotIn("enrollsecret", log.split("\n")[0])
        self.assertIn("mode:600", log)
        self.assertIn("code:enrollsecret_ABC123", log)
        self.assertTrue(log.rstrip().endswith("0"))
        leftovers = [p for p in (self.home / ".agentes-runner").iterdir() if p.name.startswith("enroll.")]
        self.assertEqual(leftovers, [])

    def test_refuses_plain_http_a_malformed_code_and_a_second_enroll(self):
        self.assertEqual(self.shim("http://agents.example", "enrollsecret_ABC123\n").returncode, 64)
        self.assertEqual(self.shim("https://agents.example", "bad code; rm -rf /\n").returncode, 65)
        self.assertEqual(self.shim("https://agents.example", "enrollsecret_ABC123\n").returncode, 0)
        self.assertEqual(self.shim("https://agents.example", "enrollsecret_ABC123\n").returncode, 65)

    def test_keeps_the_runner_state_on_the_workspace(self):
        self.shim("https://agents.example", "enrollsecret_ABC123\n")
        state = self.home / ".agentes-runner"
        self.assertTrue((state / "config.json").exists())
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)

    def test_removes_a_code_a_killed_shim_left_behind(self):
        state = self.home / ".agentes-runner"
        state.mkdir(mode=0o700)
        stale = state / "enroll.OLD123"
        stale.write_text("an old code")
        self.assertEqual(self.shim("https://agents.example", "enrollsecret_ABC123\n").returncode, 0)
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
