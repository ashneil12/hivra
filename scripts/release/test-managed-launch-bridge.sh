#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
old=408e6b6fb39fc278adfdfea10d83fc8556b1969c
cutoff=4bfe13577cd2dd7baa8917b970b5a3a6fa133cab

work=$(mktemp -d)
container="managed-launch-bridge-test-$$"
image=docker.io/supabase/postgres@sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518
postgrest_image=docker.io/postgrest/postgrest@sha256:5922bde07147b82b1c9d8f749e48c1e5b99ebb233f3888bb7ab65f07cf4ac82d
node_image=node@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f
cleanup() {
  if [[ -e "$work/postgrest-id" ]]; then
    docker rm -f "$(cat "$work/postgrest-id")" >/dev/null
  fi
  if [[ -e "$work/container-id" ]]; then
    docker rm -f "$(cat "$work/container-id")" >/dev/null
  fi
  rm -rf "$work"
}
trap cleanup EXIT
case "$#:${1:-}" in
  0:) ;;
  1:--pull-test-images)
    for ref in "$image" "$postgrest_image" "$node_image"; do docker pull "$ref"; done
    ;;
  *) printf 'Usage: %s [--pull-test-images]\n' "$0" >&2; exit 2 ;;
esac
migrations=dashboard/supabase/migrations
fixtures=scripts/release/fixtures
bridge="$migrations/20261126192500_managed_launch_bridge.sql"
classic_bridge="$migrations/20261126194500_classic_placement_bridge.sql"
mkdir "$work/old" "$work/combined"
git archive "$old" "$migrations" | tar -x -C "$work/old"
git archive "$cutoff" "$migrations" | tar -x -C "$work/combined"
docker run --pull never --rm --detach --network none --name "$container" --cidfile "$work/container-id" \
  -e POSTGRES_PASSWORD=synthetic-test-only "$image" >/dev/null
psql() {
  docker exec -i "$container" psql -X -d postgres -U postgres -v ON_ERROR_STOP=1 "$@"
}
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -q \
    && psql -Atc "select 1 from pg_roles where rolname='service_role'" 2>/dev/null | grep -qx 1; then
    break
  fi
  sleep 1
done
psql -Atc 'select version()'

