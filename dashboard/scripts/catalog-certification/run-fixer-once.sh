#!/usr/bin/env bash
# Start one bounded cheap-agent repair for a catalog target whose latest live
# certification failed. Serial, deduped by target/fingerprint, never live.
set -euo pipefail

REPO="${FIXER_REPO:-$HOME/Projects/Hivra-public-canary}"
WORKTREE="${FIXER_WORKTREE:-$HOME/Worktrees/hivra/catalog-fixer}"
STATE="${FIXER_STATE:-$HOME/.local/state/hivra-catalog-certification}"
GH_REPO="${FIXER_GH_REPO:-ashneil12/hivra}"
MODEL="${REMEDIATION_MODEL:-gpt-reserve}"

mkdir -p "$STATE/remediation"
LOCK="$STATE/remediation-lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else echo "catalog remediation already running" >&2; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need git
need node
need gh
need codex

cert_ledger="$STATE/certification-ledger.jsonl"
remediation_ledger="$STATE/remediation-ledger.jsonl"
if [ ! -f "$cert_ledger" ]; then
  echo "[fixer] no certification ledger yet"
  exit 75
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; rm -rf "$LOCK"' EXIT
gh pr list -R "$GH_REPO" --state open --limit 100 --json number,title,headRefName >"$tmp/open-prs.json"
target_json="$(node "$SCRIPT_DIR/catalog-remediation.mjs" --cert-ledger "$cert_ledger" --remediation-ledger "$remediation_ledger" --open-prs "$tmp/open-prs.json" --choose)"
if [ -z "$target_json" ] || [ "$target_json" = "null" ]; then
  echo "[fixer] no actionable certified failure is ready for remediation"
  exit 75
fi
printf '%s\n' "$target_json" >"$tmp/target.json"
target="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.profileId)' "$tmp/target.json")"
stamp="$(date -u +%Y%m%d%H%M%S)"
run_id="$(openssl rand -hex 4)"
branch="catalog-fix/$target-$stamp"
evidence_file="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.evidenceFile??"")' "$tmp/target.json")"
raw_evidence=""
if [ -n "$evidence_file" ]; then
  raw_evidence="$(find "$STATE" -type f -name "$evidence_file" 2>/dev/null | head -1 || true)"
fi
runner_log=""
if [ -n "$raw_evidence" ] && [ -f "$(dirname "$raw_evidence")/runner.log" ]; then
  runner_log="$(dirname "$raw_evidence")/runner.log"
fi
evidence="$STATE/remediation/$target-$stamp-evidence.json"
EVIDENCE_OUT="$evidence" RAW_EVIDENCE="$raw_evidence" RUNNER_LOG="$runner_log" node - "$tmp/target.json" <<'NODE'
const fs = require('fs');
const target = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const raw = process.env.RAW_EVIDENCE || null;
const log = process.env.RUNNER_LOG || null;
fs.writeFileSync(process.env.EVIDENCE_OUT, `${JSON.stringify({
  schema: 'hivra.catalog-remediation-evidence.v1',
  ...target,
  rawEvidencePath: raw,
  runnerLogPath: log,
  warning: 'Local operator evidence. Do not copy paths, ids, emails, screenshots, env values, or secret-shaped strings into public git or GitHub output.',
}, null, 2)}\n`);
NODE

echo "[fixer] target=$target branch=$branch evidence=$evidence model=$MODEL"
target_arg="$(cat "$tmp/target.json")"
node "$SCRIPT_DIR/catalog-remediation.mjs" --append --remediation-ledger "$remediation_ledger" --target-json "$target_arg" --status started --branch "$branch" --run-id "$run_id" >/dev/null

git -C "$REPO" fetch -q origin canary
if [ -e "$WORKTREE/.git" ]; then
  git -C "$WORKTREE" reset -q --hard
  git -C "$WORKTREE" clean -qfd
  git -C "$WORKTREE" checkout -q -B "$branch" origin/canary
else
  mkdir -p "$(dirname "$WORKTREE")"
  git -C "$REPO" worktree add -q -B "$branch" "$WORKTREE" origin/canary
fi
[ -e "$WORKTREE/dashboard/node_modules" ] || ln -s "$REPO/dashboard/node_modules" "$WORKTREE/dashboard/node_modules"

repo_root="$(cd "$SCRIPT_DIR/../../.." && pwd)"
skill_file="${FIXER_SKILL_FILE:-$repo_root/.devin/skills/catalog-certification-fixer/SKILL.md}"
if [ ! -f "$skill_file" ]; then
  echo "[fixer] missing fixer skill at $skill_file" >&2
  exit 2
fi
log="$STATE/remediation/$target-$stamp-agent.log"
prompt="Read and follow $skill_file exactly. You are in prepared worktree $WORKTREE on branch $branch. TARGET=$target BRANCH=$branch EVIDENCE=$evidence RUN_LOG=$runner_log. Repair exactly this one live catalog certification failure. You are unattended; do not ask questions."
set +e
codex exec -m "$MODEL" -c 'model_reasoning_effort="low"' --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox -C "$WORKTREE" "$prompt" >"$log" 2>&1
agent_status=$?
set -e

gh pr list -R "$GH_REPO" --state all --head "$branch" --limit 5 --json number,state,mergedAt,url >"$tmp/branch-prs.json" 2>/dev/null || printf '[]\n' >"$tmp/branch-prs.json"
pr_info="$(node -e 'const rows=require(process.argv[1]);const row=rows.find(r=>r.mergedAt)||rows.find(r=>r.state==="OPEN")||rows[0];process.stdout.write(row?`${row.number}|${row.state}|${row.mergedAt?"merged":"unmerged"}`:"| |")' "$tmp/branch-prs.json")"
pr_number="$(printf '%s' "$pr_info" | cut -d'|' -f1 | tr -d ' ')"
pr_merge_state="$(printf '%s' "$pr_info" | cut -d'|' -f3 | tr -d ' ')"
pr_lifecycle_state="$(printf '%s' "$pr_info" | cut -d'|' -f2 | tr -d ' ')"
result_line="$(grep '^RESULT:' "$log" | tail -1 || true)"
if [ -n "$pr_number" ] && [ "$pr_merge_state" = "merged" ]; then
  final_status="merged"
elif [ -n "$pr_number" ] && [ "$pr_lifecycle_state" = "OPEN" ]; then
  final_status="pr-open"
elif printf '%s' "$result_line" | grep -q 'blocked'; then
  final_status="blocked"
else
  final_status="agent-failed"
fi
reason="agent exit $agent_status; ${result_line#RESULT: }"
append_args=(--append --remediation-ledger "$remediation_ledger" --target-json "$target_arg" --status "$final_status" --branch "$branch" --run-id "$run_id" --reason "$reason")
if [ -n "$pr_number" ]; then append_args+=(--pr-number "$pr_number"); fi
node "$SCRIPT_DIR/catalog-remediation.mjs" "${append_args[@]}" >/dev/null

echo "[fixer] target=$target agent_exit=$agent_status status=$final_status pr=${pr_number:-none} log=$log"
if [ "$final_status" = "merged" ] || [ "$final_status" = "pr-open" ]; then
  exit 0
fi
exit 1
