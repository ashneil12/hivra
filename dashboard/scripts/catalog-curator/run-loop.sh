#!/usr/bin/env bash
# Runs one unattended catalog-curator pass (.devin/skills/catalog-curator).
# Meant for launchd/cron on a machine with Docker, gh and an authenticated
# Devin CLI. One pass at a time; each pass uses a fresh branch from canary.
set -euo pipefail

REPO="${CURATOR_REPO:-$HOME/Projects/Hivra-public-canary}"
WORKTREE="${CURATOR_WORKTREE:-$HOME/Worktrees/hivra/catalog-curator}"
STATE="${CURATOR_STATE:-$HOME/.local/state/hivra-catalog-curator}"
mkdir -p "$STATE"
# macOS has no flock: an atomic mkdir is the lock. A lock older than 6h is stale.
LOCK="$STATE/lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else echo "curator pass already running" >&2; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
git -C "$REPO" fetch -q origin canary
# Close only curation PRs whose apps are already on Canary or duplicated by a
# newer open pass. Ledger-only or unique-app PRs are reported but kept. Never
# let reconciliation block curation itself.
reconcile_log="$STATE/reconcile-$(date -u +%Y%m%dT%H%M%SZ).log"
if ! node "$REPO/dashboard/scripts/catalog-curator/reconcile-stale-prs.mjs" >"$reconcile_log" 2>&1; then
  echo "stale curation PR reconciliation failed; see $reconcile_log" >&2
fi
branch="curation/$(date -u +%Y%m%d-%H%M)"
if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
  git -C "$WORKTREE" reset -q --hard && git -C "$WORKTREE" clean -qfd
  git -C "$WORKTREE" checkout -q -B "$branch" origin/canary
else
  git -C "$REPO" worktree add -q -B "$branch" "$WORKTREE" origin/canary
fi
[ -e "$WORKTREE/dashboard/node_modules" ] || ln -s "$REPO/dashboard/node_modules" "$WORKTREE/dashboard/node_modules"

export CURATOR_WORKTREE="$WORKTREE"
cd "$WORKTREE"
log="$STATE/pass-$(date -u +%Y%m%dT%H%M%SZ).log"
prompt="Run the catalog-curator skill (.devin/skills/catalog-curator/SKILL.md) for one pass in $WORKTREE on branch $branch. Follow it exactly."
# CURATOR_AGENT: codex is the cheap unattended default. Devin is opt-in.
agent="${CURATOR_AGENT:-codex}"
codex_model="${CURATOR_MODEL:-gpt-reserve}"
run_devin() {
  devin_args=(-p "$prompt" --permission-mode dangerous --respect-workspace-trust false)
  if [ -n "${CURATOR_DEVIN_MODEL:-}" ]; then devin_args+=(--model "$CURATOR_DEVIN_MODEL"); fi
  devin "${devin_args[@]}" >"$log" 2>&1
}
run_codex() {
  codex exec -m "$codex_model" -c 'model_reasoning_effort="low"' --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox -C "$WORKTREE" "$prompt" >>"$log" 2>&1
}
status=0
case "$agent" in
  devin) run_devin || status=$? ;;
  codex) run_codex || status=$? ;;
  *) echo "unknown CURATOR_AGENT=$agent" >"$log"; exit 1 ;;
esac
if [ "$status" -ne 0 ] && [ "$agent" = devin ] && command -v codex >/dev/null 2>&1 \
  && grep -Eiq 'quota|usage limit|weekly limit|out of credits' "$log"; then
  if [ -z "$(git -C "$WORKTREE" status --porcelain)" ]; then
    echo "devin quota/limit failure (exit $status); retrying this same pass with codex" >>"$log"
    status=0
    run_codex || status=$?
  else
    echo "devin quota/limit failure (exit $status) after the worktree changed; not falling back over a partial pass" >>"$log"
  fi
fi
[ "$status" -eq 0 ] || echo "pass exited $status (agent=$agent)" >>"$log"