docker exec -i "$container" psql -X -d postgres -U supabase_admin -v ON_ERROR_STOP=1 -q <<'SQL'
create table storage.buckets(id text primary key, name text not null, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
grant usage on schema storage to postgres;
SQL
psql -q <<'SQL'
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
SQL

apply() {
  if ! psql -q < "$1" > "$work/migration.log" 2>&1; then
    printf 'Failed at %s\n' "${1##*/}" >&2
    cat "$work/migration.log" >&2
    exit 1
  fi
}
{
  for file in "$work/old/$migrations/"*.sql; do
    if [[ ${file##*/} != 20261123220000_optional_holder_switch.sql ]]; then
      printf '\\echo %s\n%s\n' "${file##*/}" 'begin;'
      cat "$file"
      printf '\n%s\n' 'commit;' 'reset all;'
    fi
  done
} > "$work/baseline.sql"
if ! psql -q < "$work/baseline.sql" > "$work/baseline.log" 2>&1; then
  tail -35 "$work/baseline.log" >&2
  exit 1
fi
assert_install_rejected() {
  local mutation=$1
  if {
    printf '%s\n' 'begin;' "$mutation"
    cat "$bridge"
    printf '\n%s\n' 'commit;'
  } | psql -q > "$work/init.log" 2>&1; then
    printf 'Bridge accepted an unreviewed initial schema: %s\n' "$mutation" >&2
    exit 1
  fi
  grep -q 'managed launch bridge requires the reviewed legacy or placement schema' "$work/init.log"
  [[ $(psql -Atc "select to_regnamespace('managed_launch_bridge_private') is null") == t ]]
}
assert_install_rejected "create table public.holder_admissions(user_id text);"
assert_install_rejected "grant execute on function public.insert_hivra_managed_agent(jsonb,integer) to anon;"
assert_install_rejected "alter function public.insert_hivra_managed_agent(jsonb,integer) set search_path=public;"
assert_install_rejected "create function public.insert_hivra_managed_agent(jsonb) returns jsonb language sql as \$\$select \$1\$\$;"
echo 'PASS bridge initialization refuses mixed schema, exposed ACL, modified search path and overload'
{
  echo 'begin;'
  cat "$bridge" "$classic_bridge"
  printf '\n%s\n' 'commit;'
} > "$work/bridge.sql"
apply "$work/bridge.sql"

docker exec -i "$container" psql -X -d postgres -U supabase_admin -v ON_ERROR_STOP=1 -q <<'SQL'
create role bridge_test_gateway login noinherit password 'bridge-offline-only';
grant anon, service_role to bridge_test_gateway;
SQL
PGRST_JWT_SECRET=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
export PGRST_JWT_SECRET
docker run --pull never --rm --detach --network "container:$container" --cidfile "$work/postgrest-id" \
  --env PGRST_JWT_SECRET --env PGRST_DB_URI=postgres://bridge_test_gateway:bridge-offline-only@127.0.0.1:5432/postgres \
  --env PGRST_DB_ANON_ROLE=anon --env PGRST_DB_TX_END=rollback-allow-override \
  "$postgrest_image" >/dev/null

probe() {
  psql -q -v epoch="$1" -v raw_insert="$2" -v raw_reserve="$3" < "$fixtures/managed-launch-bridge-probe.sql"
  psql -q -v epoch="$1" < "$fixtures/managed-launch-bridge-classic.sql"
  local run_race=0
  if [[ $1 == placement ]]; then
    psql -q <<'SQL'
insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,product_surface,infrastructure_provider,
  proxmox_node,proxmox_vmid,cpu_limit,ram_limit,disk_size_gb,seat_funding)
values('00000000-0000-4000-8000-000000000201','synthetic-http-owner','Classic race fixture','stopped','paused',
  'hermesos','proxmox','bridge-host',13001,1,2048,30,'paid');
SQL
    run_race=1
  fi
  psql -qc "notify pgrst, 'reload schema'" </dev/null
  docker run --pull never --rm --network "container:$container" --env PGRST_JWT_SECRET --env "RUN_CLASSIC_START_RACE=$run_race" \
    --volume "$root/$fixtures/managed-launch-bridge-http.mjs:/managed-launch-bridge-http.mjs:ro" \
    "$node_image" node /managed-launch-bridge-http.mjs "$1" "$2" "$3"
  if [[ $run_race == 1 ]]; then
    psql -qc "delete from public.hermes_instances where id='00000000-0000-4000-8000-000000000201'" </dev/null
  fi
}

read_epoch() {
  psql -Atc 'set role service_role; select public.managed_launch_bridge_epoch()' </dev/null | tail -1
}

assert_transition_rejected() {
  local sql=$1 message=$2
  if psql -q -c "$sql" > "$work/transition.log" 2>&1; then
    printf 'Bridge accepted an invalid transition: %s\n' "$sql" >&2
    exit 1
  fi
  grep -Fq "$message" "$work/transition.log"
}

probe legacy inserted reserved
assert_transition_rejected "select managed_launch_bridge_private.finish_transition('legacy','funding');" \
  'managed launch bridge transition must be locked in this transaction'
assert_transition_rejected "begin; select managed_launch_bridge_private.begin_transition('legacy','funding'); select managed_launch_bridge_private.finish_transition('legacy','funding'); commit;" \
  'managed launch bridge transition successor does not match'
assert_transition_rejected "begin; alter function public.insert_hivra_managed_agent(jsonb,integer) set search_path=public; set local role service_role; select public.managed_launch_bridge_epoch(); commit;" \
  'managed launch bridge epoch does not match the reviewed schema'
echo 'PASS rejects an unlocked transition, missing successor DDL and active schema drift'
while read -r path <&9; do
  file="$work/combined/$path"
  version=${path##*/}
  version=${version%%_*}
  next=
  case "$version" in
    20261124230000) predecessor=legacy; next=funding ;;
    20261125040000) predecessor=funding; next=placement ;;
  esac
  if [[ -n $next ]]; then
    node "$fixtures/managed-launch-bridge-lock.mjs" "$container" "$predecessor" "$next"
  fi
  {
    printf '%s\n' 'begin;' "set local lock_timeout = '5s';"
    if [[ -n $next ]]; then
      printf '%s\n' "select managed_launch_bridge_private.begin_transition('$predecessor','$next');"
    fi
    cat "$file"
    printf '\n'
    if [[ -n $next ]]; then
      printf '%s\n' "select managed_launch_bridge_private.finish_transition('$predecessor','$next');"
    fi
    printf '%s\n' "insert into supabase_migrations.schema_migrations(version) values ('$version');" 'commit;'
  } > "$work/cutover.sql"
  if [[ -n $next ]]; then
    sed '$s/^commit;$/rollback;/' "$work/cutover.sql" > "$work/aborted-cutover.sql"
    apply "$work/aborted-cutover.sql"
    [[ $(read_epoch) == "$predecessor" ]]
    [[ $(psql -Atc "select count(*) from supabase_migrations.schema_migrations where version='$version'" </dev/null) == 0 ]]
    echo "PASS rollback preserves $predecessor and leaves no ledger entry for $version"
  fi
  apply "$work/cutover.sql"
  case "${file##*/}" in
    20261124010000_*)
      probe legacy inserted reserved
      psql -q < "$fixtures/managed-launch-bridge-holder-fixture.sql"
      ;;
    20261124230000_*|20261125040000_*)
      probe "$next" invalid_request invalid_request
      ;;
  esac
done 9< <(git diff --diff-filter=A --name-only "$old" "$cutoff" -- "$migrations" | sort)
[[ $(psql -Atc 'select count(*) from supabase_migrations.schema_migrations') == 12 ]]
echo 'PASS applied the 12 pinned delta files'
assert_transition_rejected "begin; alter function public.insert_hermes_instance(jsonb,numeric,boolean) set search_path=public; select public.managed_launch_bridge_epoch(); commit;" \
  'managed launch bridge epoch does not match the reviewed schema'
probe placement invalid_request invalid_request

{
  cat <<'SQL'
begin;
drop function public.managed_launch_bridge_epoch(),
  public.insert_hivra_managed_agent_bridge_v1(text,jsonb,integer,numeric,boolean),
  public.reserve_hivra_launch_model_bridge_v1(text,text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean),
  public.insert_hermes_instance_bridge_v1(text,jsonb,numeric,boolean),
  public.claim_hermes_instance_start_bridge_v1(text,uuid,text,uuid,text,integer,numeric,boolean),
  public.finish_hermes_instance_start_bridge_v1(uuid,text,uuid,text);
drop schema managed_launch_bridge_private cascade;
SQL
  cat "$work/combined/$migrations/20261123220000_optional_holder_switch.sql"
  echo
  cat "$bridge" "$classic_bridge"
  echo
  sed '1d;$d' "$fixtures/managed-launch-bridge-probe.sql"
  echo 'rollback;'
} > "$work/install-on-placement.sql"
psql -q -v epoch=placement -v raw_insert=invalid_request -v raw_reserve=invalid_request < "$work/install-on-placement.sql"
echo 'PASS independent bridge install on the already-migrated placement contract'
