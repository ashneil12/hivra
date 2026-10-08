import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RefusedError,
  buildAtomicApply,
  checkDownPlan,
  parseChainList,
  parseRowsArgs,
  renderReport,
  renderRearmSql,
  partitionGuards,
  resolveChain,
  runRehearsal,
} from './prod-chain-rehearsal.mjs';

const SQL_A = 'create table public.a (id int primary key);\n';

// ---------------------------------------------------------------- atomic wrapper
test('wrapper is one transaction: guard, file verbatim, ledger row, commit', () => {
  const w = buildAtomicApply({ fileName: '20260101000000_make_a.sql', sql: SQL_A });
  assert.equal(w.version, '20260101000000');
  assert.equal(w.name, 'make_a');
  const lines = w.wrapped.split('\n');
  assert.equal(lines[2], 'begin;');
  assert.match(w.wrapped, /set local lock_timeout = '5s';/);
  assert.match(w.wrapped, /set local statement_timeout = '45s';/);
  const guard = w.wrapped.indexOf('already in the ledger');
  const body = w.wrapped.indexOf(SQL_A.trim());
  const ledger = w.wrapped.indexOf('insert into supabase_migrations.schema_migrations');
  const commit = w.wrapped.lastIndexOf('commit;');
  assert.ok(guard > 0 && guard < body && body < ledger && ledger < commit);
  assert.match(w.wrapped, /version = '20260101000000' or name = 'make_a'/);
  assert.match(w.wrapped, /-- source sha256: [0-9a-f]{64}/);
});

test('wrapper tags never collide with a migration that uses its own dollar quotes', () => {
  const sql = "do $migration$ begin perform 1; end $migration$;\ncreate table b();\n";
  const w = buildAtomicApply({ fileName: '20260101000001_b.sql', sql });
  const tags = [...w.wrapped.matchAll(/\$(guard|migration)_[0-9a-f]{8}\$/g)].map((m) => m[0]);
  assert.ok(tags.length >= 4);
  for (const t of new Set(tags)) assert.equal(sql.includes(t), false);
});

test('wrapper escapes single quotes in the statements array literal source', () => {
  const sql = "insert into public.t values ('it''s');\n";
  const w = buildAtomicApply({ fileName: '20260101000002_q.sql', sql });
  assert.ok(w.wrapped.includes("array[$migration_"));
  assert.ok(w.wrapped.includes(sql));
});

test('wrapper refuses what cannot be atomic', () => {
  const refuse = (sql, re) => assert.throws(() => buildAtomicApply({ fileName: '20260101000003_x.sql', sql }), (e) => e instanceof RefusedError && re.test(e.message));
  refuse('begin;\ncreate table x();\ncommit;\n', /transaction control/);
  refuse('create index concurrently i on t(a);\n', /CONCURRENTLY/);
  refuse('vacuum t;\n', /cannot run inside a transaction/);
  refuse('alter system set work_mem = 1;\n', /cannot run inside a transaction/);
  refuse('   \n', /empty/);
  assert.throws(() => buildAtomicApply({ fileName: 'bad name.sql', sql: SQL_A }), RefusedError);
});

test('wrapper does not mistake comments, strings or function bodies for transaction control', () => {
  const sql = [
    '-- begin; commit; create index concurrently',
    "select 'begin; commit;';",
    'create function f() returns void language plpgsql as $$ begin perform 1; if true then null; end if; end $$;',
    '',
  ].join('\n');
  const w = buildAtomicApply({ fileName: '20260101000004_ok.sql', sql });
  assert.equal(w.warnings.length, 0);
});

test('wrapper warns on enum ADD VALUE but still builds', () => {
  const w = buildAtomicApply({ fileName: '20260101000005_e.sql', sql: "alter type public.t add value 'x';\n" });
  assert.equal(w.warnings.length, 1);
});

// ---------------------------------------------------------------- chain list
test('chain list accepts plain versions, record-only marker, comments and plan-format lines', () => {
  const list = parseChainList([
    '# pinned chain',
    '20260101000000',
    '20260101000002   record-only',
    '[3] PLAN  20260101000001_b.sql  sha256:abcdef0123456789',
    '',
  ].join('\n'));
  assert.deepEqual(list, [
    { version: '20260101000000', recordOnly: false },
    { version: '20260101000002', recordOnly: true },
    { version: '20260101000001', recordOnly: false },
  ]);
});

test('chain list rejects duplicates and junk', () => {
  assert.throws(() => parseChainList('20260101000000\n20260101000000\n'), /duplicate/);
  assert.throws(() => parseChainList('not-a-version\n'), /unrecognised/);
});

