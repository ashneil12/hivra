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
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
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
PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
PUBLIC_PLACEHOLDERS = ("HIVRA_PUBLIC_ORIGIN", "HIVRA_PUBLIC_HOST")
STACK_SERVICE_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,23}$")

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
SECRETS_PATH = Path(os.environ.get("HIVRA_CATALOG_APP_SECRETS", "/etc/hivra/catalog-app.secrets"))
COMPOSE_PATH = APP_ROOT / "compose.yaml"
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


def _validate_generated_secrets(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 8:
        raise CatalogAppError("invalid generatedSecrets")
    for name in value:
        if not isinstance(name, str) or not ENV_KEY_RE.fullmatch(name):
            raise CatalogAppError("invalid generatedSecrets entry")
    if len(set(value)) != len(value):
        raise CatalogAppError("generatedSecrets must be unique")
    return list(value)


def _env_placeholders_ok(value, secret_names):
    """Mirror of the schema rule: ${HIVRA_PUBLIC_ORIGIN}, ${HIVRA_PUBLIC_HOST}
    and ${NAME} for a declared generated secret are the only placeholders."""
    if not isinstance(value, str):
        return False
    allowed = set(PUBLIC_PLACEHOLDERS) | set(secret_names)
    stripped = PLACEHOLDER_RE.sub("", value)
    if "${" in stripped:
        return False
    return all(match.group(1) in allowed for match in PLACEHOLDER_RE.finditer(value))


def _env_map_placeholders_ok(env, secret_names):
    if not env:
        return True
    return all(_env_placeholders_ok(item, secret_names) for item in env.values())


def _check_runtime_env_placeholders(runtime, secret_names):
    for env in (runtime.get("env"), (runtime.get("modelEnv") or {}).get("extraEnv")):
        if env and not _env_map_placeholders_ok(env, secret_names):
            raise CatalogAppError("env value uses an undeclared placeholder")


def _validate_setup(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"commands"}:
        raise CatalogAppError("invalid catalog app setup")
    commands = value.get("commands")
    if not isinstance(commands, list) or not (1 <= len(commands) <= 16):
        raise CatalogAppError("invalid setup commands")
    for command in commands:
        if not _printable_str(command, 2000):
            raise CatalogAppError("invalid setup command")
    return {"commands": list(commands)}


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
            "kind", "imageRepo", "imageTag", "imageDigest", "containerPort", "hostPort",
            "healthPath", "volumes", "env", "generatedSecrets", "modelEnv",
            "dropAllCaps", "stopTimeoutSeconds", "proxyMode",
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
        digest = runtime.get("imageDigest")
        if "imageDigest" in runtime and (not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest)):
            raise CatalogAppError("invalid docker image digest")
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
        generated_secrets = _validate_generated_secrets(runtime.get("generatedSecrets"))
        model_env = _validate_model_env(runtime.get("modelEnv"))
        norm_runtime = {
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
        }
        if generated_secrets:
            norm_runtime["generatedSecrets"] = generated_secrets
        if digest:
            norm_runtime["imageDigest"] = digest
        _check_runtime_env_placeholders(norm_runtime, generated_secrets)
        return {
            "appId": app_id,
            "name": name.strip(),
            "runtime": norm_runtime,
        }

    if kind == "cli-web":
        allowed = {"kind", "installer", "webService", "cliChat", "setup", "env", "generatedSecrets", "modelEnv"}
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
        generated_secrets = _validate_generated_secrets(runtime.get("generatedSecrets"))
        model_env = _validate_model_env(runtime.get("modelEnv"))
        setup = _validate_setup(runtime.get("setup"))
        norm_runtime = {
            "kind": "cli-web",
            "installer": norm_inst,
            "webService": norm_web,
            "cliChat": norm_chat,
            "setup": setup,
            "env": env,
            "modelEnv": model_env,
        }
        if generated_secrets:
            norm_runtime["generatedSecrets"] = generated_secrets
        _check_runtime_env_placeholders(norm_runtime, generated_secrets)
        return {
            "appId": app_id,
            "name": name.strip(),
            "runtime": norm_runtime,
        }

    if kind == "docker-stack":
        allowed = {"kind", "services", "web", "stopTimeoutSeconds"}
        if not set(runtime).issubset(allowed):
            raise CatalogAppError("unexpected docker-stack field")
        services = runtime.get("services")
        web = runtime.get("web")
        stop_timeout = runtime.get("stopTimeoutSeconds", 25)
        if not isinstance(services, list) or not (2 <= len(services) <= 6):
            raise CatalogAppError("invalid docker-stack services")
        if type(stop_timeout) is not int or not (5 <= stop_timeout <= 120):
            raise CatalogAppError("invalid stopTimeoutSeconds")
        if not isinstance(web, dict) or not set(web).issubset({"service", "containerPort", "hostPort", "healthPath", "proxyMode"}):
            raise CatalogAppError("invalid docker-stack web")
        w_service = web.get("service")
        w_cport = web.get("containerPort")
        w_hport = web.get("hostPort")
        w_hpath = web.get("healthPath")
        w_proxy = web.get("proxyMode")
        if not isinstance(w_service, str) or not STACK_SERVICE_NAME_RE.fullmatch(w_service):
            raise CatalogAppError("invalid docker-stack web service")
        if type(w_cport) is not int or not (1 <= w_cport <= 65535):
            raise CatalogAppError("invalid docker-stack containerPort")
        if type(w_hport) is not int or not (PORT_MIN <= w_hport <= PORT_MAX):
            raise CatalogAppError("invalid docker-stack hostPort")
        if not _safe_health_path(w_hpath):
            raise CatalogAppError("invalid docker-stack healthPath")
        if w_proxy not in ("standard", "loopback-origin"):
            raise CatalogAppError("invalid docker-stack proxyMode")

        norm_services = []
        seen_names = set()
        all_secret_names = set()
        for index, svc in enumerate(services):
            if not isinstance(svc, dict) or not set(svc).issubset(
                {"name", "imageRepo", "imageTag", "env", "generatedSecrets", "volumes", "dropAllCaps", "dependsOn"}
            ):
                raise CatalogAppError("invalid docker-stack service")
            sname = svc.get("name")
            if not isinstance(sname, str) or not STACK_SERVICE_NAME_RE.fullmatch(sname) or sname in seen_names:
                raise CatalogAppError("invalid or duplicate docker-stack service name")
            seen_names.add(sname)
            srepo = svc.get("imageRepo")
            stag = svc.get("imageTag")
            if not isinstance(srepo, str) or not IMAGE_REPO_RE.fullmatch(srepo):
                raise CatalogAppError("invalid docker-stack imageRepo")
            if not isinstance(stag, str) or not IMAGE_TAG_RE.fullmatch(stag):
                raise CatalogAppError("invalid docker-stack imageTag")
            # Non-web services must not track a moving tag: a `latest` pull on
            # update could silently change a database major version.
            if sname != w_service and stag == "latest":
                raise CatalogAppError("docker-stack non-web service must not use the latest tag")
            senv = _validate_env_map(svc.get("env"))
            ssecrets = _validate_generated_secrets(svc.get("generatedSecrets"))
            all_secret_names.update(ssecrets)
            svols = svc.get("volumes") or []
            if not isinstance(svols, list) or len(svols) > 8:
                raise CatalogAppError("invalid docker-stack service volumes")
            norm_vols = []
            seen_vols = set()
            for vol in svols:
                if not isinstance(vol, dict) or set(vol) != {"name", "mountPath"}:
                    raise CatalogAppError("invalid docker-stack volume entry")
                vname, vmount = vol["name"], vol["mountPath"]
                if not isinstance(vname, str) or not VOLUME_NAME_RE.fullmatch(vname) or vname in seen_vols:
                    raise CatalogAppError("invalid docker-stack volume name")
                if not _safe_mount_path(vmount):
                    raise CatalogAppError("unsafe docker-stack volume mountPath")
                seen_vols.add(vname)
                norm_vols.append({"name": vname, "mountPath": vmount})
            sdrop = svc.get("dropAllCaps", False)
            if type(sdrop) is not bool:
                raise CatalogAppError("invalid docker-stack dropAllCaps")
            sdeps = svc.get("dependsOn") or []
            if not isinstance(sdeps, list) or len(sdeps) > 5 or not all(
                isinstance(d, str) and STACK_SERVICE_NAME_RE.fullmatch(d) for d in sdeps
            ):
                raise CatalogAppError("invalid docker-stack dependsOn")
            norm_services.append({
                "name": sname,
                "imageRepo": srepo,
                "imageTag": stag,
                "env": senv,
                "generatedSecrets": ssecrets,
                "volumes": norm_vols,
                "dropAllCaps": sdrop,
                "dependsOn": list(sdeps),
            })
        if w_service not in seen_names:
            raise CatalogAppError("docker-stack web service is not declared")
        earlier = set()
        for svc in norm_services:
            for dep in svc["dependsOn"]:
                if dep not in earlier:
                    raise CatalogAppError("docker-stack dependsOn must reference an earlier service")
            earlier.add(svc["name"])
        # Placeholders resolve against the app-wide secret set (one root-only
        # secrets file shared by every service env file).
        for svc in norm_services:
            _check_runtime_env_placeholders(svc, all_secret_names)
        return {
            "appId": app_id,
            "name": name.strip(),
            "runtime": {
                "kind": "docker-stack",
                "services": norm_services,
                "web": {
                    "service": w_service,
                    "containerPort": w_cport,
                    "hostPort": w_hport,
                    "healthPath": w_hpath,
                    "proxyMode": w_proxy,
                },
                "stopTimeoutSeconds": stop_timeout,
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


def _valid_public_origin(value):
    """Mirror of install-agent's canonical_origin: https:// plus a dotted,
    label-safe hostname with no port, path or credentials."""
    if not isinstance(value, str) or not value.startswith("https://") or len(value) > 261:
        return False
    hostname = value[len("https://"):]
    if "." not in hostname:
        return False
    tld = hostname.rsplit(".", 1)[1]
    if not re.fullmatch(r"[a-z]{2,63}", tld):
        return False
    return all(
        not label.startswith("xn--") and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in hostname.split(".")
    )


def _public_origin_parts(public_origin):
    origin = str(public_origin or "").strip()
    host = urllib.parse.urlparse(origin).hostname or ""
    return origin, host


def _load_or_create_secrets(names, secrets_path=SECRETS_PATH):
    """Root-only KEY=VALUE store. Existing values are reused verbatim so a
    reinstall or update never silently rotates a secret the app already stored
    (sessions, encrypted fields). Returns {name: value} for the requested
    names; secret values are never logged."""
    existing = {}
    try:
        info = secrets_path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise CatalogAppError("catalog app secrets path is not a regular file")
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise CatalogAppError("catalog app secrets file has unsafe ownership or mode")
        for line in secrets_path.read_text(encoding="utf-8").splitlines():
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            if ENV_KEY_RE.fullmatch(key):
                existing[key] = val
    except FileNotFoundError:
        pass
    merged = dict(existing)
    changed = False
    for name in names:
        if name not in merged:
            merged[name] = secrets.token_urlsafe(32)
            changed = True
    if changed or not secrets_path.exists():
        lines = [f"{key}={merged[key]}" for key in sorted(merged)]
        _write_atomic(secrets_path, ("\n".join(lines) + "\n").encode("utf-8"), 0o600)
    return {name: merged[name] for name in names}


def _substitute_env_value(value, secret_map, public_origin, public_host):
    def repl(match):
        name = match.group(1)
        if name == "HIVRA_PUBLIC_ORIGIN":
            if not _valid_public_origin(public_origin):
                raise CatalogAppError("manifest uses ${HIVRA_PUBLIC_ORIGIN} but no valid publicOrigin was provided")
            return public_origin
        if name == "HIVRA_PUBLIC_HOST":
            if not _valid_public_origin(public_origin):
                raise CatalogAppError("manifest uses ${HIVRA_PUBLIC_HOST} but no valid publicOrigin was provided")
            return public_host
        if name in secret_map:
            return secret_map[name]
        raise CatalogAppError(f"env placeholder ${{{name}}} has no generated secret value")
    return PLACEHOLDER_RE.sub(repl, value)


def _merged_env_map(static_env, model_env, model_key, model_base_url, model_name):
    merged = dict(static_env or {})
    if model_env and model_key and model_base_url:
        for k, v in (model_env.get("extraEnv") or {}).items():
            merged[k] = v
        merged[model_env["apiKeyVar"]] = model_key
        merged[model_env["baseUrlVar"]] = model_base_url
        if model_env.get("modelVar") and model_name:
            merged[model_env["modelVar"]] = model_name
    return merged


def _build_env_lines(static_env, model_env, model_key, model_base_url, model_name,
                     secret_map=None, public_origin="", public_host="", raw_secrets=None):
    merged = _merged_env_map(static_env, model_env, model_key, model_base_url, model_name)
    for key, value in merged.items():
        merged[key] = _substitute_env_value(str(value), secret_map or {}, public_origin, public_host)
    for key, value in (raw_secrets or {}).items():
        merged[key] = value
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


def _pull_and_resolve_digest(repo: str, tag: str, expected_digest=None) -> str:
    if expected_digest:
        arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
        if not arch:
            raise CatalogAppError("unsupported platform for pinned docker image")
        target_platform = f"linux/{arch}"
        ref = f"{repo}@{expected_digest}"
        subprocess.run(["/usr/bin/docker", "pull", "--platform", target_platform, ref],
                       check=True, timeout=1800, stdin=subprocess.DEVNULL)
        inspected = subprocess.run(
            ["/usr/bin/docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}} {{json .RepoDigests}}", ref],
            check=True, timeout=30, capture_output=True, text=True, stdin=subprocess.DEVNULL,
        )
        actual_platform, _, digests = inspected.stdout.strip().partition(" ")
        if actual_platform != target_platform:
            raise CatalogAppError(f"pinned docker image does not match {target_platform}")
        if not any(digest.endswith(f"@{expected_digest}") for digest in (json.loads(digests) or [])):
            raise CatalogAppError("pulled docker image digest does not match the catalog pin")
        return ref
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


def install_docker_web(spec, model_key="", model_base_url="", model_name="", public_origin=""):
    app_id = spec["appId"]
    name = spec["name"]
    rt = spec["runtime"]
    _ensure_docker()
    pinned_image = _pull_and_resolve_digest(rt["imageRepo"], rt["imageTag"], rt.get("imageDigest"))
    digest = pinned_image.rsplit("@", 1)[1]

    APP_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(APP_ROOT, 0o700)
    _write_atomic(APP_ROOT / "image", (pinned_image + "\n").encode("utf-8"), 0o600)

    secret_names = rt.get("generatedSecrets") or []
    secret_map = _load_or_create_secrets(secret_names) if secret_names else {}
    public_origin, public_host = _public_origin_parts(public_origin)
    env_bytes = _build_env_lines(
        rt.get("env"), rt.get("modelEnv"), model_key, model_base_url, model_name,
        secret_map=secret_map, public_origin=public_origin, public_host=public_host,
        raw_secrets={name: secret_map[name] for name in secret_names},
    )
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
    if "imageDigest" in rt:
        meta["imageDigest"] = rt["imageDigest"]
    _write_atomic(METADATA_PATH, (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)

    vol_flags = []
    for vol in rt["volumes"]:
        vol_flags.extend(["-v", f"hivra-app-{app_id}-{vol['name']}:{vol['mountPath']}"])
    cap_flags = ["--cap-drop", "ALL"] if rt["dropAllCaps"] else []
    port_spec = f"127.0.0.1:{rt['hostPort']}:{rt['containerPort']}"
    container_name = f"hivra-app-{app_id}"
    stop_timeout = rt["stopTimeoutSeconds"]

    image_pin = rt.get("imageDigest")
    runner_args = [
        "/usr/bin/docker", "run", "--rm",
        *(["--pull=never"] if image_pin else []),
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
        f"[[ \"$image\" == {shlex.quote(pinned_image) if image_pin else '*@sha256:*'} ]] || {{ echo 'invalid catalog app image' >&2; exit 1; }}\n"
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


def install_cli_web(spec, model_key="", model_base_url="", model_name="", public_origin=""):
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

    secret_names = rt.get("generatedSecrets") or []
    secret_map = _load_or_create_secrets(secret_names) if secret_names else {}
    public_origin, public_host = _public_origin_parts(public_origin)
    env_path = AGENT_HOME / ".hivra" / "catalog-app-model.env"
    env_bytes = _build_env_lines(
        rt.get("env"), rt.get("modelEnv"), model_key, model_base_url, model_name,
        secret_map=secret_map, public_origin=public_origin, public_host=public_host,
        raw_secrets={name: secret_map[name] for name in secret_names},
    )
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

    setup_commands = (rt.get("setup") or {}).get("commands") or []
    if setup_commands:
        # Headless upstream configuration env vars alone cannot express (e.g.
        # `zeroclaw config set`). Commands come from the curated manifest, run
        # as the unprivileged agent user with the merged env loaded, and must
        # be idempotent because the update path re-runs this install.
        merged_env = _merged_env_map(rt.get("env"), rt.get("modelEnv"), model_key, model_base_url, model_name)
        merged_env = {
            key: _substitute_env_value(str(value), secret_map, public_origin, public_host)
            for key, value in merged_env.items()
        }
        merged_env.update({name: secret_map[name] for name in secret_names})
        for command in setup_commands:
            _as_agent(["/bin/bash", "-c", command], env_extra=merged_env, timeout=300)

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


def _ensure_compose():
    """docker compose v2 is required for docker-stack runtimes. On the guest
    image it may be absent; install the distro package and verify."""
    try:
        subprocess.run(
            ["/usr/bin/docker", "compose", "version"],
            check=True, timeout=30, capture_output=True, stdin=subprocess.DEVNULL,
        )
        return
    except Exception:
        pass
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive"}
    subprocess.run(
        ["/usr/bin/apt-get", "-o", "Acquire::Retries=3", "update"],
        check=True, timeout=300, stdin=subprocess.DEVNULL, env=env,
    )
    subprocess.run(
        ["/usr/bin/apt-get", "-o", "Acquire::Retries=3", "install", "-y", "--no-install-recommends", "docker-compose-v2"],
        check=True, timeout=600, stdin=subprocess.DEVNULL, env=env,
    )
    subprocess.run(
        ["/usr/bin/docker", "compose", "version"],
        check=True, timeout=30, capture_output=True, stdin=subprocess.DEVNULL,
    )


def _yaml_scalar(value):
    """Double-quote a scalar for the rendered compose file. Restricted charset
    keeps JSON escaping identical to YAML double-quoted scalars."""
    return json.dumps(str(value))


def _compose_service_block(service, pinned_image, env_dir, app_id):
    lines = [f"  {_yaml_scalar(service['name'])}:"]
    lines.append(f"    image: {_yaml_scalar(pinned_image)}")
    lines.append("    restart: unless-stopped")
    lines.append("    security_opt:")
    lines.append('      - "no-new-privileges:true"')
    if service.get("dropAllCaps"):
        lines.append("    cap_drop:")
        lines.append('      - "ALL"')
    env_path = Path(env_dir) / f"{service['name']}.env"
    lines.append("    env_file:")
    lines.append(f"      - {_yaml_scalar(str(env_path))}")
    volumes = service.get("volumes") or []
    if volumes:
        lines.append("    volumes:")
        for vol in volumes:
            key = f"hivra-app-{app_id}-{vol['name']}"
            lines.append(f"      - {_yaml_scalar(key + ':' + vol['mountPath'])}")
    deps = service.get("dependsOn") or []
    if deps:
        lines.append("    depends_on:")
        for dep in deps:
            lines.append(f"      - {_yaml_scalar(dep)}")
    return lines


def _compose_yaml(app_id, runtime, resolve_image, env_dir):
    """Single composer for install, --render-only and the update path. The
    manifest never supplies YAML. `resolve_image(service_name)` returns the
    image ref to pin (repo@sha256:... on real installs)."""
    web = runtime["web"]
    lines = ["name: hivra-app", "services:"]
    volume_keys = []
    for service in runtime["services"]:
        pinned = resolve_image(service["name"])
        if not pinned:
            raise CatalogAppError(f"missing image for service {service['name']}")
        lines.extend(_compose_service_block(service, pinned, env_dir, app_id))
        if service["name"] == web["service"]:
            port_spec = "127.0.0.1:%s:%s" % (web["hostPort"], web["containerPort"])
            lines.append("    ports:")
            lines.append(f"      - {_yaml_scalar(port_spec)}")
        for vol in service.get("volumes") or []:
            key = f"hivra-app-{app_id}-{vol['name']}"
            if key not in volume_keys:
                volume_keys.append(key)
    if volume_keys:
        lines.append("volumes:")
        for key in volume_keys:
            lines.append(f"  {_yaml_scalar(key)}:")
            lines.append("    name: " + _yaml_scalar(key))
    lines.append("networks:")
    lines.append("  default: {}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def render_compose_yaml(app_id, runtime, digests, env_dir):
    """Install/update rendering: every image must be a pulled digest pin."""
    def resolve(name):
        pinned = digests.get(name)
        if not pinned or "@sha256:" not in pinned:
            raise CatalogAppError(f"missing pinned digest for service {name}")
        return pinned
    return _compose_yaml(app_id, runtime, resolve, env_dir)


def _stack_secret_names(runtime):
    names = []
    for service in runtime["services"]:
        for name in service.get("generatedSecrets") or []:
            if name not in names:
                names.append(name)
    return names


def _stack_env_bytes(service, secret_map, public_origin, public_host):
    static = service.get("env") or {}
    substituted = {
        key: _substitute_env_value(str(value), secret_map, public_origin, public_host)
        for key, value in static.items()
    }
    for name in service.get("generatedSecrets") or []:
        substituted[name] = secret_map[name]
    lines = [f"{key}={str(substituted[key]).replace(chr(13), '').replace(chr(10), '')}" for key in sorted(substituted)]
    return ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")


def install_docker_stack(spec, public_origin=""):
    app_id = spec["appId"]
    name = spec["name"]
    rt = spec["runtime"]
    _ensure_docker()
    _ensure_compose()

    public_origin, public_host = _public_origin_parts(public_origin)
    secret_names = _stack_secret_names(rt)
    secret_map = _load_or_create_secrets(secret_names) if secret_names else {}

    APP_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(APP_ROOT, 0o700)
    env_dir = APP_ROOT / "env"
    env_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(env_dir, 0o700)

    digests = {}
    for service in rt["services"]:
        pinned = _pull_and_resolve_digest(service["imageRepo"], service["imageTag"])
        digests[service["name"]] = pinned
        env_bytes = _stack_env_bytes(service, secret_map, public_origin, public_host)
        _write_atomic(env_dir / f"{service['name']}.env", env_bytes, 0o600)

    compose_bytes = render_compose_yaml(app_id, rt, digests, str(env_dir))
    _write_atomic(COMPOSE_PATH, compose_bytes, 0o600)

    web = rt["web"]
    meta = {
        "schema": 1,
        "appId": app_id,
        "name": name,
        "kind": "docker-stack",
        "runtime": rt,
        "digests": digests,
        "composeFile": str(COMPOSE_PATH),
        "hostPort": web["hostPort"],
        "healthPath": web["healthPath"],
        "proxyMode": web["proxyMode"],
        "unit": "hivra-catalog-app.service",
    }
    _write_atomic(METADATA_PATH, (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)

    stop_timeout = rt.get("stopTimeoutSeconds", 25)
    unit_text = (
        "[Unit]\n"
        f"Description=Hivra Catalog App ({name} stack on 127.0.0.1:{web['hostPort']})\n"
        "After=network-online.target docker.service\n"
        "Requires=docker.service\n"
        "[Service]\n"
        "TimeoutStartSec=0\n"
        f"TimeoutStopSec={stop_timeout + 30}\n"
        "Restart=always\n"
        "RestartSec=5\n"
        f"ExecStart=/usr/bin/docker compose -p hivra-app -f {shlex.quote(str(COMPOSE_PATH))} up\n"
        f"ExecStop=-/usr/bin/docker compose -p hivra-app -f {shlex.quote(str(COMPOSE_PATH))} down\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    _write_atomic(Path("/etc/systemd/system/hivra-catalog-app.service"), unit_text.encode("utf-8"), 0o644)
    subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=30, stdin=subprocess.DEVNULL)
    subprocess.run(["/usr/bin/systemctl", "enable", "--now", "hivra-catalog-app.service"], check=True, timeout=60, stdin=subprocess.DEVNULL)
    primary = digests[web["service"]]
    _record_app_version(app_id, primary.rsplit("@", 1)[1])
    return {"images": digests, "version": primary.rsplit("@", 1)[1]}


def render_only(spec_path, out_dir):
    """Write exactly what install would write, minus pulls/systemd: the env
    file(s), compose.yaml and metadata under out_dir, with a fake publicOrigin
    (payload may override) and deterministic fake secrets so output is stable
    for the verifier and tests."""
    payload = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    spec = validate_catalog_app_spec(payload.get("spec") if isinstance(payload, dict) and "spec" in payload else payload)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rt = spec["runtime"]
    public_origin = str(payload.get("publicOrigin") or "https://box-verify.example.test")
    if not _valid_public_origin(public_origin):
        raise CatalogAppError("render-only publicOrigin must be a valid https origin")
    public_origin, public_host = _public_origin_parts(public_origin)
    if rt["kind"] == "docker-web":
        names = rt.get("generatedSecrets") or []
        fake = {name: f"render-only-{name.lower()}" for name in names}
        env = _build_env_lines(
            rt.get("env"), rt.get("modelEnv"), "", "", "",
            secret_map=fake, public_origin=public_origin, public_host=public_host,
            raw_secrets=fake,
        )
        _write_atomic(out / "env", env, 0o600)
        image = f"{rt['imageRepo']}@{rt['imageDigest']}" if "imageDigest" in rt else f"{rt['imageRepo']}:{rt['imageTag']}"
        meta = {"schema": 1, "appId": spec["appId"], "name": spec["name"], "kind": "docker-web",
                "hostPort": rt["hostPort"], "healthPath": rt["healthPath"], "proxyMode": rt["proxyMode"],
                "image": image}
        _write_atomic(out / "meta.json", (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)
    elif rt["kind"] == "cli-web":
        names = rt.get("generatedSecrets") or []
        fake = {name: f"render-only-{name.lower()}" for name in names}
        env = _build_env_lines(
            rt.get("env"), rt.get("modelEnv"), "", "", "",
            secret_map=fake, public_origin=public_origin, public_host=public_host,
            raw_secrets=fake,
        )
        _write_atomic(out / "env", env, 0o600)
    else:
        env_dir = out / "env"
        env_dir.mkdir(parents=True, exist_ok=True)
        all_fake = {name: f"render-only-{name.lower()}" for name in _stack_secret_names(rt)}
        for service in rt["services"]:
            _write_atomic(env_dir / f"{service['name']}.env",
                          _stack_env_bytes(service, all_fake, public_origin, public_host), 0o600)
        refs = {service["name"]: f"{service['imageRepo']}:{service['imageTag']}" for service in rt["services"]}
        # Tag refs, not digests: render-only performs no pull. The verifier
        # pulls through compose itself; install pins digests instead.
        compose = _compose_yaml(spec["appId"], rt, lambda name: refs[name], str(env_dir))
        _write_atomic(out / "compose.yaml", compose, 0o600)
        web = rt["web"]
        meta = {"schema": 1, "appId": spec["appId"], "name": spec["name"], "kind": "docker-stack",
                "hostPort": web["hostPort"], "healthPath": web["healthPath"], "proxyMode": web["proxyMode"],
                "composeFile": str(out / "compose.yaml"), "envDir": str(env_dir)}
        _write_atomic(out / "meta.json", (json.dumps(meta, indent=2) + "\n").encode("utf-8"), 0o644)
    return {"outDir": str(out)}


def render_compose_for_update(meta_path, digests):
    """Re-render /opt/hivra-app/compose.yaml with new pinned digests for the
    updater. Env files and the secrets store are untouched: generated values
    are stable across updates by design."""
    meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
    if meta.get("kind") != "docker-stack" or not isinstance(meta.get("runtime"), dict):
        raise CatalogAppError("catalog app meta is not a docker-stack install")
    runtime = meta["runtime"]
    env_dir = str(APP_ROOT / "env")
    compose = render_compose_yaml(meta["appId"], runtime, digests, env_dir)
    _write_atomic(COMPOSE_PATH, compose, 0o600)
    return {"composeFile": str(COMPOSE_PATH)}


def main():
    parser = argparse.ArgumentParser(description="Hivra generic catalog app runner")
    parser.add_argument("action", choices=("validate", "install", "meta", "render-only", "render-compose"))
    parser.add_argument("spec_file", nargs="?")
    parser.add_argument("out_dir", nargs="?")
    args = parser.parse_args()

    if args.action == "meta":
        if not METADATA_PATH.is_file():
            sys.exit(1)
        sys.stdout.write(METADATA_PATH.read_text(encoding="utf-8"))
        return

    if args.action == "render-only":
        if not args.spec_file or not args.out_dir:
            raise CatalogAppError("render-only requires <spec.json> <outdir>")
        result = render_only(args.spec_file, args.out_dir)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return

    if args.action == "render-compose":
        raw = sys.stdin.buffer.read(MAX_SPEC_BYTES + 1)
        if not raw or len(raw) > MAX_SPEC_BYTES:
            raise CatalogAppError("catalog app payload exceeds size bound")
        digests = json.loads(raw.decode("utf-8"))
        if not isinstance(digests, dict):
            raise CatalogAppError("render-compose expects a service->image map")
        result = render_compose_for_update(METADATA_PATH, digests)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
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
    public_origin = str(payload.get("publicOrigin") or "")
    kind = spec["runtime"]["kind"]
    if kind == "docker-web":
        result = install_docker_web(spec, model_key, model_base_url, model_name, public_origin)
    elif kind == "docker-stack":
        result = install_docker_stack(spec, public_origin)
    else:
        result = install_cli_web(spec, model_key, model_base_url, model_name, public_origin)
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
