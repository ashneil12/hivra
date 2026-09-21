#!/usr/bin/env python3
"""Install the experimental, brokered Selkies X11 desktop on one guest.

This is an explicit post-provision computer-profile operation. It never runs on
the Proxmox host, never replaces the guest OS, and never enables Omarchy.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import uuid


IMAGE = "ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa"
IMAGE_INDEX_DIGEST = "sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa"
BASE_IMAGE_USER = "1000"
BASE_IMAGE_ENTRYPOINT = ["/etc/container-entrypoint.sh"]
BASE_IMAGE_COMMAND = None
BASE_IMAGE_WORKDIR = "/home/ubuntu"
DERIVED_IMAGE_USER = "ubuntu"
DERIVED_IMAGE_LABEL_PREFIX = "io.hivra.remote-desktop"
CONTAINER = "hivra-selkies-desktop"
NETWORK = "hivra-remote-desktop"
ROOT = Path("/opt/hivra/remote-desktop")
STATE = Path("/var/lib/hivra/remote-desktop")
WORKSPACE = Path("/home/bux/Hivra")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
IMAGE_ID_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
CONTROL_BYPASS_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
CONTROL_BYPASS_FILENAME = "control-bypass-secret"
CONTROL_BYPASS_PATH = ROOT / "control-protection-bypass"
# Source-bound candidate verified in the 2026-09-06 image campaign. The archive,
# OCI manifest and config digest are separate identities, not interchangeable
# Docker IDs. Other UID/GID or base-engine identities retain source derivation.
PREPARED_IMAGE = {
    "archiveSha256": "08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578",
    "archiveBytes": 4124832768,
    "manifestDigest": "sha256:ee596064f9a341a3a75841027e8d0a5f251b299ac144fab6ce7d1421f6c8a34b",
    "configDigest": "sha256:0a82b716e1e744f7344ea857bd7b69dba29500d893a40867bf13f524fb76bef0",
    "recipeSha256": "fb3ff9f7074c8f021f2470f13fff72f6fc6063be12494d0e66646f413d577b39",
    "baseImageId": "sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa",
}
PREPARED_IMAGE_DIRECTORY = Path("/var/cache/hivra/desktop-images")

SPECIAL_MODE_VALIDATOR = r"""import os,stat,sys
root=os.path.realpath(sys.argv[1]); old_uid=int(sys.argv[2]); old_gid=int(sys.argv[3]); remap_uid=sys.argv[4]=='1'; remap_gid=sys.argv[5]=='1'
expected={'/usr/local/share/fonts':('directory',0o2775,old_uid,old_gid),'/opt/google/chrome/chrome-sandbox':('regular',0o4755,old_uid,old_gid)}
actual={}; root_dev=os.lstat(root).st_dev
def kind(info):
 return 'directory' if stat.S_ISDIR(info.st_mode) else 'regular' if stat.S_ISREG(info.st_mode) else 'other'
def selected(info):
 return (remap_uid and info.st_uid==old_uid) or (remap_gid and info.st_gid==old_gid)
def inspect(path):
 info=os.lstat(path)
 if selected(info) and stat.S_IMODE(info.st_mode)&0o6000:
  relative='/' + os.path.relpath(path,root)
  actual[relative]=(kind(info),stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid)
 return info
def walk_error(error): raise error
inspect(root)
for parent,directories,files in os.walk(root,topdown=True,followlinks=False,onerror=walk_error):
 retained=[]
 for name in directories:
  info=inspect(os.path.join(parent,name))
  if info.st_dev==root_dev and not stat.S_ISLNK(info.st_mode): retained.append(name)
 directories[:]=retained
 for name in files: inspect(os.path.join(parent,name))
raise SystemExit(0 if actual==expected else 1)"""

SYMLINK_IDENTITY_REWRITER = r"""import os,stat,sys
root=os.path.realpath(sys.argv[1]); old_uid=int(sys.argv[2]); old_gid=int(sys.argv[3]); new_uid=int(sys.argv[4]); new_gid=int(sys.argv[5]); remap_uid=sys.argv[6]=='1'; remap_gid=sys.argv[7]=='1'
required=('listxattr','getxattr','setxattr','lchown','utime','replace','symlink','readlink')
if any(not callable(getattr(os,name,None)) for name in required): raise SystemExit(1)
blocked_xattrs=('trusted.overlay.','user.overlay.')
root_dev=os.lstat(root).st_dev; links=[]
def selected(info):
 return (remap_uid and info.st_uid==old_uid) or (remap_gid and info.st_gid==old_gid)
def metadata(path,info):
 target=os.readlink(path)
 names=tuple(sorted(os.listxattr(path,follow_symlinks=False)))
 if len(names)!=len(set(names)) or len(names)>64 or any(not isinstance(name,str) or not name or name.startswith(blocked_xattrs) for name in names): raise RuntimeError('unsupported xattrs')
 attrs=tuple((name,os.getxattr(path,name,follow_symlinks=False)) for name in names)
 if sum(len(value) for _,value in attrs)>1048576: raise RuntimeError('unsupported xattrs')
 return (target,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_atime_ns,info.st_mtime_ns,attrs)
def stable(value):
 target,uid,gid,mode,atime_ns,mtime_ns,attrs=value
 return (target,uid,gid,mode,mtime_ns,attrs)
def inspect(path):
 info=os.lstat(path)
 if stat.S_ISLNK(info.st_mode) and selected(info):
  if info.st_nlink!=1: raise RuntimeError('linked symlink')
  links.append((path,metadata(path,info)))
 return info
def walk_error(error): raise error
inspect(root)
for parent,directories,files in os.walk(root,topdown=True,followlinks=False,onerror=walk_error):
 retained=[]
 for name in directories:
  info=inspect(os.path.join(parent,name))
  if info.st_dev==root_dev and not stat.S_ISLNK(info.st_mode): retained.append(name)
 directories[:]=retained
 for name in files: inspect(os.path.join(parent,name))
