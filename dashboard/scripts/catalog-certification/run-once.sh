#!/usr/bin/env bash
# Certify one universal-catalog launch against the exact public Canary revision.
# Serial by design: one paid customer-visible computer at a time. Never promotes.
set -euo pipefail
umask 077

REPO="${CERT_REPO:-$HOME/Projects/Hivra-public-canary}"
WORKTREE="${CERT_WORKTREE:-$HOME/Worktrees/hivra/catalog-certification-runner}"
STATE="${CERT_STATE:-$HOME/.local/state/hivra-catalog-certification}"
HOST=canary.hermesos.cloud
REF=canary
IDLE_MINUTES="${CERT_IDLE_MINUTES:-0}"
mode=launch
requested_target=""
case "${1:-}" in
  "") ;;
  --verify-only) [ "$#" -eq 1 ] || exit 2; mode=verify ;;
  --target)
    if [ "$#" -ne 2 ] || ! [[ "$2" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then exit 2; fi
    requested_target="$2"
    ;;
  *) echo "[certify] expected --verify-only, --target <catalog-slug>, or no arguments" >&2; exit 2 ;;
esac

mkdir -p "$STATE/results"
LOCK="$STATE/certification-lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[certify] certification lock exists; verify the previous run and its cleanup before removing a stale lock" >&2
  exit 2
fi
trap 'rmdir "$LOCK"' EXIT
hold_file="$STATE/TEARDOWN_REVIEW_REQUIRED"
if [ -e "$hold_file" ]; then
  echo "[certify] blocked: verify the previous run's cleanup before clearing TEARDOWN_REVIEW_REQUIRED" >&2
  exit 77
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need git
need node
need npm

echo "[certify] resolving served Canary revision"
served_json="$(node "$SCRIPT_DIR/served-canary-revision.mjs")" || exit 2
sha="$(printf '%s' "$served_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.sha)})')"
deployment="$(printf '%s' "$served_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.deploymentId)})')"
export CERT_VERCEL_DEPLOYMENT_ID="$deployment"
echo "[certify] $HOST is $deployment at $sha"
if [ "$mode" = verify ]; then
  node "$SCRIPT_DIR/canary-test-env.mjs" --verify-only || exit 2
  echo "[certify] verified Canary test env availability without starting a browser"
  exit 0
fi

account_file="$STATE/certification-account-email"
if [ ! -f "$account_file" ] || [ -L "$account_file" ] || [ ! -O "$account_file" ] || [ "$(stat -f %Lp "$account_file")" != 600 ]; then
  echo "[certify] configure the existing dedicated standing account in the runner's owner-only account file" >&2
  exit 76
fi
export CERTIFICATION_ACCOUNT_EMAIL="$(cat "$account_file")"

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

ledger="$STATE/certification-ledger.jsonl"
plan_args=(--dashboard "$WORKTREE/dashboard" --ledger "$ledger" --canary-sha "$sha" --choose)
if [ -n "$requested_target" ]; then plan_args+=(--target "$requested_target"); fi
target="$(node "$SCRIPT_DIR/certification-plan.mjs" "${plan_args[@]}")" || exit 2
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

export HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp
export LAUNCH_SWEEP_CERTIFICATION=1
export LAUNCH_SWEEP_BASE_URL="https://$HOST"
export LAUNCH_SWEEP_CANARY_SHA="$sha"
export LAUNCH_SWEEP_ONLY="$target"
export LAUNCH_SWEEP_IDLE_MINUTES="$IDLE_MINUTES"
export LAUNCH_SWEEP_OUT_DIR="$out_dir"
export LAUNCH_SWEEP_RUN_ID="$run_id"

set +e
node "$SCRIPT_DIR/canary-test-env.mjs" --launch-sweep >"$out_dir/runner.log" 2>&1
sweep_status=$?
set -e
if [ "$sweep_status" -eq 74 ]; then
  echo "[certify] could not verify Canary test env; no browser started" >&2
  exit 2
fi

set +e
node "$SCRIPT_DIR/append-certification-result.mjs" \
  --ledger "$ledger" \
  --out-dir "$out_dir" \
  --target "$target" \
  --canary-sha "$sha" \
  --provisioner-version "$provisioner" \
  --run-id "$run_id" \
  --sweep-exit-code "$sweep_status" >"$out_dir/ledger-row.json" 2>"$out_dir/ledger-row-error.log"
append_status=$?
set -e

disposition=hold
if [ "$append_status" -eq 0 ]; then
  disposition="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { certificationRunDisposition } = await import(pathToFileURL(process.argv[1]));
    console.log(certificationRunDisposition(JSON.parse(readFileSync(process.argv[2], "utf8"))));
  ' "$SCRIPT_DIR/append-certification-result.mjs" "$out_dir/ledger-row.json")" || disposition=hold
else
  echo "[certify] failed to append certification evidence; inspect the run directory" >&2
fi

echo "[certify] target=$target sweep_exit=$sweep_status disposition=$disposition"

case "$disposition" in
  pass) exit 0 ;;
  fail) exit 1 ;;
  account) exit 76 ;;
  *)
    printf 'run=%s\ntarget=%s\ncanary_sha=%s\n' "$run_id" "$target" "$sha" > "$hold_file"
    echo "[certify] blocked: cleanup is unverified; review the run before resuming" >&2
    exit 77
    ;;
esac
