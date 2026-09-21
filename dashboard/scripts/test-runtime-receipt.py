#!/usr/bin/env python3
"""Executable tests for the guest runtime receipt; no host/package mutation."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parent.parent / "provisioner" / "hivra-runtime-receipt.py"
spec = importlib.util.spec_from_file_location("hivra_runtime_receipt", SOURCE)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class FixtureRunner:
    def __init__(self):
        self.calls = []

    def __call__(self, arguments, user=None):
        self.calls.append((arguments, user))
        joined = " ".join(arguments)
        if arguments[0] == "/usr/bin/dpkg-query":
            return (
                "zlib1g:amd64\t1:1.2.11.dfsg-2ubuntu9.2\tamd64\tzlib\t1:1.2.11.dfsg-2ubuntu9.2\tii \n"
                "bash\t5.1-6ubuntu1.1\tamd64\tbash\t5.1-6ubuntu1.1\tii \n"
            ).encode("ascii")
        if "rev-parse HEAD" in joined:
            return ("a" * 40 + "\n").encode("ascii") if "/opt/bux" in joined else None
        if "diff --no-ext-diff" in joined:
            return b"public installer diff\n"
        if "status --porcelain" in joined:
            return b" M install.sh\0"
        if arguments[0:2] == ["/usr/bin/systemctl", "show"] and arguments[-1] == "bux-hivra-chat.service":
            return b"LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
        if arguments[:3] == ["/usr/bin/docker", "image", "inspect"]:
            return json.dumps("sha256:" + "b" * 64).encode() + b"\t" + json.dumps(["agent0ai/agent-zero@sha256:" + "c" * 64]).encode() + b'\t"amd64"\t"linux"\n'
        versions = {
            "/usr/local/bin/cloudflared": b"cloudflared version 2026.8.2\n",
            "/usr/bin/claude": b"2.1.246\n",
            "/home/bux/.npm-global/bin/codex": b"codex-cli 0.149.1\n",
            "/usr/bin/node": b"v24.0.0\n",
        }
        return versions.get(arguments[0])


class RuntimeReceiptTest(unittest.TestCase):
    def test_native_dependency_inventory_is_explicit_and_excludes_credentials(self):
        package = self.root / "opt/hivra/deepseek-runtime/node_modules/@deepseek-ai/dsh"
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"name":"@deepseek-ai/dsh","version":"0.1.2-alpha.2","license":"MIT"}')
        (package / "LICENSE").write_text("synthetic license fixture")
        private = self.root / "home/bux/.hivra/deepseek/.dsh"
        private.mkdir(parents=True)
        (private / ".credentials.yaml").write_text("synthetic-never-read-secret")
        value = receipt.collect_receipt(provisioner_version="2026.08.31.2", agent_kind="deepseek-harness",
            substrate="provider-vm", browser_enabled=False, root=self.root, runner=FixtureRunner())
        native = [item for item in value["npmGlobalPackages"] if item["scope"] == "deepseek-native"]
        self.assertEqual([item["name"] for item in native], ["@deepseek-ai/dsh"])
        self.assertFalse(value["releaseApproved"])
        self.assertNotIn("synthetic-never-read-secret", json.dumps(value))
        self.assertTrue(any(item["name"] == "@deepseek-ai/dsh" for item in receipt.build_installed_sbom(value, "a" * 64)["components"]))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hivra-runtime-receipt-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        for path, value in {
            "usr/lib/os-release": 'ID=ubuntu\nVERSION_ID="22.04"\nBUILD_ID=20260807\n',
            "proc/sys/kernel/osrelease": "5.15.0-fixture\n",
            "usr/share/doc/bash/copyright": "GPL notice\n",
            "usr/share/doc/zlib1g/copyright": "zlib notice\n",
            "usr/lib/node_modules/@anthropic-ai/claude-code/package.json": '{"name":"@anthropic-ai/claude-code","version":"2.1.246","license":"SEE LICENSE IN README.md"}',
            "home/bux/.npm-global/lib/node_modules/@openai/codex/package.json": '{"name":"@openai/codex","version":"0.149.1","license":"Apache-2.0"}',
            "home/bux/.npm-global/lib/node_modules/@openai/codex/LICENSE": "Apache License 2.0\n",
            "home/bux/.npm-global/lib/node_modules/@openai/codex/node_modules/chalk/package.json": '{"name":"chalk","version":"5.6.2","license":"MIT"}',
            "home/bux/.npm-global/lib/node_modules/@openai/codex/node_modules/chalk/license": "MIT License\n",
            "opt/bux/hivra-chat/server.js": "public server\n",
            "etc/systemd/system/bux-hivra-chat.service": "[Service]\n",
        }.items():
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(value)
        (self.root / "etc").mkdir(parents=True, exist_ok=True)
        (self.root / "etc/os-release").symlink_to("../usr/lib/os-release")

    def test_collects_sorted_exact_state_without_environment_or_user_data(self):
        runner = FixtureRunner()
        value = receipt.collect_receipt(
            provisioner_version="2026.08.30.1",
            agent_kind="codex",
            substrate="provider-vm",
            browser_enabled=False,
            root=self.root,
            runner=runner,
        )
        self.assertFalse(value["releaseApproved"])
        self.assertEqual(value["host"]["operatingSystem"], {
            "ID": "ubuntu", "VERSION_ID": "22.04", "BUILD_ID": "20260807",
            "IMAGE_ID": None, "IMAGE_VERSION": None,
        })
        self.assertEqual([package["name"] for package in value["systemPackages"]], ["bash", "zlib1g:amd64"])
        self.assertTrue(all(package["copyrightSha256"] for package in value["systemPackages"]))
        self.assertEqual(
            [package["name"] for package in value["npmGlobalPackages"]],
            ["@openai/codex", "chalk", "@anthropic-ai/claude-code"],
        )
        self.assertEqual(value["schemaVersion"], 2)
        self.assertEqual(value["inventoryCompleteness"], {
            "npmGlobalPackages": "recursive-node-modules-v1",
            "systemPackages": "dpkg-installed-v1",
        })
        chalk = next(package for package in value["npmGlobalPackages"] if package["name"] == "chalk")
        self.assertEqual(
            chalk["installPath"],
            "/home/bux/.npm-global/lib/node_modules/@openai/codex/node_modules/chalk",
        )
        self.assertEqual(value["gitCheckouts"][0]["head"], "a" * 40)
        self.assertTrue(value["gitCheckouts"][0]["dirty"])
        self.assertEqual(value["services"][2], {"active": "active", "load": "loaded", "unit": "bux-hivra-chat.service", "unitFile": "enabled"})
        raw = receipt.encode(value).decode("ascii")
        for forbidden in ("TOKEN=", "PASSWORD=", "API_KEY=", ".browser-profile", ".codex/auth", "processEnvironment"):
            self.assertNotIn(forbidden, raw)
        self.assertEqual(receipt.encode(value), receipt.encode(receipt.collect_receipt(
            provisioner_version="2026.08.30.1", agent_kind="codex", substrate="provider-vm",
            browser_enabled=False, root=self.root, runner=FixtureRunner())))

    def test_builds_deterministic_installed_sbom_and_notice_manifest(self):
        value = receipt.collect_receipt(
            provisioner_version="2026.08.30.1", agent_kind="codex", substrate="provider-vm",
            browser_enabled=False, root=self.root, runner=FixtureRunner(),
        )
        digest = receipt.sha256(receipt.encode(value))
        sbom = receipt.build_installed_sbom(value, digest)
        self.assertEqual((sbom["bomFormat"], sbom["specVersion"], sbom["version"]), ("CycloneDX", "1.6", 1))
        purls = sorted(component["purl"] for component in sbom["components"] if "purl" in component)
        self.assertIn("pkg:deb/ubuntu/bash@5.1-6ubuntu1.1?arch=amd64&distro=ubuntu-22.04", purls)
        self.assertIn("pkg:npm/%40openai/codex@0.149.1", purls)
        self.assertEqual(
            next(prop["value"] for prop in sbom["metadata"]["component"]["properties"]
                 if prop["name"] == "hivra:source-receipt-sha256"),
            digest,
        )
        notice = receipt.build_notice_manifest(value, digest)
        self.assertFalse(notice["releaseApproved"])
        self.assertEqual(notice["sourceReceiptSha256"], digest)
        self.assertEqual(notice["summary"], {
            "npmPackageCount": 3,
            "npmPackagesWithoutDeclaredLicenseCount": 0,
            "npmPackagesWithoutLicenseFilesCount": 1,
            "systemPackageCount": 2,
            "systemPackagesMissingCopyrightCount": 0,
        })
        codex = next(package for package in notice["npmGlobalPackages"] if package["name"] == "@openai/codex")
        self.assertEqual(codex["licenseFiles"][0]["name"], "LICENSE")
        chalk = next(package for package in notice["npmGlobalPackages"] if package["name"] == "chalk")
        chalk_component = next(
            component for component in sbom["components"]
            if component.get("purl") == "pkg:npm/chalk@5.6.2"
        )
        self.assertIn(
            {"name": "hivra:npm:install-path", "value": chalk["installPath"]},
            chalk_component["properties"],
        )
        self.assertEqual(
            receipt.encode(sbom),
            receipt.encode(receipt.build_installed_sbom(value, digest)),
        )
        combined = receipt.encode(sbom) + receipt.encode(notice)
        for forbidden in (b"TOKEN=", b"PASSWORD=", b"API_KEY=", b"processEnvironment", b"commandLine"):
            self.assertNotIn(forbidden, combined)

    def test_records_only_the_selected_digest_bound_container_image(self):
        runner = FixtureRunner()
        image = "agent0ai/agent-zero@sha256:" + "c" * 64
        value = receipt.collect_receipt(
            provisioner_version="2026.08.30.1", agent_kind="agent-zero", substrate="proxmox-kvm",
            browser_enabled=False, agent_zero_image=image, root=self.root, runner=runner,
        )
        self.assertEqual(value["containerImages"], [{
            "architecture": "amd64", "id": "sha256:" + "b" * 64, "operatingSystem": "linux",
            "reference": image, "repoDigests": [image],
        }])
        docker_calls = [call for call in runner.calls if call[0][:3] == ["/usr/bin/docker", "image", "inspect"]]
        self.assertEqual(docker_calls[0][0][3], image)

    def test_fails_closed_on_missing_or_duplicate_package_inventory(self):
        with self.assertRaisesRegex(receipt.ReceiptError, "dpkg inventory unavailable"):
            receipt.parse_dpkg(None, self.root)
        duplicate = b"bash\t1\tamd64\tbash\t1\tii \nbash\t1\tamd64\tbash\t1\tii \n"
        with self.assertRaisesRegex(receipt.ReceiptError, "duplicate"):
            receipt.parse_dpkg(duplicate, self.root)

    def test_excludes_removed_packages_with_retained_configuration_from_the_installed_inventory(self):
        raw = (
            b"tcl8.6\t8.6.12+dfsg-1build1\tamd64\ttcl8.6\t8.6.12+dfsg-1build1\trc \n"
            b"bash\t5.1-6ubuntu1.1\tamd64\tbash\t5.1-6ubuntu1.1\tii \n"
        )
        self.assertEqual(
            [package["name"] for package in receipt.parse_dpkg(raw, self.root)],
            ["bash"],
        )
        with self.assertRaisesRegex(receipt.ReceiptError, "invalid dpkg inventory"):
            receipt.parse_dpkg(raw.replace(b"rc ", b"bad"), self.root)

    def test_recursive_npm_inventory_fails_closed_on_symlinked_packages(self):
        linked = self.root / "home/bux/.npm-global/lib/node_modules/linked-runtime"
        linked.symlink_to("@openai/codex", target_is_directory=True)
        with self.assertRaisesRegex(receipt.ReceiptError, "symlinked npm package"):
            receipt.package_json_records(
                self.root,
                "/home/bux/.npm-global/lib/node_modules",
                "agent-user",
            )

    def test_direct_access_refresh_preserves_package_evidence_and_requires_exact_active_install(self):
        runner = FixtureRunner()
        value = receipt.collect_receipt(provisioner_version="2026.08.30.2", agent_kind="codex",
            substrate="provider-vm", browser_enabled=False, root=self.root, runner=runner)
        output_dir = self.root / "var/lib/hivra"
        output_dir.mkdir(parents=True)
        receipt.write_runtime_evidence(value, output_dir)
        kwargs = dict(provisioner_version="2026.08.30.2", agent_kind="codex", substrate="provider-vm", root=self.root)
        with self.assertRaisesRegex(receipt.ReceiptError, "artifacts"):
            receipt.refresh_direct_access_evidence(**kwargs, runner=runner)
        for name in ("etc/hivra-direct-access.Caddyfile", "etc/systemd/system/hivra-direct-access.service"):
            (self.root / name).write_text("public access fixture\n")
        with self.assertRaisesRegex(receipt.ReceiptError, "not active"):
            receipt.refresh_direct_access_evidence(**kwargs, runner=runner)
        def active(arguments, user=None):
            if arguments[-1] == "hivra-direct-access.service":
                return b"LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
            return runner(arguments, user)
        refreshed = receipt.refresh_direct_access_evidence(**kwargs, runner=active)
        for key in ("systemPackages", "npmGlobalPackages", "containerImages", "gitCheckouts", "agent", "host"):
            self.assertEqual(refreshed[key], value[key])
        self.assertIn("/etc/hivra-direct-access.Caddyfile", [a["path"] for a in refreshed["artifacts"]])
        with self.assertRaisesRegex(receipt.ReceiptError, "does not match"):
            receipt.refresh_direct_access_evidence(**{**kwargs, "agent_kind": "claude"}, runner=active)
        (output_dir / "runtime-receipt.sha256").write_text("wrong\n")
        with self.assertRaisesRegex(receipt.ReceiptError, "checksum"):
            receipt.refresh_direct_access_evidence(**kwargs, runner=active)

    def test_atomic_private_receipt_and_checksum_are_byte_bound(self):
        output_dir = self.root / "var/lib/hivra"
        output_dir.mkdir(parents=True)
        output = output_dir / "runtime-receipt.json"
        checksum = output_dir / "runtime-receipt.sha256"
        digest = receipt.write_receipt({"schemaVersion": 1, "releaseApproved": False}, output, checksum)
        self.assertEqual(digest, receipt.sha256(output.read_bytes()))
        self.assertEqual(checksum.read_text(), f"{digest}  runtime-receipt.json\n")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(checksum.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(output_dir.glob(".runtime-evidence-*")), [])

    def test_writes_all_private_runtime_evidence_with_byte_bound_checksums(self):
        value = receipt.collect_receipt(
            provisioner_version="2026.08.30.1", agent_kind="codex", substrate="provider-vm",
            browser_enabled=False, root=self.root, runner=FixtureRunner(),
        )
        output_dir = self.root / "evidence"
        result = receipt.write_runtime_evidence(value, output_dir)
        expected = {
            "runtime-receipt.json", "runtime-receipt.sha256",
            "runtime-sbom.cdx.json", "runtime-sbom.sha256",
            "runtime-notice-manifest.json", "runtime-notice-manifest.sha256",
        }
        self.assertEqual({path.name for path in output_dir.iterdir()}, expected)
        for path in output_dir.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for artifact, checksum in (
            ("runtime-receipt.json", "runtime-receipt.sha256"),
            ("runtime-sbom.cdx.json", "runtime-sbom.sha256"),
            ("runtime-notice-manifest.json", "runtime-notice-manifest.sha256"),
        ):
            digest = receipt.sha256((output_dir / artifact).read_bytes())
            self.assertEqual((output_dir / checksum).read_text(), f"{digest}  {artifact}\n")
        self.assertEqual(result["receiptSha256"], receipt.sha256((output_dir / "runtime-receipt.json").read_bytes()))
        self.assertGreater(result["sbomComponentCount"], 0)
        self.assertEqual(json.loads((output_dir / "runtime-notice-manifest.json").read_text())["sourceReceiptSha256"], result["receiptSha256"])

    def test_argument_contract_rejects_unpinned_images_and_cross_kind_image_input(self):
        with patch("sys.argv", ["receipt", "--provisioner-version", "latest", "--agent-kind", "codex",
                                "--substrate", "provider-vm", "--browser-enabled", "0"]):
            with self.assertRaisesRegex(receipt.ReceiptError, "provisioner version"):
                receipt.arguments()
        with patch("sys.argv", ["receipt", "--provisioner-version", "2026.08.30.1", "--agent-kind", "codex",
                                "--substrate", "provider-vm", "--browser-enabled", "0",
                                "--agent-zero-image", "agent0ai/agent-zero:latest"]):
            with self.assertRaisesRegex(receipt.ReceiptError, "unexpected container image"):
                receipt.arguments()

    def test_argument_contract_accepts_linux_desktop_without_an_agent_image(self):
        with patch("sys.argv", ["receipt", "--provisioner-version", "2026.09.02.8", "--agent-kind", "linux-desktop",
                                "--substrate", "proxmox-kvm", "--browser-enabled", "0"]):
            value = receipt.arguments()
        self.assertEqual(value.agent_kind, "linux-desktop")
        self.assertIsNone(value.agent_zero_image)


if __name__ == "__main__":
    unittest.main()