for index,(path,before) in enumerate(sorted(links)):
 current=os.lstat(path)
 identity=(current.st_dev,current.st_ino)
 if not stat.S_ISLNK(current.st_mode) or current.st_nlink!=1 or stable(metadata(path,current))!=stable(before): raise RuntimeError('symlink changed')
 target,uid,gid,mode,atime_ns,mtime_ns,attrs=before
 mapped_uid=new_uid if remap_uid and uid==old_uid else uid; mapped_gid=new_gid if remap_gid and gid==old_gid else gid
 temporary=os.path.join(os.path.dirname(path),'.'+os.path.basename(path)+f'.hivra-identity-{os.getpid()}-{index}')
 if os.path.lexists(temporary): raise RuntimeError('temporary symlink exists')
 try:
  os.symlink(target,temporary)
  os.lchown(temporary,mapped_uid,mapped_gid)
  if os.readlink(temporary)!=target: raise RuntimeError('symlink target mismatch')
  for name,value in attrs: os.setxattr(temporary,name,value,follow_symlinks=False)
  names=tuple(sorted(os.listxattr(temporary,follow_symlinks=False)))
  if names!=tuple(name for name,_ in attrs) or any(os.getxattr(temporary,name,follow_symlinks=False)!=value for name,value in attrs): raise RuntimeError('symlink xattr mismatch')
  os.utime(temporary,ns=(atime_ns,mtime_ns),follow_symlinks=False)
  candidate=os.lstat(temporary)
  actual=(candidate.st_uid,candidate.st_gid,stat.S_IMODE(candidate.st_mode),candidate.st_atime_ns,candidate.st_mtime_ns)
  if not stat.S_ISLNK(candidate.st_mode) or candidate.st_nlink!=1 or actual!=(mapped_uid,mapped_gid,mode,atime_ns,mtime_ns): raise RuntimeError('temporary symlink mismatch')
  current=os.lstat(path)
  if (current.st_dev,current.st_ino)!=identity or current.st_nlink!=1 or stable(metadata(path,current))!=stable(before): raise RuntimeError('symlink changed')
  os.replace(temporary,path)
  if os.path.lexists(temporary) or os.readlink(path)!=target: raise RuntimeError('symlink replace mismatch')
  names=tuple(sorted(os.listxattr(path,follow_symlinks=False)))
  if names!=tuple(name for name,_ in attrs) or any(os.getxattr(path,name,follow_symlinks=False)!=value for name,value in attrs): raise RuntimeError('symlink xattr mismatch')
  os.utime(path,ns=(atime_ns,mtime_ns),follow_symlinks=False)
  after=os.lstat(path)
  actual=(after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode),after.st_atime_ns,after.st_mtime_ns)
  if not stat.S_ISLNK(after.st_mode) or after.st_nlink!=1 or actual!=(mapped_uid,mapped_gid,mode,atime_ns,mtime_ns): raise RuntimeError('symlink rewrite mismatch')
 except BaseException:
  try:
   if os.path.lexists(temporary): os.unlink(temporary)
  finally: raise"""


def run(
    command: list[str],
    *,
    check: bool = True,
    capture: bool = False,
    stage: str | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    safe_stage = stage or Path(command[0]).name.replace("-", "_")
    try:
        result = subprocess.run(
            command,
            check=False,
            text=True,
            input=input_text,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            # Package managers and Docker emit progress on stderr. Capture it
            # inside the guest so the bounded host runner receives only the
            # final, allowlisted stage receipt. Never echo command arguments or
            # stdin: one readiness probe consumes Basic auth through curl config.
            stderr=subprocess.PIPE,
            timeout=15 * 60,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{safe_stage}_timeout") from None
    if check and result.returncode != 0:
        raise RuntimeError(f"{safe_stage}_failed")
    return result


def origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or value != f"https://{parsed.netloc}"
    ):
        raise ValueError("origin must be one canonical HTTPS origin")
    return value


def checked_desktop_identity(uid: int, gid: int) -> tuple[int, int]:
    # Self-managed guests may legitimately assign uid/gid 1000 to bux. The
    # desktop can retain that numeric identity without a filesystem rewrite;
    # any higher ordinary uid/gid is mapped explicitly below.
    if (
        isinstance(uid, bool)
        or isinstance(gid, bool)
        or not isinstance(uid, int)
        or not isinstance(gid, int)
        or uid < 1000
        or gid < 1000
        or uid > 60000
        or gid > 60000
    ):
        raise RuntimeError("desktop_identity_unsafe")
    return uid, gid


def identity_image_recipe(uid: int, gid: int) -> str:
    uid, gid = checked_desktop_identity(uid, gid)
    # No context, COPY, ADD, package manager or network access is permitted in
    # this derivation. The exact pulled base supplies every byte. Remap all
    # root-filesystem inodes bearing the old numeric identity so the named
    # Ubuntu desktop remains coherent after its uid/gid changes. Admit only the
    # two reviewed base-image special-mode inodes because chown would otherwise
    # silently clear their bits; restore and verify them after the rewrite.
    remap_uid = uid != 1000
    remap_gid = gid != 1000
    steps = [
        "set -eu",
        '[ "$(/usr/bin/id -u ubuntu)" = "1000" ]',
        '[ "$(/usr/bin/id -g ubuntu)" = "1000" ]',
        'passwd_rows="$(/usr/bin/getent passwd)"',
        "printf '%s\\n' \"$passwd_rows\" | /usr/bin/awk -F: '($1==\"ubuntu\" || $3==\"1000\") { seen+=1; if (NF==7 && $1==\"ubuntu\" && $3==\"1000\" && $4==\"1000\" && $6==\"/home/ubuntu\") valid+=1 } END { exit !(seen==1 && valid==1) }'",
        'group_rows="$(/usr/bin/getent group)"',
        "printf '%s\\n' \"$group_rows\" | /usr/bin/awk -F: '($1==\"ubuntu\" || $3==\"1000\") { seen+=1; if (NF==4 && $1==\"ubuntu\" && $3==\"1000\") valid+=1 } END { exit !(seen==1 && valid==1) }'",
    ]
    if remap_uid:
        steps.extend([
            "set +e",
            f'target_passwd="$(/usr/bin/getent passwd {uid} 2>/dev/null)"',
            "target_passwd_status=$?",
            "set -e",
            '[ "$target_passwd_status" = "2" ]',
            '[ -z "$target_passwd" ]',
            f'target_uid_inode="$(/usr/bin/find / -xdev -uid {uid} -print -quit 2>/dev/null)"',
            '[ -z "$target_uid_inode" ]',
        ])
    if remap_gid:
        steps.extend([
            "set +e",
            f'target_group="$(/usr/bin/getent group {gid} 2>/dev/null)"',
            "target_group_status=$?",
            "set -e",
            '[ "$target_group_status" = "2" ]',
            '[ -z "$target_group" ]',
            f'target_gid_inode="$(/usr/bin/find / -xdev -gid {gid} -print -quit 2>/dev/null)"',
            '[ -z "$target_gid_inode" ]',
        ])
    if remap_uid or remap_gid:
        steps.extend([
            "identity_fail() { printf 'HIVRA_DESKTOP_IDENTITY_BUILD_FAILURE %s\\n' \"$1\" >&2; exit 1; }",
            "/usr/bin/python3 -c "
            + shlex.quote("exec(" + repr(SPECIAL_MODE_VALIDATOR) + ")")
            + f" / 1000 1000 {int(remap_uid)} {int(remap_gid)}"
            + " || identity_fail special_mode_contract",
        ])
    if remap_gid:
        steps.append(f"/usr/sbin/groupmod -g {gid} ubuntu")
    usermod = []
    if remap_uid:
        usermod.extend(["-u", str(uid)])
    if remap_gid:
        usermod.extend(["-g", str(gid)])
    if usermod:
        steps.append("/usr/sbin/usermod " + " ".join(usermod) + " ubuntu")
    if remap_uid or remap_gid:
        steps.append(
            "/usr/bin/python3 -c "
            + shlex.quote("exec(" + repr(SYMLINK_IDENTITY_REWRITER) + ")")
            + f" / 1000 1000 {uid} {gid} {int(remap_uid)} {int(remap_gid)}"
            + " || identity_fail symlink_identity_rewrite"
        )
    if remap_uid:
        steps.extend([
            f"/usr/bin/find / -xdev -uid 1000 -exec /usr/bin/chown -h {uid} {{}} +",
            'remaining_uid="$(/usr/bin/find / -xdev -uid 1000 -print -quit 2>/dev/null)"',
            '[ -z "$remaining_uid" ]',
        ])
    if remap_gid:
        steps.extend([
            f"/usr/bin/find / -xdev -gid 1000 -exec /usr/bin/chgrp -h {gid} {{}} +",
            'remaining_gid="$(/usr/bin/find / -xdev -gid 1000 -print -quit 2>/dev/null)"',
            '[ -z "$remaining_gid" ]',
        ])
    if remap_uid or remap_gid:
        steps.extend([
            "/usr/bin/chmod 2775 /usr/local/share/fonts || identity_fail special_mode_restore",
            "/usr/bin/chmod 4755 /opt/google/chrome/chrome-sandbox || identity_fail special_mode_restore",
            f'[ ! -L /usr/local/share/fonts ] && [ -d /usr/local/share/fonts ] && [ "$(/usr/bin/stat -Lc \'%a:%u:%g\' /usr/local/share/fonts)" = "2775:{uid}:{gid}" ] || identity_fail special_mode_restore',
            f'[ ! -L /opt/google/chrome/chrome-sandbox ] && [ -f /opt/google/chrome/chrome-sandbox ] && [ "$(/usr/bin/stat -Lc \'%a:%u:%g\' /opt/google/chrome/chrome-sandbox)" = "4755:{uid}:{gid}" ] || identity_fail special_mode_restore',
        ])
    steps.extend([
        f'[ "$(/usr/bin/id -u ubuntu)" = "{uid}" ]',
        f'[ "$(/usr/bin/id -g ubuntu)" = "{gid}" ]',
    ])
    return (
        f"FROM {IMAGE}\nUSER 0\nRUN "
        + "; \\\n    ".join(steps)
        + "\nUSER ubuntu\n"
    )


def inspect_image(reference: str, stage: str) -> dict[str, object]:
    result = run(
        ["/usr/bin/docker", "image", "inspect", reference],
        capture=True,
        stage=stage,
    )
    try:
        documents = json.loads(result.stdout)
    except (TypeError, ValueError):
        raise RuntimeError(f"{stage}_invalid") from None
    if len(documents) != 1 or not isinstance(documents[0], dict):
        raise RuntimeError(f"{stage}_invalid")
    return documents[0]


def exact_image_config(document: dict[str, object], *, derived: bool) -> dict[str, object]:
    config = document.get("Config")
    if not isinstance(config, dict):
        raise RuntimeError("desktop_image_config_invalid")
    expected_user = DERIVED_IMAGE_USER if derived else BASE_IMAGE_USER
    if (
        document.get("Os") != "linux"
        or document.get("Architecture") != "amd64"
        or not isinstance(document.get("Id"), str)
        or not IMAGE_ID_RE.fullmatch(str(document["Id"]))
        or config.get("User") != expected_user
        or config.get("Entrypoint") != BASE_IMAGE_ENTRYPOINT
        or config.get("Cmd") is not BASE_IMAGE_COMMAND
        or config.get("WorkingDir") != BASE_IMAGE_WORKDIR
        or config.get("Volumes") is not None
    ):
        raise RuntimeError("desktop_image_config_invalid")
    return config


def exact_image_layers(document: dict[str, object]) -> list[str]:
    rootfs = document.get("RootFS")
    if not isinstance(rootfs, dict) or rootfs.get("Type") != "layers":
        raise RuntimeError("desktop_image_layers_invalid")
    layers = rootfs.get("Layers")
    if (
        not isinstance(layers, list)
        or not layers
        or any(not isinstance(layer, str) or not IMAGE_ID_RE.fullmatch(layer) for layer in layers)
    ):
        raise RuntimeError("desktop_image_layers_invalid")
    return layers


def build_identity_image(uid: int, gid: int) -> dict[str, object]:
    uid, gid = checked_desktop_identity(uid, gid)
    base = inspect_image(IMAGE, "desktop_base_image_inspect")
    base_config = exact_image_config(base, derived=False)
    base_layers = exact_image_layers(base)
    repo_digests = base.get("RepoDigests")
    if not isinstance(repo_digests, list) or IMAGE not in repo_digests:
        raise RuntimeError("desktop_base_image_digest_mismatch")
    recipe = identity_image_recipe(uid, gid)
    recipe_sha256 = hashlib.sha256(recipe.encode("utf-8")).hexdigest()
    local_tag = f"hivra/selkies-egl-desktop:uid-{uid}-gid-{gid}-{recipe_sha256[:16]}"
    labels = {
        f"{DERIVED_IMAGE_LABEL_PREFIX}.base-index-digest": IMAGE_INDEX_DIGEST,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.base-image-id": str(base["Id"]),
        f"{DERIVED_IMAGE_LABEL_PREFIX}.identity-recipe-sha256": recipe_sha256,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-user": DERIVED_IMAGE_USER,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-uid": str(uid),
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-gid": str(gid),
    }
    command = [
        "/usr/bin/docker", "build", "--pull=false", "--network=none",
        "--tag", local_tag,
    ]
    for key, value in sorted(labels.items()):
        command.extend(["--label", f"{key}={value}"])
    command.append("-")
    build = run(
        command,
        check=False,
        capture=True,
        input_text=recipe,
        stage="desktop_identity_image_build",
    )
    if build.returncode != 0:
        output = f"{build.stdout or ''}\n{build.stderr or ''}"
        for reason in (
            "special_mode_contract",
            "symlink_identity_rewrite",
            "special_mode_restore",
        ):
            if f"HIVRA_DESKTOP_IDENTITY_BUILD_FAILURE {reason}" in output:
                raise RuntimeError(f"desktop_identity_image_build_{reason}_failed")
        raise RuntimeError("desktop_identity_image_build_failed")
    derived = inspect_image(local_tag, "desktop_identity_image_inspect")
    return identity_image_receipt(base, derived, uid, gid, labels, recipe_sha256)


def identity_image_receipt(base, derived, uid, gid, labels, recipe_sha256):
    base_config = exact_image_config(base, derived=False)
    base_layers = exact_image_layers(base)
    derived_config = exact_image_config(derived, derived=True)
    image_labels = derived_config.get("Labels")
    base_labels = base_config.get("Labels")
    if base_labels is None:
        base_labels = {}
    expected_labels = {**base_labels, **labels} if isinstance(base_labels, dict) else None
    base_unchanged = {key: value for key, value in base_config.items() if key not in ("User", "Labels")}
    derived_unchanged = {key: value for key, value in derived_config.items() if key not in ("User", "Labels")}
    derived_layers = exact_image_layers(derived)
    expected_layer_counts = {len(base_layers) + 1}
    if uid == 1000 and gid == 1000:
        # Some builders omit a filesystem layer for the identity-only no-op RUN.
        expected_layer_counts.add(len(base_layers))
    if (
        not isinstance(image_labels, dict)
        or image_labels != expected_labels
        or derived_unchanged != base_unchanged
        or derived_layers[:len(base_layers)] != base_layers
        or len(derived_layers) not in expected_layer_counts
    ):
        raise RuntimeError("desktop_identity_image_mismatch")
    return {
        "baseImage": IMAGE,
        "baseImageIndexDigest": IMAGE_INDEX_DIGEST,
        "baseImageId": base["Id"],
        "runtimeImageId": derived["Id"],
        "identityRecipeSha256": recipe_sha256,
        "desktopUser": DERIVED_IMAGE_USER,
        "desktopUid": uid,
        "desktopGid": gid,
    }


def open_prepared_image_archive():
    """Only root-owned, non-writable ancestry; no symlink or special-file input."""
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in PREPARED_IMAGE_DIRECTORY.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                return None
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("desktop_prepared_archive_parent_unsafe")
        try:
            fd = os.open(PREPARED_IMAGE["archiveSha256"] + ".tar",
                         os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        archive = os.fdopen(fd, "rb")
        info = os.fstat(archive.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            archive.close()
            raise RuntimeError("desktop_prepared_archive_unsafe")
        return archive
    finally:
        os.close(directory)


def resolve_identity_image(uid: int, gid: int) -> dict[str, object]:
    uid, gid = checked_desktop_identity(uid, gid)
    recipe_sha256 = hashlib.sha256(identity_image_recipe(uid, gid).encode()).hexdigest()
    if (uid, gid) != (1001, 1001) or recipe_sha256 != PREPARED_IMAGE["recipeSha256"]:
        return build_identity_image(uid, gid)
    archive = open_prepared_image_archive()
    if archive is None:
        return build_identity_image(uid, gid)
    with archive:
        before = os.fstat(archive.fileno())
        digest = hashlib.sha256()
        for chunk in iter(lambda: archive.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
        after = os.fstat(archive.fileno())
        signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if (before.st_size != PREPARED_IMAGE["archiveBytes"]
                or signature(before) != signature(after)
                or digest.hexdigest() != PREPARED_IMAGE["archiveSha256"]):
            raise RuntimeError("desktop_prepared_archive_mismatch")
        base = inspect_image(IMAGE, "desktop_base_image_inspect")
        exact_image_config(base, derived=False)
        if IMAGE not in (base.get("RepoDigests") or []):
            raise RuntimeError("desktop_base_image_digest_mismatch")
        # The existing capability ABI binds base-image-id to the local engine.
        # Do not rewrite that label or weaken it for a different storage backend.
        if base["Id"] != PREPARED_IMAGE["baseImageId"]:
            return build_identity_image(uid, gid)
        archive.seek(0)
        try:
            result = subprocess.run(["/usr/bin/docker", "image", "load"], stdin=archive,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    timeout=900, check=False,
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        except (subprocess.SubprocessError, OSError):
            raise RuntimeError("desktop_prepared_image_load_failed") from None
        if result.returncode != 0 or signature(before) != signature(os.fstat(archive.fileno())):
            raise RuntimeError("desktop_prepared_image_load_failed")
    # Storage backends need not resolve config digests as image references.
    # Select an exact pinned ID from the daemon's full-ID inventory instead of
    # guessing a lookup alias or parsing the free-form `docker load` output.
    # Containerd-backed Docker can hide an untagged imported image from the
    # default list. Include it without relaxing either pinned-ID check below.
    inventory = run(["/usr/bin/docker", "image", "ls", "--all", "--no-trunc", "--quiet"],
                    capture=True, stage="desktop_prepared_image_inventory").stdout.splitlines()
    if any(not IMAGE_ID_RE.fullmatch(value) for value in inventory):
        raise RuntimeError("desktop_prepared_image_inventory_invalid")
    reference = next((value for value in (PREPARED_IMAGE["manifestDigest"], PREPARED_IMAGE["configDigest"])
                      if value in inventory), None)
    if reference is None:
        raise RuntimeError("desktop_prepared_image_identity_missing")
    derived = inspect_image(reference, "desktop_prepared_image_inspect")
    if derived.get("Id") not in (PREPARED_IMAGE["configDigest"], PREPARED_IMAGE["manifestDigest"]):
        raise RuntimeError("desktop_prepared_image_identity_mismatch")
    labels = {
        f"{DERIVED_IMAGE_LABEL_PREFIX}.base-index-digest": IMAGE_INDEX_DIGEST,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.base-image-id": str(base["Id"]),
        f"{DERIVED_IMAGE_LABEL_PREFIX}.identity-recipe-sha256": recipe_sha256,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-user": DERIVED_IMAGE_USER,
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-uid": str(uid),
        f"{DERIVED_IMAGE_LABEL_PREFIX}.desktop-gid": str(gid),
    }
    return identity_image_receipt(base, derived, uid, gid, labels, recipe_sha256)


def verify_workspace_identity(runtime_image_id: str, uid: int, gid: int) -> None:
    uid, gid = checked_desktop_identity(uid, gid)
    if not IMAGE_ID_RE.fullmatch(runtime_image_id):
        raise RuntimeError("desktop_runtime_image_invalid")
    probe_name = f".hivra-desktop-identity-{secrets.token_hex(24)}"
    workspace_fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        workspace_info = os.fstat(workspace_fd)
        if (
            not stat.S_ISDIR(workspace_info.st_mode)
            or workspace_info.st_uid != uid
            or workspace_info.st_gid != gid
            or stat.S_IMODE(workspace_info.st_mode) != 0o700
        ):
            raise RuntimeError("desktop_workspace_identity_mismatch")
        container_path = f"/home/ubuntu/Hivra/{probe_name}"
        command = (
            f"set -eu; [ \"$(/usr/bin/id -u)\" = \"{uid}\" ]; "
            f"[ \"$(/usr/bin/id -g)\" = \"{gid}\" ]; "
            "[ \"$(/usr/bin/id -un)\" = ubuntu ]; umask 077; "
            f": > {container_path}"
        )
        run([
            "/usr/bin/docker", "run", "--rm", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--mount", f"type=bind,src={WORKSPACE},dst=/home/ubuntu/Hivra",
            "--entrypoint", "/bin/bash", runtime_image_id, "-c", command,
        ], stage="desktop_workspace_identity_probe")
        info = os.stat(probe_name, dir_fd=workspace_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != uid
            or info.st_gid != gid
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise RuntimeError("desktop_workspace_identity_mismatch")
    finally:
        try:
            os.unlink(probe_name, dir_fd=workspace_fd)
        except FileNotFoundError:
            pass
        os.close(workspace_fd)


def write_private(path: Path, value: str, *, uid: int = 0, gid: int = 0, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(12)}.tmp")
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        payload = value.encode("utf-8")
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise OSError("private file write did not advance")
            offset += written
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def read_control_bypass_secret(path_value: str | None, source: Path) -> str:
    if path_value is None:
        return ""
    path = Path(path_value)
    try:
        if (
            not path.is_absolute()
            or path.name != CONTROL_BYPASS_FILENAME
            or path.parent.resolve(strict=True) != source
        ):
            raise ValueError("control_bypass_file_invalid")
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except (OSError, ValueError):
        raise ValueError("control_bypass_file_invalid") from None
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise ValueError("control_bypass_file_invalid")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            payload = stream.read(257)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            path.unlink()
        except OSError:
            raise RuntimeError("control_bypass_file_cleanup_failed") from None
    try:
        secret = payload.decode("ascii")
    except UnicodeDecodeError:
        raise ValueError("control_bypass_secret_invalid") from None
    if not CONTROL_BYPASS_SECRET_RE.fullmatch(secret):
        raise ValueError("control_bypass_secret_invalid")
    return secret


def verify_control_origin_access(control_origin: str, secret: str) -> None:
    if not secret:
        return
    result = run(
        [
            "/usr/bin/curl",
            "--config", "-",
            "--silent", "--show-error",
            "--output", "/dev/null",
            "--write-out", "%{http_code}",
            "--connect-timeout", "5",
            "--max-time", "10",
            "--proto", "=https",
            f"{control_origin}/api/remote-desktop/sessions/exchange",
        ],
        check=False,
        capture=True,
        stage="control_origin_bypass_probe",
        input_text=f'header = "x-vercel-protection-bypass: {secret}"\n',
    )
    # This route exports POST only, so a direct GET reaching Next.js is 405.
    # Vercel protection responses (including 302/401) must never look ready.
    if result.returncode != 0 or result.stdout.strip() != "405":
        raise RuntimeError("control_origin_bypass_probe_failed")


class PreparedGuest:
    """Private in-process handoff, never a readiness receipt or journal payload.

    Includes a credential: do not serialize/log this value. Provider recovery
    must validate retained private files instead of repeating preparation.
    """

    __slots__ = ("source", "broker_source", "server_source", "node_binary",
                 "docker_env_path", "broker_env_path", "runtime_image_id",
                 "image_identity", "public_origin", "broker_gid", "isolation_path", "basic_pair", "network_id")

    def __init__(self, *, source: Path, broker_source: Path, server_source: Path,
                 node_binary: str, docker_env_path: Path, broker_env_path: Path,
                 runtime_image_id: str, image_identity: dict[str, object],
                 public_origin: str, broker_gid: int, isolation_path: Path, basic_pair: str, network_id: str | None = None):
        self.source = source
        self.broker_source = broker_source
        self.server_source = server_source
        self.node_binary = node_binary
        self.docker_env_path = docker_env_path
        self.broker_env_path = broker_env_path
        self.runtime_image_id = runtime_image_id
        self.image_identity = image_identity
        self.public_origin = public_origin
        self.broker_gid = broker_gid
        self.isolation_path = isolation_path
        self.basic_pair = basic_pair
        self.network_id = network_id


def prepare_guest(args: argparse.Namespace, *, network_preparer=None) -> PreparedGuest:
    """Prepare guest assets/credentials; does not create or start the desktop.

    Docker itself may be installed/started. This is not an idempotent provider
    recovery entrypoint: credentials rotate here. Only the original worker's
    once-only preparation phase may eventually call it for provider guests.
    network_preparer is an in-process locked-worker callback, never a CLI field.
    """
    if os.geteuid() != 0:
        raise RuntimeError("installer must run as root")
    if network_preparer is not None and not callable(network_preparer):
        raise ValueError("invalid private network preparer")
    if args.computer_kind not in {"hermes-instance", "hivra-agent"} or not UUID_RE.fullmatch(args.computer_id):
        raise ValueError("computer identity is invalid")
    control_origin = origin(args.control_origin)
    public_origin = origin(args.public_origin)
    node_binary = shutil.which("node", path="/usr/local/bin:/usr/bin:/bin")
    if node_binary is None or not Path(node_binary).is_file():
        raise RuntimeError("node_runtime_unavailable")
    source = Path(args.source_dir).resolve(strict=True)
    broker_source = source / "broker.cjs"
    server_source = source / "server.cjs"
    for candidate in (broker_source, server_source):
        if not candidate.is_file() or candidate.is_symlink():
            raise ValueError("remote desktop source closure is incomplete")
    control_bypass_secret = read_control_bypass_secret(args.control_bypass_file, source)
    verify_control_origin_access(control_origin, control_bypass_secret)

    if run(["/usr/bin/id", "hivra-desktop-broker"], check=False).returncode != 0:
        run(["/usr/sbin/useradd", "--system", "--home-dir", str(STATE), "--shell", "/usr/sbin/nologin", "hivra-desktop-broker"])
    identity = run(["/usr/bin/id", "-u", "hivra-desktop-broker"], capture=True)
    group = run(["/usr/bin/id", "-g", "hivra-desktop-broker"], capture=True)
    broker_uid = int(identity.stdout.strip())
    broker_gid = int(group.stdout.strip())
    bux_uid = int(run(["/usr/bin/id", "-u", "bux"], capture=True, stage="bux_uid").stdout.strip())
    bux_gid = int(run(["/usr/bin/id", "-g", "bux"], capture=True, stage="bux_gid").stdout.strip())

    if run(["/usr/bin/which", "docker"], check=False).returncode != 0:
        run(["/usr/bin/apt-get", "update"])
        run(["/usr/bin/apt-get", "install", "-y", "docker.io"])
    run(["/usr/bin/systemctl", "enable", "--now", "docker"])
    run(["/usr/bin/systemctl", "is-active", "--quiet", "docker"])

    opt_root = Path("/opt")
    hivra_root = Path("/opt/hivra")
    for parent in (opt_root, hivra_root):
        if parent.is_symlink():
            raise RuntimeError("immutable_parent_unsafe")
        parent.mkdir(exist_ok=True, mode=0o755)
        parent_info = os.lstat(parent)
        if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != 0 or parent_info.st_mode & 0o022:
            raise RuntimeError("immutable_parent_unsafe")
    if ROOT.is_symlink():
        raise RuntimeError("immutable_root_unsafe")
    ROOT.mkdir(exist_ok=True, mode=0o755)
    os.chown(ROOT, 0, 0)
    os.chmod(ROOT, 0o755)
    root_info = os.lstat(ROOT)
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != 0 or stat.S_IMODE(root_info.st_mode) != 0o755:
        raise RuntimeError("immutable_root_unsafe")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(STATE, broker_uid, broker_gid)
    bux_home = WORKSPACE.parent
    try:
        home_info = os.lstat(bux_home)
    except OSError:
        raise RuntimeError("bux_home_unsafe") from None
    if (
        not stat.S_ISDIR(home_info.st_mode)
        or home_info.st_uid != bux_uid
        or home_info.st_mode & 0o022
    ):
        raise RuntimeError("bux_home_unsafe")
    try:
        workspace_info = os.lstat(WORKSPACE)
    except FileNotFoundError:
        WORKSPACE.mkdir(mode=0o700)
        os.chown(WORKSPACE, bux_uid, bux_gid)
        workspace_info = os.lstat(WORKSPACE)
    except OSError:
        raise RuntimeError("bux_workspace_unsafe") from None
    if not stat.S_ISDIR(workspace_info.st_mode) or workspace_info.st_uid != bux_uid:
        raise RuntimeError("bux_workspace_unsafe")
    os.chown(WORKSPACE, bux_uid, bux_gid)
    os.chmod(WORKSPACE, 0o700)
    workspace_info = os.lstat(WORKSPACE)
    if (
        not stat.S_ISDIR(workspace_info.st_mode)
        or workspace_info.st_uid != bux_uid
        or workspace_info.st_gid != bux_gid
        or stat.S_IMODE(workspace_info.st_mode) != 0o700
    ):
        raise RuntimeError("bux_workspace_unsafe")

    # Prove the exact image and mounted workspace identity before replacing any
    # installed broker code, bypass material, or loopback credentials. A failed
    # derivation therefore leaves the currently running desktop configuration
    # untouched and can be inspected or retried from a fresh operation.
    run(["/usr/bin/docker", "pull", IMAGE], stage="docker_pull")
    image_identity = resolve_identity_image(bux_uid, bux_gid)
    runtime_image_id = str(image_identity["runtimeImageId"])
    verify_workspace_identity(runtime_image_id, bux_uid, bux_gid)

    for source_file in (broker_source, server_source):
        destination = ROOT / source_file.name
        destination.write_bytes(source_file.read_bytes())
        os.chmod(destination, 0o644)
        os.chown(destination, 0, 0)

    if control_bypass_secret:
        write_private(CONTROL_BYPASS_PATH, control_bypass_secret, uid=0, gid=broker_gid, mode=0o640)
    else:
        try:
            CONTROL_BYPASS_PATH.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            raise RuntimeError("control_bypass_file_cleanup_failed") from None

    username = f"hivra-{secrets.token_urlsafe(12)}"
    password = secrets.token_urlsafe(32)
    basic_pair = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", basic_pair):
        raise RuntimeError("basic_auth_encoding_invalid")
    basic_path = STATE / "basic-auth.b64"
    docker_env_path = STATE / "selkies.env"
    broker_env_path = STATE / "broker.env"
    # These are installation trust anchors, not broker runtime state. Keep them
    # in the root-owned program directory so the unprivileged broker cannot
    # unlink or replace them merely because it owns STATE for sessions.json.
    isolation_path = ROOT / "input-isolation"
    state_path = STATE / "sessions.json"
    write_private(basic_path, basic_pair + "\n", uid=broker_uid, gid=broker_gid)
    write_private(docker_env_path, "\n".join([
        f"SELKIES_BASIC_AUTH_USER={username}",
        f"SELKIES_BASIC_AUTH_PASSWORD={password}",
        "SELKIES_ENABLE_BASIC_AUTH=true",
        "SELKIES_ENABLE_HTTPS=false",
        "SELKIES_MODE=websockets",
        "SELKIES_WAYLAND=false",
        # HQ is the product default. The authenticated handoff broker can
        # lower this live to the 12 Mbps Performance profile without exposing
        # the Selkies control channel or restarting the desktop.
        "SELKIES_FRAMERATE=60",
        "SELKIES_VIDEO_BITRATE=25000",
        # Selkies sizes the X11 framebuffer in browser CSS pixels. A 192 DPI
        # desktop therefore makes controls twice their expected on-screen size
        # when the browser already performs its own HiDPI scaling. Keep the
        # guest at 96 DPI so a 1080p browser viewport has 1080p usable space.
        "SELKIES_SCALING_DPI=96",
        "SELKIES_USE_CSS_SCALING=true|locked",
        # Keep capture, RandR monitor and CRTC dimensions identical. CVT rounds
        # unaligned widths; Qt 6.10 then misses the Plasma screen-geometry signal.
        # Lock the supported setting so older browser preferences cannot undo it.
        "SELKIES_FORCE_ALIGNED_RESOLUTION=true|locked",
        "SELKIES_COMMAND_ENABLED=false",
        "SELKIES_ENABLE_CLIPBOARD=false",
        "SELKIES_ENABLE_BINARY_CLIPBOARD=false",
        "SELKIES_AUDIO_ENABLED=false",
        "SELKIES_MICROPHONE_ENABLED=false",
        "SELKIES_GAMEPAD_ENABLED=false",
        "SELKIES_WEBCAM_ENABLED=false",
        "SELKIES_FILE_TRANSFERS=none",
    ]) + "\n")
    broker_environment = [
        f"HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN={control_origin}",
        f"HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN={public_origin}",
        f"HIVRA_REMOTE_DESKTOP_COMPUTER_KIND={args.computer_kind}",
        f"HIVRA_REMOTE_DESKTOP_COMPUTER_ID={args.computer_id}",
        "HIVRA_REMOTE_DESKTOP_TRANSPORT=selkies-websocket",
        "HIVRA_REMOTE_DESKTOP_UPSTREAM_PORT=8088",
        "HIVRA_REMOTE_DESKTOP_BROKER_PORT=8090",
        f"HIVRA_REMOTE_DESKTOP_BASIC_AUTH_FILE={basic_path}",
        f"HIVRA_REMOTE_DESKTOP_STATE_FILE={state_path}",
        f"HIVRA_REMOTE_DESKTOP_INPUT_ISOLATION_FILE={isolation_path}",
    ]
    if control_bypass_secret:
        broker_environment.append(
            f"HIVRA_REMOTE_DESKTOP_CONTROL_BYPASS_FILE={CONTROL_BYPASS_PATH}"
        )
    write_private(broker_env_path, "\n".join(broker_environment) + "\n", uid=0, gid=broker_gid, mode=0o640)

    network_id = prepare_guest_network(network_preparer)

    return PreparedGuest(
        source=source, broker_source=broker_source, server_source=server_source,
        node_binary=node_binary, docker_env_path=docker_env_path,
        broker_env_path=broker_env_path, runtime_image_id=runtime_image_id,
        image_identity=image_identity, public_origin=public_origin,
        broker_gid=broker_gid, isolation_path=isolation_path, basic_pair=basic_pair, network_id=network_id,
    )


def read_private_at(directory_fd, name, uid, gid, mode):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid or before.st_gid != gid
                or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != mode or before.st_size > 16384):
            raise RuntimeError("unsafe provider private file")
        raw = os.read(fd, 16385)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        if len(raw) != before.st_size or any(getattr(before, key) != getattr(after, key) for key in fields):
            raise RuntimeError("provider private file changed")
        return raw
    finally:
        os.close(fd)


def read_provider_files():
    if os.geteuid() != 0:
        raise RuntimeError("provider configuration requires root")
    broker = pwd.getpwnam("hivra-desktop-broker")
    if broker.pw_uid <= 0 or broker.pw_gid <= 0:
        raise RuntimeError("invalid provider broker identity")
    for parent in reversed((STATE.parent, *STATE.parent.parents)):
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("unsafe provider state ancestry")
    fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != broker.pw_uid or info.st_gid != broker.pw_gid
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError("unsafe provider state directory")
        return {
            "desktop": read_private_at(fd, "selkies.env", 0, 0, 0o600),
            "broker": read_private_at(fd, "broker.env", 0, broker.pw_gid, 0o640),
            "basic": read_private_at(fd, "basic-auth.b64", broker.pw_uid, broker.pw_gid, 0o600),
        }
    finally:
        os.close(fd)


def private_environment(raw):
    if not isinstance(raw, bytes) or len(raw) > 16384 or not raw.endswith(b"\n"):
        raise ValueError("invalid private environment")
    result = {}
    for line in raw.decode("ascii").splitlines():
        name, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name) or name in result or "\0" in value:
            raise ValueError("invalid private environment")
        result[name] = value
    return result


def read_provider_configuration(args):
    """Return private desktop env bytes only after broker/credential agreement.

    No mutation, rotation or readiness claim. The worker must also verify these
    bytes against the original environment intent and actual stopped container.
    Never print/serialize the return value or captured private files.
    """
    try:
        if args.computer_kind != "hivra-agent" or not UUID_RE.fullmatch(args.computer_id):
            raise ValueError()
        control_origin, public_origin = origin(args.control_origin), origin(args.public_origin)
        if args.control_bypass_file is not None or os.path.lexists(CONTROL_BYPASS_PATH):
            raise ValueError()
        files = read_provider_files()
        desktop = private_environment(files["desktop"])
        expected_basic = base64.b64encode((desktop["SELKIES_BASIC_AUTH_USER"] + ":" + desktop["SELKIES_BASIC_AUTH_PASSWORD"]).encode("ascii")) + b"\n"
        if files["basic"] != expected_basic:
            raise ValueError()
        expected_broker = {
            "HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN": control_origin,
            "HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN": public_origin,
            "HIVRA_REMOTE_DESKTOP_COMPUTER_KIND": "hivra-agent",
            "HIVRA_REMOTE_DESKTOP_COMPUTER_ID": args.computer_id,
            "HIVRA_REMOTE_DESKTOP_TRANSPORT": "selkies-websocket",
            "HIVRA_REMOTE_DESKTOP_UPSTREAM_PORT": "8088",
            "HIVRA_REMOTE_DESKTOP_BROKER_PORT": "8090",
            "HIVRA_REMOTE_DESKTOP_BASIC_AUTH_FILE": str(STATE / "basic-auth.b64"),
            "HIVRA_REMOTE_DESKTOP_STATE_FILE": str(STATE / "sessions.json"),
            "HIVRA_REMOTE_DESKTOP_INPUT_ISOLATION_FILE": str(ROOT / "input-isolation"),
        }
        if private_environment(files["broker"]) != expected_broker:
            raise ValueError()
        return files["desktop"]
    except Exception:
        raise RuntimeError("Provider desktop configuration could not be verified") from None


def prepare_guest_network(network_preparer):
    if network_preparer is not None:
        # Provider ownership/unknown outcomes are handled by the original locked
        # journal. Do not fall back to name-based creation when it fails.
        identity = network_preparer()
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise RuntimeError("provider network identity could not be verified")
        return identity
    network_inspect = run(["/usr/bin/docker", "network", "inspect", NETWORK], check=False)
    if network_inspect.returncode != 0:
        run(
            ["/usr/bin/docker", "network", "create", "--driver", "bridge", "--label", "hivra.remote-desktop=v1", NETWORK],
            stage="docker_network_create",
        )
    return None


def activate_managed_guest(args: argparse.Namespace, prepared: PreparedGuest) -> dict[str, object]:
    """Existing managed activation. Provider workers must not use this path."""
    if prepared.network_id is not None:
        raise RuntimeError("provider desktop requires its owned activation path")
    node_binary = prepared.node_binary
    docker_env_path = prepared.docker_env_path
    broker_env_path = prepared.broker_env_path
    runtime_image_id = prepared.runtime_image_id
    selkies_unit = f"""[Unit]
