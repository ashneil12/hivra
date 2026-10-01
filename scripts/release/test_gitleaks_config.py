#!/usr/bin/env python3
"""Guards for the repository's gitleaks configuration.

What this proves, without needing the gitleaks binary:

* the custom rules match every token format this repository issues, in the
  neutral contexts the default rules miss, and ignore the short fixtures used in
  tests and low-entropy placeholders;
* the allowlists stay narrow: every entry is bound to an exact value (and to one
  file unless the value is a published constant), none is path-only, and none
  has gone stale;
* .gitleaksignore holds no line-number fingerprints.

The CI job separately runs the real gitleaks binary over the exported tree, so
these checks cover the configuration's shape and the rules' regular
expressions, not the binary's behavior.
"""

from __future__ import annotations

import base64
import math
import re
import json
import secrets
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = tomllib.loads((ROOT / ".gitleaks.toml").read_text(encoding="utf-8"))
RULES = {rule["id"]: rule for rule in CONFIG.get("rules", [])}

EXPECTED_RULE_IDS = {
    "hivra-managed-venice-proxy-key",
    "hivra-activity-collector-token",
    "hivra-server-enrollment-code",
    "bankr-api-key",
    "supabase-secret-key",
}


def entropy(value: str) -> float:
    counts: dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    return -sum((n / len(value)) * math.log2(n / len(value)) for n in counts.values())


def b64url(length: int) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(length)).decode().rstrip("=")


def base32_lower(length: int) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    return "".join(alphabet[byte % 32] for byte in secrets.token_bytes(length))


def alnum(length: int) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    return "".join(alphabet[byte % 62] for byte in secrets.token_bytes(length))


def detects(rule_id: str, text: str) -> bool:
    """True when the rule's regex matches and the match clears its entropy floor."""
    rule = RULES[rule_id]
    for match in re.finditer(rule["regex"], text):
        if entropy(match.group(0)) >= rule.get("entropy", 0):
            return True
    return False


def tracked_text_files() -> dict[str, str]:
    listing = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z"], check=True, capture_output=True
    ).stdout.decode("utf-8").split("\0")
    files: dict[str, str] = {}
    for name in filter(None, listing):
        path = ROOT / name
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data:
            continue
        files[name] = data.decode("utf-8", errors="replace")
    return files


def split_inline_flags(pattern: str) -> tuple[str, int]:
    """Go writes flags as a (?i) prefix; Python wants them as arguments."""
    flags = 0
    while True:
        match = re.match(r"\(\?([is]+)\)", pattern)
        if not match:
            return pattern, flags
        if "i" in match.group(1):
            flags |= re.IGNORECASE
        if "s" in match.group(1):
            flags |= re.DOTALL
        pattern = pattern[match.end():]


