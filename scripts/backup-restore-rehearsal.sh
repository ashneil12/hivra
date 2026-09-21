#!/usr/bin/env bash
# Local-only HermesOS backup/restore rehearsal.
# Safe defaults: no prod, no customer data, no secrets, no remote storage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_ROOT="${HERMESOS_BACKUP_REHEARSAL_DIR:-/workspace/.hermesos-backup-rehearsals}"
RUN_DIR="$OUT_ROOT/$TS"
SRC_DIR="$RUN_DIR/source"
RESTORE_DIR="$RUN_DIR/restore"
REPORT="$RUN_DIR/report.md"
ARCHIVE="$RUN_DIR/hermesos-canary-control-plane-sample.tar.gz"
MANIFEST="$RUN_DIR/manifest.sha256"

mkdir -p "$SRC_DIR" "$RESTORE_DIR"
chmod 700 "$RUN_DIR"

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [ -e "$ROOT/$src" ]; then
    mkdir -p "$(dirname "$SRC_DIR/$dest")"
    cp -a "$ROOT/$src" "$SRC_DIR/$dest"
  fi
}

copy_specs_sample() {
  local dest="$SRC_DIR/docs/superpowers/specs"
  mkdir -p "$dest"
  find "$ROOT/docs/superpowers/specs" -maxdepth 1 -type f \
    ! -iname '*secret*' \
    ! -iname '*credential*' \
    ! -iname '*key*' \
    -print0 | while IFS= read -r -d '' file; do
      cp -a "$file" "$dest/$(basename "$file")"
    done
}

# Non-secret, canary-control-plane sample only.
copy_specs_sample
copy_if_exists "dashboard/package.json" "dashboard/package.json"
copy_if_exists "dashboard/package-lock.json" "dashboard/package-lock.json"
copy_if_exists "dashboard/scripts/generate-migrations-manifest.cjs" "dashboard/scripts/generate-migrations-manifest.cjs"
copy_if_exists "dashboard/src/lib/subscription.ts" "dashboard/src/lib/subscription.ts"
copy_if_exists "dashboard/src/lib/services/tier-specs.ts" "dashboard/src/lib/services/tier-specs.ts"

# Guardrails: fail if accidental secret-looking files enter the rehearsal source.
if find "$SRC_DIR" -type f \( -name '.env*' -o -name '*secret*' -o -name '*key*' -o -name '*.pem' -o -name '*.p12' \) | grep -q .; then
  echo "Refusing rehearsal: source contains secret-looking file names" >&2
  find "$SRC_DIR" -type f \( -name '.env*' -o -name '*secret*' -o -name '*key*' -o -name '*.pem' -o -name '*.p12' \) >&2
  exit 2
fi

( cd "$SRC_DIR" && tar -czf "$ARCHIVE" . )
sha256sum "$ARCHIVE" > "$MANIFEST"
tar -xzf "$ARCHIVE" -C "$RESTORE_DIR"

# Verify restored files match original sample tree.
( cd "$SRC_DIR" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$RUN_DIR/source.files.sha256"
( cd "$RESTORE_DIR" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$RUN_DIR/restore.files.sha256"
sed 's#  ./#  #' "$RUN_DIR/source.files.sha256" > "$RUN_DIR/source.normalized.sha256"
sed 's#  ./#  #' "$RUN_DIR/restore.files.sha256" > "$RUN_DIR/restore.normalized.sha256"
diff -u "$RUN_DIR/source.normalized.sha256" "$RUN_DIR/restore.normalized.sha256" > "$RUN_DIR/diff.txt" || {
  echo "Restore verification failed; see $RUN_DIR/diff.txt" >&2
  exit 3
}

FILE_COUNT="$(find "$SRC_DIR" -type f | wc -l | tr -d ' ')"
ARCHIVE_BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
ARCHIVE_SHA="$(cut -d' ' -f1 "$MANIFEST")"
cat > "$REPORT" <<EOF_REPORT
# HermesOS Backup Restore Rehearsal

Status: passed
Timestamp: $TS
Scope: local-only canary control-plane sample
Source: $ROOT
Run dir: $RUN_DIR
Archive: $ARCHIVE
Archive bytes: $ARCHIVE_BYTES
Archive sha256: $ARCHIVE_SHA
File count: $FILE_COUNT

## Safety

- No prod target touched.
- No remote storage touched.
- No customer data selected.
- Secret-looking file names are rejected before archive creation.

## Verification

- Archive created.
- Archive checksum written.
- Archive restored into fresh local directory.
- Restored file checksums matched source sample.

## Next real gate

Remote encrypted backup still needs:

1. Hetzner Storage Box target.
2. age recipient or key escrow decision.
3. canary restore drill window/scope approval.
EOF_REPORT

printf '%s\n' "$REPORT"