Description=Hivra contained Selkies X11 desktop
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm --force {CONTAINER}
ExecStart=/usr/bin/docker run --rm --name {CONTAINER} --network {NETWORK} --publish 127.0.0.1:8088:8080 --env-file {docker_env_path} --cpus 2 --memory 4g --shm-size 2g --pids-limit 2048 --security-opt no-new-privileges --mount type=bind,src={WORKSPACE},dst=/home/ubuntu/Hivra {runtime_image_id}
ExecStop=/usr/bin/docker stop --time 10 {CONTAINER}
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
"""
    broker_unit = f"""[Unit]
Description=Hivra remote desktop session broker
After=network-online.target hivra-selkies-desktop.service
Requires=hivra-selkies-desktop.service

[Service]
Type=simple
User=hivra-desktop-broker
Group=hivra-desktop-broker
EnvironmentFile={broker_env_path}
ExecStart={node_binary} {ROOT / 'server.cjs'}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={STATE}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/hivra-selkies-desktop.service").write_text(selkies_unit, encoding="utf-8")
    Path("/etc/systemd/system/hivra-remote-desktop-broker.service").write_text(broker_unit, encoding="utf-8")
    os.chmod("/etc/systemd/system/hivra-selkies-desktop.service", 0o644)
    os.chmod("/etc/systemd/system/hivra-remote-desktop-broker.service", 0o644)

    run(["/usr/bin/systemctl", "daemon-reload"])
    # `enable --now` starts an inactive unit but deliberately leaves an active
    # one untouched. Every install rotates the loopback credential and may
    # replace broker code, so an idempotent retry must explicitly restart both
    # services or the container/broker keep stale runtime state.
    run(["/usr/bin/systemctl", "enable", "hivra-selkies-desktop.service"], stage="selkies_service_enable")
    run(["/usr/bin/systemctl", "enable", "hivra-remote-desktop-broker.service"], stage="broker_service_enable")
    run(["/usr/bin/systemctl", "restart", "hivra-selkies-desktop.service"], stage="selkies_service_start")
    run(["/usr/bin/systemctl", "restart", "hivra-remote-desktop-broker.service"], stage="broker_service_start")
    run(["/usr/bin/systemctl", "restart", "bux-hivra-chat.service"], stage="chat_service_restart")
    return verify_guest(args, prepared)