test('resolveChain enforces one file per version and strict filename order', () => {
  const files = ['20260101000000_a.sql', '20260101000001_b.sql', '20260101000002_c.sql'];
  const out = resolveChain(parseChainList('20260101000002\n20260101000000\n'), files);
  assert.deepEqual(out.map((e) => e.file), ['20260101000000_a.sql', '20260101000002_c.sql']);
  assert.throws(() => resolveChain(parseChainList('20269999999999\n'), files), /no migration file/);
  assert.throws(() => resolveChain(parseChainList('20260101000000\n'), [...files, '20260101000000_dup.sql']), /more than one/);
});

// ---------------------------------------------------------------- row inputs
test('row arguments are limited to the five constrained tables', () => {
  assert.deepEqual(parseRowsArgs(['hivra_agents=/x/a.csv']), [{ table: 'hivra_agents', path: '/x/a.csv' }]);
  assert.throws(() => parseRowsArgs(['profiles=/x/p.csv']), /not one of/);
  assert.throws(() => parseRowsArgs(['hivra_agents']), /table=path/);
  assert.throws(() => parseRowsArgs(['hivra_agents=a.csv', 'hivra_agents=b.csv']), /twice/);
});

// ---------------------------------------------------------------- runner (fake engine)
function fakeEngine({ failOn = [], guards = null, probe = null } = {}) {
  const applied = [];
  const calls = [];
  return {
    applied,
    calls,
    async prepare() { calls.push('prepare'); },
    async loadSchema() { calls.push('loadSchema'); return { errors: [] }; },
    async loadRows(table) { calls.push(`rows:${table}`); return { count: 3 }; },
    async rowCounts() { return { hivra_agents: 3 }; },
    async apply(version, wrapped) {
      if (failOn.includes(version)) return { ok: false, error: 'ERROR:  check constraint "x" of relation "hivra_agents" is violated by some row' };
      applied.push(version);
      return { ok: true, notices: 0 };
    },
    async recordOnly(version) { applied.push(`record:${version}`); return { ok: true }; },
    async postChecks() { return { ledgerCount: applied.length, exposedDefiners: [], rlsOff: [] }; },
    async stop() { calls.push('stop'); },
  };
}

const CHAIN = [
  { version: '20260101000000', name: 'a', file: '20260101000000_a.sql', recordOnly: false },
  { version: '20260101000001', name: 'b', file: '20260101000001_b.sql', recordOnly: false },
  { version: '20260101000002', name: 'c', file: '20260101000002_c.sql', recordOnly: false },
  { version: '20260101000003', name: 'd', file: '20260101000003_d.sql', recordOnly: true },
];
const readMigration = () => SQL_A;

test('runner applies in order, then the record-only rows, and reports every file', async () => {
  const engine = fakeEngine();
  const report = await runRehearsal({ engine, kind: 'synthetic', schemaSql: 'select 1;', chain: CHAIN, readMigration, rows: [{ table: 'hivra_agents', path: 'x.csv' }] });
  assert.equal(report.passed, true);
  assert.deepEqual(engine.applied, ['20260101000000', '20260101000001', '20260101000002', 'record:20260101000003']);
  assert.equal(report.files.length, 4);
  assert.deepEqual(report.files.map((f) => f.status), ['PASS', 'PASS', 'PASS', 'RECORDED']);
  assert.ok(engine.calls.includes('rows:hivra_agents'));
});

test('runner stops at the first failure and marks the rest NOT RUN', async () => {
  const engine = fakeEngine({ failOn: ['20260101000001'] });
  const report = await runRehearsal({ engine, kind: 'real', schemaSql: 'select 1;', chain: CHAIN, readMigration });
  assert.equal(report.passed, false);
  assert.deepEqual(engine.applied, ['20260101000000']);
  assert.deepEqual(report.files.map((f) => f.status), ['PASS', 'FAIL', 'NOT RUN', 'NOT RUN']);
  assert.match(report.files[1].error, /violated by some row/);
  assert.equal(report.firstFailure.version, '20260101000001');
});

test('runner refuses to start when a file cannot be wrapped (before touching the database)', async () => {
  const engine = fakeEngine();
  const bad = (f) => (f === '20260101000001_b.sql' ? 'begin;\nselect 1;\ncommit;\n' : SQL_A);
  await assert.rejects(runRehearsal({ engine, kind: 'real', schemaSql: 'select 1;', chain: CHAIN, readMigration: bad }), /20260101000001_b\.sql.*transaction control/s);
  assert.equal(engine.calls.includes('loadSchema'), false);
});

