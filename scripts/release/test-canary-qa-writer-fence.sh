#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
baseline=043185e116d4de78373fa51d02a6c007ab023618
migrations=dashboard/supabase/migrations
migration="$migrations/20261126203500_canary_qa_writer_fence.sql"
fixtures=scripts/release/fixtures
work=$(mktemp -d)
container="canary-qa-fence-test-$$"
pg_image=docker.io/supabase/postgres@sha256:28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518
rest_image=docker.io/postgrest/postgrest@sha256:5922bde07147b82b1c9d8f749e48c1e5b99ebb233f3888bb7ab65f07cf4ac82d
node_image=node@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f
cleanup() {
  if [[ -f "$work/rest-id" ]]; then docker rm -f "$(cat "$work/rest-id")" >/dev/null; fi
  if [[ -f "$work/pg-id" ]]; then docker rm -f "$(cat "$work/pg-id")" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
case "$#:${1:-}" in
  0:) ;;
  1:--pull-test-images)
    for image in "$pg_image" "$rest_image" "$node_image"; do docker pull "$image"; done
    ;;
  *) echo "Usage: $0 [--pull-test-images]" >&2; exit 2 ;;
esac
git archive "$baseline" "$migrations" | tar -x -C "$work"
docker run --pull never --rm --detach --network none --name "$container" --cidfile "$work/pg-id" \
  -e POSTGRES_PASSWORD=synthetic-qa-fence-only "$pg_image" >/dev/null

psql() {
  docker exec -i "$container" psql -X -d postgres -U postgres -v ON_ERROR_STOP=1 "$@"
}
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -q \
    && psql -Atc "select 1 from pg_roles where rolname='service_role'" </dev/null 2>/dev/null | grep -qx 1; then break; fi
  sleep 1
done
psql -Atc 'select version()' </dev/null
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
{
  for file in "$work/$migrations/"*.sql; do
    if [[ ${file##*/} == 20261123220000_optional_holder_switch.sql ]]; then continue; fi
    printf '\\echo %s\n%s\n' "${file##*/}" 'begin;'
    cat "$file"
    printf '\n%s\n' 'commit;' 'reset all;'
  done
  cat "$work/$migrations/20261123220000_optional_holder_switch.sql"
  printf '\n%s\n' 'begin;'
  cat "$migration"
  printf '\n%s\n' 'commit;'
} > "$work/install.sql"
if ! psql -q < "$work/install.sql" > "$work/install.log" 2>&1; then
  tail -45 "$work/install.log" >&2
  exit 1
fi

psql -q <<'SQL'
create role qa_fixture_gateway login noinherit password 'synthetic-qa-gateway-only';
create role hivra_canary_qa_a nologin noinherit;
create role hivra_canary_qa_b nologin noinherit;
create role hivra_canary_qa_fallback nologin noinherit;
grant anon,service_role,hivra_canary_qa_a,hivra_canary_qa_b,hivra_canary_qa_fallback to qa_fixture_gateway;
create function public.synthetic_canary_qa_change_classic(p_id uuid,p_vmid integer)
returns uuid language sql volatile security definer set search_path=pg_catalog,pg_temp as $$
  update public.hermes_instances set name='Synthetic updated Classic fixture',proxmox_vmid=p_vmid where id=p_id returning id
$$;
revoke all on function public.synthetic_canary_qa_change_classic(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_canary_qa_dispatch(text,text,integer,text,uuid),
  public.finish_canary_qa_dispatch(uuid,text),public.insert_hermes_instance(jsonb,numeric,boolean),
  public.synthetic_canary_qa_change_classic(uuid,integer)
  to hivra_canary_qa_a,hivra_canary_qa_b,hivra_canary_qa_fallback;
insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio,thinpool_size_gb)
  values('qa-fixture-host',32,131072,1,1000),('qa-control-host',32,131072,1,1000);
SQL
PGRST_JWT_SECRET=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
export PGRST_JWT_SECRET
docker run --pull never --rm --detach --network "container:$container" --cidfile "$work/rest-id" \
  --env PGRST_JWT_SECRET --env PGRST_DB_URI=postgres://qa_fixture_gateway:synthetic-qa-gateway-only@127.0.0.1:5432/postgres \
  --env PGRST_DB_ANON_ROLE=anon "$rest_image" >/dev/null

probe() {
  docker run --pull never --rm --network "container:$container" --env PGRST_JWT_SECRET \
    --volume "$root/$fixtures/canary-qa-writer-fence-http.mjs:/fixture/canary-qa-writer-fence-http.mjs:ro" \
    --volume "$root/dashboard/src/lib/hivra/canary-qa-dispatch.ts:/fixture/canary-qa-dispatch.ts:ro" \
    "$node_image" node --disable-warning=ExperimentalWarning /fixture/canary-qa-writer-fence-http.mjs "$1"
}

scope() {
  psql -q -c "select canary_qa_writer_private.set_scope('user_CanaryQaFixture','qa-fixture-host',13011,$1,$2)" </dev/null
}
must_refuse() {
  if psql -q -c "$1" </dev/null > "$work/expected-refusal.log" 2>&1; then
    echo "QA scope unexpectedly changed" >&2; exit 1
  fi
  grep -Fq "$2" "$work/expected-refusal.log"
}

probe off
must_refuse "begin isolation level repeatable read; select canary_qa_writer_private.set_scope('user_CanaryQaFixture','qa-fixture-host',13011,'hivra_canary_qa_a',now()+interval '15 minutes'); commit;" \
  'Canary QA scope changes require READ COMMITTED'
scope "'hivra_canary_qa_a'" "now()+interval '15 minutes'"
node "$fixtures/canary-qa-writer-fence-lock.mjs" "$container"
probe a
scope null null
probe closed
must_refuse "select canary_qa_writer_private.set_scope('user_CanaryQaFixture','qa-fixture-host',13011,'hivra_canary_qa_b',now()+interval '15 minutes')" \
  'close and reconcile the Canary QA writer before opening a generation'
psql -q <<'SQL'
begin;
select canary_qa_writer_private.settle_closed_dispatch('user_CanaryQaFixture','qa-fixture-host',13011,'resize',
  '00000000-0000-4000-8000-000000000402','refused');
rollback;
do $$
begin
  if not exists(select 1 from canary_qa_writer_private.dispatches
    where operation_id='00000000-0000-4000-8000-000000000402' and outcome is null)
    then raise exception 'rollback discarded or settled the original dispatch'; end if;
  if not canary_qa_writer_private.settle_closed_dispatch('user_CanaryQaFixture','qa-fixture-host',13011,'resize',
    '00000000-0000-4000-8000-000000000402','refused') then raise exception 'closed settlement failed'; end if;
end;
$$;
SQL
scope "'hivra_canary_qa_b'" "now()+interval '15 minutes'"
probe b
scope null null
must_refuse "select canary_qa_writer_private.set_scope('user_CanaryQaFixture','qa-fixture-host',13011,'hivra_canary_qa_a',now()+interval '15 minutes')" \
  'a revoked Canary QA generation cannot reopen'
scope "'hivra_canary_qa_fallback'" "now()+interval '15 minutes'"
probe fallback
scope null null
echo 'PASS three isolated generations; rollback used a fresh role and preserved the original receipt'