class RuleSet(unittest.TestCase):
    def test_config_keeps_the_default_rules_and_the_expected_custom_rules(self):
        self.assertIs(CONFIG["extend"]["useDefault"], True)
        self.assertEqual(set(RULES), EXPECTED_RULE_IDS)
        self.assertNotIn("allowlist", CONFIG, "use [[allowlists]] entries with exact values")
        for rule_id, rule in RULES.items():
            self.assertTrue(rule.get("description"), rule_id)
            self.assertTrue(rule.get("keywords"), f"{rule_id} needs keywords so gitleaks prefilters")
            self.assertGreaterEqual(rule.get("entropy", 0), 3.0, f"{rule_id} needs an entropy floor")
            self.assertNotIn("allowlists", rule, f"{rule_id}: allowlist at the top level only")
            self.assertNotIn("allowlist", rule, f"{rule_id}: allowlist at the top level only")
            re.compile(rule["regex"])

    def test_custom_rules_detect_fresh_tokens_in_neutral_contexts(self):
        for _ in range(25):
            samples = {
                "hivra-managed-venice-proxy-key": "hven_live_" + b64url(32),
                "hivra-activity-collector-token": f"hvra_otlp_v1.{b64url(24)}.{b64url(32)}",
                "hivra-server-enrollment-code": "hse1_" + base32_lower(32),
                "bankr-api-key": "bk_" + alnum(40),
                "supabase-secret-key": "sb_secret_" + b64url(30),
            }
            samples_ptr = "bk_ptr_" + alnum(40)
            # The shapes the repo's own fixtures use: prefix, short id, underscore, secret.
            bankr_shapes = ["bk_usr_" + alnum(8) + "_" + alnum(32), "bk_ptr_" + alnum(8) + "_" + alnum(32),
                            "bk_agent_" + alnum(8) + "_" + alnum(32), "bk_usr_" + alnum(40)]
            for rule_id, token in samples.items():
                for template in ("{t}", "see {t} here", 'const a = "{t}";', '["{t}"]', "`{t}`"):
                    with self.subTest(rule=rule_id, template=template):
                        self.assertTrue(detects(rule_id, template.format(t=token)))
            self.assertTrue(detects("bankr-api-key", f"key {samples_ptr}"))
            for shape in bankr_shapes:
                with self.subTest(rule="bankr-api-key", shape=shape[:12]):
                    self.assertTrue(detects("bankr-api-key", f'const key = "{shape}";'))
                    self.assertTrue(detects("bankr-api-key", f"see {shape} here"))

    def test_custom_rules_ignore_the_short_fixtures_and_low_entropy_placeholders(self):
        negatives = {
            "hivra-managed-venice-proxy-key": [
                "hven_live_TESTKEY123",
                "hven_live_AZKEY123",
                "hven_live_" + "A" * 43,
                "hven_live_" + "ab" * 21 + "a",
                "xhven_live_" + b64url(32),  # no word boundary: part of another identifier
            ],
            "hivra-activity-collector-token": [
                "hvra_otlp_v1.short.short",
                "hvra_otlp_v1." + "a" * 20 + "." + "a" * 20,
                "hvra_otlp_v1.<claims>.<signature>",
            ],
            "hivra-server-enrollment-code": [
                "hse1_" + "a" * 32,
                "hse1_" + base32_lower(31),
                "hse1_" + "A1" * 16,  # outside the lowercase base32 alphabet
            ],
            "bankr-api-key": [
                "bk_usr_abcd1234_usersecretvalue000",
                "bk_ptr_abcd1234_partner",
                "bk_" + "a" * 40,
                "bk_short",
                "bk_usr_fixture0_placeholdervalue0000",
            ],
            "supabase-secret-key": [
                "sb_secret_short",
                "sb_secret_" + "x" * 30,
                "sb_publishable_" + b64url(30),  # publishable keys are public by design
            ],
        }
        for rule_id, values in negatives.items():
            for value in values:
                with self.subTest(rule=rule_id, value=value):
                    self.assertFalse(detects(rule_id, value))