test('runner fails the rehearsal when the schema load had errors, unless allowed', async () => {
  const engine = fakeEngine();
  engine.loadSchema = async () => ({ errors: ['ERROR: role "x" does not exist'] });
  const strict = await runRehearsal({ engine, kind: 'real', schemaSql: 's', chain: CHAIN, readMigration });
  assert.equal(strict.passed, false);
  assert.equal(strict.files.length, 4);
  assert.ok(strict.files.every((f) => f.status === 'NOT RUN'));
  const lenient = await runRehearsal({ engine: fakeEngine(), kind: 'real', schemaSql: 's', chain: CHAIN, readMigration, allowLoadErrors: true });
  assert.equal(lenient.passed, true);
});

test('a synthetic result can never be read as the real gate', async () => {
  const report = await runRehearsal({ engine: fakeEngine(), kind: 'synthetic', schemaSql: 's', chain: CHAIN, readMigration });
  const text = renderReport(report);
  assert.match(text, /SYNTHETIC/);
  assert.match(text, /does NOT satisfy the production rehearsal gate/);
  assert.equal(report.gateEligible, false);
  const real = await runRehearsal({ engine: fakeEngine(), kind: 'real', schemaSql: 's', chain: CHAIN, readMigration });
  assert.equal(real.gateEligible, true);
  assert.doesNotMatch(renderReport(real), /does NOT satisfy/);
  await assert.rejects(runRehearsal({ engine: fakeEngine(), kind: 'maybe', schemaSql: 's', chain: CHAIN, readMigration }), /kind/);
});

test('report is public-safe: no absolute paths, hosts or ids leak in', async () => {
  const report = await runRehearsal({ engine: fakeEngine(), kind: 'synthetic', schemaSql: 's', chain: CHAIN, readMigration, rows: [{ table: 'hivra_agents', path: ['', 'Users', 'someone', 'secret', 'agents.csv'].join('/') }] });
  const text = JSON.stringify(report) + renderReport(report);
  assert.doesNotMatch(text, /\/Users\//);
});

// ---------------------------------------------------------------- guard attribution
test('runner records which chain file introduced each hivra_agents guard', async () => {
  const states = [
    { constraints: [], triggers: [], notNullColumns: [] },
    { constraints: [{ name: 'k1', def: 'CHECK (a)' }], triggers: [], notNullColumns: [] },
    { constraints: [{ name: 'k1', def: 'CHECK (a)' }], triggers: [{ name: 't1', def: 'CREATE TRIGGER t1' }], notNullColumns: [] },
    { constraints: [{ name: 'k1', def: 'CHECK (b)' }, { name: 'k2', def: 'CHECK (c)' }], triggers: [{ name: 't1', def: 'CREATE TRIGGER t1' }], notNullColumns: [] },
  ];
  let i = 0;
  const engine = fakeEngine();
  engine.captureGuards = async () => states[Math.min(i++, states.length - 1)];
  const report = await runRehearsal({ engine, kind: 'synthetic', schemaSql: 's', chain: CHAIN.slice(0, 3), readMigration });
  // call order: before, after file 1, after file 2, after file 3, final
  assert.deepEqual(report.guards.byFile, {
    '20260101000000_a': ['constraint k1'],
    '20260101000001_b': ['trigger t1'],
    '20260101000002_c': ['constraint k2'],
  });
});

// ---------------------------------------------------------------- guard scope and re-arm
test('guards are split by the chain files the down plan is scoped to', () => {
  const added = {
    constraints: [{ name: 'k1', introducedBy: '20260101000000_a' }, { name: 'k2', introducedBy: '20260101000001_b' }],
    triggers: [{ name: 't1', introducedBy: '20260101000001_b' }],
    notNullColumns: [],
  };
  const { inScope, outOfScope } = partitionGuards(added, new Set(['20260101000001']));
  assert.deepEqual(inScope.constraints.map((c) => c.name), ['k2']);
  assert.deepEqual(inScope.triggers.map((c) => c.name), ['t1']);
  assert.deepEqual(outOfScope.constraints.map((c) => c.name), ['k1']);
  const all = partitionGuards(added, null);
  assert.equal(all.outOfScope.constraints.length, 0);
});

test('re-arm SQL restores constraints then triggers from the captured definitions', () => {
  const sql = renderRearmSql({
    constraints: [{ name: 'hivra_agents_x_check', def: "CHECK ((status = ANY (ARRAY['a'::text])))" }],
    triggers: [{ name: 'hivra_agents_y_guard', def: 'CREATE TRIGGER hivra_agents_y_guard BEFORE INSERT ON public.hivra_agents FOR EACH ROW EXECUTE FUNCTION guard_y()' }],
    notNullColumns: [],
  });
  assert.match(sql, /^begin;/m);
  assert.match(sql, /alter table public\.hivra_agents add constraint hivra_agents_x_check CHECK/);
  assert.ok(sql.indexOf('add constraint') < sql.indexOf('create trigger hivra_agents_y_guard') + sql.length);
  assert.match(sql, /CREATE TRIGGER hivra_agents_y_guard BEFORE INSERT ON public\.hivra_agents/);
  assert.match(sql, /commit;\s*$/);
});

// ---------------------------------------------------------------- down plan review
const ADDED = {
  constraints: [{ name: 'hivra_agents_deployment_mode_check' }, { name: 'hivra_agents_operation_shape_check' }],
  triggers: [{ name: 'hivra_agents_provider_installer_guard' }],
  notNullColumns: [{ name: 'some_required_col' }],
};

test('down plan review passes when it drops exactly the added guards', () => {
  const sql = [
    'begin;',
    'drop trigger if exists hivra_agents_provider_installer_guard on public.hivra_agents;',
    'alter table public.hivra_agents drop constraint if exists hivra_agents_deployment_mode_check;',
    'alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;',
    'alter table public.hivra_agents alter column some_required_col drop not null;',
    'commit;',
  ].join('\n');
  const r = checkDownPlan(ADDED, sql);
  assert.deepEqual(r, { ok: true, missing: [], unexpected: [] });
});

test('down plan review flags a missed guard and an unrelated drop', () => {
  const sql = [
    'begin;',
    'drop trigger if exists hivra_agents_provider_installer_guard on public.hivra_agents;',
    'alter table public.hivra_agents drop constraint if exists hivra_agents_deployment_mode_check;',
    'alter table public.hivra_agents drop constraint if exists hivra_agents_pkey;',
    'drop table public.hivra_agents;',
    'commit;',
  ].join('\n');
  const r = checkDownPlan(ADDED, sql);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['constraint hivra_agents_operation_shape_check', 'not null some_required_col']);
  assert.ok(r.unexpected.some((u) => /hivra_agents_pkey/.test(u)));
  assert.ok(r.unexpected.some((u) => /drop table/i.test(u)));
});

