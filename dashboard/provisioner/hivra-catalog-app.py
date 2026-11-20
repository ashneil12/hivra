#!/usr/bin/env python3
"""Generic guest installer and validator for declarative Hivra catalog apps.

Supports two universal runtime shapes on an isolated Hivra computer:
  - docker-web: pulls an official upstream OCI image, pins its @sha256 digest,
    runs it bound strictly to 127.0.0.1:<hostPort>:<containerPort> with named
    volumes and no-new-privileges, behind Hivra's authenticated gateway (/app/).
  - cli-web: installs an official upstream CLI via uv-tool, npm-global, or a
    GitHub release archive (safe extraction, no arbitrary shell commands), and
    wires either a loopback web systemd unit (bux-catalog-app.service) or
    HivraChat's generic CLI adapter (~/.hivra/agent-cmd.json).

All inputs are strictly validated; zero shell interpolation is used when
invoking package managers, Docker, or systemd.
"""
import argparse
import io
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,38}[a-z0-9]$")
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
IMAGE_REPO_RE = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?(?::[0-9]{2,5})?/)?"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}$"
)
IMAGE_TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEALTH_PATH_RE = re.compile(r"^/[A-Za-z0-9._~/-]{0,120}$")
VOLUME_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MOUNT_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,120}$")
PACKAGE_NAME_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]{0,63}/)?[a-z0-9][a-z0-9._-]{0,99}$")
BIN_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
GITHUB_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RELEASE_ASSET_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}\.(?:tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$")
SAFE_ARG_RE = re.compile(r"^[A-Za-z0-9._:/=,@+-]{1,128}$")
SEMVER_RE = re.compile(r"\b(\d{1,6}\.\d{1,6}\.\d{1,6})\b")

PORT_MIN = 3200
PORT_MAX = 3999
MAX_SPEC_BYTES = 16384
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

FORBIDDEN_MOUNT_PREFIXES = (
    "/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/bin", "/sbin", "/usr", "/lib",
)

METADATA_PATH = Path(os.environ.get("HIVRA_CATALOG_APP_META", "/etc/hivra/catalog-app.json"))
DOCKER_ENV_PATH = Path(os.environ.get("HIVRA_CATALOG_APP_ENV", "/etc/hivra/catalog-app.env"))
APP_ROOT = Path(os.environ.get("HIVRA_CATALOG_APP_ROOT", "/opt/hivra-app"))
RECORD_PATH = Path(os.environ.get("HIVRA_AGENT_APP_RECORD", "/var/lib/hivra/agent-app.json"))
AGENT_USER = os.environ.get("HIVRA_AGENT_USER", "bux")
AGENT_HOME = Path(os.environ.get("HIVRA_AGENT_HOME", "/home/bux"))


class CatalogAppError(Exception):
    pass


def _printable_str(value, max_len=512):
    if not isinstance(value, str) or len(value.encode("utf-8")) > max_len:
        return False
    return all(ord(ch) >= 32 and ord(ch) != 127 for ch in value)


def _safe_health_path(value):
    if not isinstance(value, str) or not HEALTH_PATH_RE.fullmatch(value):
        return False
    return all(part not in (".", "..") for part in value.split("/"))


def _safe_mount_path(value):
    if not isinstance(value, str) or not MOUNT_PATH_RE.fullmatch(value) or value == "/":
        return False
    if any(part in (".", "..") for part in value.split("/")):
        return False
    for prefix in FORBIDDEN_MOUNT_PREFIXES:
        if value == prefix or value.startswith(prefix + "/"):
            return False
    return True


def _validate_env_map(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 32:
        raise CatalogAppError("invalid catalog app env map")
    cleaned = {}
    for key, item in value.items():
        if not isinstance(key, str) or not ENV_KEY_RE.fullmatch(key) or not _printable_str(item, 512):
            raise CatalogAppError("invalid catalog app env entry")
        cleaned[key] = item
    return cleaned


def _validate_model_env(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise CatalogAppError("invalid catalog app modelEnv")
    allowed = {"apiKeyVar", "baseUrlVar", "modelVar", "extraEnv"}
    if not set(value).issubset(allowed):
        raise CatalogAppError("unexpected modelEnv key")
    for required in ("apiKeyVar", "baseUrlVar"):
        if not isinstance(value.get(required), str) or not ENV_KEY_RE.fullmatch(value[required]):
            raise CatalogAppError("invalid modelEnv binding")
    model_var = value.get("modelVar")
    if model_var is not None and (not isinstance(model_var, str) or not ENV_KEY_RE.fullmatch(model_var)):
        raise CatalogAppError("invalid modelEnv modelVar")
    extra_env = _validate_env_map(value.get("extraEnv"))
    out = {"apiKeyVar": value["apiKeyVar"], "baseUrlVar": value["baseUrlVar"]}
    if model_var is not None:
        out["modelVar"] = model_var
    if extra_env:
        out["extraEnv"] = extra_env
    return out


def validate_catalog_app_spec(spec):
    """Strictly validate a catalog app launch spec and return a normalized copy."""
    if not isinstance(spec, dict) or set(spec) != {"appId", "name", "runtime"}:
        raise CatalogAppError("invalid catalog app spec envelope")
    app_id = spec.get("appId")
    name = spec.get("name")
    runtime = spec.get("runtime")
    if not isinstance(app_id, str) or not SLUG_RE.fullmatch(app_id):
        raise CatalogAppError("invalid catalog app id")
    if not _printable_str(name, 60) or len(name.strip()) < 2:
        raise CatalogAppError("invalid catalog app name")
    if not isinstance(runtime, dict):
        raise CatalogAppError("invalid catalog app runtime")
    kind = runtime.get("kind")

    if kind == "docker-web":
        allowed = {
            "kind", "imageRepo", "imageTag", "containerPort", "hostPort",
            "healthPath", "volumes", "env", "modelEnv", "dropAllCaps",
            "stopTimeoutSeconds", "proxyMode",
        }
        if not set(runtime).issubset(allowed):
            raise CatalogAppError("unexpected docker-web field")
        repo = runtime.get("imageRepo")
        tag = runtime.get("imageTag")
        cport = runtime.get("containerPort")
        hport = runtime.get("hostPort")
        hpath = runtime.get("healthPath")
        volumes = runtime.get("volumes")
        proxy_mode = runtime.get("proxyMode")
        drop_caps = runtime.get("dropAllCaps", False)
        stop_timeout = runtime.get("stopTimeoutSeconds", 25)
        if not isinstance(repo, str) or not IMAGE_REPO_RE.fullmatch(repo):
            raise CatalogAppError("invalid docker image repository")
        if not isinstance(tag, str) or not IMAGE_TAG_RE.fullmatch(tag):
            raise CatalogAppError("invalid docker image tag")
        if type(cport) is not int or not (1 <= cport <= 65535):
            raise CatalogAppError("invalid containerPort")
        if type(hport) is not int or not (PORT_MIN <= hport <= PORT_MAX):
            raise CatalogAppError("invalid hostPort")
        if not _safe_health_path(hpath):
            raise CatalogAppError("invalid healthPath")
        if not isinstance(volumes, list) or not (1 <= len(volumes) <= 8):
            raise CatalogAppError("invalid docker volumes")
        norm_vols = []
        seen_names = set()
        for vol in volumes:
            if not isinstance(vol, dict) or set(vol) != {"name", "mountPath"}:
                raise CatalogAppError("invalid docker volume entry")
            vname, vmount = vol["name"], vol["mountPath"]
            if not isinstance(vname, str) or not VOLUME_NAME_RE.fullmatch(vname) or vname in seen_names:
                raise CatalogAppError("invalid docker volume name")
            if not _safe_mount_path(vmount):
                raise CatalogAppError("unsafe docker volume mountPath")
            seen_names.add(vname)
            norm_vols.append({"name": vname, "mountPath": vmount})
        if proxy_mode not in ("standard", "loopback-origin"):
            raise CatalogAppError("invalid proxyMode")
        if type(drop_caps) is not bool:
            raise CatalogAppError("invalid dropAllCaps")
        if type(stop_timeout) is not int or not (5 <= stop_timeout <= 120):
            raise CatalogAppError("invalid stopTimeoutSeconds")
        env = _validate_env_map(runtime.get("env"))
        model_env = _validate_model_env(runtime.get("modelEnv"))
        return {
            "appId": app_id,
            "name": name.strip(),
            "runtime": {
                "kind": "docker-web",
                "imageRepo": repo,
                "imageTag": tag,
                "containerPort": cport,
                "hostPort": hport,
                "healthPath": hpath,
                "volumes": norm_vols,
                "env": env,
                "modelEnv": model_env,
                "dropAllCaps": drop_caps,
                "stopTimeoutSeconds": stop_timeout,
                "proxyMode": proxy_mode,
            },
        }

    if kind == "cli-web":
        allowed = {"kind", "installer", "webService", "cliChat", "env", "modelEnv"}
        if not set(runtime).issubset(allowed):
            raise CatalogAppError("unexpected cli-web field")
        inst = runtime.get("installer")
        if not isinstance(inst, dict):
            raise CatalogAppError("invalid cli installer")
        method = inst.get("method")
        if method in ("uv-tool", "npm-global"):
            if set(inst) != {"method", "packageName", "binName"}:
                raise CatalogAppError("invalid package installer")
            if not isinstance(inst["packageName"], str) or not PACKAGE_NAME_RE.fullmatch(inst["packageName"]):
                raise CatalogAppError("invalid packageName")
            if not isinstance(inst["binName"], str) or not BIN_NAME_RE.fullmatch(inst["binName"]):
                raise CatalogAppError("invalid binName")
            norm_inst = dict(inst)
        elif method == "github-release-tar":
            if not set(inst).issubset({"method", "repo", "binName", "assetX64", "assetArm64"}):
                raise CatalogAppError("invalid github-release-tar installer")
            if not isinstance(inst.get("repo"), str) or not GITHUB_REPO_RE.fullmatch(inst["repo"]):
                raise CatalogAppError("invalid github repo")
            if not isinstance(inst.get("binName"), str) or not BIN_NAME_RE.fullmatch(inst["binName"]):
                raise CatalogAppError("invalid binName")
            if not isinstance(inst.get("assetX64"), str) or not RELEASE_ASSET_RE.fullmatch(inst["assetX64"]):
                raise CatalogAppError("invalid assetX64")
            asset_arm64 = inst.get("assetArm64")
            if asset_arm64 is not None and (not isinstance(asset_arm64, str) or not RELEASE_ASSET_RE.fullmatch(asset_arm64)):
                raise CatalogAppError("invalid assetArm64")
            norm_inst = {
                "method": "github-release-tar",
                "repo": inst["repo"],
                "binName": inst["binName"],
                "assetX64": inst["assetX64"],
                **({"assetArm64": asset_arm64} if asset_arm64 else {}),
            }
        else:
            raise CatalogAppError("unsupported cli installer method")

        web_service = runtime.get("webService")
        norm_web = None
        if web_service is not None:
            if not isinstance(web_service, dict) or not set(web_service).issubset({"binName", "args", "hostPort", "healthPath", "proxyMode"}):
                raise CatalogAppError("invalid webService")
            ws_bin = web_service.get("binName", norm_inst["binName"])
            ws_args = web_service.get("args")
            ws_port = web_service.get("hostPort")
            ws_health = web_service.get("healthPath")
            ws_proxy = web_service.get("proxyMode")
            if not isinstance(ws_bin, str) or not BIN_NAME_RE.fullmatch(ws_bin):
                raise CatalogAppError("invalid webService binName")
            if not isinstance(ws_args, list) or len(ws_args) > 24 or not all(isinstance(a, str) and SAFE_ARG_RE.fullmatch(a) for a in ws_args):
                raise CatalogAppError("invalid webService args")
            if type(ws_port) is not int or not (PORT_MIN <= ws_port <= PORT_MAX):
                raise CatalogAppError("invalid webService hostPort")
            if not _safe_health_path(ws_health):
                raise CatalogAppError("invalid webService healthPath")
            if ws_proxy not in ("standard", "loopback-origin"):
                raise CatalogAppError("invalid webService proxyMode")
            norm_web = {
                "binName": ws_bin,
                "args": ws_args,
                "hostPort": ws_port,
                "healthPath": ws_health,
                "proxyMode": ws_proxy,
            }

        cli_chat = runtime.get("cliChat")
        norm_chat = None
        if cli_chat is not None:
            if not isinstance(cli_chat, dict) or set(cli_chat) != {"args", "promptVia"}:
                raise CatalogAppError("invalid cliChat")
            chat_args = cli_chat.get("args")
            prompt_via = cli_chat.get("promptVia")
            if not isinstance(chat_args, list) or len(chat_args) > 16 or not all(isinstance(a, str) and SAFE_ARG_RE.fullmatch(a) for a in chat_args):
                raise CatalogAppError("invalid cliChat args")
            if prompt_via not in ("arg", "stdin"):
                raise CatalogAppError("invalid cliChat promptVia")
            norm_chat = {"args": chat_args, "promptVia": prompt_via}

        if norm_web is None and norm_chat is None:
            raise CatalogAppError("cli-web requires webService or cliChat")

        env = _validate_env_map(runtime.get("env"))
        model_env = _validate_model_env(runtime.get("modelEnv"))
        return {
            "appId": app_id,
            "name": name.strip(),
            "runtime": {
                "kind": "cli-web",
                "installer": norm_inst,
                "webService": norm_web,
                "cliChat": norm_chat,
                "env": env,
                "modelEnv": model_env,
            },
        }

    raise CatalogAppError("unsupported catalog app runtime kind")


def _write_atomic(path: Path, data: bytes, mode: int, uid: int = 0, gid: int = 0):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".hivra-app-", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(fd)
        if os.geteuid() == 0 and (uid != 0 or gid != 0):
            os.chown(tmp, uid, gid)
        os.replace(tmp, path)
    finally:
        os.close(fd)
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _build_env_lines(static_env, model_env, model_key, model_base_url, model_name):
    merged = dict(static_env or {})
    if model_env and model_key and model_base_url:
        for k, v in (model_env.get("extraEnv") or {}).items():
            merged[k] = v
        merged[model_env["apiKeyVar"]] = model_key
        merged[model_env["baseUrlVar"]] = model_base_url
        if model_env.get("modelVar") and model_name:
            merged[model_env["modelVar"]] = model_name
    lines = []
    for key in sorted(merged):
        val = str(merged[key]).replace("\r", "").replace("\n", "")
        lines.append(f"{key}={val}")
    return ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")


def _record_app_version(app_id: str, version: str):
    payload = json.dumps({"name": app_id, "version": version}, separators=(",", ":")).encode("utf-8") + b"\n"
    _write_atomic(RECORD_PATH, payload, 0o644)


def _agent_uid_gid():
    entry = pwd.getpwnam(AGENT_USER)
    return entry.pw_uid, entry.pw_gid


def _as_agent(cmd, *, env_extra=None, timeout=1200):
    env = {
        "HOME": str(AGENT_HOME),
        "USER": AGENT_USER,
        "LANG": "C.UTF-8",
        "PATH": f"{AGENT_HOME}/.local/bin:{AGENT_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin",
        "npm_config_prefix": str(AGENT_HOME / ".npm-global"),
        "npm_config_update_notifier": "false",
    }
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["/usr/sbin/runuser", "-u", AGENT_USER, "--", *cmd],
        check=True,
        timeout=timeout,
        env=env,
        stdin=subprocess.DEVNULL,
    )


def _ensure_docker():
    if shutil.which("docker") is None:
        subprocess.run(
            ["/usr/bin/apt-get", "-o", "Acquire::Retries=3", "update"],
            check=True, timeout=300, stdin=subprocess.DEVNULL,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive"},
        )
        subprocess.run(
            ["/usr/bin/apt-get", "-o", "Acquire::Retries=3", "install", "-y", "--no-install-recommends", "docker.io"],
            check=True, timeout=600, stdin=subprocess.DEVNULL,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive"},
        )
    subprocess.run(["/usr/bin/systemctl", "enable", "--now", "docker"], check=True, timeout=60, stdin=subprocess.DEVNULL)
    subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "docker"], check=True, timeout=15, stdin=subprocess.DEVNULL)


