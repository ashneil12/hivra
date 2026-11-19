#!/usr/bin/env bash
# reencrypt-cold-archive.sh — turn ONE plain cold archive on the Storage Box into an
# age-encrypted one, then (only when told to) remove the plain copy.
#
# Run from a PVE host that has the `cold` ssh alias.
#
#   reencrypt-cold-archive.sh <remote-path> --expected-sha256=<hex> [mode]
#
# <remote-path> is a PLAIN archive path, one of
#   free|paid/<instance-uuid>/data-<ts>.tar.zst          (manifest meta/<uuid>/<ts>.json)
#   daily/paid/<instance-uuid>/vzdump-qemu-<vmid>-<ts>.vma.zst
#                                                         (manifest daily-meta/<uuid>/<ts>.json)
# --expected-sha256 is the plain sha256 recorded in the manifest or the DB row.
#
# Modes (default is a dry run that changes nothing, locally or remotely):
#   (none)                    dry run: validate, probe the remote read-only, print the plan.
#   --apply                   steps 1-7 below, ending with the plain copy deleted.
#   --apply --keep-plain      steps 1-6 only. The plain copy stays. Used by the dashboard
#                             sweep, which deletes the plain copy in a SECOND step only after
#                             the DB row points at the encrypted file.
#   --delete-plain --enc-sha256=<hex> --enc-size=<n>
#                             step 7 on its own: confirms the encrypted copy and the updated
#                             manifest on the Storage Box, then deletes the plain copy.
#
# --apply order (the plain copy is never touched before step 7):
#   1. download the plain archive to scratch
#   2. check its sha256 against --expected-sha256
#   3. age -r $HERMES_BACKUP_AGE_RECIPIENT  (plain removed from scratch)
#   4. upload as <path>.age
#   5. verify: remote size (ls -l) AND the full sha256 of a fresh re-download
#      (the Storage Box shell is restricted: no pipes, no remote hashing is assumed;
#       only ls, cat, mkdir, rm are used remotely)
#   6. write the updated manifest (path -> .age, sha/size of the ENCRYPTED file,
#      "encryption": "age", "plain_sha256")
#   7. delete the plain archive
#
# Re-running is safe: if the .age copy and a manifest that already describes it exist,
# the script verifies them and resumes instead of re-encrypting.
#
# Final machine-readable line (stdout):
#   REENCRYPT_RESULT plain=<path> enc=<path>.age enc_sha256=<hex> enc_size=<n> plain_sha256=<hex> plain_deleted=<0|1> manifest=<path> resumed=<0|1>
#
# Exit codes:
#   0 ok   1 usage   2 unsafe path   3 sha mismatch (archive or manifest)
#   4 plain archive missing / download failed   5 not enough scratch space
#   6 upload or verification failed (plain copy untouched)   7 age not installed
#   8 missing/invalid recipient   9 age failed   10 manifest read/write failed
#   11 deleting the plain copy failed   12 --delete-plain refused (encrypted copy
#   or manifest not confirmed; nothing deleted)
#
# Env: HERMES_BACKUP_AGE_RECIPIENT (public age1... key; required for --apply and dry run),
#      HERMES_REENCRYPT_SCRATCH_ROOT (default /var/tmp),
#      HERMES_REENCRYPT_SCRATCH_SLACK_MB (default 256). Scratch needs 2x the archive + slack.

set -euo pipefail

usage() {
  echo "usage: $0 <remote-path> --expected-sha256=<hex> [--apply [--keep-plain] | --delete-plain --enc-sha256=<hex> --enc-size=<n>]" >&2
  exit 1
}

PLAIN_PATH="${1:-}"
[ -n "$PLAIN_PATH" ] || usage
shift

APPLY=0
KEEP_PLAIN=0
DELETE_PLAIN=0
EXPECTED_SHA=""
ENC_SHA_ARG=""
ENC_SIZE_ARG=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --keep-plain) KEEP_PLAIN=1 ;;
    --delete-plain) DELETE_PLAIN=1 ;;
    --expected-sha256=*) EXPECTED_SHA="${arg#*=}" ;;
    --enc-sha256=*) ENC_SHA_ARG="${arg#*=}" ;;
    --enc-size=*) ENC_SIZE_ARG="${arg#*=}" ;;
    *) usage ;;
  esac
done
if [ "$APPLY" = 1 ] && [ "$DELETE_PLAIN" = 1 ]; then usage; fi
if [ "$KEEP_PLAIN" = 1 ] && [ "$APPLY" != 1 ]; then usage; fi

# ── path safety: strict allow-list, same shape as the retention code ──
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
KIND=""
MANIFEST_PATH=""
if [[ "$PLAIN_PATH" =~ ^(free|paid)/($UUID_RE)/data-([0-9A-Za-z_-]{8,32})\.tar\.zst$ ]]; then
  KIND=cold
  MANIFEST_PATH="meta/${BASH_REMATCH[2]}/${BASH_REMATCH[3]}.json"
  PATH_KEY=archive_path; SHA_KEY=archive_sha256; SIZE_KEY=archive_size_bytes
