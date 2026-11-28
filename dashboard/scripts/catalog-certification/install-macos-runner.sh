#!/usr/bin/env bash
# Install the two continuous catalog runners as macOS LaunchAgents.
# The runners themselves still fetch Canary secrets just-in-time from Vercel;
# no Clerk or Supabase secret is written into a plist or env file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HOME/.local/state/hivra-catalog-certification"
REPO="$HOME/Projects/Hivra-public-canary"
CERT_WORKTREE="$HOME/Worktrees/hivra/catalog-certification-runner"
FIXER_WORKTREE="$HOME/Worktrees/hivra/catalog-fixer"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PROJECT_ID="${HIVRA_CANARY_VERCEL_PROJECT_ID:-}"
SCOPE="${HIVRA_VERCEL_SCOPE:-${VERCEL_SCOPE:-}}"
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --cert-worktree) CERT_WORKTREE="$2"; shift 2 ;;
    --fixer-worktree) FIXER_WORKTREE="$2"; shift 2 ;;
    --launch-agents-dir) LAUNCH_AGENTS_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$PROJECT_ID" ]; then
  echo "HIVRA_CANARY_VERCEL_PROJECT_ID or --project-id is required" >&2
  exit 2
fi
if [ -z "$SCOPE" ]; then
  echo "HIVRA_VERCEL_SCOPE or --scope is required" >&2
  exit 2
fi
for file in run-continuous.sh run-once.sh run-fixer-continuous.sh run-fixer-once.sh served-canary-revision.mjs canary-test-env.mjs vercel-rest.mjs certification-plan.mjs append-certification-result.mjs catalog-remediation.mjs; do
  [ -f "$SCRIPT_DIR/$file" ] || { echo "missing $SCRIPT_DIR/$file" >&2; exit 2; }
done
skill_source="$(cd "$SCRIPT_DIR/../../.." && pwd)/.devin/skills/catalog-certification-fixer/SKILL.md"
[ -f "$skill_source" ] || { echo "missing $skill_source" >&2; exit 2; }

bin_dir="$STATE/bin"
mkdir -p "$bin_dir" "$STATE/logs" "$LAUNCH_AGENTS_DIR"
cp "$SCRIPT_DIR"/*.mjs "$SCRIPT_DIR"/*.sh "$bin_dir/"
chmod +x "$bin_dir"/*.mjs "$bin_dir"/*.sh
skill_copy="$STATE/catalog-certification-fixer-SKILL.md"
cp "$skill_source" "$skill_copy"

write_plist() {
  local label="$1" script="$2" logbase="$3" outfile="$4"
  LABEL="$label" SCRIPT="$script" LOGBASE="$logbase" OUTFILE="$outfile" \
  PROJECT_ID="$PROJECT_ID" SCOPE_VALUE="$SCOPE" STATE="$STATE" REPO="$REPO" \
  CERT_WORKTREE="$CERT_WORKTREE" FIXER_WORKTREE="$FIXER_WORKTREE" SKILL_COPY="$skill_copy" \
  python3 - <<'PY'
import os
from xml.sax.saxutils import escape

label = os.environ["LABEL"]
script = os.environ["SCRIPT"]
logbase = os.environ["LOGBASE"]
outfile = os.environ["OUTFILE"]
env = {
    "HOME": os.environ.get("HOME", ""),
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "HIVRA_CANARY_VERCEL_PROJECT_ID": os.environ["PROJECT_ID"],
    "HIVRA_VERCEL_SCOPE": os.environ["SCOPE_VALUE"],
    "CERT_REPO": os.environ["REPO"],
    "CERT_WORKTREE": os.environ["CERT_WORKTREE"],
    "CERT_STATE": os.environ["STATE"],
    "FIXER_REPO": os.environ["REPO"],
    "FIXER_WORKTREE": os.environ["FIXER_WORKTREE"],
    "FIXER_STATE": os.environ["STATE"],
    "FIXER_SKILL_FILE": os.environ["SKILL_COPY"],
}
env_xml = "\n".join(f"    <key>{escape(k)}</key><string>{escape(v)}</string>" for k, v in env.items())
text = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{escape(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>{escape(script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
{env_xml}
  </dict>
  <key>StandardOutPath</key><string>{escape(logbase)}.out.log</string>
  <key>StandardErrorPath</key><string>{escape(logbase)}.err.log</string>
</dict>
</plist>
'''
with open(outfile, "w", encoding="utf-8") as fh:
    fh.write(text)
PY
}

cert_plist="$LAUNCH_AGENTS_DIR/cloud.hivra.catalog-certifier.plist"
fixer_plist="$LAUNCH_AGENTS_DIR/cloud.hivra.catalog-fixer.plist"
write_plist "cloud.hivra.catalog-certifier" "$bin_dir/run-continuous.sh" "$STATE/logs/certifier-launchd" "$cert_plist"
write_plist "cloud.hivra.catalog-fixer" "$bin_dir/run-fixer-continuous.sh" "$STATE/logs/fixer-launchd" "$fixer_plist"
plutil -lint "$cert_plist" "$fixer_plist" >/dev/null

if [ "$START" -eq 1 ]; then
  uid="$(id -u)"
  launchctl bootout "gui/$uid/cloud.hivra.catalog-certifier" 2>/dev/null || true
  launchctl bootout "gui/$uid/cloud.hivra.catalog-fixer" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$cert_plist"
  launchctl bootstrap "gui/$uid" "$fixer_plist"
  launchctl kickstart "gui/$uid/cloud.hivra.catalog-certifier"
  launchctl kickstart "gui/$uid/cloud.hivra.catalog-fixer"
  echo "installed and started cloud.hivra.catalog-certifier and cloud.hivra.catalog-fixer"
else
  echo "installed plist files without starting them: $cert_plist $fixer_plist"
fi
echo "state: $STATE"
