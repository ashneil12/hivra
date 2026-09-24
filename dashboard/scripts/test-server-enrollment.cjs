// Apply every migration in order in PostgreSQL/WASM, with Supabase's default
// privileges emulated, then apply the server enrollment migration a second
// time (rerun-safe) and prove, in actual SQL:
// - grants, RLS and EXECUTE revocation on every new object;
// - issue limits, fetch counting, consume-once reports, identical-replay
//   acknowledgement, refused-report counting, expiry at commit;
// - Yes creates exactly one pinned sudo connection, never for an identity the
//   account already pins; a second Yes changes nothing;
// - Replace access: the lease, attempts, revision checks, credential-recovery
//   and switch paths, receipts kept for both enrollments, rebind recorded;
// - receipts are append-only (grants and trigger), deleted only by cascade;
// - the retention sweep and account deletion;
// - discovery contract v2 commit checks and the revision-bound privilege.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const MIGRATION = "20260924213000_server_enrollment_command.sql";
const WORDS = fs.readFileSync(path.resolve(__dirname, "../src/lib/infrastructure/server-enrollment-words.ts"), "utf8");

const PRELUDE = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create role supabase_admin; create role authenticator;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create schema auth; create schema storage; create schema supabase_migrations; create schema extensions;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.role() returns text language sql stable as $$ select null::text $$;
  create table auth.users (id uuid primary key, email text);
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now(),
    updated_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text
    references storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz default now(),
    updated_at timestamptz default now());
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')) $$;
  create function public.digest(bytea,text) returns bytea language sql as $$ select sha256($1) $$;
  create publication supabase_realtime;
