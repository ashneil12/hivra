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
devin -p "Run the catalog-curator skill (.devin/skills/catalog-curator/SKILL.md) for one pass in $WORKTREE on branch $branch." \
  ${CURATOR_MODEL:+--model "$CURATOR_MODEL"} \
  --permission-mode dangerous --respect-workspace-trust false >"$log" 2>&1 || echo "pass exited $?" >>"$log"