def verify_provider_running_identity(inspected: object, container_id: str, network_id: str) -> None:
    if not isinstance(inspected, dict):
        raise RuntimeError("provider running desktop identity could not be verified")
    networks = inspected.get("NetworkSettings", {}).get("Networks")
    state = inspected.get("State", {})
    if (inspected.get("Id") != container_id or inspected.get("Name") != "/" + CONTAINER
            or state.get("Running") is not True
            or any(state.get(key) is not False for key in ("Paused", "Restarting", "Dead"))
            or not isinstance(networks, dict) or set(networks) != {NETWORK}
            or not isinstance(networks[NETWORK], dict) or networks[NETWORK].get("NetworkID") != network_id):
        raise RuntimeError("provider running desktop identity could not be verified")


def verify_guest(args: argparse.Namespace, prepared: PreparedGuest, *, container_id: str | None = None) -> dict[str, object]:
    """Verify running guest access and publish capability, never start services.

    Provider callers supply the exact container ID from original ownership,
    under their still-held operation/cleanup fence. Internal probes are not
    browser acceptance or authority to release that operation.
    """
    if os.geteuid() != 0:
        raise RuntimeError("guest readiness requires root")
    network_id = prepared.network_id
    if network_id is None:
        if container_id is not None:
            raise RuntimeError("invalid desktop readiness identity")
    elif (not isinstance(network_id, str) or not re.fullmatch(r"[0-9a-f]{64}", network_id)
          or not isinstance(container_id, str) or not re.fullmatch(r"[0-9a-f]{64}", container_id)):
        raise RuntimeError("invalid desktop readiness identity")
    source = prepared.source
    broker_source = prepared.broker_source
    server_source = prepared.server_source
    runtime_image_id = prepared.runtime_image_id
    image_identity = prepared.image_identity
    public_origin = prepared.public_origin
    broker_gid = prepared.broker_gid
    isolation_path = prepared.isolation_path
    basic_pair = prepared.basic_pair
    if network_id is not None:
        desktop = private_environment(read_provider_configuration(args))
        actual_basic = base64.b64encode((desktop["SELKIES_BASIC_AUTH_USER"] + ":" + desktop["SELKIES_BASIC_AUTH_PASSWORD"]).encode("ascii")).decode("ascii")
        if actual_basic != basic_pair or public_origin != origin(args.public_origin):
            raise RuntimeError("provider readiness configuration changed")
    for unit in ("hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service"):
        run(["/usr/bin/systemctl", "is-active", "--quiet", unit], stage=f"service_active_{unit.split('.')[0].replace('-', '_')}")

    # systemd considers the service active as soon as `docker run` is its live
    # ExecStart process. The named container can still be between creation and
    # an entrypoint restart at that instant, so an immediate `docker inspect`
    # is a race. Converge on an inspectable, running container before checking
    # the immutable isolation boundary. A crash loop remains fail-closed.
    container_deadline = time.monotonic() + 120
    inspected = None
    while True:
        container_result = run(
            ["/usr/bin/docker", "inspect", container_id if network_id is not None else CONTAINER],
            check=False,
            capture=True,
            stage="docker_container_inspect",
        )
        if container_result.returncode == 0:
            try:
                candidate = json.loads(container_result.stdout)[0]
            except (ValueError, TypeError, IndexError):
                candidate = None
            if isinstance(candidate, dict) and candidate.get("State", {}).get("Running") is True:
                inspected = candidate
                break
        if time.monotonic() >= container_deadline:
            raise RuntimeError("selkies_container_readiness_timeout")
        time.sleep(2)
    assert inspected is not None
    binding = inspected.get("NetworkSettings", {}).get("Ports", {}).get("8080/tcp")
    groups = run(["/usr/bin/id", "-nG", "bux"], capture=True).stdout.split()
    broker_groups = run(["/usr/bin/id", "-nG", "hivra-desktop-broker"], capture=True).stdout.split()
    mounts = inspected.get("Mounts", [])
    isolated = (
        inspected.get("Image") == runtime_image_id
        and inspected.get("Config", {}).get("Image") == runtime_image_id
        and inspected.get("Config", {}).get("User") == DERIVED_IMAGE_USER
        and inspected.get("HostConfig", {}).get("Privileged") is False
        and inspected.get("HostConfig", {}).get("NetworkMode") == (network_id if network_id is not None else NETWORK)
        and binding == [{"HostIp": "127.0.0.1", "HostPort": "8088"}]
        and "docker" not in groups
        and "docker" not in broker_groups
        and all(mount.get("Destination") != "/var/run/docker.sock" for mount in mounts)
        and mounts == [{
            "Type": "bind",
            "Source": str(WORKSPACE),
            "Destination": "/home/ubuntu/Hivra",
            "Mode": "",
            "RW": True,
            "Propagation": "rprivate",
        }]
    )
    if not isolated:
        raise RuntimeError("Selkies input isolation could not be verified")
    if network_id is not None:
        verify_provider_running_identity(inspected, container_id, network_id)
    write_private(isolation_path, "selkies-container-no-agent-input-v1\n", uid=0, gid=broker_gid, mode=0o640)

    run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "10", "-H", f"Host: {urllib.parse.urlsplit(public_origin).netloc}", "http://127.0.0.1:8090/healthz"], stage="broker_health")
    # systemd becomes active when Docker starts the container, before Selkies'
    # protected HTTP listener is necessarily ready. Converge on the actual
    # security contract rather than treating process state as socket readiness.
    authenticated_curl_config = f'header = "Authorization: Basic {basic_pair}"\n'
    deadline = time.monotonic() + 120
    while True:
        unauthorized = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "5", "http://127.0.0.1:8088/"], check=False, capture=True, stage="selkies_unauthorized_probe")
        # Feed the root-only credential through curl config stdin. Putting it
        # in argv would expose it to an untrusted process polling /proc.
        authenticated = run(["/usr/bin/curl", "--config", "-", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "5", "http://127.0.0.1:8088/"], check=False, capture=True, stage="selkies_authenticated_probe", input_text=authenticated_curl_config)
        if unauthorized.returncode == 0 and unauthorized.stdout.strip() == "401" and authenticated.returncode == 0 and authenticated.stdout.strip() == "200":
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("selkies_readiness_timeout")
        time.sleep(2)

    revision = hashlib.sha256(
        (source / "install-guest.py").read_bytes()
        + b"\0"
        + broker_source.read_bytes()
        + b"\0"
        + server_source.read_bytes()
        + b"\0"
        + IMAGE.encode("ascii")
    ).hexdigest()
    capability = {
        "protocol": "hivra-remote-desktop-installed-v1",
        "computerKind": args.computer_kind,
        "computerId": args.computer_id,
        "capabilityGeneration": str(uuid.uuid4()),
        "observedRevision": revision,
        "compositor": "x11",
        "installedTransports": ["selkies-websocket"],
        "privateNetworkReachable": False,
        "supportsInputTakeover": True,
        "brokerOrigin": public_origin,
        **image_identity,
        "inputIsolation": "selkies-container-no-agent-input-v1",
    }
    if network_id is not None:
        # HTTP convergence can outlive the initial process observation. Do not
        # publish from stale evidence, restart anything, or retry an outage.
        for unit in ("hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service"):
            run(["/usr/bin/systemctl", "is-active", "--quiet", unit], stage="provider_final_service_active")
        result = run(["/usr/bin/docker", "inspect", container_id], capture=True, stage="provider_final_container_inspect")
        try:
            final = json.loads(result.stdout)
        except (ValueError, TypeError):
            final = None
        if not isinstance(final, list) or len(final) != 1:
            raise RuntimeError("provider running desktop identity could not be verified")
        verify_provider_running_identity(final[0], container_id, network_id)
    write_private(ROOT / "capability.json", json.dumps(capability, sort_keys=True, separators=(",", ":")) + "\n")
    return capability