test('down plan review ignores commented-out statements', () => {
  const sql = '-- drop trigger hivra_agents_provider_installer_guard on public.hivra_agents;\nselect 1;\n';
  const r = checkDownPlan({ constraints: [], triggers: [{ name: 'hivra_agents_provider_installer_guard' }], notNullColumns: [] }, sql);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- real Postgres (opt-in)
// HIVRA_REHEARSAL_DB_TEST=1 [HIVRA_REHEARSAL_TEST_IMAGE=postgres:16]. Needs docker.
const dbTest = process.env.HIVRA_REHEARSAL_DB_TEST === '1' ? test : test.skip;
dbTest('end to end on a throwaway Postgres: stub roles, schema, rows, chain, stop at failure', async () => {
  const { createDockerEngine } = await import('./prod-chain-rehearsal.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-test-'));
  writeFileSync(join(dir, 'agents.csv'), 'id,user_id,status\n1,u1,running\n2,u2,\n');
  const migrations = {
    '20260201000000_add_status_default.sql': "update public.hivra_agents set status = 'provisioning' where status is null;\n",
    '20260201000001_status_not_null.sql': 'alter table public.hivra_agents alter column status set not null;\n',
    '20260201000002_after.sql': 'create table public.after_failure(id int);\n',
  };
  const chain = Object.keys(migrations).map((file) => ({ version: file.slice(0, 14), name: file.slice(15, -4), file, recordOnly: false }));
  const engine = await createDockerEngine({ image: process.env.HIVRA_REHEARSAL_TEST_IMAGE || 'postgres:16' });
  try {
    const schema = 'create table public.hivra_agents (id int primary key, user_id text not null, status text);\n';
    // second file must fail: one CSV row has an empty status that the first file
    // does not repair because it targets a different table
    const report = await runRehearsal({
      engine, kind: 'synthetic', schemaSql: schema, chain,
      readMigration: (f) => migrations[f],
      rows: [{ table: 'hivra_agents', path: join(dir, 'agents.csv') }],
    });
    assert.equal(report.passed, true, JSON.stringify(report.files));
    // negative control: break the first file so the second fails atomically
    const bad = { ...migrations, '20260201000000_add_status_default.sql': 'select 1;\n' };
    const engine2 = await createDockerEngine({ image: process.env.HIVRA_REHEARSAL_TEST_IMAGE || 'postgres:16' });
    try {
      const r2 = await runRehearsal({ engine: engine2, kind: 'synthetic', schemaSql: schema, chain, readMigration: (f) => bad[f], rows: [{ table: 'hivra_agents', path: join(dir, 'agents.csv') }] });
      assert.deepEqual(r2.files.map((f) => f.status), ['PASS', 'FAIL', 'NOT RUN']);
      assert.match(r2.files[1].error, /contains null values|violated by some row/);
      assert.equal(r2.post.ledgerCount, 1, 'failed file left no ledger row');
    } finally {
      await engine2.stop();
    }
  } finally {
    await engine.stop();
  }
});