elif [[ "$PLAIN_PATH" =~ ^daily/paid/($UUID_RE)/vzdump-qemu-[0-9]+-([0-9]{8}T[0-9]{6}Z)\.vma\.zst$ ]]; then
  KIND=daily
  MANIFEST_PATH="daily-meta/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}.json"
  PATH_KEY=backup_path; SHA_KEY=backup_sha256; SIZE_KEY=backup_size_bytes
else
  echo "REFUSING_REENCRYPT_UNSAFE_PATH: not an allowed plain archive path" >&2
  exit 2
fi
ENC_PATH="$PLAIN_PATH.age"

if ! [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]]; then
  echo "REFUSING_REENCRYPT_BAD_ARGS: --expected-sha256 must be 64 lowercase hex characters" >&2
  exit 1
fi
if [ "$DELETE_PLAIN" = 1 ]; then
  if ! [[ "$ENC_SHA_ARG" =~ ^[0-9a-f]{64}$ ]] || ! [[ "$ENC_SIZE_ARG" =~ ^[0-9]+$ ]]; then
    echo "REFUSING_REENCRYPT_BAD_ARGS: --delete-plain needs --enc-sha256=<hex> and --enc-size=<n>" >&2
    exit 1
  fi
fi

if [ "$DELETE_PLAIN" != 1 ]; then
  RECIPIENT="${HERMES_BACKUP_AGE_RECIPIENT:-}"
  if ! [[ "$RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]]; then
    echo "REFUSING_REENCRYPT_BAD_AGE_RECIPIENT: HERMES_BACKUP_AGE_RECIPIENT is missing or not an age1... public key; nothing was changed" >&2
    exit 8
  fi
  if ! command -v age >/dev/null 2>&1; then
    echo "REFUSING_REENCRYPT_NO_AGE: the age binary is not installed on $(hostname); nothing was changed" >&2
    exit 7
  fi
fi

SCRATCH_ROOT="${HERMES_REENCRYPT_SCRATCH_ROOT:-/var/tmp}"
SLACK_MB="${HERMES_REENCRYPT_SCRATCH_SLACK_MB:-256}"
if ! [[ "$SLACK_MB" =~ ^[0-9]+$ ]]; then
  echo "invalid HERMES_REENCRYPT_SCRATCH_SLACK_MB=$SLACK_MB" >&2
  exit 1
fi

# Remote helpers. Only commands the restricted Storage Box shell is already known to
# run in this repo's scripts: ls, cat, rm. No pipes or compound commands run remotely.
remote_size() { # prints the byte size, or nothing when the file is missing/unreachable
  ssh cold "ls -l -- '$1'" 2>/dev/null | awk 'NF >= 5 { print $5; exit }' || true
}

SCRATCH=""
cleanup() { [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT

PLAIN_SIZE="$(remote_size "$PLAIN_PATH")"
ENC_REMOTE_SIZE="$(remote_size "$ENC_PATH")"

if [ "$APPLY" != 1 ] && [ "$DELETE_PLAIN" != 1 ]; then
  echo "DRY_RUN reencrypt kind=$KIND plain=$PLAIN_PATH plain_size=${PLAIN_SIZE:-missing} enc_present=$([ -n "$ENC_REMOTE_SIZE" ] && echo yes || echo no)"
  echo "would: download plain -> verify sha256 == expected -> age encrypt -> upload $ENC_PATH -> verify size + re-download sha"
  echo "would: write manifest $MANIFEST_PATH (path -> .age, encrypted sha/size, encryption=age, plain_sha256)"
  echo "would: delete $PLAIN_PATH only after all of the above (with --apply and without --keep-plain)"
  exit 0
fi

SCRATCH="$(mktemp -d "$SCRATCH_ROOT/hermes-reencrypt-XXXXXX")"
MF_PY="$SCRATCH/mf.py"
cat > "$MF_PY" <<'PY'
import json, sys
# inspect <manifest> <plain> <enc> <path_key> <sha_key> <size_key> <expected_plain_sha>
#   prints "plain" when the manifest still describes the plain archive,
#   "enc <size> <sha>" when it already describes the age copy; exit 3 otherwise.
# update <manifest> <enc> <path_key> <sha_key> <size_key> <plain_sha> <new_size> <new_sha> <out>
mode = sys.argv[1]
try:
    m = json.load(open(sys.argv[2]))
    assert isinstance(m, dict)
except Exception as e:
    print("unreadable manifest: %s" % e, file=sys.stderr); sys.exit(2)
if mode == "inspect":
    plain, enc, pk, sk, zk, exp = sys.argv[3:9]
    if m.get(pk) == plain and m.get(sk) == exp and "encryption" not in m:
        print("plain"); sys.exit(0)
    if m.get(pk) == enc and m.get("encryption") == "age" and m.get("plain_sha256") == exp \
            and isinstance(m.get(zk), int) and isinstance(m.get(sk), str):
        print("enc %d %s" % (m[zk], m[sk])); sys.exit(0)
    print("manifest does not match the archive path/sha", file=sys.stderr); sys.exit(3)
if mode == "update":
    enc, pk, sk, zk, plain_sha, size, sha, out = sys.argv[3:11]
    m[pk] = enc
    m[sk] = sha
    m[zk] = int(size)
    m["encryption"] = "age"
    m["plain_sha256"] = plain_sha
    json.dump(m, open(out, "w"), indent=2); open(out, "a").write("\n")
    sys.exit(0)
sys.exit(2)
PY

fetch_manifest() { # -> $SCRATCH/manifest.json, returns non-zero when unreadable
  ssh cold "cat -- '$MANIFEST_PATH'" > "$SCRATCH/manifest.json" 2>/dev/null && [ -s "$SCRATCH/manifest.json" ]
}
mf() { python3 "$MF_PY" "$@"; }

print_result() { # plain_deleted resumed
  echo "REENCRYPT_RESULT plain=$PLAIN_PATH enc=$ENC_PATH enc_sha256=$ENC_SHA enc_size=$ENC_SIZE plain_sha256=$EXPECTED_SHA plain_deleted=$1 manifest=$MANIFEST_PATH resumed=$2"
}

# ── --delete-plain: confirm the encrypted copy + manifest, then delete the plain copy ──
if [ "$DELETE_PLAIN" = 1 ]; then
  REFUSE="REFUSING_DELETE_PLAIN: encrypted copy or manifest not confirmed on the Storage Box; nothing was deleted"
  fetch_manifest || { echo "$REFUSE (manifest unreadable)" >&2; exit 12; }
  STATE="$(mf inspect "$SCRATCH/manifest.json" "$PLAIN_PATH" "$ENC_PATH" "$PATH_KEY" "$SHA_KEY" "$SIZE_KEY" "$EXPECTED_SHA" 2>/dev/null)" \
    || { echo "$REFUSE (manifest does not describe the encrypted copy)" >&2; exit 12; }
  [ "$STATE" = "enc $ENC_SIZE_ARG $ENC_SHA_ARG" ] || { echo "$REFUSE (manifest sha/size differ from the arguments)" >&2; exit 12; }
  [ "$ENC_REMOTE_SIZE" = "$ENC_SIZE_ARG" ] || { echo "$REFUSE (remote size ${ENC_REMOTE_SIZE:-missing} != $ENC_SIZE_ARG)" >&2; exit 12; }
  if ! ssh cold "rm -f -- '$PLAIN_PATH'" >/dev/null; then
    echo "failed to delete $PLAIN_PATH" >&2
    exit 11
  fi
  ENC_SHA="$ENC_SHA_ARG"; ENC_SIZE="$ENC_SIZE_ARG"
  print_result 1 0
  exit 0
fi

# ── --apply ──
fetch_manifest || { echo "cannot read manifest $MANIFEST_PATH; nothing was changed" >&2; exit 10; }
MSTATE="$(mf inspect "$SCRATCH/manifest.json" "$PLAIN_PATH" "$ENC_PATH" "$PATH_KEY" "$SHA_KEY" "$SIZE_KEY" "$EXPECTED_SHA" 2>&1)" || {
  echo "REFUSING_REENCRYPT_SHA_MISMATCH: manifest $MANIFEST_PATH does not match the expected sha/path ($MSTATE); nothing was changed" >&2
  exit 3
}

ENC_SHA=""
ENC_SIZE=""
RESUMED=0
if [[ "$MSTATE" == enc\ * ]]; then
  # A previous run already uploaded the encrypted copy and rewrote the manifest.
  # Verify that copy for real before relying on it.
  read -r _ ENC_SIZE ENC_SHA <<< "$MSTATE"
  [ "$ENC_REMOTE_SIZE" = "$ENC_SIZE" ] || { echo "resume: remote size ${ENC_REMOTE_SIZE:-missing} != manifest $ENC_SIZE; nothing was changed" >&2; exit 6; }
  rsync -a -e ssh "cold:$ENC_PATH" "$SCRATCH/resume.age" || { echo "resume: download failed" >&2; exit 6; }
  [ "$(sha256sum "$SCRATCH/resume.age" | awk '{print $1}')" = "$ENC_SHA" ] || { echo "resume: encrypted copy sha differs from manifest; nothing was changed" >&2; exit 6; }
  RESUMED=1
  echo "RESUME encrypted copy already uploaded and verified"
else
  if [ -z "$PLAIN_SIZE" ] || [ "$PLAIN_SIZE" = 0 ]; then
    echo "plain archive $PLAIN_PATH is missing on the Storage Box; nothing was changed" >&2
    exit 4
  fi
  AVAIL_KB="$(df -Pk "$SCRATCH" 2>/dev/null | awk 'NR == 2 { print $4+0 }')"
  NEED_BYTES=$(( PLAIN_SIZE * 2 + SLACK_MB * 1024 * 1024 ))
  if ! [[ "${AVAIL_KB:-}" =~ ^[0-9]+$ ]] || [ $(( AVAIL_KB * 1024 )) -lt "$NEED_BYTES" ]; then
    echo "REFUSING_REENCRYPT_NO_SCRATCH_SPACE: need ${NEED_BYTES} bytes in $SCRATCH, have $(( ${AVAIL_KB:-0} * 1024 )); nothing was changed" >&2
    exit 5
  fi

  # 1. download
  echo "downloading $PLAIN_PATH ($PLAIN_SIZE bytes)"
  rsync -a --partial -e ssh "cold:$PLAIN_PATH" "$SCRATCH/plain" || { echo "download failed; nothing was changed" >&2; exit 4; }
  # 2. sha
  GOT_SHA="$(sha256sum "$SCRATCH/plain" | awk '{print $1}')"
  if [ "$GOT_SHA" != "$EXPECTED_SHA" ]; then
    echo "REFUSING_REENCRYPT_SHA_MISMATCH: downloaded archive sha256 $GOT_SHA != expected $EXPECTED_SHA; nothing was changed" >&2
    exit 3
  fi
  # 3. encrypt, then drop the plain scratch copy
  if ! age -r "$RECIPIENT" -o "$SCRATCH/enc.age" "$SCRATCH/plain" || [ ! -s "$SCRATCH/enc.age" ]; then
    echo "age encryption failed; nothing was uploaded" >&2
    exit 9
  fi
  rm -f "$SCRATCH/plain"
  ENC_SIZE="$(stat -c %s "$SCRATCH/enc.age")"
  ENC_SHA="$(sha256sum "$SCRATCH/enc.age" | awk '{print $1}')"
  # 4. upload (a stale partial .age from an earlier failed run is safe to overwrite:
  #    the manifest did not describe it, so nothing references it)
  if ! rsync -a --inplace --partial -e ssh "$SCRATCH/enc.age" "cold:$ENC_PATH"; then
    ssh cold "rm -f -- '$ENC_PATH'" >/dev/null 2>&1 || true
    echo "upload failed; plain copy untouched" >&2
    exit 6
  fi
  # 5. verify size and full content
  if [ "$(remote_size "$ENC_PATH")" != "$ENC_SIZE" ]; then
    echo "uploaded size mismatch; plain copy untouched" >&2
    exit 6
  fi
  if ! rsync -a -e ssh "cold:$ENC_PATH" "$SCRATCH/verify.age" || [ "$(sha256sum "$SCRATCH/verify.age" | awk '{print $1}')" != "$ENC_SHA" ]; then
    echo "uploaded sha mismatch on re-download; plain copy untouched" >&2
    exit 6
  fi
  # 6. manifest (written only after the encrypted copy is confirmed)
  mf update "$SCRATCH/manifest.json" "$ENC_PATH" "$PATH_KEY" "$SHA_KEY" "$SIZE_KEY" "$EXPECTED_SHA" "$ENC_SIZE" "$ENC_SHA" "$SCRATCH/manifest.new.json" \
    || { echo "manifest rewrite failed; plain copy untouched" >&2; exit 10; }
  rsync -a -e ssh "$SCRATCH/manifest.new.json" "cold:$MANIFEST_PATH" \
    || { echo "manifest upload failed; plain copy untouched" >&2; exit 10; }
  # confirm the manifest landed
  fetch_manifest && [ "$(mf inspect "$SCRATCH/manifest.json" "$PLAIN_PATH" "$ENC_PATH" "$PATH_KEY" "$SHA_KEY" "$SIZE_KEY" "$EXPECTED_SHA" 2>/dev/null)" = "enc $ENC_SIZE $ENC_SHA" ] \
    || { echo "manifest not confirmed after upload; plain copy untouched" >&2; exit 10; }
fi

# 7. delete the plain copy: only after the encrypted copy and manifest are confirmed above
if [ "$KEEP_PLAIN" = 1 ]; then
  print_result 0 "$RESUMED"
  exit 0
fi
if ! ssh cold "rm -f -- '$PLAIN_PATH'" >/dev/null; then
  echo "failed to delete $PLAIN_PATH (encrypted copy and manifest are in place)" >&2
  exit 11
fi
print_result 1 "$RESUMED"
