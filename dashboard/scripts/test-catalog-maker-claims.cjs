// Apply every migration up to 20261113051700 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), then check maker claims and use per agent type:
// a person holds one claim per page, a claim's line and repository have a
// fixed shape, a proven claim carries the time it was proven; use per type
// counts people and hours in the range, finished launches, agents running now
// and the agents kept for their first two weeks; and browsers can read or
// call none of it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261113051700_catalog_maker_claims.sql";

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create role supabase_admin; create role authenticator;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      create schema auth; create schema storage; create schema supabase_migrations; create schema extensions;
      create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.role() returns text language sql stable as $$ select null::text $$;
      create table auth.users (id uuid primary key, email text);
      create table storage.buckets (id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
        name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
      create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
      create publication supabase_realtime;
      create function public.digest(text, text) returns bytea language sql as $$ select sha256(convert_to($1, 'UTF8')) $$;
      create function public.digest(bytea, text) returns bytea language sql as $$ select sha256($1) $$;
    `);
    const files = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name <= TARGET).sort();
    assert.equal(files.at(-1), TARGET, "the migration under test is applied last");
    const apply = async (name) =>
      // PGlite ships without extensions; the functions they provide are stubbed above.
      db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, ""));
    for (const name of files.slice(0, -1)) await apply(name);
    await apply(TARGET);
    await apply(TARGET);

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const fails = async (sql, args, why) => assert.rejects(db.query(sql, args), undefined, why);

    // ── Claims ───────────────────────────────────────────────────────────────
    // The value of a claim's line: 32 hex characters, published in the maker's repository.
    const CLAIM_VALUE = "0123456789abcdef".repeat(2);
    const claim = "insert into public.hivra_catalog_claims (profile_id, user_id, repo, token) values ($1, $2, $3, $4) returning id, status";
    const first = await one(claim, ["openclaw", "ana", "openclaw/openclaw", CLAIM_VALUE]);
    assert.equal(first.status, "pending");
    await fails(claim, ["openclaw", "ana", "openclaw/openclaw", "f".repeat(32)], "one claim per person and page");
    await fails(claim, ["openclaw", "ben", "openclaw/openclaw", CLAIM_VALUE], "a line belongs to one claim");
    await fails(claim, ["openclaw", "ben", "openclaw/openclaw", "not-a-token"], "a line has a fixed shape");
    await fails(claim, ["openclaw", "ben", "https://github.com/openclaw/openclaw", "a".repeat(32)], "a repository is owner/name");
    await fails(claim, ["Open Claw", "ben", "openclaw/openclaw", "a".repeat(32)], "a page id is a slug");
    // Two people can claim the same page, each with their own line.
    await one(claim, ["openclaw", "ben", "openclaw/openclaw", "a".repeat(32)]);
    await fails("update public.hivra_catalog_claims set status = 'verified' where id = $1", [first.id], "a proven claim says when");
    await fails("update public.hivra_catalog_claims set status = 'revoked' where id = $1", [first.id], "only pending or verified");
    await db.query("update public.hivra_catalog_claims set status = 'verified', verified_at = now(), check_result = 'verified' where id = $1", [first.id]);
    await fails("update public.hivra_catalog_claims set check_result = 'maybe' where id = $1", [first.id], "a check has a known result");

    // ── Use per agent type ───────────────────────────────────────────────────
    const agent = async (user, type, status = "running") => (await one(
      "insert into public.hivra_agents (user_id, type, name, status) values ($1, $2, 'agent', $3) returning id", [user, type, status])).id;
    const event = (agentId, user, type, name, at) => db.query(
      "insert into public.hivra_agent_events (agent_id, user_id, event, agent_type, created_at) values ($1, $2, $3, $4, $5)", [agentId, user, name, type, at]);
    const used = (agentId, user, type, at) => db.query(
      `select public.hivra_record_agent_activity(p_agent_id => $1, p_user_id => $2, p_agent_type => $3, p_observed_at => $4,
         p_reachable => true, p_open_connections => 1, p_used_hours => array[$4]::timestamptz[])`, [agentId, user, type, at]);

    const anaClaw = await agent("ana", "openclaw");
    const benClaw = await agent("ben", "openclaw");
    const benCodex = await agent("ben", "codex", "stopped");
    const gone = "11111111-1111-4111-8111-111111111111";
    const stayed = "22222222-2222-4222-8222-222222222222";

    await used(anaClaw, "ana", "openclaw", "2026-11-05T10:05:00Z");
    await used(anaClaw, "ana", "openclaw", "2026-11-06T10:05:00Z");
    await used(benClaw, "ben", "openclaw", "2026-11-21T09:00:00Z");
    // Before the range: not counted.
    await used(benCodex, "ben", "codex", "2026-10-20T09:00:00Z");

    await event(anaClaw, "ana", "openclaw", "provisioned", "2026-11-02T08:00:00Z");
    await event(benClaw, "ben", "openclaw", "provisioned", "2026-11-20T08:00:00Z");
    await event(benCodex, "ben", "codex", "provisioned", "2026-11-25T08:00:00Z");
    // Launched earlier and deleted five days later: not kept.
    await event(gone, "cy", "openclaw", "provisioned", "2026-10-20T08:00:00Z");
    await event(gone, "cy", "openclaw", "deleted", "2026-10-25T08:00:00Z");
    // Launched earlier and deleted after its first two weeks: kept.
    await event(stayed, "di", "openclaw", "provisioned", "2026-10-25T08:00:00Z");
    await event(stayed, "di", "openclaw", "deleted", "2026-11-20T08:00:00Z");
    // A launch that never finished is not a launch.
    await event(null, "ed", "openclaw", "launch_requested", "2026-11-10T08:00:00Z");

    const use = async (from, to) => (await db.query("select * from public.hivra_catalog_use_by_type($1, $2)", [from, to])).rows;
    assert.deepEqual(await use("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"), [
      { agent_type: "codex", people: 0, active_hours: 0, launches: 1, running_now: 0, two_week_launches: 0, two_week_kept: 0 },
      { agent_type: "openclaw", people: 2, active_hours: 3, launches: 2, running_now: 2, two_week_launches: 3, two_week_kept: 2 },
    ]);
    // A narrower range moves what is counted in it; running now does not depend on the range.
    const week = await use("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z");
    assert.deepEqual(week.find((row) => row.agent_type === "openclaw"),
      { agent_type: "openclaw", people: 1, active_hours: 2, launches: 1, running_now: 2, two_week_launches: 1, two_week_kept: 0 });

    // Browsers can read or call none of it.
    const signature = "public.hivra_catalog_use_by_type(timestamptz, timestamptz)";
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const allowed = (await one("select has_table_privilege($1, 'public.hivra_catalog_claims', $2) as ok", [role, privilege])).ok;
        assert.equal(allowed, false, `${role} cannot ${privilege} claims`);
      }
      assert.equal((await one("select has_function_privilege($1, $2, 'execute') as ok", [role, signature])).ok, false, `${role} cannot read use per type`);
    }
    assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') as ok", [signature])).ok, true);
    assert.equal((await one("select relrowsecurity as on from pg_class where oid = 'public.hivra_catalog_claims'::regclass")).on, true);
    console.log("PASS catalog maker claims");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