class Allowlists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = CONFIG.get("allowlists", [])
        cls.files = tracked_text_files()

    def test_the_ignore_file_has_no_line_number_fingerprints(self):
        lines = (ROOT / ".gitleaksignore").read_text(encoding="utf-8").splitlines()
        fingerprints = [line for line in lines if line.strip() and not line.lstrip().startswith("#")]
        self.assertEqual(fingerprints, [], "add a value-bound [[allowlists]] entry to .gitleaks.toml instead")

    def test_every_entry_is_bound_to_an_exact_value(self):
        self.assertTrue(self.entries)
        for entry in self.entries:
            description = entry.get("description", "")
            self.assertGreaterEqual(len(description), 20, "every entry says why it is safe")
            self.assertEqual(entry.get("regexTarget"), "secret", description)
            for forbidden in ("commits", "stopwords"):
                self.assertNotIn(forbidden, entry, f"{description}: {forbidden} widens the entry")
            regexes = entry.get("regexes", [])
            self.assertTrue(regexes, f"{description}: a value regex is required")
            for regex in regexes:
                body, _ = split_inline_flags(regex)
                self.assertTrue(body.startswith("^") and body.endswith("$"), f"{description}: anchor {regex}")
                self.assertNotRegex(body[1:-1], r"(?<!\\)(?:\.\*|\.\+)", f"{description}: no wildcards")
            paths = entry.get("paths")
            if paths is not None:
                self.assertEqual(entry.get("condition"), "AND", f"{description}: path entries need condition AND")
                for path in paths:
                    self.assertTrue(path.startswith("^") and path.endswith("$"), f"{description}: anchor {path}")
                # In `gitleaks dir` a global allowlist with `paths` skips the whole file for every rule,
                # ignoring condition and regexes. Only a rule-scoped entry keeps the file scanned.
                targets = entry.get("targetRules")
                self.assertTrue(targets and all(re.fullmatch(r"[a-z0-9-]+", str(rule)) for rule in targets),
                                f"{description}: a path entry must name the rule(s) it applies to (targetRules)")

    def test_unbound_entries_are_only_published_contract_addresses(self):
        for entry in self.entries:
            if "paths" in entry:
                continue
            for regex in entry["regexes"]:
                body, _ = split_inline_flags(regex)
                self.assertRegex(body, r"^\^0x[0-9a-f]{40}\$$", entry["description"])

    def test_every_entry_still_matches_something_in_the_tree(self):
        for entry in self.entries:
            path_patterns = [re.compile(p) for p in entry.get("paths", [])]
            candidates = {
                name: text
                for name, text in self.files.items()
                if not path_patterns or any(p.search(name) for p in path_patterns)
            }
            self.assertTrue(candidates, f"no tracked file matches the path of: {entry['description']}")
            for regex in entry["regexes"]:
                body, flags = split_inline_flags(regex)
                unanchored = re.compile(body[1:-1], flags)
                hits = [name for name, text in candidates.items() if unanchored.search(text)]
                self.assertTrue(hits, f"stale allowlist value ({entry['description']}): {regex}")


@unittest.skipUnless(shutil.which("gitleaks"), "gitleaks is not installed")
class DirectoryScanKeepsAllowlistedFilesScanned(unittest.TestCase):
    """The CI tree scans use `gitleaks dir`. A reviewed file must stay scanned for everything else."""

    def scan(self, relative: str, content: str) -> list[dict]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            report = root / "report.json"
            subprocess.run(
                ["gitleaks", "dir", str(root / "dashboard"), "--config", str(ROOT / ".gitleaks.toml"),
                 "--no-banner", "--redact=100", "--report-format", "json", "--report-path", str(report)],
                check=False, capture_output=True, text=True,
            )
            return json.loads(report.read_text(encoding="utf-8")) if report.exists() else []

    def test_the_reviewed_value_passes_and_a_real_looking_secret_in_the_same_file_does_not(self):
        reviewed = 'const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";\n'
        self.assertEqual(self.scan("dashboard/auth.ts", reviewed), [], "the reviewed public client id stays allowed")
        stripe = "sk_live_" + alnum(24)
        findings = self.scan("dashboard/auth.ts", reviewed + f'const stripeLive = "{stripe}";\n')
        self.assertTrue(findings, "a Stripe live key pasted into an allowlisted file must still be found")

    def test_a_private_key_block_in_an_allowlisted_production_file_is_still_found(self):
        # Assembled from pieces so this file holds no private-key marker itself.
        begin, end = "-----BEGIN " + "RSA PRIVATE" + " KEY-----", "-----END " + "RSA PRIVATE" + " KEY-----"
        pem = begin + "\n" + "\n".join(alnum(64) for _ in range(6)) + "\n" + end + "\n"
        findings = self.scan("dashboard/src/lib/encryption-rotation.ts", pem)
        self.assertIn("private-key", {finding["RuleID"] for finding in findings})


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], "-v"])