def _pull_and_resolve_digest(repo: str, tag: str) -> str:
    ref = f"{repo}:{tag}"
    subprocess.run(["/usr/bin/docker", "pull", ref], check=True, timeout=1800, stdin=subprocess.DEVNULL)
    inspected = subprocess.run(
        ["/usr/bin/docker", "image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", ref],
        check=True, timeout=30, capture_output=True, text=True, stdin=subprocess.DEVNULL,
    )
    prefix = repo + "@"
    for line in inspected.stdout.splitlines():
        candidate = line.strip()
        if candidate.startswith(prefix):
            digest = candidate.split("@", 1)[1]
            if DIGEST_RE.fullmatch(digest):
                return candidate
    # Docker Hub official/short names may normalize to docker.io/library/... or similar
    for line in inspected.stdout.splitlines():
        candidate = line.strip()
        if "@" in candidate and DIGEST_RE.fullmatch(candidate.rsplit("@", 1)[1]):
            return candidate
    raise CatalogAppError("unable to resolve pulled docker image digest")


def install_docker_web(spec, model_key="", model_base_url="", model_name=""):
    app_id = spec["appId"]
    name = spec["name"]
    rt = spec["runtime"]
    _ensure_docker()
    pinned_image = _pull_and_resolve_digest(rt["imageRepo"], rt["imageTag"])
    digest = pinned_image.rsplit("@", 1)[1]

    APP_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(APP_ROOT, 0o700)
    _write_atomic(APP_ROOT / "image", (pinned_image + "\n").encode("utf-8"), 0o600)

    env_bytes = _build_env_lines(rt.get("env"), rt.get("modelEnv"), model_key, model_base_url, model_name)
    _write_atomic(DOCKER_ENV_PATH, env_bytes, 0o600)

    meta = {
        "schema": 1,
        "appId": app_id,
        "name": name,
        "kind": "docker-web",
        "imageRepo": rt["imageRepo"],
        "imageTag": rt["imageTag"],
        "containerPort": rt["containerPort"],
        "hostPort": rt["hostPort"],
        "healthPath": rt["healthPath"],
        "proxyMode": rt["proxyMode"],
        "volumes": rt["volumes"],
        "dropAllCaps": rt["dropAllCaps"],
        "stopTimeoutSeconds": rt["stopTimeoutSeconds"],
        "unit": "hivra-catalog-app.service",
        "containerName": f"hivra-app-{app_id}",
    }
    _write_atomic(METADATA_PATH, (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)

    vol_flags = []
    for vol in rt["volumes"]:
        vol_flags.extend(["-v", f"hivra-app-{app_id}-{vol['name']}:{vol['mountPath']}"])
    cap_flags = ["--cap-drop", "ALL"] if rt["dropAllCaps"] else []
    port_spec = f"127.0.0.1:{rt['hostPort']}:{rt['containerPort']}"
    container_name = f"hivra-app-{app_id}"
    stop_timeout = rt["stopTimeoutSeconds"]

    runner_args = [
        "/usr/bin/docker", "run", "--rm",
        "--name", container_name,
        "--security-opt", "no-new-privileges",
        *cap_flags,
        "-p", port_spec,
        "--env-file", str(DOCKER_ENV_PATH),
        *vol_flags,
    ]
    runner_cmd = " ".join(shlex.quote(arg) for arg in runner_args)
    runner_script = (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"image=\"$(head -n 1 {shlex.quote(str(APP_ROOT / 'image'))})\"\n"
        "[[ \"$image\" == *@sha256:* ]] || { echo 'invalid catalog app image' >&2; exit 1; }\n"
        f"/usr/bin/docker rm -f {shlex.quote(container_name)} >/dev/null 2>&1 || true\n"
        f"exec {runner_cmd} \"$image\"\n"
    )
    _write_atomic(Path("/usr/local/sbin/hivra-catalog-app-run"), runner_script.encode("utf-8"), 0o755)

    unit_text = (
        "[Unit]\n"
        f"Description=Hivra Catalog App ({name} on 127.0.0.1:{rt['hostPort']})\n"
        "After=network-online.target docker.service\n"
        "Requires=docker.service\n"
        "[Service]\n"
        "TimeoutStartSec=0\n"
        f"TimeoutStopSec={stop_timeout + 10}\n"
        "Restart=always\n"
        "RestartSec=5\n"
        "ExecStart=/usr/local/sbin/hivra-catalog-app-run\n"
        f"ExecStop=-/usr/bin/docker stop -t {stop_timeout} {container_name}\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    _write_atomic(Path("/etc/systemd/system/hivra-catalog-app.service"), unit_text.encode("utf-8"), 0o644)
    subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=30, stdin=subprocess.DEVNULL)
    subprocess.run(["/usr/bin/systemctl", "enable", "--now", "hivra-catalog-app.service"], check=True, timeout=60, stdin=subprocess.DEVNULL)
    _record_app_version(app_id, digest)
    return {"image": pinned_image, "version": digest}


def _safe_extract_binary(archive_bytes: bytes, asset_name: str, dest_dir: Path, bin_names: list[str], uid: int, gid: int):
    dest_dir.mkdir(parents=True, exist_ok=True)
    found = {}
    wanted = set(bin_names)
    if asset_name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                base = os.path.basename(info.filename)
                if base in wanted:
                    data = zf.read(info)
                    target = dest_dir / base
                    _write_atomic(target, data, 0o755, uid=uid, gid=gid)
                    found[base] = str(target)
    else:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:*") as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                base = os.path.basename(member.name)
                if base in wanted:
                    extracted = tf.extractfile(member)
                    if extracted is None:
                        continue
                    data = extracted.read(MAX_ARCHIVE_BYTES + 1)
                    if len(data) > MAX_ARCHIVE_BYTES:
                        raise CatalogAppError("extracted binary exceeds size limit")
                    target = dest_dir / base
                    _write_atomic(target, data, 0o755, uid=uid, gid=gid)
                    found[base] = str(target)
    return found


def _download_github_release(repo: str, asset_name: str) -> bytes:
    url = f"https://github.com/{repo}/releases/latest/download/{asset_name}"
    req = urllib.request.Request(url, headers={"User-Agent": "hivra-catalog-app/1"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) > MAX_ARCHIVE_BYTES:
            raise CatalogAppError("release archive exceeds size limit")
        return data


def _probe_cli_version(bin_path: str) -> str:
    try:
        res = subprocess.run(
            ["/usr/sbin/runuser", "-u", AGENT_USER, "--", bin_path, "--version"],
            timeout=15, capture_output=True, text=True, stdin=subprocess.DEVNULL,
            env={"HOME": str(AGENT_HOME), "PATH": f"{AGENT_HOME}/.local/bin:{AGENT_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"},
        )
        combined = (res.stdout or "") + "\n" + (res.stderr or "")
        match = SEMVER_RE.search(combined)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "latest"


def install_cli_web(spec, model_key="", model_base_url="", model_name=""):
    app_id = spec["appId"]
    name = spec["name"]
    rt = spec["runtime"]
    inst = rt["installer"]
    uid, gid = _agent_uid_gid()

    bin_dir = AGENT_HOME / ".local" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(bin_dir, uid, gid)

    if inst["method"] == "uv-tool":
        if shutil.which("uv") is None and not (bin_dir / "uv").exists():
            _as_agent(["/usr/bin/python3", "-m", "pip", "install", "--user", "--break-system-packages", "uv"])
        uv_bin = str(bin_dir / "uv") if (bin_dir / "uv").exists() else (shutil.which("uv") or "uv")
        _as_agent([uv_bin, "tool", "install", "--force", inst["packageName"]])
        resolved_bin = str(bin_dir / inst["binName"])
    elif inst["method"] == "npm-global":
        _as_agent(["/usr/bin/npm", "install", "-g", f"{inst['packageName']}@latest"])
        resolved_bin = str(AGENT_HOME / ".npm-global" / "bin" / inst["binName"])
    elif inst["method"] == "github-release-tar":
        arch = platform.machine().lower()
        asset = inst.get("assetArm64") if arch in ("aarch64", "arm64") and inst.get("assetArm64") else inst["assetX64"]
        archive_bytes = _download_github_release(inst["repo"], asset)
        wanted_bins = [inst["binName"]]
        if rt.get("webService") and rt["webService"]["binName"] not in wanted_bins:
            wanted_bins.append(rt["webService"]["binName"])
        found = _safe_extract_binary(archive_bytes, asset, bin_dir, wanted_bins, uid, gid)
        if inst["binName"] not in found:
            raise CatalogAppError(f"binary {inst['binName']} not found in release archive")
        resolved_bin = found[inst["binName"]]
    else:
        raise CatalogAppError("unsupported cli installer method")

    env_path = AGENT_HOME / ".hivra" / "catalog-app-model.env"
    env_bytes = _build_env_lines(rt.get("env"), rt.get("modelEnv"), model_key, model_base_url, model_name)
    _write_atomic(env_path, env_bytes, 0o600, uid=uid, gid=gid)

    ws = rt.get("webService")
    cli_chat = rt.get("cliChat")

    if cli_chat is not None:
        cmd_doc = {
            "bin": resolved_bin,
            "args": cli_chat["args"],
            "promptVia": cli_chat["promptVia"],
            "envFile": str(env_path),
        }
        _write_atomic(
            AGENT_HOME / ".hivra" / "agent-cmd.json",
            (json.dumps(cmd_doc, indent=2) + "\n").encode("utf-8"),
            0o600,
            uid=uid,
            gid=gid,
        )

    unit_name = None
    if ws is not None:
        ws_bin_path = str(Path(resolved_bin).parent / ws["binName"]) if (Path(resolved_bin).parent / ws["binName"]).exists() else resolved_bin
        exec_line = " ".join(shlex.quote(part) for part in [ws_bin_path, *ws["args"]])
        unit_name = "bux-catalog-app.service"
        unit_text = (
            "[Unit]\n"
            f"Description=Hivra Catalog App ({name} WebUI on 127.0.0.1:{ws['hostPort']})\n"
            "After=network-online.target\n"
            "[Service]\n"
            f"User={AGENT_USER}\n"
            f"WorkingDirectory={AGENT_HOME}\n"
            f"Environment=HOME={AGENT_HOME}\n"
            f"Environment=PATH={AGENT_HOME}/.local/bin:{AGENT_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin\n"
            f"EnvironmentFile=-{env_path}\n"
            f"ExecStart={exec_line}\n"
            "Restart=always\n"
            "RestartSec=5\n"
            "[Install]\n"
            "WantedBy=multi-user.target\n"
        )
        _write_atomic(Path(f"/etc/systemd/system/{unit_name}"), unit_text.encode("utf-8"), 0o644)
        subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=30, stdin=subprocess.DEVNULL)
        subprocess.run(["/usr/bin/systemctl", "enable", "--now", unit_name], check=True, timeout=60, stdin=subprocess.DEVNULL)

    meta = {
        "schema": 1,
        "appId": app_id,
        "name": name,
        "kind": "cli-web",
        "installer": inst,
        "binPath": resolved_bin,
        "hostPort": ws["hostPort"] if ws else None,
        "healthPath": ws["healthPath"] if ws else None,
        "proxyMode": ws["proxyMode"] if ws else None,
        "cliChat": cli_chat,
        "unit": unit_name,
    }
    _write_atomic(METADATA_PATH, (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)

    version = _probe_cli_version(resolved_bin)
    _record_app_version(app_id, version)
    return {"bin": resolved_bin, "version": version}


def main():
    parser = argparse.ArgumentParser(description="Hivra generic catalog app runner")
    parser.add_argument("action", choices=("validate", "install", "meta"))
    args = parser.parse_args()

    if args.action == "meta":
        if not METADATA_PATH.is_file():
            sys.exit(1)
        sys.stdout.write(METADATA_PATH.read_text(encoding="utf-8"))
        return

    raw = sys.stdin.buffer.read(MAX_SPEC_BYTES + 1)
    if not raw or len(raw) > MAX_SPEC_BYTES:
        raise CatalogAppError("catalog app payload exceeds size bound")
    payload = json.loads(raw.decode("utf-8"))

    if args.action == "validate":
        normalized = validate_catalog_app_spec(payload)
        sys.stdout.write(json.dumps(normalized, separators=(",", ":")) + "\n")
        return

    if not isinstance(payload, dict) or "spec" not in payload:
        raise CatalogAppError("install payload missing spec")
    spec = validate_catalog_app_spec(payload["spec"])
    model_key = str(payload.get("modelKey") or "")
    model_base_url = str(payload.get("modelBaseUrl") or "")
    model_name = str(payload.get("model") or "")
    if spec["runtime"]["kind"] == "docker-web":
        result = install_docker_web(spec, model_key, model_base_url, model_name)
    else:
        result = install_cli_web(spec, model_key, model_base_url, model_name)
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except CatalogAppError as exc:
        print(f"hivra-catalog-app: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"hivra-catalog-app: unexpected error ({type(exc).__name__})", file=sys.stderr)
        sys.exit(1)