`;

function ed25519() {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.from(jwk.x, "base64url")]);
  return {
    key: "ssh-ed25519 " + blob.toString("base64"),
    fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
    hex: createHash("sha256").update(blob).digest("hex"),
  };
}

const codeHash = () => randomBytes(32).toString("hex");
const sealed = () => "sealed-test-only-" + randomBytes(48).toString("hex");
const digest = () => randomBytes(32).toString("hex");
const FACTS = { hostname: "ip-172-31-4-9", osId: "ubuntu", osVersionId: "24.04", architecture: "x86_64",
  cpuCount: 4, memoryBytes: 16729309184, virtualization: "kvm", proxmoxVersion: null, sshMatchRules: false };

async function main() {
  const db = new PGlite();
  const results = [];
  const pass = (name) => results.push(name);
  try {
    await db.exec(PRELUDE);
    for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/create extension[^;]*;/gi, ""));
    }
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, MIGRATION), "utf8")); // Rerun-safe.

    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const count = async (sql, params = []) => Number((await one(sql, params)).n);
    const call = async (fn, args) => (await one(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args)).r;
    const asRole = async (role, sql, params = []) => {
      await db.exec(`set role ${role}`);
      try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
    };
    const refusedAs = async (role, sql, params = []) => {
      await assert.rejects(asRole(role, sql, params));
    };
    // The superuser owns every table; replica mode lets the test move clocks
    // without the guard triggers, the way time would.
    const rewind = async (sql, params = []) => {
      await db.exec("set session_replication_role = replica");
      try { await db.query(sql, params); } finally { await db.exec("set session_replication_role = origin"); }
    };
    const enrollment = async (id) => one("select * from public.infrastructure_server_enrollments where id = $1", [id]);
    const events = async (id) => (await db.query(
      "select kind, actor, detail, observed_address, host_fingerprint_sha256 from public.infrastructure_server_enrollment_events where enrollment_id = $1 order by id", [id])).rows;

    const admin = ed25519();
    const issue = async (user, overrides = {}) => {
      const a = { user, code: codeHash(), version: "2026.09.24.1", key: admin.key, fingerprint: admin.fingerprint,
        sealed: sealed(), replace: null, ...overrides };
      const result = await call("issue_server_enrollment", [a.user, a.code, a.version, a.key, a.fingerprint, a.sealed, a.replace]);
      return { ...result, code: a.code };
    };
    const report = async (code, overrides = {}) => {
      const host = overrides.host ?? ed25519();
      const a = { digest: digest(), kind: "enrolled", admin: admin.fingerprint, hostKey: host.key,
        hostFingerprint: host.fingerprint, port: 22, facts: FACTS, consent: "terminal", reenrollment: false,
        observed: "203.0.113.24", words: "amber-falcon-river", ...overrides };
      const result = await call("report_server_enrollment", [code, a.digest, a.kind, a.admin, a.hostKey,
        a.hostFingerprint, a.port, JSON.stringify(a.facts), a.consent, a.reenrollment, a.observed, a.words]);
      return { ...result, host, digest: a.digest };
    };
    const bundle = () => "sealed-connection-" + randomBytes(32).toString("hex");
    const confirm = async (user, id, host = "203.0.113.24", name = "ip-172-31-4-9") =>
      call("confirm_server_enrollment", [user, id, host, name, bundle(), 1]);

    // --- Grants, RLS, EXECUTE -------------------------------------------------
    for (const table of ["infrastructure_server_enrollments", "infrastructure_server_enrollment_events"]) {
      assert.equal((await one("select relrowsecurity r from pg_class where oid = $1::regclass", [`public.${table}`])).r, true);
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["select", "insert", "update", "delete"]) {
          assert.equal((await one("select has_table_privilege($1, $2, $3) r", [role, `public.${table}`, privilege])).r, false,
            `${role} ${privilege} ${table}`);
        }
      }
    }
    const privileges = async (table) => Object.fromEntries(await Promise.all(["select", "insert", "update", "delete"]
      .map(async (p) => [p, (await one("select has_table_privilege('service_role', $1, $2) r", [`public.${table}`, p])).r])));
    assert.deepEqual(await privileges("infrastructure_server_enrollments"), { select: true, insert: false, update: false, delete: true });
    assert.deepEqual(await privileges("infrastructure_server_enrollment_events"), { select: true, insert: false, update: false, delete: false });
    const rpcs = ["issue_server_enrollment", "record_server_enrollment_fetch", "refuse_server_enrollment_report",
      "report_server_enrollment", "confirm_server_enrollment", "begin_server_enrollment_replacement",
      "complete_server_enrollment_replacement", "fail_server_enrollment_replacement",
      "record_server_enrollment_identity_mismatch", "decline_server_enrollment", "cancel_server_enrollment",
      "sweep_server_enrollments"];
    const functionRows = (await db.query(
      "select p.oid::regprocedure::text sig, p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname = any($1) or p.proname in ('append_server_enrollment_event','server_enrollment_identity_matches','server_enrollment_word_list','is_server_enrollment_words','server_enrollment_key_hex_fingerprint'))",
      [rpcs])).rows;
    assert.equal(functionRows.filter((row) => rpcs.includes(row.proname)).length, rpcs.length);
    // A role with no grants of its own can execute only what PUBLIC can.
    await db.exec("create role enrollment_probe_nobody");
    for (const row of functionRows) {
      for (const role of ["anon", "authenticated", "enrollment_probe_nobody"]) {
        const can = (await one("select has_function_privilege($1, $2, 'execute') r", [role, row.sig])).r;
        assert.equal(can, false, `${role} can execute ${row.sig}`);
      }
      const internal = ["append_server_enrollment_event", "server_enrollment_identity_matches"].includes(row.proname);
      if (rpcs.includes(row.proname)) {
        assert.equal(row.prosecdef, true, `${row.sig} is SECURITY DEFINER`);
        assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') r", [row.sig])).r, true);
      }
      if (internal) assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') r", [row.sig])).r, false);
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["usage", "select", "update"]) {
        assert.equal((await one("select has_sequence_privilege($1, 'public.infrastructure_server_enrollment_events_id_seq', $2) r", [role, privilege])).r, false,
          `${role} ${privilege} on the receipts sequence`);
      }
    }
    await refusedAs("service_role", "insert into public.infrastructure_server_enrollments (user_id, code_sha256, phase, issued_at, expires_at, script_version, admin_public_key, admin_key_fingerprint) values ('u', $1, 'issued', now(), now() + interval '15 minutes', '2026.09.24.1', $2, $3)",
      [codeHash(), admin.key, admin.fingerprint]);
    // The SQL word list and the app's list are the same 256 words.
    const sqlWords = (await one("select public.server_enrollment_word_list() r")).r;
    const tsList = WORDS.slice(WORDS.indexOf("SERVER_ENROLLMENT_WORDS = ["), WORDS.indexOf("] as const"));
    const tsWords = [...tsList.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sqlWords, tsWords);
    assert.equal(new Set(sqlWords).size, 256);
    pass("grants, RLS and EXECUTE");

    // --- Issue ----------------------------------------------------------------
    const first = await issue("owner");
    assert.equal(first.outcome, "issued");
    let row = await enrollment(first.enrollmentId);
    assert.equal(row.phase, "issued");
    assert.equal(new Date(row.expires_at) - new Date(row.issued_at), 15 * 60_000);
    assert.equal(row.code_sha256, first.code);
    assert.deepEqual((await events(first.enrollmentId)).map((e) => e.kind), ["issued"]);
    const second = await issue("owner"), third = await issue("owner");
    assert.equal((await issue("owner")).outcome, "active_limit");
    // "Get a new command" cancels the code it replaces.
    const replaced = await issue("owner", { replace: third.enrollmentId });
    assert.equal(replaced.outcome, "issued");
    row = await enrollment(third.enrollmentId);
    assert.equal(row.phase, "cancelled");
    assert.equal(row.sealed_admin_private_key, null);
    assert.deepEqual((await events(third.enrollmentId)).map((e) => e.kind), ["issued", "cancelled"]);
    // Another account's id can't be cancelled through replace.
    const foreign = await issue("other");
    const afterForeign = await issue("owner", { replace: foreign.enrollmentId });
    assert.equal(afterForeign.outcome, "active_limit");
    assert.equal((await enrollment(foreign.enrollmentId)).phase, "issued");
    await assert.rejects(issue("owner", { code: "not-a-hash" }));
    await assert.rejects(issue("owner", { fingerprint: ed25519().fingerprint }));
    // 30 per day, whatever happened to them.
    for (let index = 0; index < 26; index += 1) {
      const next = await issue("daily");
      await call("cancel_server_enrollment", ["daily", next.enrollmentId]);
    }
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollments where user_id = 'daily'"), 26);
    for (let index = 0; index < 4; index += 1) {
      const next = await issue("daily");
      assert.equal(next.outcome, "issued");
      await call("cancel_server_enrollment", ["daily", next.enrollmentId]);
    }
    assert.equal((await issue("daily")).outcome, "daily_limit");
    pass("issue: active and daily limits, replacement cancels, owner-bound");

    // --- Fetch ----------------------------------------------------------------
    for (let index = 1; index <= 20; index += 1) {
      const fetched = await call("record_server_enrollment_fetch", [first.code]);
      assert.equal(fetched.status, "served");
      assert.equal(fetched.userId, "owner");
      assert.equal(fetched.adminPublicKey, admin.key);
    }
    assert.equal((await call("record_server_enrollment_fetch", [first.code])).status, "fetch_limit");
    row = await enrollment(first.enrollmentId);
    assert.equal(row.script_fetches, 20);
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'script_served'", [first.enrollmentId]), 20);
    assert.equal((await call("record_server_enrollment_fetch", [codeHash()])).status, "not_usable");
    assert.equal((await call("record_server_enrollment_fetch", ["short"])).status, "not_usable");
    assert.equal((await call("record_server_enrollment_fetch", [third.code])).status, "not_usable");
    pass("fetch: counted, capped at 20 without spending the code");

    // --- Report ---------------------------------------------------------------
    // The code stays valid for a report after the 20th download.
    const accepted = await report(first.code, { observed: "203.0.113.24" });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.words, "amber-falcon-river");
    row = await enrollment(first.enrollmentId);
    assert.equal(row.phase, "reported");
    assert.equal(new Date(row.confirm_by) - new Date(row.reported_at), 30 * 60_000);
    assert.equal(row.observed_address, "203.0.113.24");
    assert.equal(row.host_fingerprint_sha256, accepted.host.fingerprint);
    assert.ok(row.sealed_admin_private_key);
    const reportedEvent = (await events(first.enrollmentId)).find((e) => e.kind === "reported");
    assert.equal(reportedEvent.observed_address, "203.0.113.24");
    assert.equal(reportedEvent.host_fingerprint_sha256, accepted.host.fingerprint);
    // A byte-identical repeat gets the stored words, not the new ones.
    const replay = await report(first.code, { digest: accepted.digest, host: accepted.host, words: "zinc-zebra-yeti" });
    assert.deepEqual({ status: replay.status, words: replay.words, replay: replay.replay },
      { status: "accepted", words: "amber-falcon-river", replay: true });
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'reported'", [first.enrollmentId]), 1);
    // A different body after the report: refused, row unchanged (T2).
    const before = JSON.stringify(await enrollment(first.enrollmentId));
    assert.equal((await report(first.code)).status, "not_usable");
    assert.equal(JSON.stringify(await enrollment(first.enrollmentId)), before);
    assert.equal((await report(codeHash())).status, "not_usable");
    // Invalid reports raise before anything changes.
    for (const bad of [{ words: "amber-falcon-notaword" }, { words: "amber falcon river" }, { port: 0 },
      { admin: ed25519().fingerprint }, { hostFingerprint: ed25519().fingerprint }, { consent: "maybe" },
      { observed: "x".repeat(46) }]) {
      await assert.rejects(report(second.code, bad), undefined, JSON.stringify(bad));
    }
    assert.equal((await enrollment(second.enrollmentId)).phase, "issued");
    // Unsupported: spends the code, wipes the key, nothing to connect.
    const unsupportedIssue = await issue("unsupported-user");
    const unsupported = await report(unsupportedIssue.code, { kind: "unsupported", hostKey: null, hostFingerprint: null,
      port: null, admin: null, reenrollment: null, words: null, facts: { ...FACTS, osVersionId: "20.04" } });
    assert.equal(unsupported.status, "unsupported");
    row = await enrollment(unsupportedIssue.enrollmentId);
    assert.equal(row.phase, "unsupported");
    assert.equal(row.sealed_admin_private_key, null);
    assert.ok(row.decided_at);
    assert.equal((await report(unsupportedIssue.code, { kind: "unsupported", digest: unsupported.digest, hostKey: null,
      hostFingerprint: null, port: null, admin: null, reenrollment: null, words: null,
      facts: { ...FACTS, osVersionId: "20.04" } })).status, "unsupported");
    // Expiry is checked at commit (T23).
    const late = await issue("late-user");
    await rewind("update public.infrastructure_server_enrollments set issued_at = issued_at - interval '16 minutes', expires_at = expires_at - interval '16 minutes' where id = $1", [late.enrollmentId]);
    assert.equal((await report(late.code)).status, "not_usable");
    assert.equal((await call("record_server_enrollment_fetch", [late.code])).status, "not_usable");
    assert.equal((await enrollment(late.enrollmentId)).phase, "issued");
    pass("report: consume once, identical replay, unsupported, expiry at commit");

    // --- Refused reports ------------------------------------------------------
    const refusing = await issue("refusal-user");
    for (let index = 1; index <= 9; index += 1) {
      const refused = await call("refuse_server_enrollment_report", [refusing.code, index % 2 ? "ipv4_required" : "private_address"]);
      assert.deepEqual(refused, { status: "refused", cancelled: false });
    }
    row = await enrollment(refusing.enrollmentId);
    assert.equal(row.phase, "issued");
    assert.equal(row.refused_reports, 9);
    assert.equal(row.last_refusal, "ipv4_required");
    assert.equal(row.observed_address, null);
    assert.deepEqual(await call("refuse_server_enrollment_report", [refusing.code, "invalid_report"]), { status: "refused", cancelled: true });
    row = await enrollment(refusing.enrollmentId);
    assert.equal(row.phase, "cancelled");
    assert.equal(row.sealed_admin_private_key, null);
    assert.equal((await call("refuse_server_enrollment_report", [refusing.code, "invalid_report"])).status, "not_usable");
    assert.equal((await report(refusing.code)).status, "not_usable");
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'refused_report'", [refusing.enrollmentId]), row.refused_reports);
    await assert.rejects(call("refuse_server_enrollment_report", [second.code, "other"]));
    pass("refused reports: counted on the row and in receipts, the tenth cancels");

    // --- Yes ------------------------------------------------------------------
    assert.equal((await confirm("other", first.enrollmentId)).outcome, "not_found");
    assert.equal((await enrollment(first.enrollmentId)).phase, "reported");
    const yes = await confirm("owner", first.enrollmentId);
    assert.equal(yes.outcome, "connected");
    const connection = await one("select * from public.infrastructure_connections where id = $1", [yes.connectionId]);
    assert.deepEqual({ provider: connection.provider, user: connection.ssh_user, privilege: connection.ssh_privilege,
      type: connection.ssh_host_key_type, host: connection.ssh_host, port: connection.ssh_port,
      fingerprint: connection.ssh_host_fingerprint_sha256, status: connection.status, revision: Number(connection.revision) },
    { provider: "host", user: "hivra", privilege: "sudo", type: "ssh-ed25519", host: "203.0.113.24", port: 22,
      fingerprint: accepted.host.hex, status: "pending", revision: 1 });
    assert.equal(await count("select count(*) n from public.infrastructure_connection_secrets where connection_id = $1", [yes.connectionId]), 1);
    row = await enrollment(first.enrollmentId);
    assert.deepEqual({ phase: row.phase, outcome: row.outcome, connection: row.connection_id, key: row.sealed_admin_private_key },
      { phase: "confirmed", outcome: "connected", connection: yes.connectionId, key: null });
    assert.deepEqual((await events(first.enrollmentId)).slice(-2).map((e) => e.kind), ["confirmed", "connection_created"]);
    // A second Yes (the double click, or a race) changes nothing (T22).
    assert.equal((await confirm("owner", first.enrollmentId)).outcome, "not_pending");
    assert.equal(await count("select count(*) n from public.infrastructure_connections where user_id = 'owner'"), 1);
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'confirmed'", [first.enrollmentId]), 1);
    // A server still retrying a lost acknowledgement after Yes gets the same
    // acknowledgement, so it keeps the setup Hivra just connected; nothing
    // changes (review finding 7). After confirm_by it is refused.
    const confirmedBefore = JSON.stringify(await enrollment(first.enrollmentId));
    const confirmedReplay = await report(first.code, { digest: accepted.digest, host: accepted.host, words: "zinc-zebra-yeti" });
    assert.deepEqual({ status: confirmedReplay.status, words: confirmedReplay.words, replay: confirmedReplay.replay },
      { status: "accepted", words: "amber-falcon-river", replay: true });
    assert.equal(JSON.stringify(await enrollment(first.enrollmentId)), confirmedBefore);
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'reported'", [first.enrollmentId]), 1);
    // A different body after Yes is still refused (T2, T3).
    assert.equal((await report(first.code, { host: accepted.host })).status, "not_usable");
    // Terminal phases can never hold a key (T4).
    await assert.rejects(db.query("update public.infrastructure_server_enrollments set sealed_admin_private_key = $2 where id = $1", [first.enrollmentId, sealed()]));
    await db.exec("set session_replication_role = replica");
    await assert.rejects(db.query("update public.infrastructure_server_enrollments set sealed_admin_private_key = $2 where id = $1", [first.enrollmentId, sealed()]));
    await db.exec("set session_replication_role = origin");
    // A report of an identity this account already pins: Yes is refused (T30).
    const known = await report(second.code, { host: accepted.host });
    assert.equal(known.status, "accepted");
    assert.equal((await confirm("owner", second.enrollmentId)).outcome, "known_identity");
    assert.equal((await enrollment(second.enrollmentId)).phase, "reported");
    assert.equal(await count("select count(*) n from public.infrastructure_connections where user_id = 'owner'"), 1);
    // The same identity in another account is not a match there.
    const otherReport = await report(foreign.code, { host: accepted.host });
    assert.equal(otherReport.status, "accepted");
    const otherYes = await confirm("other", foreign.enrollmentId);
    assert.equal(otherYes.outcome, "connected");
    // Names never collide: the second server with the same hostname gets " 2".
    const again = await issue("other");
    await report(again.code);
    const againYes = await confirm("other", again.enrollmentId);
    assert.equal((await one("select name from public.infrastructure_connections where id = $1", [againYes.connectionId])).name, "ip-172-31-4-9 2");
    // Yes after confirm_by (T23).
    const slow = await issue("slow-user");
    await report(slow.code);
    await rewind("update public.infrastructure_server_enrollments set reported_at = reported_at - interval '31 minutes', confirm_by = confirm_by - interval '31 minutes' where id = $1", [slow.enrollmentId]);
    assert.equal((await confirm("slow-user", slow.enrollmentId)).outcome, "not_pending");
    // A confirmed report's repeat is acknowledged only until confirm_by.
    const windowed = await issue("window-user");
    const windowedReport = await report(windowed.code);
    assert.equal((await confirm("window-user", windowed.enrollmentId)).outcome, "connected");
    assert.equal((await report(windowed.code, { digest: windowedReport.digest, host: windowedReport.host })).status, "accepted");
    await rewind("update public.infrastructure_server_enrollments set reported_at = reported_at - interval '31 minutes', confirm_by = confirm_by - interval '31 minutes' where id = $1", [windowed.enrollmentId]);
    assert.equal((await report(windowed.code, { digest: windowedReport.digest, host: windowedReport.host })).status, "not_usable");
    assert.equal(await count("select count(*) n from public.infrastructure_connections where user_id = 'slow-user'"), 0);
    pass("Yes: one pinned sudo connection, owner-bound, never for a known identity");

    // --- No and cancel --------------------------------------------------------
    const declined = await issue("decliner");
    const declinedReport = await report(declined.code);
    assert.equal((await call("decline_server_enrollment", ["other", declined.enrollmentId])).outcome, "not_found");
    assert.equal((await call("decline_server_enrollment", ["decliner", declined.enrollmentId])).outcome, "rejected");
    row = await enrollment(declined.enrollmentId);
    assert.deepEqual({ phase: row.phase, key: row.sealed_admin_private_key }, { phase: "rejected", key: null });
    assert.equal((await call("decline_server_enrollment", ["decliner", declined.enrollmentId])).outcome, "not_pending");
    // After No, even a byte-identical repeat is refused, so a retrying server
    // rolls back (T3).
    assert.equal((await report(declined.code, { digest: declinedReport.digest, host: declinedReport.host })).status, "not_usable");
    assert.equal((await confirm("decliner", declined.enrollmentId)).outcome, "not_pending");
    assert.equal((await call("cancel_server_enrollment", ["owner", first.enrollmentId])).outcome, "not_pending");
    pass("No and cancel wipe the key and end the code");

    // --- Replace access -------------------------------------------------------
    const web1 = yes.connectionId;
    const revision = async (id) => Number((await one("select revision from public.infrastructure_connections where id = $1", [id])).revision);
    const secret = async (id) => (await one("select encrypted_bundle from public.infrastructure_connection_secrets where connection_id = $1", [id])).encrypted_bundle;
    const begin = (user, id, connectionId, rev, mode, run) =>
      call("begin_server_enrollment_replacement", [user, id, connectionId, rev, mode, run]);
    const fail = (user, id, run, failure) => call("fail_server_enrollment_replacement", [user, id, run, failure]);
    // A bound agent makes the key-only path record a rebind.
    const target = randomUUID(), agentId = randomUUID();
    await db.exec("set session_replication_role = replica");
    await db.query("insert into public.deployment_targets (id, user_id, connection_id, evidence_connection_revision, external_id, display_name, status, capacity, capabilities, supported_isolation_drivers, isolation_class) values ($1, 'owner', $2, 1, 'gvisor-x', 'web-1 / gvisor-x', 'ready', '{}', '{\"kind\":\"gvisor\",\"launchReady\":true}', '{gvisor-runsc}', 'application-kernel')", [target, web1]);
    await db.exec("alter table public.hivra_agents disable trigger user");
    await db.query("alter table public.hivra_agents drop constraint if exists hivra_agents_deployment_authority_matrix_check");
    await db.query("insert into public.hivra_agents (id, user_id, type, name, status, deployment_mode, infrastructure_connection_id, deployment_target_id, infrastructure_connection_revision, computer_substrate) values ($1, 'owner', 'codex', 'Codex', 'running', 'self-managed', $2, $3, 1, 'proxmox-kvm')", [agentId, web1, target]);
    await db.exec("alter table public.hivra_agents enable trigger user");
    await db.exec("set session_replication_role = origin");
    const oldSecret = await secret(web1);
    const runA = randomUUID();
    assert.equal((await begin("other", second.enrollmentId, web1, 1, "key", runA)).outcome, "not_found");
    assert.equal((await begin("owner", second.enrollmentId, web1, 2, "key", runA)).outcome, "connection_changed");
    assert.equal((await begin("owner", second.enrollmentId, web1, 1, "switch", runA)).outcome, "connection_changed");
    assert.deepEqual(await begin("owner", second.enrollmentId, web1, 1, "key", runA), { outcome: "begun", attempt: 1 });
    // A second click can't start a second check.
    assert.equal((await begin("owner", second.enrollmentId, web1, 1, "key", randomUUID())).outcome, "busy");
    // A failed check changes nothing on the connection.
    assert.equal((await fail("owner", second.enrollmentId, runA, "host_key_mismatch")).outcome, "recorded");
    assert.equal(await revision(web1), 1);
    assert.equal(await secret(web1), oldSecret);
    row = await enrollment(second.enrollmentId);
    assert.deepEqual({ phase: row.phase, failure: row.last_replacement_failure, lease: row.replacement_run_id, attempts: row.replacement_attempts },
      { phase: "reported", failure: "host_key_mismatch", lease: null, attempts: 1 });
    assert.deepEqual((await events(second.enrollmentId)).filter((e) => e.kind.startsWith("replacement") || e.kind === "identity_mismatch").map((e) => [e.kind, e.detail]),
      [["replacement_refused", "host_key_mismatch"], ["identity_mismatch", null]]);
    // Complete needs the held lease.
    assert.equal((await call("complete_server_enrollment_replacement", ["owner", second.enrollmentId, runA, bundle(), 1, null])).outcome, "lease_lost");
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      const run = randomUUID();
      assert.equal((await begin("owner", second.enrollmentId, web1, 1, "key", run)).outcome, "begun");
      // A probe that met Proxmox VE is recorded with its own class (finding 4).
      const failure = attempt === 3 ? "proxmox_needs_root" : "authentication_failed";
      await fail("owner", second.enrollmentId, run, failure);
      assert.equal((await enrollment(second.enrollmentId)).last_replacement_failure, failure);
    }
    await assert.rejects(fail("owner", second.enrollmentId, randomUUID(), "made_up"));
    // A stale revision at completion is refused and changes nothing.
    const runB = randomUUID();
    assert.deepEqual(await begin("owner", second.enrollmentId, web1, 1, "key", runB), { outcome: "begun", attempt: 5 });
    await rewind("update public.infrastructure_connections set revision = revision + 1 where id = $1", [web1]);
    assert.equal((await call("complete_server_enrollment_replacement", ["owner", second.enrollmentId, runB, bundle(), 1, null])).outcome, "connection_changed");
    await rewind("update public.infrastructure_connections set revision = revision - 1 where id = $1", [web1]);
    await fail("owner", second.enrollmentId, runB, "connection_changed");
    assert.equal((await begin("owner", second.enrollmentId, web1, 1, "key", randomUUID())).outcome, "attempts_exhausted");
    // A fresh enrollment for the same server replaces access after a verified check.
    const fresh = await issue("owner");
    await report(fresh.code, { host: accepted.host });
    const runC = randomUUID();
    assert.equal((await begin("owner", fresh.enrollmentId, web1, 1, "key", runC)).outcome, "begun");
    const newBundle = bundle();
    const replacedResult = await call("complete_server_enrollment_replacement", ["owner", fresh.enrollmentId, runC, newBundle, 1, null]);
    assert.deepEqual(replacedResult, { outcome: "replaced", connectionId: web1, revision: 2 });
    const web1After = await one("select * from public.infrastructure_connections where id = $1", [web1]);
    assert.deepEqual({ revision: Number(web1After.revision), status: web1After.status, rebind: Number(web1After.pending_binding_rebind_from_revision),
      user: web1After.ssh_user, host: web1After.ssh_host, fingerprint: web1After.ssh_host_fingerprint_sha256 },
    { revision: 2, status: "pending", rebind: 1, user: "hivra", host: "203.0.113.24", fingerprint: accepted.host.hex });
    assert.equal(await secret(web1), newBundle);
    assert.equal((await one("select status from public.deployment_targets where id = $1", [target])).status, "unavailable");
    row = await enrollment(fresh.enrollmentId);
    assert.deepEqual({ phase: row.phase, outcome: row.outcome, from: Number(row.replaced_from_revision), key: row.sealed_admin_private_key },
      { phase: "confirmed", outcome: "replaced_access", from: 1, key: null });
    // Both enrollments stay receipts for web-1.
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollments where connection_id = $1", [web1]), 2);
    assert.deepEqual((await events(fresh.enrollmentId)).slice(-3).map((e) => e.kind), ["replacement_verified", "confirmed", "access_replaced"]);
    // Switch: a root login connection no agent uses moves to hivra with sudo.
    const root = ed25519();
    const rootConnection = (await one("select id from public.create_host_infrastructure_connection('owner', 'db-1', '198.51.100.7', 22, 'root', $1, 'sealed-root-bundle-fixture-0000000000000000', 1::smallint)", [root.hex])).id;
    const switching = await issue("owner");
    await report(switching.code, { host: root });
    const runD = randomUUID();
    assert.equal((await begin("owner", switching.enrollmentId, rootConnection, 1, "key", runD)).outcome, "connection_changed");
    assert.equal((await begin("owner", switching.enrollmentId, rootConnection, 1, "switch", runD)).outcome, "begun");
    await assert.rejects(call("complete_server_enrollment_replacement", ["owner", switching.enrollmentId, runD, bundle(), 1, " "]));
    const switched = await call("complete_server_enrollment_replacement", ["owner", switching.enrollmentId, runD, bundle(), 1, "198.51.100.8"]);
    assert.equal(switched.outcome, "replaced");
    const dbAfter = await one("select * from public.infrastructure_connections where id = $1", [rootConnection]);
    assert.deepEqual({ user: dbAfter.ssh_user, privilege: dbAfter.ssh_privilege, type: dbAfter.ssh_host_key_type, host: dbAfter.ssh_host, revision: Number(dbAfter.revision) },
      { user: "hivra", privilege: "sudo", type: "ssh-ed25519", host: "198.51.100.8", revision: 2 });
    // A login connection that agents use is never switched.
    const busyRoot = ed25519();
    const busyConnection = (await one("select id from public.create_host_infrastructure_connection('owner', 'db-2', '198.51.100.9', 22, 'root', $1, 'sealed-root-bundle-fixture-0000000000000000', 1::smallint)", [busyRoot.hex])).id;
    await db.exec("set session_replication_role = replica");
    await db.query("insert into public.hivra_agents (id, user_id, type, name, status, deployment_mode, infrastructure_connection_id, deployment_target_id, infrastructure_connection_revision, computer_substrate) values ($1, 'owner', 'codex', 'Codex 2', 'running', 'self-managed', $2, $3, 1, 'proxmox-kvm')", [randomUUID(), busyConnection, target]);
    await db.exec("set session_replication_role = origin");
    const busySwitch = await issue("owner");
    await report(busySwitch.code, { host: busyRoot });
    assert.equal((await begin("owner", busySwitch.enrollmentId, busyConnection, 1, "switch", randomUUID())).outcome, "agents_bound");
    await call("decline_server_enrollment", ["owner", busySwitch.enrollmentId]);
    pass("Replace: lease, attempts, revision, key-only and switch paths, receipts kept");

    // --- Receipts are append-only (T24) -----------------------------------
    const anyEvent = (await one("select id from public.infrastructure_server_enrollment_events where enrollment_id = $1 limit 1", [first.enrollmentId])).id;
    await refusedAs("service_role", "update public.infrastructure_server_enrollment_events set detail = 'x' where id = $1", [anyEvent]);
    await refusedAs("service_role", "delete from public.infrastructure_server_enrollment_events where id = $1", [anyEvent]);
    await refusedAs("service_role", "insert into public.infrastructure_server_enrollment_events (enrollment_id, user_id, kind, actor) values ($1, 'owner', 'issued', 'owner')", [first.enrollmentId]);
    await refusedAs("service_role", "update public.infrastructure_server_enrollments set phase = 'expired' where id = $1", [second.enrollmentId]);
    await assert.rejects(db.query("update public.infrastructure_server_enrollment_events set detail = 'x' where id = $1", [anyEvent]), /cannot be changed/);
    await assert.rejects(db.query("delete from public.infrastructure_server_enrollment_events where id = $1", [anyEvent]), /only with their enrollment/);
    await assert.rejects(db.query("update public.infrastructure_server_enrollments set phase = 'issued' where id = $1", [first.enrollmentId]));
    await assert.rejects(db.query("update public.infrastructure_server_enrollments set host_public_key = $2 where id = $1", [second.enrollmentId, ed25519().key]));
    // TRUNCATE skips row triggers: its own guard refuses it, also as the table
    // owner and through a cascade from enrollments (review finding 5).
    await refusedAs("service_role", "truncate public.infrastructure_server_enrollment_events");
    await assert.rejects(db.query("truncate public.infrastructure_server_enrollment_events"), /only with their enrollment/);
    await assert.rejects(db.query("truncate public.infrastructure_server_enrollments cascade"), /only with their enrollment/);
    assert.ok(await count("select count(*) n from public.infrastructure_server_enrollment_events") > 0);
    const eventsBefore = await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1", [declined.enrollmentId]);
    assert.ok(eventsBefore > 0);
    await asRole("service_role", "delete from public.infrastructure_server_enrollments where id = $1", [declined.enrollmentId]);
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1", [declined.enrollmentId]), 0);
    // Counters on the row match the receipts.
    for (const id of [first.enrollmentId, refusing.enrollmentId]) {
      const counters = await enrollment(id);
      assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'script_served'", [id]), counters.script_fetches);
      assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = $1 and kind = 'refused_report'", [id]), counters.refused_reports);
    }
    pass("receipts: never updated, deleted only by cascade, counters match");

    // --- Sweep and retention (T41) ----------------------------------------
    await assert.rejects(call("sweep_server_enrollments", [new Date(Date.now() + 5 * 60_000).toISOString()]));
    const expiring = await issue("sweeper");
    await rewind("update public.infrastructure_server_enrollments set issued_at = issued_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' where id = $1", [expiring.enrollmentId]);
    const waiting = await issue("sweeper");
    await report(waiting.code);
    await rewind("update public.infrastructure_server_enrollments set reported_at = reported_at - interval '40 minutes', confirm_by = confirm_by - interval '40 minutes' where id = $1", [waiting.enrollmentId]);
    const swept = await call("sweep_server_enrollments", [new Date().toISOString()]);
    assert.ok(swept.expired >= 2);
    for (const id of [expiring.enrollmentId, waiting.enrollmentId]) {
      row = await enrollment(id);
      assert.deepEqual({ phase: row.phase, key: row.sealed_admin_private_key }, { phase: "expired", key: null });
      assert.ok((await events(id)).some((e) => e.kind === "expired"));
    }
    // Disconnect (delete_infrastructure_connection) of a connection the setup
    // command created: the foreign key's "on delete set null" is the one
    // update the enrollment guard lets through, so Disconnect works and the
    // receipts stay (review finding 5).
    const disconnected = await one("select * from public.delete_infrastructure_connection('other', $1)", [againYes.connectionId]);
    assert.ok(disconnected);
    assert.equal(await count("select count(*) n from public.infrastructure_connections where id = $1", [againYes.connectionId]), 0);
    row = await enrollment(again.enrollmentId);
    assert.deepEqual({ phase: row.phase, connection: row.connection_id, removed: row.connection_removed_at }, { phase: "confirmed", connection: null, removed: null });
    await call("sweep_server_enrollments", [new Date().toISOString()]);
    assert.ok((await enrollment(again.enrollmentId)).connection_removed_at);
    // Retention: ended rows after 30 days, removed-connection receipts after 90.
    await rewind("update public.infrastructure_server_enrollments set decided_at = decided_at - interval '31 days' where id = $1", [expiring.enrollmentId]);
    await rewind("update public.infrastructure_server_enrollments set decided_at = decided_at - interval '29 days' where id = $1", [waiting.enrollmentId]);
    await rewind("update public.infrastructure_server_enrollments set connection_removed_at = connection_removed_at - interval '91 days' where id = $1", [again.enrollmentId]);
    const retention = await call("sweep_server_enrollments", [new Date().toISOString()]);
    assert.ok(retention.deleted >= 2);
    assert.equal(await enrollment(expiring.enrollmentId), undefined);
    assert.equal(await enrollment(again.enrollmentId), undefined);
    assert.ok(await enrollment(waiting.enrollmentId));
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where enrollment_id = any($1)", [[expiring.enrollmentId, again.enrollmentId]]), 0);
    // Receipts for a connection that still exists are never deleted.
    await rewind("update public.infrastructure_server_enrollments set decided_at = decided_at - interval '400 days' where id = $1", [first.enrollmentId]);
    await call("sweep_server_enrollments", [new Date().toISOString()]);
    assert.ok(await enrollment(first.enrollmentId));
    pass("sweep: expiry, key wiping, retention by rule, receipts of live connections kept");

    // --- Account deletion -------------------------------------------------
    await asRole("service_role", "delete from public.infrastructure_server_enrollments where user_id = 'decliner'");
    await asRole("service_role", "delete from public.infrastructure_server_enrollments where user_id = 'refusal-user'");
    assert.equal(await count("select count(*) n from public.infrastructure_server_enrollment_events where user_id in ('decliner', 'refusal-user')"), 0);
    pass("account deletion removes enrollments and their receipts");

    // --- Identity mismatch at the first sign-in ---------------------------
    assert.equal(await call("record_server_enrollment_identity_mismatch", ["other", otherYes.connectionId]), true);
    assert.equal(await call("record_server_enrollment_identity_mismatch", ["other", otherYes.connectionId]), false);
    assert.equal(await call("record_server_enrollment_identity_mismatch", ["owner", otherYes.connectionId]), false);
    pass("identity mismatch recorded once, on the owner's enrollment");

    // --- Discovery contract v2 and revision-bound privilege (T27) ---------
    const snapshot = (connectionId, rev, runId, version, provider, environment) => {
      const observedAt = new Date();
      return { observedAt, expiresAt: new Date(observedAt.getTime() + 15 * 60_000), json: {
        discoveryId: runId, connectionId, connectionRevision: rev, connectionProvider: provider, contractVersion: version,
        observedAt: observedAt.toISOString(), expiresAt: new Date(observedAt.getTime() + 15 * 60_000).toISOString(),
        hostIdentityDigest: "d".repeat(64),
        host: { environment: { effectivePrivilege: "root", ...environment } },
        engines: Array.from({ length: 9 }, () => ({})),
      } };
    };
    const discover = async (userId, connectionId, rev, version, environment) => {
      const runId = randomUUID();
      assert.equal((await one("select public.begin_infrastructure_host_discovery($1, $2, $3, $4) r", [userId, connectionId, rev, runId])).r, true);
      const s = snapshot(connectionId, rev, runId, version, "host", environment);
      try {
        return (await one("select public.complete_infrastructure_host_discovery($1, $2, $3, $4, $5, $6, $7, $8) r",
          [userId, connectionId, rev, runId, s.observedAt.toISOString(), s.expiresAt.toISOString(), "d".repeat(64), JSON.stringify(s.json)])).r;
      } finally {
        await db.query("select public.release_infrastructure_host_discovery($1, $2, $3, $4)", [userId, connectionId, rev, runId]);
      }
    };
    const loginHost = ed25519();
    const loginConnection = (await one("select id from public.create_host_infrastructure_connection('owner', 'web-9', '198.51.100.10', 22, 'root', $1, 'sealed-root-bundle-fixture-0000000000000000', 1::smallint)", [loginHost.hex])).id;
    assert.equal(await discover("owner", loginConnection, 1, 1, {}), true);
    await assert.rejects(discover("owner", loginConnection, 1, 1, { privilegeVia: "login" }));
    await assert.rejects(discover("owner", loginConnection, 1, 2, { privilegeVia: "sudo", passwordlessSudo: null }));
    await assert.rejects(discover("owner", loginConnection, 1, 2, { privilegeVia: "login" }));
    await assert.rejects(discover("owner", loginConnection, 1, 3, { privilegeVia: "login", passwordlessSudo: null }));
    assert.equal(await discover("owner", loginConnection, 1, 2, { privilegeVia: "login", passwordlessSudo: false }), true);
    assert.equal((await one("select contract_version v from public.infrastructure_host_discovery_snapshots where connection_id = $1 order by observed_at desc limit 1", [loginConnection])).v, 2);
    // Changing the privilege is an operational edit: revision + 1.
    const updated = await one("select * from public.update_infrastructure_connection('owner', $1, 1, $2, true, false, null, null)", [loginConnection, JSON.stringify({ ssh_user: "ubuntu", ssh_privilege: "sudo" })]);
    assert.deepEqual({ revision: Number(updated.revision), privilege: updated.ssh_privilege, status: updated.status }, { revision: 2, privilege: "sudo", status: "pending" });
    assert.equal(await discover("owner", loginConnection, 2, 2, { privilegeVia: "sudo", passwordlessSudo: null }), true);
    await assert.rejects(db.query("select * from public.update_infrastructure_connection('owner', $1, 2, $2, true, false, null, null)", [loginConnection, JSON.stringify({ ssh_privilege: "root" })]));
    // A new pinned fingerprint clears the recorded key type.
    await db.query("select * from public.update_infrastructure_connection('owner', $1, 2, $2, true, false, null, null)", [loginConnection, JSON.stringify({ ssh_host_key_type: "ssh-ed25519" })]);
    const cleared = await one("select * from public.update_infrastructure_connection('owner', $1, 3, $2, true, false, null, null)", [loginConnection, JSON.stringify({ ssh_host_fingerprint_sha256: ed25519().hex })]);
    assert.equal(cleared.ssh_host_key_type, null);
    // Legacy Proxmox rows can't use sudo; old callers still create login rows.
    await assert.rejects(db.query("insert into public.infrastructure_connections (user_id, name, provider, ssh_host, ssh_port, ssh_user, ssh_host_fingerprint_sha256, ssh_privilege) values ('owner', 'pve', 'proxmox', '198.51.100.11', 22, 'root', $1, 'sudo')", [ed25519().hex]));
    const legacy = await one("select * from public.create_host_infrastructure_connection('owner', 'old-caller', '198.51.100.12', 22, 'root', $1, 'sealed-root-bundle-fixture-0000000000000000', 1::smallint)", [ed25519().hex]);
    assert.deepEqual({ privilege: legacy.ssh_privilege, type: legacy.ssh_host_key_type }, { privilege: "login", type: null });
    pass("discovery v2 commit checks and revision-bound privilege");

    console.log(`PASS server enrollment actual SQL: ${results.length} groups`);
    for (const name of results) console.log(`PASS ${name}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
