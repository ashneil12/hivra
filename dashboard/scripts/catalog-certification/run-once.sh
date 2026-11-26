#!/usr/bin/env bash
# Certify one universal-catalog launch against the exact public Canary revision.
# Serial by design: one paid customer-visible computer at a time. Never promotes.
set -euo pipefail
umask 077

REPO="${CERT_REPO:-$HOME/Projects/Hivra-public-canary}"
WORKTREE="${CERT_WORKTREE:-$HOME/Worktrees/hivra/catalog-certification-runner}"
STATE="${CERT_STATE:-$HOME/.local/state/hivra-catalog-certification}"
HOST="${CERT_CANARY_HOST:-canary.hermesos.cloud}"
OWNER="${CERT_GH_OWNER:-ashneil12}"
GH_REPO="${CERT_GH_REPO:-hivra}"
REF="${CERT_GH_REF:-canary}"
SCOPE="${HIVRA_VERCEL_SCOPE:-${VERCEL_SCOPE:-}}"
PROJECT_ID="${HIVRA_CANARY_VERCEL_PROJECT_ID:-}"
IDLE_MINUTES="${CERT_IDLE_MINUTES:-0}"

mkdir -p "$STATE/results"
account_file="$STATE/certification-account-email"
if [ ! -f "$account_file" ] || [ -L "$account_file" ] || [ ! -O "$account_file" ] || [ "$(stat -f %Lp "$account_file")" != 600 ]; then
  echo "[certify] provision the dedicated standing account and put its address in the runner's owner-only account file" >&2
  exit 2
fi
export CERTIFICATION_ACCOUNT_EMAIL="$(cat "$account_file")"
LOCK="$STATE/certification-lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[certify] certification lock exists; verify the previous run and its cleanup before removing a stale lock" >&2
  exit 2
fi
trap 'rmdir "$LOCK"' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need git
need node
need npm
need vercel

scope_args=()
if [ -n "$SCOPE" ]; then scope_args=(--scope "$SCOPE"); fi
if [ -z "$PROJECT_ID" ]; then
  echo "[certify] HIVRA_CANARY_VERCEL_PROJECT_ID is required" >&2
  exit 2
fi

echo "[certify] resolving served Canary revision"
served_json="$(node "$SCRIPT_DIR/served-canary-revision.mjs" --host "$HOST" --owner "$OWNER" --repo "$GH_REPO" --ref "$REF" "${scope_args[@]}")"
sha="$(printf '%s' "$served_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.sha)})')"
deployment="$(printf '%s' "$served_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.deploymentId)})')"
served_project="$(printf '%s' "$served_json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).projectId')"
if [ "$served_project" != "$PROJECT_ID" ]; then
  echo "[certify] configured project does not match the resolved deployment" >&2
  exit 2
fi
echo "[certify] $HOST is $deployment at $sha"

git -C "$REPO" fetch -q origin "$REF"
if ! git -C "$REPO" cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "[certify] served SHA is not present in $REPO after fetch; refusing to certify a guessed tree" >&2
  exit 2
fi

if [ -e "$WORKTREE/.git" ]; then
  if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
    echo "[certify] refusing to overwrite changes in the certification checkout" >&2
    exit 2
  fi
  git -C "$WORKTREE" checkout -q --detach "$sha"
else
  mkdir -p "$(dirname "$WORKTREE")"
  git -C "$REPO" worktree add -q --detach "$WORKTREE" "$sha"
fi
checkout_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
if [ "$checkout_sha" != "$sha" ]; then
  echo "[certify] checkout mismatch: got $checkout_sha, expected $sha" >&2
  exit 2
fi

cd "$WORKTREE/dashboard"
if [ ! -f e2e/launch-sweep/standing-account.ts ]; then
  echo "[certify] the served revision does not support standing-account certification" >&2
  exit 2
fi
lock_hash="$(shasum -a 256 package-lock.json | awk '{print $1}')"
hash_file="node_modules/.certification-package-lock-sha256"
if [ ! -x node_modules/.bin/playwright ] || [ ! -f "$hash_file" ] || [ "$(cat "$hash_file" 2>/dev/null || true)" != "$lock_hash" ]; then
  echo "[certify] installing exact dashboard dependencies"
  npm ci --no-audit --no-fund
  printf '%s\n' "$lock_hash" > "$hash_file"
  npx playwright install chromium >/dev/null
fi

HELPER_DIR="$SCRIPT_DIR"
if [ -f "$WORKTREE/dashboard/scripts/catalog-certification/certification-plan.mjs" ]; then
  HELPER_DIR="$WORKTREE/dashboard/scripts/catalog-certification"
fi
ledger="$STATE/certification-ledger.jsonl"
target="$(node "$HELPER_DIR/certification-plan.mjs" --dashboard "$WORKTREE/dashboard" --ledger "$ledger" --canary-sha "$sha" --choose)"
target="$(printf '%s' "$target" | tr -d '[:space:]')"
if [ -z "$target" ] || [ "$target" = "null" ]; then
  echo "[certify] no catalog entry is due"
  exit 75
fi
provisioner="$(sed -n 's/^export const PORTABLE_HIVRA_PROVISIONER_VERSION = "\([^"]*\)";/\1/p' "$WORKTREE/dashboard/src/lib/infrastructure/portable-provisioner-contract.ts" | head -1)"
if [ -z "$provisioner" ]; then
  echo "[certify] could not read the provisioner version" >&2
  exit 2
fi

run_id="$(openssl rand -hex 4)"
out_dir="$STATE/results/$run_id"
mkdir -p "$out_dir"
echo "[certify] target=$target run=$run_id provisioner=$provisioner output=$out_dir"

if ! env_exports="$(node "$HELPER_DIR/canary-test-env.mjs" --project-id "$PROJECT_ID" "${scope_args[@]}")"; then
  echo "[certify] could not load Canary test secrets from Vercel" >&2
  exit 2
fi
eval "$env_exports"
unset env_exports
export HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp
export LAUNCH_SWEEP_CERTIFICATION=1
export LAUNCH_SWEEP_BASE_URL="https://$HOST"
export LAUNCH_SWEEP_CANARY_SHA="$sha"
export LAUNCH_SWEEP_ONLY="$target"
export LAUNCH_SWEEP_IDLE_MINUTES="$IDLE_MINUTES"
export LAUNCH_SWEEP_OUT_DIR="$out_dir"
export LAUNCH_SWEEP_RUN_ID="$run_id"

set +e
npm run test:launch-sweep >"$out_dir/runner.log" 2>&1
sweep_status=$?
set -e

set +e
node "$HELPER_DIR/append-certification-result.mjs" \
  --ledger "$ledger" \
  --out-dir "$out_dir" \
  --target "$target" \
  --canary-sha "$sha" \
  --provisioner-version "$provisioner" \
  --run-id "$run_id" \
  --sweep-exit-code "$sweep_status" >"$out_dir/ledger-row.json" 2>"$out_dir/ledger-row-error.log"
append_status=$?
set -e

row_passed=false
if [ "$append_status" -eq 0 ]; then
  row_passed="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.passed?"true":"false")' "$out_dir/ledger-row.json")"
fi

echo "[certify] target=$target sweep_exit=$sweep_status certified=$row_passed"

if [ "$append_status" -ne 0 ]; then
  echo "[certify] failed to append certification evidence" >&2
  cat "$out_dir/ledger-row-error.log" >&2 || true
  exit 2
fi
if [ "$sweep_status" -ne 0 ] || [ "$row_passed" != "true" ]; then
  exit 1
fi
exit 0
