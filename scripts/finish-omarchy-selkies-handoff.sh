#!/usr/bin/env bash
# Finish the Omarchy Selkies handoff end to end.
#
# Applies the two Wayland admission migrations to the Canary database and
# records them as applied, then refreshes the Omarchy capability so the browser
# can issue a fresh session. Run from the repository root.
#
# Every step is idempotent: the migrations rewrite function bodies only when the
# old gate is still present, and the tracking insert uses ON CONFLICT DO NOTHING.
#
# Requires network access to api.supabase.com. Read-only until the apply step;
# set DRY_RUN=1 to print what would be applied without changing anything.

set -euo pipefail

CANARY_REF="${CANARY_REF:-srrwbdvxlqvqjuexitaf}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.supabase/access-token}"
MIGRATION_DIR="dashboard/supabase/migrations"
MIGRATIONS=(
  "20260909163000_omarchy_wayland_web_transport"
  "20260910120000_omarchy_wayland_web_admission_consistency"
)

[ -r "$TOKEN_FILE" ] || { echo "Missing Supabase access token: $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
ENDPOINT="https://api.supabase.com/v1/projects/${CANARY_REF}/database/query"

run_sql() {
  # Read the statement from stdin. It cannot be passed as a node argument: the
  # migrations start with a `--` comment, which node would parse as an option.
  # printf (not a here-string) so no trailing newline is added to the payload.
  local query="$1"
  printf '%s' "$query" \
    | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify({query:s})))' \
    | curl -sS --fail-with-body --max-time 60 \
        -X POST "$ENDPOINT" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'content-type: application/json' \
        --data-binary @-
}

for name in "${MIGRATIONS[@]}"; do
  file="${MIGRATION_DIR}/${name}.sql"
  [ -r "$file" ] || { echo "Missing migration: $file" >&2; exit 1; }

  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "DRY RUN: would apply ${name}"
    continue
  fi

  echo "Applying ${name}..."
  run_sql "$(cat "$file")" > /dev/null

  version="${name%%_*}"
  short_name="${name#*_}"
  run_sql "insert into supabase_migrations.schema_migrations (version, name, statements) values ('${version}', '${short_name}', null) on conflict (version) do nothing;" > /dev/null
  echo "  applied and recorded ${version}"
done

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY RUN complete. Re-run without DRY_RUN=1 to apply."
  exit 0
fi

echo
echo "Verifying effective admission for selkies-websocket on Wayland..."
run_sql "select
  p.proname,
  pg_get_functiondef(p.oid) like '%c.compositor not in (''x11'',''wayland'')%' as admits_wayland,
  pg_get_functiondef(p.oid) like '%in (''selkies-webrtc'',''selkies-websocket'') and c.compositor<>''x11''%' as still_x11_only
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'exchange_hivra_remote_desktop_session',
  'authorize_hivra_remote_desktop_session',
  'renew_hivra_remote_desktop_session_by_token',
  'issue_hivra_remote_desktop_session_v2')
order by p.proname;"

echo
echo "Next: refresh the Omarchy capability, then open the Canary desktop tab."
echo "  POST /api/hivra/agents/00000000-0000-4000-8000-000000001200/remote-desktop  {\"action\":\"refresh\"}"
echo "A capability row lives 9 minutes; refresh before opening the browser."