def install(args: argparse.Namespace) -> dict[str, object]:
    # Keep the existing CLI's managed preparation/activation order unchanged.
    return activate_managed_guest(args, prepare_guest(args))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--computer-kind", required=True)
    parser.add_argument("--computer-id", required=True)
    parser.add_argument("--control-origin", required=True)
    parser.add_argument("--public-origin", required=True)
    parser.add_argument("--control-bypass-file")
    parser.add_argument("--source-dir", default=str(Path(__file__).resolve().parent))
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({
            "protocol": "hivra-remote-desktop-install-plan-v1",
            "computerKind": args.computer_kind,
            "computerId": args.computer_id,
            "controlOrigin": origin(args.control_origin),
            "publicOrigin": origin(args.public_origin),
            "transport": "selkies-websocket",
            "image": IMAGE,
            "mutatesGuest": False,
        }, sort_keys=True))
        return
    capability = install(args)
    print("HIVRA_REMOTE_DESKTOP_INSTALLED " + json.dumps({
        "protocol": capability["protocol"],
        "computerKind": capability["computerKind"],
        "computerId": capability["computerId"],
        "capabilityGeneration": capability["capabilityGeneration"],
        "observedRevision": capability["observedRevision"],
        "transport": "selkies-websocket",
    }, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"remote desktop install failed: {error}", file=sys.stderr)
        raise SystemExit(1)
