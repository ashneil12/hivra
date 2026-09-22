#!/usr/bin/env python3
"""Write a private, deterministic receipt for one installed Hivra computer.

The receipt contains package and artifact identities, never credentials, process
environments, command lines, user files, browser profiles, or agent state. It is
evidence of observed guest state, not a redistribution or release approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tempfile
from typing import Callable
from urllib.parse import quote


OUTPUT = Path("/var/lib/hivra/runtime-receipt.json")
CHECKSUM = Path("/var/lib/hivra/runtime-receipt.sha256")
SBOM_OUTPUT = Path("/var/lib/hivra/runtime-sbom.cdx.json")
SBOM_CHECKSUM = Path("/var/lib/hivra/runtime-sbom.sha256")
NOTICE_OUTPUT = Path("/var/lib/hivra/runtime-notice-manifest.json")
NOTICE_CHECKSUM = Path("/var/lib/hivra/runtime-notice-manifest.sha256")
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
MAX_COMMAND_OUTPUT = 16 * 1024 * 1024
VERSION = re.compile(r"20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
PACKAGE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9+.-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?")
MAX_NPM_PACKAGES = 20_000


class ReceiptError(Exception):
    pass


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def encode(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"


def read_regular(path: Path, limit: int = 32 * 1024 * 1024) -> bytes | None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except (FileNotFoundError, NotADirectoryError, OSError):
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return None
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        return raw if len(raw) <= limit else None
    finally:
        os.close(descriptor)


def rooted(root: Path, absolute: str) -> Path:
    if not absolute.startswith("/") or ".." in Path(absolute).parts:
        raise ReceiptError("invalid receipt path")
    return root / absolute.lstrip("/")


def default_runner(arguments: list[str], user: str | None = None) -> bytes | None:
    command = arguments
    if user is not None:
        command = ["/usr/sbin/runuser", "-u", user, "--", *arguments]
    try:
        result = subprocess.run(
            command,
            env=ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0 or len(result.stdout) > MAX_COMMAND_OUTPUT:
        return None
    return result.stdout


def parse_os_release(raw: bytes | None) -> dict[str, str | None]:
    values: dict[str, str] = {}
    if raw is not None:
        for line in raw.decode("utf-8", "replace").splitlines():
            if "=" not in line or line.startswith("#"):
                continue
            key, value = line.split("=", 1)
            if re.fullmatch(r"[A-Z0-9_]+", key):
                values[key] = value.strip().strip('"')[:256]
    return {key: values.get(key) for key in ("ID", "VERSION_ID", "BUILD_ID", "IMAGE_ID", "IMAGE_VERSION")}


def parse_dpkg(raw: bytes | None, root: Path) -> list[dict[str, str | None]]:
    if raw is None:
        raise ReceiptError("dpkg inventory unavailable")
    packages: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for line in raw.decode("utf-8", "strict").splitlines():
        fields = line.split("\t")
        if len(fields) != 6:
            raise ReceiptError("invalid dpkg inventory")
        name, version, architecture, source_name, source_version, status = fields
        if not re.fullmatch(r"[uihrp][ncHUFWti][ R]", status):
            raise ReceiptError("invalid dpkg inventory")
        # `dpkg-query -W` includes packages whose payload has been removed but
        # whose configuration files remain (`rc `). They are not installed
        # runtime components and must not make an otherwise healthy, freshly
        # provisioned Ubuntu image fail its evidence gate. Validate every row,
        # then inventory only the fully installed `ii ` set.
        if status != "ii ":
            continue
        if not PACKAGE_NAME.fullmatch(name) or not version or not architecture:
            raise ReceiptError("invalid dpkg inventory")
        if name in seen:
            raise ReceiptError("duplicate dpkg package")
        seen.add(name)
        copyright_name = name.split(":", 1)[0]
        copyright_raw = read_regular(rooted(root, f"/usr/share/doc/{copyright_name}/copyright"))
        packages.append({
            "architecture": architecture,
            "copyrightSha256": sha256(copyright_raw) if copyright_raw is not None else None,
            "name": name,
            "sourceName": source_name or None,
            "sourceVersion": source_version or None,
            "version": version,
        })
    return sorted(packages, key=lambda package: (package["name"] or "", package["architecture"] or ""))


def npm_package_directories(directory: Path) -> list[Path]:
    packages: list[Path] = []
    try:
        children = sorted(directory.iterdir(), key=lambda path: path.name)
    except OSError as error:
        raise ReceiptError("npm package inventory unavailable") from error
    for child in children:
        if child.name.startswith("."):
            continue
        if child.is_symlink():
            raise ReceiptError("symlinked npm package inventory is unsupported")
        if not child.is_dir():
            continue
        if child.name.startswith("@"):
            try:
                scoped = sorted(child.iterdir(), key=lambda path: path.name)
            except OSError as error:
                raise ReceiptError("scoped npm package inventory unavailable") from error
            for package in scoped:
                if package.name.startswith("."):
                    continue
                if package.is_symlink():
                    raise ReceiptError("symlinked npm package inventory is unsupported")
                if package.is_dir():
                    packages.append(package)
        else:
            packages.append(child)
    return packages


def package_json_records(root: Path, absolute: str, scope: str) -> list[dict[str, object]]:
    directory = rooted(root, absolute)
    if not directory.is_dir() or directory.is_symlink():
        return []
    pending = [directory]
    package_directories: list[Path] = []
    while pending:
        node_modules = pending.pop()
        for package in npm_package_directories(node_modules):
            package_directories.append(package)
            if len(package_directories) > MAX_NPM_PACKAGES:
                raise ReceiptError("npm package inventory exceeds the safety limit")
            nested = package / "node_modules"
            if nested.is_symlink():
                raise ReceiptError("symlinked npm dependency inventory is unsupported")
            if nested.is_dir():
                pending.append(nested)
    records = []
    for package_directory in sorted(package_directories, key=lambda value: value.as_posix()):
        manifest = package_directory / "package.json"
        raw = read_regular(manifest, 4 * 1024 * 1024)
        if raw is None:
            raise ReceiptError("npm package manifest unavailable")
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ReceiptError("invalid npm package manifest")
        name, version, license_value = value.get("name"), value.get("version"), value.get("license")
        if not isinstance(name, str) or not isinstance(version, str):
            raise ReceiptError("npm package identity unavailable")
        license_files = []
        try:
            candidates = sorted(manifest.parent.iterdir(), key=lambda path: path.name.lower())
        except OSError:
            candidates = []
        for candidate in candidates:
            normalized = candidate.name.upper()
            if not (normalized == "COPYING" or normalized.startswith("LICENSE") or normalized.startswith("NOTICE")):
                continue
            license_raw = read_regular(candidate, 4 * 1024 * 1024)
            if license_raw is not None:
                license_files.append({"name": candidate.name[:256], "sha256": sha256(license_raw), "size": len(license_raw)})
        records.append({
            "declaredLicense": license_value if isinstance(license_value, str) else None,
            "installPath": f"/{package_directory.relative_to(root).as_posix()}",
            "licenseFiles": license_files,
            "name": name[:512],
            "packageJsonSha256": sha256(raw),
            "scope": scope,
            "version": version[:256],
        })
    return sorted(records, key=lambda package: (
        package["scope"] or "", package["name"] or "", package["version"] or "", package["installPath"] or "",
    ))


def first_line(raw: bytes | None) -> str | None:
    if raw is None:
        return None
    line = raw.decode("utf-8", "replace").splitlines()[0].strip() if raw else ""
    return line[:512] or None


def git_record(path: str, user: str | None, runner: Callable[[list[str], str | None], bytes | None]) -> dict[str, object] | None:
    head = first_line(runner(["/usr/bin/git", "-C", path, "rev-parse", "HEAD"], user))
    if head is None or not re.fullmatch(r"[0-9a-f]{40}", head):
        return None
    diff = runner(["/usr/bin/git", "-C", path, "diff", "--no-ext-diff", "--binary", "HEAD"], user)
    status_raw = runner(["/usr/bin/git", "-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], user)
    if diff is None or status_raw is None:
        return None
    return {
        "diffSha256": sha256(diff),
        "dirty": bool(status_raw),
        "head": head,
        "path": path,
        "statusSha256": sha256(status_raw),
    }


def artifact_records(root: Path) -> list[dict[str, object]]:
    paths = [
        "/etc/systemd/system/bux-hivra-chat.service",
        "/etc/systemd/system/bux-box-ttyd.service",
        "/etc/systemd/system/hivra-direct-access.service",
        "/etc/hivra-direct-access.Caddyfile",
        "/opt/bux/hivra-chat/app.js",
        "/opt/bux/hivra-chat/index.html",
        "/opt/bux/hivra-chat/llm-application.js",
        "/opt/bux/hivra-chat/guarded-files.cjs",
        "/opt/bux/hivra-chat/agent-zero-editor.cjs",
        "/opt/bux/hivra-chat/server.js",
        "/usr/local/bin/hivra-agent-shell",
        "/usr/share/doc/hivra-caddy/LICENSE",
        # The agent-run reporter (/opt/hivra/agent-trace, hivra-agent-trace.service)
        # is deliberately absent: this receipt is collected inside the runtime
        # bootstrap, before the fail-open reporter install at launch and on every
        # start, so any record of it here would describe a stale or pre-install
        # state. Its evidence is the control plane's install marker and heartbeats.
        "/etc/hivra/deepseek-native.json",
        "/etc/hivra/deepseek-install.json",
        "/opt/hivra/deepseek-runtime/package.json",
        "/opt/hivra/deepseek-runtime/package-lock.json",
        "/opt/hivra/deepseek-runtime/.hivra-native-install.json",
        *["/opt/hivra/deepseek-gateway/" + name for name in
          ("server.js", "llm-application.js", "guarded-files.cjs", "agent-zero-editor.cjs", "index.html", "app.js",
           "deepseek-harness/native-broker.cjs", "deepseek-harness/gateway-policy.cjs", "deepseek-harness/runtime-process.cjs")],
    ]
    records = []
    for absolute in paths:
        path = rooted(root, absolute)
        raw = read_regular(path)
        if raw is None:
            continue
        info = os.stat(path, follow_symlinks=False)
        records.append({"mode": stat.S_IMODE(info.st_mode), "path": absolute, "sha256": sha256(raw), "size": len(raw)})
    return records


def service_records(runner: Callable[[list[str], str | None], bytes | None]) -> list[dict[str, str]]:
    units = [
        "bux-aeon.service", "bux-box-ttyd.service", "bux-hivra-chat.service",
        "bux-local-browser.service", "bux-openclaw.service", "bux-ttyd.service",
        "hivra-direct-access.service",
        "hivra-agent-zero.service", "hivra-novnc.service", "hivra-x11vnc.service", "hivra-xvfb.service",
    ]
    records = []
    for unit in units:
        raw = runner(["/usr/bin/systemctl", "show", "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", unit])
        values = {"ActiveState": "unknown", "LoadState": "unknown", "UnitFileState": "unknown"}
        if raw is not None:
            pairs = [line.split("=", 1) for line in raw.decode("utf-8", "replace").splitlines()]
            if all(len(pair) == 2 for pair in pairs):
                values.update({key: value[:128] for key, value in pairs if key in values})
        records.append({"active": values["ActiveState"], "load": values["LoadState"],
                        "unit": unit, "unitFile": values["UnitFileState"]})
    return records


def container_record(image: str | None, runner: Callable[[list[str], str | None], bytes | None]) -> dict[str, object] | None:
    if image is None:
        return None
    raw = runner(["/usr/bin/docker", "image", "inspect", image, "--format", "{{json .Id}}\t{{json .RepoDigests}}\t{{json .Architecture}}\t{{json .Os}}"])
    if raw is None:
        raise ReceiptError("selected container image inventory unavailable")
    fields = raw.decode("utf-8", "strict").strip().split("\t")
    if len(fields) != 4:
        raise ReceiptError("invalid container image inventory")
    image_id, repo_digests, architecture, operating_system = (json.loads(field) for field in fields)
    if not isinstance(image_id, str) or not DIGEST.fullmatch(image_id) or not isinstance(repo_digests, list):
        raise ReceiptError("invalid container image identity")
    return {"architecture": architecture, "id": image_id, "operatingSystem": operating_system,
            "reference": image, "repoDigests": sorted(value for value in repo_digests if isinstance(value, str))}


def collect_receipt(
    *, provisioner_version: str, agent_kind: str, substrate: str, browser_enabled: bool,
    agent_zero_image: str | None = None, root: Path = Path("/"),
    runner: Callable[[list[str], str | None], bytes | None] = default_runner,
) -> dict[str, object]:
    dpkg = runner(["/usr/bin/dpkg-query", "-W", "-f=${binary:Package}\\t${Version}\\t${Architecture}\\t${source:Package}\\t${source:Version}\\t${db:Status-Abbrev}\\n"])
    packages = parse_dpkg(dpkg, root)
    binaries = []
    for name, arguments, user in [
        ("caddy", ["/usr/local/bin/caddy", "version"], None),
        ("cloudflared", ["/usr/local/bin/cloudflared", "--version"], None),
        ("claude", ["/usr/bin/claude", "--version"], None),
        ("codex", ["/home/bux/.npm-global/bin/codex", "--version"], "bux"),
        ("docker", ["/usr/bin/docker", "--version"], None),
        ("gh", ["/usr/bin/gh", "--version"], None),
        ("google-chrome", ["/usr/bin/google-chrome", "--version"], None),
        ("node", ["/usr/bin/node", "--version"], None),
        ("npm", ["/usr/bin/npm", "--version"], None),
        ("openclaw", ["/home/bux/.npm-global/bin/openclaw", "--version"], "bux"),
        ("ttyd", ["/usr/local/bin/ttyd", "--version"], None),
    ]:
        binaries.append({"name": name, "versionOutput": first_line(runner(arguments, user))})
    def checkout_user(absolute: str) -> str | None:
        try:
            return None if os.stat(rooted(root, absolute), follow_symlinks=False).st_uid == 0 else "bux"
        except (FileNotFoundError, NotADirectoryError, OSError):
            return "bux"
    git_checkouts = [record for record in (
        git_record("/opt/bux", checkout_user("/opt/bux"), runner),
        git_record("/home/bux/aeon", checkout_user("/home/bux/aeon"), runner),
    ) if record is not None]
    npm_packages = package_json_records(root, "/usr/lib/node_modules", "system")
    npm_packages.extend(package_json_records(root, "/home/bux/.npm-global/lib/node_modules", "agent-user"))
    if agent_kind == "deepseek-harness":
        # Legacy field name retained for receipt/SBOM compatibility; explicit
        # scope distinguishes the non-global immutable native dependency tree.
        npm_packages.extend(package_json_records(root, "/opt/hivra/deepseek-runtime/node_modules", "deepseek-native"))
    npm_packages.sort(key=lambda package: (
        package["scope"] or "", package["name"] or "", package["version"] or "", package["installPath"] or "",
    ))
    kernel_raw = read_regular(rooted(root, "/proc/sys/kernel/osrelease"), 4096)
    # /etc/os-release is normally a symlink on Ubuntu. Keep read_regular's
    # no-follow safety guarantee by reading the canonical regular file first;
    # the /etc path remains a compatibility fallback for distributions that
    # install it as a regular file.
    os_release_raw = read_regular(rooted(root, "/usr/lib/os-release"), 64 * 1024)
    if os_release_raw is None:
        os_release_raw = read_regular(rooted(root, "/etc/os-release"), 64 * 1024)
    receipt: dict[str, object] = {
        "agent": {"browserEnabled": browser_enabled, "kind": agent_kind},
        "artifacts": artifact_records(root),
        "binaries": binaries,
        "containerImages": [record for record in [container_record(agent_zero_image, runner)] if record is not None],
        "gaps": [
            "debian-copyright-files-are-hashed-but-license-and-source-obligations-require-review",
            "recursive-npm-artifact-identities-and-license-file-hashes-still-require-release-review",
            "receipt-is-installed-state-evidence-not-a-vulnerability-scan-or-release-approval",
        ],
        "gitCheckouts": sorted(git_checkouts, key=lambda record: str(record["path"])),
        "host": {
            "architecture": platform.machine(),
            "kernelRelease": kernel_raw.decode("utf-8", "replace").strip()[:256] if kernel_raw else None,
            "operatingSystem": parse_os_release(os_release_raw),
            "substrate": substrate,
        },
        "npmGlobalPackages": npm_packages,
        "inventoryCompleteness": {
            "npmGlobalPackages": "recursive-node-modules-v1",
            "systemPackages": "dpkg-installed-v1",
        },
        "provisionerVersion": provisioner_version,
        "releaseApproved": False,
        "schemaVersion": 2,
        "services": service_records(runner),
        "systemPackages": packages,
    }
    return receipt


def component_ref(kind: str, *identity: object) -> str:
    raw = encode([kind, *identity])
    return f"urn:hivra:component:{sha256(raw)}"


def purl_part(value: object) -> str:
    return quote(str(value), safe="")


def npm_purl(name: str, version: str) -> str:
    if name.startswith("@") and "/" in name:
        namespace, package_name = name.split("/", 1)
        return f"pkg:npm/{purl_part(namespace)}/{purl_part(package_name)}@{purl_part(version)}"
    return f"pkg:npm/{purl_part(name)}@{purl_part(version)}"


def build_installed_sbom(receipt: dict[str, object], receipt_digest: str) -> dict[str, object]:
    host = receipt["host"]
    agent = receipt["agent"]
    if not isinstance(host, dict) or not isinstance(agent, dict):
        raise ReceiptError("invalid receipt identity for SBOM")
    operating_system = host.get("operatingSystem")
    if not isinstance(operating_system, dict):
        raise ReceiptError("invalid operating system identity for SBOM")
    os_id = str(operating_system.get("ID") or "unknown")
    os_version = str(operating_system.get("VERSION_ID") or "unknown")
    components: list[dict[str, object]] = []

    for package in receipt["systemPackages"]:
        if not isinstance(package, dict):
            raise ReceiptError("invalid system package for SBOM")
        binary_name = str(package["name"])
        architecture = str(package["architecture"])
        name = binary_name.rsplit(":", 1)[0] if binary_name.endswith(f":{architecture}") else binary_name
        version = str(package["version"])
        purl = (
            f"pkg:deb/{purl_part(os_id)}/{purl_part(name)}@{purl_part(version)}"
            f"?arch={purl_part(architecture)}&distro={purl_part(f'{os_id}-{os_version}')}"
        )
        properties = []
        for key, property_name in (("sourceName", "hivra:deb:source-name"), ("sourceVersion", "hivra:deb:source-version")):
            if package.get(key) is not None:
                properties.append({"name": property_name, "value": str(package[key])})
        components.append({
            "bom-ref": component_ref("deb", binary_name, version, architecture),
            "name": name,
            "properties": properties,
            "purl": purl,
            "type": "library",
            "version": version,
        })

    for package in receipt["npmGlobalPackages"]:
        if not isinstance(package, dict):
            raise ReceiptError("invalid npm package for SBOM")
        name, version, install_path = str(package["name"]), str(package["version"]), str(package["installPath"])
        component: dict[str, object] = {
            "bom-ref": component_ref("npm", package.get("scope"), name, version, install_path),
            "hashes": [{"alg": "SHA-256", "content": str(package["packageJsonSha256"])}],
            "name": name,
            "properties": [
                {"name": "hivra:npm:install-path", "value": install_path},
                {"name": "hivra:npm:install-scope", "value": str(package["scope"])},
            ],
            "purl": npm_purl(name, version),
            "type": "library",
            "version": version,
        }
        if package.get("declaredLicense") is not None:
            component["licenses"] = [{"license": {"name": str(package["declaredLicense"])}}]
        components.append(component)

    for checkout in receipt["gitCheckouts"]:
        if not isinstance(checkout, dict):
            raise ReceiptError("invalid git checkout for SBOM")
        path, head = str(checkout["path"]), str(checkout["head"])
        components.append({
            "bom-ref": component_ref("git", path, head),
            "name": path,
            "properties": [
                {"name": "hivra:git:dirty", "value": str(bool(checkout["dirty"])).lower()},
                {"name": "hivra:git:diff-sha256", "value": str(checkout["diffSha256"])},
                {"name": "hivra:git:status-sha256", "value": str(checkout["statusSha256"])},
            ],
            "type": "application",
            "version": head,
        })

    for image in receipt["containerImages"]:
        if not isinstance(image, dict):
            raise ReceiptError("invalid container image for SBOM")
        image_id, reference = str(image["id"]), str(image["reference"])
        components.append({
            "bom-ref": component_ref("container", reference, image_id),
            "hashes": [{"alg": "SHA-256", "content": image_id.removeprefix("sha256:")}],
            "name": reference.split("@", 1)[0],
            "properties": [
                {"name": "hivra:container:reference", "value": reference},
                {"name": "hivra:container:repo-digests", "value": ",".join(str(value) for value in image["repoDigests"])},
            ],
            "type": "container",
            "version": image_id,
        })

    for artifact in receipt["artifacts"]:
        if not isinstance(artifact, dict):
            raise ReceiptError("invalid Hivra artifact for SBOM")
        path, digest = str(artifact["path"]), str(artifact["sha256"])
        components.append({
            "bom-ref": component_ref("artifact", path, digest),
            "hashes": [{"alg": "SHA-256", "content": digest}],
            "name": path,
            "properties": [
                {"name": "hivra:file:mode", "value": str(artifact["mode"])},
                {"name": "hivra:file:size", "value": str(artifact["size"])},
            ],
            "type": "file",
        })

    for binary in receipt["binaries"]:
        if not isinstance(binary, dict):
            raise ReceiptError("invalid binary for SBOM")
        name = str(binary["name"])
        component = {
            "bom-ref": component_ref("binary", name, binary.get("versionOutput")),
            "name": name,
            "type": "application",
        }
        if binary.get("versionOutput") is not None:
            component["version"] = str(binary["versionOutput"])
        components.append(component)

    components.sort(key=lambda component: str(component["bom-ref"]))
    return {
        "bomFormat": "CycloneDX",
        "components": components,
        "metadata": {
            "component": {
                "bom-ref": component_ref("hivra-agent-computer", receipt["provisionerVersion"], receipt_digest),
                "name": "hivra-agent-computer",
                "properties": [
                    {"name": "hivra:agent:kind", "value": str(agent.get("kind"))},
                    {"name": "hivra:agent:browser-enabled", "value": str(bool(agent.get("browserEnabled"))).lower()},
                    {"name": "hivra:host:substrate", "value": str(host.get("substrate"))},
                    {"name": "hivra:host:operating-system", "value": f"{os_id}-{os_version}"},
                    {"name": "hivra:source-receipt-sha256", "value": receipt_digest},
                    {"name": "hivra:release-approved", "value": "false"},
                ],
                "type": "application",
                "version": str(receipt["provisionerVersion"]),
            }
        },
        "specVersion": "1.6",
        "version": 1,
    }


def build_notice_manifest(receipt: dict[str, object], receipt_digest: str) -> dict[str, object]:
    system_packages = receipt["systemPackages"]
    npm_packages = receipt["npmGlobalPackages"]
    if not isinstance(system_packages, list) or not isinstance(npm_packages, list):
        raise ReceiptError("invalid package inventory for notice manifest")
    missing_copyright = sum(
        1 for package in system_packages
        if not isinstance(package, dict) or package.get("copyrightSha256") is None
    )
    missing_declared_license = sum(
        1 for package in npm_packages
        if not isinstance(package, dict) or package.get("declaredLicense") is None
    )
    missing_license_files = sum(
        1 for package in npm_packages
        if not isinstance(package, dict) or not package.get("licenseFiles")
    )
    return {
        "artifacts": receipt["artifacts"],
        "containerImages": receipt["containerImages"],
        "format": "hivra-installed-runtime-notice-manifest-v1",
        "gaps": receipt["gaps"],
        "gitCheckouts": receipt["gitCheckouts"],
        "npmGlobalPackages": npm_packages,
        "releaseApproved": False,
        "schemaVersion": 1,
        "sourceReceiptSha256": receipt_digest,
        "summary": {
            "npmPackageCount": len(npm_packages),
            "npmPackagesWithoutDeclaredLicenseCount": missing_declared_license,
            "npmPackagesWithoutLicenseFilesCount": missing_license_files,
            "systemPackageCount": len(system_packages),
            "systemPackagesMissingCopyrightCount": missing_copyright,
        },
        "systemPackages": system_packages,
    }


def write_private_files(files: list[tuple[Path, bytes]]) -> None:
    if not files or len({destination for destination, _ in files}) != len(files):
        raise ReceiptError("invalid private evidence destinations")
    parent = files[0][0].parent
    if any(destination.parent != parent or not destination.name for destination, _ in files):
        raise ReceiptError("invalid private evidence destinations")
    parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    parent_info = os.lstat(parent)
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid() or parent_info.st_mode & 0o022:
        raise ReceiptError("unsafe receipt directory")
    pending: list[str] = []
    try:
        for destination, value in files:
            descriptor, temporary = tempfile.mkstemp(prefix=".runtime-evidence-", dir=parent)
            pending.append(temporary)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
        for (destination, _), temporary in zip(files, pending.copy()):
            os.replace(temporary, destination)
            pending.remove(temporary)
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        for temporary in pending:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def write_receipt(receipt: dict[str, object], output: Path = OUTPUT, checksum: Path = CHECKSUM) -> str:
    if output.parent != checksum.parent or output.name == checksum.name:
        raise ReceiptError("invalid receipt destinations")
    raw = encode(receipt)
    digest = sha256(raw)
    checksum_raw = f"{digest}  {output.name}\n".encode("ascii")
    write_private_files([(output, raw), (checksum, checksum_raw)])
    return digest


def write_runtime_evidence(receipt: dict[str, object], directory: Path = OUTPUT.parent) -> dict[str, object]:
    receipt_raw = encode(receipt)
    receipt_digest = sha256(receipt_raw)
    sbom = build_installed_sbom(receipt, receipt_digest)
    sbom_raw = encode(sbom)
    notice_raw = encode(build_notice_manifest(receipt, receipt_digest))
    sbom_digest, notice_digest = sha256(sbom_raw), sha256(notice_raw)
    destinations = [
        (directory / OUTPUT.name, receipt_raw),
        (directory / CHECKSUM.name, f"{receipt_digest}  {OUTPUT.name}\n".encode("ascii")),
        (directory / SBOM_OUTPUT.name, sbom_raw),
        (directory / SBOM_CHECKSUM.name, f"{sbom_digest}  {SBOM_OUTPUT.name}\n".encode("ascii")),
        (directory / NOTICE_OUTPUT.name, notice_raw),
        (directory / NOTICE_CHECKSUM.name, f"{notice_digest}  {NOTICE_OUTPUT.name}\n".encode("ascii")),
    ]
    write_private_files(destinations)
    return {
        "noticeSha256": notice_digest,
        "receiptSha256": receipt_digest,
        "sbomComponentCount": len(sbom["components"]),
        "sbomSha256": sbom_digest,
    }


def refresh_direct_access_evidence(*, provisioner_version: str, agent_kind: str, substrate: str,
                                  root: Path = Path("/"), runner=default_runner) -> dict[str, object]:
    """Bind newly configured access to the immediately preceding install receipt.

    No package/user state is changed between collection and access setup. Keep
    all package/image provenance intact and refresh only public Hivra artifacts
    and service observations. A corrupt or different receipt is not adopted.
    """
    raw = read_regular(rooted(root, str(OUTPUT)))
    checksum = read_regular(rooted(root, str(CHECKSUM)), 256)
    if raw is None or checksum != f"{sha256(raw)}  {OUTPUT.name}\n".encode("ascii"):
        raise ReceiptError("preceding runtime receipt checksum is unavailable")
    try:
        value = json.loads(raw)
        if (value["schemaVersion"] != 2 or value["provisionerVersion"] != provisioner_version
                or value["agent"]["kind"] != agent_kind or value["host"]["substrate"] != substrate
                or substrate != "provider-vm" or value["releaseApproved"] is not False):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ReceiptError("preceding runtime receipt does not match this install") from None
    value["artifacts"] = artifact_records(root)
    value["services"] = service_records(runner)
    paths = {record["path"] for record in value["artifacts"]}
    if not {"/etc/hivra-direct-access.Caddyfile", "/etc/systemd/system/hivra-direct-access.service"} <= paths:
        raise ReceiptError("direct-access artifacts are unavailable")
    if not any(service["unit"] == "hivra-direct-access.service" and service["active"] == "active"
               and service["load"] == "loaded" for service in value["services"]):
        raise ReceiptError("direct-access service is not active")
    return value


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--provisioner-version", required=True)
    parser.add_argument("--agent-kind", choices=("claude", "codex", "aeon", "openclaw", "agent-zero", "deepseek-harness", "linux-desktop"), required=True)
    parser.add_argument("--substrate", choices=("proxmox-kvm", "provider-vm"), required=True)
    parser.add_argument("--browser-enabled", choices=("0", "1"))
    parser.add_argument("--agent-zero-image")
    parser.add_argument("--refresh-direct-access", action="store_true")
    value = parser.parse_args()
    if not VERSION.fullmatch(value.provisioner_version):
        raise ReceiptError("invalid provisioner version")
    if value.refresh_direct_access:
        if value.substrate != "provider-vm" or value.browser_enabled is not None or value.agent_zero_image is not None:
            raise ReceiptError("invalid direct-access refresh")
    elif value.browser_enabled is None:
        raise ReceiptError("browser selection is required")
    elif value.agent_kind == "agent-zero":
        if not isinstance(value.agent_zero_image, str) or "@" not in value.agent_zero_image or not DIGEST.fullmatch(value.agent_zero_image.rsplit("@", 1)[1]):
            raise ReceiptError("invalid selected container image")
    elif value.agent_zero_image is not None:
        raise ReceiptError("unexpected container image")
    return value


def main() -> int:
    if os.geteuid() != 0:
        raise ReceiptError("runtime receipt requires root")
    value = arguments()
    receipt = refresh_direct_access_evidence(
        provisioner_version=value.provisioner_version, agent_kind=value.agent_kind, substrate=value.substrate,
    ) if value.refresh_direct_access else collect_receipt(
        provisioner_version=value.provisioner_version,
        agent_kind=value.agent_kind,
        substrate=value.substrate,
        browser_enabled=value.browser_enabled == "1",
        agent_zero_image=value.agent_zero_image,
    )
    evidence = write_runtime_evidence(receipt)
    print(
        f"HIVRA_RUNTIME_RECEIPT_V1 sha256={evidence['receiptSha256']} "
        f"packages={len(receipt['systemPackages'])} sbomSha256={evidence['sbomSha256']} "
        f"sbomComponents={evidence['sbomComponentCount']} noticeSha256={evidence['noticeSha256']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReceiptError as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(1)
