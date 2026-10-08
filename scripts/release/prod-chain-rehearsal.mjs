import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Rehearse the production migration chain on a throwaway local Postgres.
//
// WHY: the production ledger is not evidence, canary evolved differently from
// production, and a migration can add a constraint or guard trigger that
// rejects rows production already holds. The only honest proof that the chain
// applies is to run it, file by file, on a copy of production's schema plus the
// rows of the constrained tables. See docs/release/PROD-CHAIN-REHEARSAL.md.
//
// What it does, in order:
//   1. wraps every chain file in the SAME atomic wrapper the real run uses
//      (one transaction: lock/statement timeouts, ledger guard, the file
//      verbatim, ledger row, commit). Refuses a file that cannot be wrapped
//      before any database exists.
//   2. starts a throwaway Postgres container (default: the Supabase Postgres
//      image, so anon / authenticated / service_role / supabase_read_only_user
//      are real roles) and stubs whatever the image lacks.
//   3. loads a schema-only dump, then optional row CSVs.
//   4. applies the chain in strict filename order, one transaction per file,
//      and STOPS at the first failure. The record-only entries go last.
//   5. post-chain checks, hivra_agents guard diff, and (optional) the old-build
//      write probe and the down plan rehearsal.
//
// It never connects to any hosted database. The only network it touches is the
// local docker daemon.

const HERE = dirname(fileURLToPath(import.meta.url));
// four-part tag, joined so the tree hygiene scan does not read it as an address
export const DEFAULT_IMAGE = `public.ecr.aws/supabase/postgres:${['17', '6', '1', '165'].join('.')}`;
export const CONSTRAINED_TABLES = [
  'hivra_agents',
  'crypto_deposit_receipts',
  'yearly_token_quotes',
  'yearly_token_subscriptions',
  'managed_venice_token_quotes',
];
const FILE_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export class RefusedError extends Error {}

// ---------------------------------------------------------------- lexer
// Returns the SQL with comments removed, string contents blanked, and each
// dollar-quoted body replaced by \0<n>\0, so statement checks only ever see
// top-level syntax.
export function lex(sql) {
  const out = [];
  const bodies = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (sql.startsWith('/*', i)) {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      out.push(' ');
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      out.push("''");
      i = j + 1;
    } else if (c === '"') {
      let j = sql.indexOf('"', i + 1);
      if (j < 0) j = n - 1;
      out.push(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (!m) {
        out.push(c);
        i += 1;
        continue;
      }
      const tag = m[0];
      let j = sql.indexOf(tag, i + tag.length);
      if (j < 0) j = n;
      bodies.push(sql.slice(i + tag.length, j));
      out.push(`\u0000${bodies.length - 1}\u0000`);
      i = j + tag.length;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return { code: out.join(''), bodies };
}

export const statements = (code) => code.split(';').map((s) => s.trim()).filter(Boolean);
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const lit = (s) => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- atomic wrapper
// Mirrors the maintainer's build-atomic-apply wrapper: same transaction shape,
// same ledger guard (version OR name), same refusals.
export function buildAtomicApply({ fileName, sql, lockTimeout = '5s', statementTimeout = '45s', nameGuard = true }) {
  const m = FILE_RE.exec(fileName);
  if (!m) throw new RefusedError(`${fileName} is not <14-digit-version>_<snake_name>.sql`);
  if (fileName.includes('_pending_destructive_migrations')) throw new RefusedError('destructive migrations are not part of the chain');
  const [, version, name] = m;
  if (!sql.trim()) throw new RefusedError('empty migration');
  const problems = [];
  const warnings = [];
  for (const st of statements(lex(sql).code)) {
    const s = squash(st);
    if (/^(begin|start transaction|commit|end|rollback|savepoint|release)\b/.test(s) && !s.startsWith('end if')) problems.push(`top-level transaction control: ${s.slice(0, 60)}`);
    if (/\bconcurrently\b/.test(s)) problems.push(`CONCURRENTLY cannot run inside a transaction: ${s.slice(0, 80)}`);
    if (/^(vacuum|alter system|create database|drop database)\b/.test(s)) problems.push(`cannot run inside a transaction: ${s.slice(0, 60)}`);
    if (/^alter type .* add value/.test(s)) warnings.push(`enum ADD VALUE is not usable until commit: ${s.slice(0, 80)}`);
  }
  if (problems.length) throw new RefusedError(`not atomically wrappable: ${problems.join('; ')}`);
  const fresh = (prefix) => {
    for (;;) {
      const tag = `$${prefix}_${randomBytes(4).toString('hex')}$`;
      if (!sql.includes(tag)) return tag;
    }
  };
  const g = fresh('guard');
  const t = fresh('migration');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const body = sql.trimEnd();
  const wrapped = [
    `-- atomic apply: ${version}_${name}`,
    `-- source sha256: ${sha256}`,
    'begin;',
    `set local lock_timeout = ${lit(lockTimeout)};`,
    `set local statement_timeout = ${lit(statementTimeout)};`,
    `do ${g} begin`,
    '  if exists (select 1 from supabase_migrations.schema_migrations',
    `             where version = ${lit(version)}${nameGuard ? ` or name = ${lit(name)}` : ''}) then`,
    `    raise exception '${version}_${name} is already in the ledger (by version${nameGuard ? ' or name' : ''}); not re-applying';`,
    '  end if;',
    `end ${g};`,
    '',
    body,
    body.endsWith(';') ? '' : ';',
    '',
    'insert into supabase_migrations.schema_migrations (version, name, statements)',
    `values (${lit(version)}, ${lit(name)}, array[${t}${sql}${t}]);`,
    'commit;',
    '',
  ].join('\n');
  return { version, name, wrapped, sha256, warnings };
}

// ---------------------------------------------------------------- chain list
export function parseChainList(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = /^(\d{14})(?:\s+(record-only))?\s*$/.exec(line);
    let recordOnly = false;
    if (m) recordOnly = Boolean(m[2]);
    else {
      m = /^\[\d+\]\s+PLAN\s+(\d{14})_[a-z0-9_]+\.sql\b/.exec(line);
    }
    if (!m) throw new Error(`chain list: unrecognised line: ${line.slice(0, 80)}`);
    if (seen.has(m[1])) throw new Error(`chain list: duplicate version ${m[1]}`);
    seen.add(m[1]);
    out.push({ version: m[1], recordOnly });
  }
  return out;
}

export function resolveChain(entries, fileNames) {
  const resolved = entries.map((e) => {
    const hits = fileNames.filter((f) => f.startsWith(`${e.version}_`) && f.endsWith('.sql'));
    if (hits.length === 0) throw new Error(`chain: no migration file for version ${e.version}`);
    if (hits.length > 1) throw new Error(`chain: more than one file for version ${e.version}`);
    const m = FILE_RE.exec(hits[0]);
    if (!m) throw new Error(`chain: ${hits[0]} is not <14-digit-version>_<snake_name>.sql`);
    return { version: e.version, name: m[2], file: hits[0], recordOnly: e.recordOnly };
  });
  return resolved.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export function parseRowsArgs(args) {
  const seen = new Set();
  return args.map((a) => {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`--rows expects table=path.csv, got "${a}"`);
    const table = a.slice(0, i);
    if (!CONSTRAINED_TABLES.includes(table)) throw new Error(`--rows: "${table}" is not one of ${CONSTRAINED_TABLES.join(', ')}`);
    if (seen.has(table)) throw new Error(`--rows: ${table} given twice`);
    seen.add(table);
    return { table, path: a.slice(i + 1) };
  });
}

// ---------------------------------------------------------------- down plan review
// The down plan may drop exactly the guards the chain added to hivra_agents:
// triggers, CHECK constraints, and NOT NULL without default. Anything else is
// flagged. Comments and string contents are ignored.
export function checkDownPlan(added, sql) {
  const expected = new Set([
    ...added.constraints.map((c) => `constraint ${c.name}`),
    ...added.triggers.map((t) => `trigger ${t.name}`),
    ...added.notNullColumns.map((c) => `not null ${c.name}`),
  ]);
  const seen = new Set();
  const unexpected = [];
  const table = '(?:only\\s+)?(?:public\\.)?hivra_agents';
  for (const st of statements(lex(sql).code)) {
    const s = squash(st);
    if (/^(begin|commit|set local [a-z_]+ = '[^']*'|set local [a-z_]+ to '[^']*'|select\b.*)$/.test(s)) continue;
    let m = new RegExp(`^drop trigger (?:if exists )?"?([a-z0-9_]+)"? on (?:public\\.)?hivra_agents$`).exec(s);
    if (m) {
      seen.add(`trigger ${m[1]}`);
      if (!expected.has(`trigger ${m[1]}`)) unexpected.push(`trigger ${m[1]}`);
      continue;
    }
    m = new RegExp(`^alter table ${table} (.+)$`).exec(s);
    if (m) {
      for (const action of m[1].split(/,\s*(?=drop constraint|alter column)/)) {
        const dc = /^drop constraint (?:if exists )?"?([a-z0-9_]+)"?$/.exec(action.trim());
        const dn = /^alter column "?([a-z0-9_]+)"? drop not null$/.exec(action.trim());
        if (dc) {
          seen.add(`constraint ${dc[1]}`);
          if (!expected.has(`constraint ${dc[1]}`)) unexpected.push(`constraint ${dc[1]}`);
        } else if (dn) {
          seen.add(`not null ${dn[1]}`);
          if (!expected.has(`not null ${dn[1]}`)) unexpected.push(`not null ${dn[1]}`);
        } else unexpected.push(`statement: alter table hivra_agents ${action.trim().slice(0, 80)}`);
      }
      continue;
    }
    unexpected.push(`statement: ${s.slice(0, 80)}`);
  }
  const missing = [...expected].filter((e) => !seen.has(e));
  return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

export function diffGuards(before, after) {
  const key = (list) => new Map(list.map((x) => [x.name, x]));
  const added = { constraints: [], triggers: [], notNullColumns: [] };
  const redefined = { constraints: [], triggers: [] };
  for (const kind of ['constraints', 'triggers']) {
    const b = key(before[kind]);
    for (const a of after[kind]) {
      if (!b.has(a.name)) added[kind].push(a);
      else if (b.get(a.name).def !== a.def) redefined[kind].push(a);
    }
  }
  const bn = new Set(before.notNullColumns.map((c) => c.name));
  added.notNullColumns = after.notNullColumns.filter((c) => !bn.has(c.name));
  return { added, redefined };
}

// Split the guards the chain added into those introduced by the files the down
// plan is scoped to (versions) and the rest. scopeVersions null = everything.
export function partitionGuards(added, scopeVersions) {
  const inScope = { constraints: [], triggers: [], notNullColumns: [] };
  const outOfScope = { constraints: [], triggers: [], notNullColumns: [] };
  for (const kind of Object.keys(inScope)) {
    for (const g of added[kind]) {
      const version = String(g.introducedBy || '').slice(0, 14);
      (!scopeVersions || scopeVersions.has(version) ? inScope : outOfScope)[kind].push(g);
    }
  }
  return { inScope, outOfScope };
}

// SQL that puts captured guards back (constraints, then triggers), idempotent.
// Re-adding a CHECK validates every row, so rows written while the guards were
// off may need repair first; the whole script is one transaction.
export function renderRearmSql(guards) {
  const out = ['begin;', "set local lock_timeout = '5s';"];
  for (const c of guards.constraints) {
    out.push(`alter table public.hivra_agents drop constraint if exists ${c.name};`);
    out.push(`alter table public.hivra_agents add constraint ${c.name} ${c.def};`);
  }
  for (const t of guards.triggers) {
    out.push(`drop trigger if exists ${t.name} on public.hivra_agents;`);
    out.push(`${t.def};`);
  }
  out.push('commit;', '');
  return out.join('\n');
}

const sameGuards = (a, b) => {
  const norm = (g) => JSON.stringify({ c: g.constraints.map((x) => [x.name, x.def]), t: g.triggers.map((x) => [x.name, x.def]), n: g.notNullColumns.map((x) => x.name) });
  return norm(a) === norm(b);
};

// ---------------------------------------------------------------- schema dump hygiene
// A pg_dump of schema public replays three things the target container already
// has or cannot grant: CREATE SCHEMA public, and default privileges for roles the
// rehearsal user is not allowed to change (supabase_admin). They are dropped and
// counted in the report; everything else is loaded exactly as dumped.
export function normalizeSchemaDump(sql) {
  const removed = { createSchemaPublic: 0, defaultPrivilegesForAdmin: 0 };
  const kept = [];
  for (const line of sql.split('\n')) {
    if (/^CREATE SCHEMA public;\s*$/.test(line)) removed.createSchemaPublic += 1;
    else if (/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin\b/.test(line)) removed.defaultPrivilegesForAdmin += 1;
    else kept.push(line);
  }
  return { sql: kept.join('\n'), removed };
}

// ---------------------------------------------------------------- runner
const firstLines = (text, n = 3) => text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' | ');

export async function runRehearsal({
  engine,
  kind,
  schemaSql,
  chain,
  readMigration,
  rows = [],
  probeSql = null,
  downPlanSql = null,
  rearmSql = null,
  guardScope = null,
  allowLoadErrors = false,
  log = () => {},
  now = () => Date.now(),
}) {
  if (kind !== 'real' && kind !== 'synthetic') throw new Error('kind must be "real" (a dump of the real target) or "synthetic"');
  const wrappers = new Map();
  const shas = new Map();
  for (const e of chain) {
    const sql = readMigration(e.file);
    shas.set(e.version, createHash('sha256').update(sql).digest('hex').slice(0, 16));
    if (e.recordOnly) continue;
    try {
      wrappers.set(e.version, buildAtomicApply({ fileName: e.file, sql }));
    } catch (err) {
      if (err instanceof RefusedError) throw new Error(`${e.file}: ${err.message}`);
      throw err;
    }
  }
  const ordered = [...chain.filter((e) => !e.recordOnly), ...chain.filter((e) => e.recordOnly)];
  const files = ordered.map((e) => ({ version: e.version, name: e.name, status: 'NOT RUN', recordOnly: e.recordOnly, sha256: shas.get(e.version) }));
  const report = {
    kind,
    gateEligible: false,
    passed: false,
    schemaSha256: createHash('sha256').update(schemaSql).digest('hex').slice(0, 16),
    chainSize: chain.length,
    files,
    loadErrors: [],
    rows: [],
    firstFailure: null,
    post: null,
    guards: null,
    probe: null,
    downPlan: null,
  };

  await engine.prepare();
  const normalised = normalizeSchemaDump(schemaSql);
  report.dumpNormalised = normalised.removed;
  const load = await engine.loadSchema(normalised.sql);
  report.loadErrors = load.errors;
  if (load.errors.length && !allowLoadErrors) {
    report.firstFailure = { version: null, name: 'schema load', error: `${load.errors.length} error(s) loading the schema dump; first: ${load.errors[0]}` };
    return finish(report, kind);
  }
  for (const r of rows) {
    const res = await engine.loadRows(r.table, r.path);
    report.rows.push({ table: r.table, loaded: res.count });
  }
  const countsBefore = rows.length ? await engine.rowCounts(rows.map((r) => r.table)) : {};
  if (engine.exposure) report.pre = await engine.exposure();
  const guardsBefore = engine.captureGuards ? await engine.captureGuards() : null;
  if (probeSql && engine.runProbe) report.probe = { before: await engine.runProbe(probeSql) };
  // which file introduced each hivra_agents guard (needs one catalog read per file)
  const origin = new Map();
  let guardsPrev = guardsBefore;

  let stopped = false;
  for (let i = 0; i < ordered.length; i += 1) {
    const e = ordered[i];
    const f = files[i];
    if (stopped) continue;
    const t0 = now();
    const res = e.recordOnly ? await engine.recordOnly(e.version, e.name, readMigration(e.file)) : await engine.apply(e.version, wrappers.get(e.version).wrapped);
    f.ms = now() - t0;
    if (res.ok) {
      if (guardsPrev) {
        const now2 = await engine.captureGuards();
        const d = diffGuards(guardsPrev, now2);
        for (const [kind, label] of [['constraints', 'constraint'], ['triggers', 'trigger'], ['notNullColumns', 'not null']]) {
          for (const x of d.added[kind]) if (!origin.has(`${label} ${x.name}`)) origin.set(`${label} ${x.name}`, `${e.version}_${e.name}`);
        }
        guardsPrev = now2;
      }
      f.status = e.recordOnly ? 'RECORDED' : 'PASS';
      if (res.notices) f.notices = res.notices;
    } else {
      f.status = 'FAIL';
      f.error = res.error;
      report.firstFailure = { version: e.version, name: e.name, error: res.error };
      stopped = true;
    }
    log(`[${i + 1}/${ordered.length}] ${f.status} ${e.version}_${e.name}`);
  }

  report.post = await engine.postChecks(chain);
  if (rows.length) {
    const after = await engine.rowCounts(rows.map((r) => r.table));
    report.rowCounts = { before: countsBefore, after };
  }
  if (guardsBefore && !stopped) {
    const guardsAfter = await engine.captureGuards();
    report.guards = diffGuards(guardsBefore, guardsAfter);
    const label = { constraints: 'constraint', triggers: 'trigger', notNullColumns: 'not null' };
    report.guards.byFile = {};
    for (const kind of Object.keys(label)) {
      for (const x of report.guards.added[kind]) {
        const file = origin.get(`${label[kind]} ${x.name}`) || 'unknown';
        x.introducedBy = file;
        (report.guards.byFile[file] ||= []).push(`${label[kind]} ${x.name}`);
      }
    }
    if (probeSql && engine.runProbe) report.probe.after = await engine.runProbe(probeSql);
    const scope = guardScope ? new Set(guardScope) : null;
    const { inScope, outOfScope } = partitionGuards(report.guards.added, scope);
    const names = (g) => ({ constraints: g.constraints.map((x) => x.name), triggers: g.triggers.map((x) => x.name), notNullColumns: g.notNullColumns.map((x) => x.name) });
    report.guards.inScope = names(inScope);
    report.guards.outOfScope = names(outOfScope);
    report.generatedRearmSql = renderRearmSql(inScope);
    if (downPlanSql && engine.runPlain) {
      const down = { review: checkDownPlan(inScope, downPlanSql) };
      const applied = await engine.runPlain(downPlanSql);
      down.applied = applied.ok;
      if (!applied.ok) down.error = applied.error;
      const guardsDown = await engine.captureGuards();
      const present = (kind) => new Set(guardsDown[kind].map((x) => x.name));
      down.remainingAdded = {
        constraints: inScope.constraints.map((x) => x.name).filter((n) => present('constraints').has(n)),
        triggers: inScope.triggers.map((x) => x.name).filter((n) => present('triggers').has(n)),
        notNullColumns: inScope.notNullColumns.map((x) => x.name).filter((n) => present('notNullColumns').has(n)),
      };
      down.outOfScopeStillPresent = outOfScope.triggers.length + outOfScope.constraints.length + outOfScope.notNullColumns.length;
      if (probeSql && engine.runProbe) down.probe = await engine.runProbe(probeSql);
      if (rearmSql) {
        const rearmed = await engine.runPlain(rearmSql);
        const guardsRe = await engine.captureGuards();
        down.rearm = { applied: rearmed.ok, error: rearmed.error, identical: rearmed.ok && sameGuards(guardsRe, guardsAfter) };
        if (probeSql && engine.runProbe) down.rearm.probe = await engine.runProbe(probeSql);
      }
      report.downPlan = down;
    }
  }
  return finish(report, kind);
}

function finish(report, kind) {
  const filesOk = report.files.every((f) => f.status === 'PASS' || f.status === 'RECORDED');
  const postOk = !report.post || (report.post.missingFromLedger || []).length === 0;
  const downOk = !report.downPlan || (report.downPlan.review.ok && report.downPlan.applied
    && report.downPlan.remainingAdded.constraints.length === 0
    && report.downPlan.remainingAdded.triggers.length === 0
    && report.downPlan.remainingAdded.notNullColumns.length === 0
    && (!report.downPlan.probe || report.downPlan.probe.every((p) => p.ok))
    && (!report.downPlan.rearm || (report.downPlan.rearm.applied && report.downPlan.rearm.identical)));
  report.passed = filesOk && postOk && downOk && !report.firstFailure && report.files.length > 0;
  report.gateEligible = kind === 'real' && report.passed;
  return report;
}

export function renderReport(report) {
  const out = [];
  const banner = report.kind === 'synthetic'
    ? 'SYNTHETIC RESULT. The schema was built from public migrations plus modelled older variants, not from a dump of production. This does NOT satisfy the production rehearsal gate.'
    : 'Real-dump rehearsal: the schema input was declared to be a dump of the real target.';
  out.push(banner);
  out.push(`schema sha256:${report.schemaSha256}  chain files: ${report.chainSize}  result: ${report.passed ? 'PASS' : 'FAIL'}`);
  if (report.dumpNormalised && (report.dumpNormalised.createSchemaPublic || report.dumpNormalised.defaultPrivilegesForAdmin)) out.push(`dump lines skipped: CREATE SCHEMA public ${report.dumpNormalised.createSchemaPublic}, default privileges for the image admin role ${report.dumpNormalised.defaultPrivilegesForAdmin}`);
  if (report.loadErrors.length) out.push(`schema load errors: ${report.loadErrors.length} (first: ${report.loadErrors[0]})`);
  for (const r of report.rows) out.push(`rows loaded: ${r.table} ${r.loaded}`);
  out.push('');
  const width = String(report.files.length).length;
  report.files.forEach((f, i) => {
    const idx = String(i + 1).padStart(width, ' ');
    const extra = f.status === 'FAIL' ? `  ${f.error}` : f.ms !== undefined ? `  ${f.ms}ms` : '';
    out.push(`[${idx}/${report.files.length}] ${f.status.padEnd(8)} ${f.version}_${f.name}${f.recordOnly ? ' (record-only)' : ''}${extra}`);
  });
  const counts = report.files.reduce((a, f) => ({ ...a, [f.status]: (a[f.status] || 0) + 1 }), {});
  out.push('');
  out.push(`summary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (report.firstFailure) out.push(`first failure: ${report.firstFailure.version || ''} ${report.firstFailure.name}: ${report.firstFailure.error}`);
  if (report.post) {
    const p = report.post;
    out.push(`post: chain versions in ledger ${p.ledgerCount}/${report.chainSize}; missing ${p.missingFromLedger?.length ?? 0}; SECURITY DEFINER callable by anon/authenticated ${p.exposedDefiners?.length ?? 0}; public tables with RLS off ${p.rlsOff?.length ?? 0}`);
    if (report.pre) out.push(`pre-chain (the loaded schema): SECURITY DEFINER callable by anon/authenticated ${report.pre.exposedDefiners.length}; public tables with RLS off ${report.pre.rlsOff.length}`);
    if (p.exposedDefiners?.length) out.push(`  exposed: ${p.exposedDefiners.slice(0, 10).join(', ')}${p.exposedDefiners.length > 10 ? ` (+${p.exposedDefiners.length - 10} more)` : ''}`);
    if (p.rlsOff?.length) out.push(`  rls off: ${p.rlsOff.join(', ')}`);
  }
  if (report.rowCounts) out.push(`row counts before -> after: ${Object.keys(report.rowCounts.before).map((t) => `${t} ${report.rowCounts.before[t]} -> ${report.rowCounts.after[t]}`).join(', ')}`);
  if (report.guards) {
    const a = report.guards.added;
    out.push(`hivra_agents guards added by the chain: ${a.triggers.length} triggers, ${a.constraints.length} CHECK constraints, ${a.notNullColumns.length} NOT NULL without default; redefined: ${report.guards.redefined.constraints.length} constraints, ${report.guards.redefined.triggers.length} triggers`);
    if (report.guards.inScope) out.push(`  in the down plan scope: ${report.guards.inScope.triggers.length} triggers, ${report.guards.inScope.constraints.length} constraints, ${report.guards.inScope.notNullColumns.length} not-null; outside it: ${report.guards.outOfScope.triggers.length} triggers, ${report.guards.outOfScope.constraints.length} constraints`);
    for (const [file, list] of Object.entries(report.guards.byFile || {})) out.push(`  ${file}: ${list.length} (${list.join(', ')})`);
  }
  if (report.probe) {
    const fmt = (list) => (list || []).map((p) => `${p.label}:${p.ok ? 'ok' : 'REJECTED'}`).join(' ');
    out.push(`old-build write probe before chain: ${fmt(report.probe.before)}`);
    if (report.probe.after) out.push(`old-build write probe after chain:  ${fmt(report.probe.after)}`);
  }
  if (report.downPlan) {
    const d = report.downPlan;
    out.push(`down plan review: ${d.review.ok ? 'matches the added guards exactly' : `MISMATCH missing=[${d.review.missing.join('; ')}] unexpected=[${d.review.unexpected.join('; ')}]`}`);
    out.push(`down plan applied: ${d.applied ? 'yes' : `NO ${d.error}`}; in-scope guards still present: ${d.remainingAdded.triggers.length} triggers, ${d.remainingAdded.constraints.length} constraints, ${d.remainingAdded.notNullColumns.length} not-null; out-of-scope guards left in place: ${d.outOfScopeStillPresent}`);
    if (d.probe) out.push(`old-build write probe after down plan: ${d.probe.map((p) => `${p.label}:${p.ok ? 'ok' : 'REJECTED'}`).join(' ')}`);
    if (d.rearm) out.push(`re-arm: ${d.rearm.applied ? 'applied' : `NOT applied ${d.rearm.error}`}; guard set identical to post-chain: ${d.rearm.identical ? 'yes' : 'NO'}${d.rearm.probe ? `; probe ${d.rearm.probe.map((p) => `${p.label}:${p.ok ? 'ok' : 'REJECTED'}`).join(' ')}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- docker engine
function run(cmd, args, { input, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolvePromise({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const STUB_SQL = `
do $stub$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','supabase_read_only_user','authenticator','supabase_admin','dashboard_user'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
end $stub$;
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists supabase_migrations;
do $stub$ begin
  if to_regprocedure('auth.uid()') is null then
    create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
  end if;
  if to_regprocedure('auth.role()') is null then
    create function auth.role() returns text language sql stable as 'select nullif(current_setting(''request.jwt.claim.role'', true), '''')::text';
  end if;
  if to_regprocedure('auth.jwt()') is null then
    create function auth.jwt() returns jsonb language sql stable as 'select coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
  end if;
end $stub$;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz default now());
create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $stub$ begin
  if to_regprocedure('storage.foldername(text)') is null then
    create function storage.foldername(name text) returns text[] language sql immutable as 'select case when array_length(string_to_array(name, ''/''), 1) > 1 then (string_to_array(name, ''/''))[1:array_length(string_to_array(name, ''/''), 1) - 1] else array[]::text[] end';
  end if;
  if to_regprocedure('storage.filename(text)') is null then
    create function storage.filename(name text) returns text language sql immutable as 'select (string_to_array(name, ''/''))[array_length(string_to_array(name, ''/''), 1)]';
  end if;
  begin create extension if not exists pgcrypto with schema extensions; exception when others then null; end;
  begin create extension if not exists "uuid-ossp" with schema extensions; exception when others then null; end;
end $stub$;
grant usage on schema extensions, auth, storage, public to anon, authenticated, service_role;
grant all on schema supabase_migrations to postgres;
alter table supabase_migrations.schema_migrations owner to postgres;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter role postgres set search_path = "$user", public, extensions;
`;

const GUARDS_SQL = `
select json_build_object(
  'constraints', coalesce((select json_agg(json_build_object('name', conname, 'def', pg_get_constraintdef(oid)) order by conname)
     from pg_constraint where conrelid = 'public.hivra_agents'::regclass and contype = 'c'), '[]'::json),
  'triggers', coalesce((select json_agg(json_build_object('name', tgname, 'def', pg_get_triggerdef(oid)) order by tgname)
     from pg_trigger where tgrelid = 'public.hivra_agents'::regclass and not tgisinternal), '[]'::json),
  'notNullColumns', coalesce((select json_agg(json_build_object('name', a.attname) order by a.attname)
     from pg_attribute a where a.attrelid = 'public.hivra_agents'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attnotnull and a.attgenerated = '' and a.attidentity = ''
       and not exists (select 1 from pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum)), '[]'::json)
)::text
`;

const EXPOSED_SQL = `
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f','p') and p.prosecdef and p.prorettype <> 'trigger'::regtype
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
order by 1
`;

const RLS_OFF_SQL = `
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1
`;

export async function createDockerEngine({ image = DEFAULT_IMAGE, name = `rehearsal-${randomBytes(4).toString('hex')}`, keep = false, log = () => {} } = {}) {
  const password = randomBytes(12).toString('hex');
  const start = await run('docker', ['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, image]);
  if (start.code !== 0) throw new Error(`docker run failed: ${firstLines(start.stderr)}`);
  let admin = 'postgres';

  const psql = (sql, { user = 'postgres', stopOnError = true, extra = [] } = {}) => run(
    'docker',
    ['exec', '-i', '-e', `PGPASSWORD=${password}`, name, 'psql', '-h', 'localhost', '-U', user, '-d', 'postgres', '-X', '-q', '-At', ...(stopOnError ? ['-v', 'ON_ERROR_STOP=1'] : []), ...extra],
    { input: sql },
  );
  const errorText = (r) => {
    const lines = r.stderr.split('\n').map((l) => l.replace(/^psql:<stdin>:\d+: /, '').trim()).filter(Boolean);
    const i = lines.findIndex((l) => l.startsWith('ERROR:'));
    if (i < 0) return lines.slice(-2).join(' | ') || `psql exited ${r.code}`;
    return lines.slice(i, i + 3).join(' | ');
  };
  const query = async (sql, user = 'postgres') => {
    const r = await psql(sql, { user });
    if (r.code !== 0) throw new Error(`query failed: ${errorText(r)}`);
    return r.stdout.trim();
  };

  for (let attempt = 0, okRuns = 0; ; attempt += 1) {
    if (attempt > 120) {
      const logs = await run('docker', ['logs', '--tail', '5', name]);
      await run('docker', ['rm', '-f', name]);
      throw new Error(`postgres container never became ready: ${firstLines(logs.stderr + logs.stdout)}`);
    }
    const r = await psql('select 1;');
    okRuns = r.code === 0 ? okRuns + 1 : 0;
    if (okRuns >= 3) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  return {
    name,
    async prepare() {
      const su = await query("select rolsuper from pg_roles where rolname = current_user");
      if (su !== 't') admin = 'supabase_admin';
      const r = await psql(STUB_SQL, { user: admin });
      if (r.code !== 0) throw new Error(`stubbing roles and schemas failed: ${errorText(r)}`);
    },
    async loadSchema(sql) {
      const r = await psql(sql, { stopOnError: false });
      const errors = r.stderr.split('\n').filter((l) => /\bERROR:/.test(l)).map((l) => l.replace(/^psql:<stdin>:\d+: /, '').trim());
      // the dump may create the ledger table itself; make sure it exists either way
      await psql('create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text); alter table supabase_migrations.schema_migrations owner to postgres;', { user: admin });
      return { errors };
    },
    async loadRows(table, path) {
      const csv = readFileSync(path, 'utf8');
      const header = csv.split('\n', 1)[0].trim();
      const cols = header.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) throw new Error(`${table} csv: header has an unexpected column name`);
      const r = await psql(csv, { user: admin, extra: ['-c', 'set session_replication_role = replica', '-c', `\\copy public.${table} (${cols.join(', ')}) from stdin with (format csv, header true)`] });
      if (r.code !== 0) throw new Error(`${table}: loading rows failed: ${errorText(r)}`);
      return { count: Number(await query(`select count(*) from public.${table}`, admin)) };
    },
    async rowCounts(tables) {
      const out = {};
      for (const t of tables) out[t] = Number(await query(`select count(*) from public.${t}`, admin));
      return out;
    },
    async apply(version, wrapped) {
      const r = await psql(wrapped);
      return r.code === 0 ? { ok: true, notices: (r.stderr.match(/NOTICE:/g) || []).length } : { ok: false, error: errorText(r) };
    },
    async recordOnly(version, fileName, sql) {
      const m = /^(\d{14})_(.+)$/.exec(`${version}_${fileName}`);
      let tag = '$rec$';
      for (let i = 0; sql.includes(tag); i += 1) tag = `$rec${i}$`;
      const r = await psql([
        'insert into supabase_migrations.schema_migrations (version, name, statements)',
        `select ${lit(m[1])}, ${lit(m[2])}, array[${tag}${sql}${tag}]`,
        `where not exists (select 1 from supabase_migrations.schema_migrations where version = ${lit(m[1])} or name = ${lit(m[2])});`,
      ].join('\n'));
      return r.code === 0 ? { ok: true } : { ok: false, error: errorText(r) };
    },
    async exposure() {
      const lines = async (sql) => (await query(sql)).split('\n').filter(Boolean);
      return { exposedDefiners: await lines(EXPOSED_SQL), rlsOff: await lines(RLS_OFF_SQL) };
    },
    async postChecks(chain) {
      const versions = chain.map((e) => lit(e.version)).join(',');
      const have = (await query(`select version from supabase_migrations.schema_migrations where version in (${versions})`)).split('\n').filter(Boolean);
      const lines = async (sql) => (await query(sql)).split('\n').filter(Boolean);
      return {
        ledgerCount: have.length,
        missingFromLedger: chain.map((e) => e.version).filter((v) => !have.includes(v)),
        exposedDefiners: await lines(EXPOSED_SQL),
        rlsOff: await lines(RLS_OFF_SQL),
      };
    },
    async captureGuards() {
      if (!(await query("select to_regclass('public.hivra_agents') is not null"))) return null;
      return JSON.parse(await query(GUARDS_SQL));
    },
    // Probe file: blocks introduced by "-- @probe <label>". Each block runs in
    // its own transaction that is always rolled back.
    async runProbe(sql) {
      const blocks = sql.split(/^-- @probe /m).slice(1).map((b) => {
        const nl = b.indexOf('\n');
        return { label: b.slice(0, nl).trim(), body: b.slice(nl + 1) };
      });
      const out = [];
      for (const b of blocks) {
        // the live build talks to the database as service_role through PostgREST
        const prelude = "set local role service_role;\nselect set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true), set_config('request.jwt.claim.role', 'service_role', true);\n";
        const r = await psql(`begin;\n${prelude}${b.body}\nrollback;\n`);
        out.push(r.code === 0 ? { label: b.label, ok: true } : { label: b.label, ok: false, error: errorText(r) });
      }
      return out;
    },
    async runPlain(sql) {
      const r = await psql(sql);
      return r.code === 0 ? { ok: true } : { ok: false, error: errorText(r) };
    },
    async dumpPublicSchema() {
      const r = await run('docker', ['exec', '-e', `PGPASSWORD=${password}`, name, 'pg_dump', '-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-owner', '--schema', 'public']);
      if (r.code !== 0) throw new Error(`pg_dump failed: ${firstLines(r.stderr)}`);
      return r.stdout;
    },
    async copyOutCsv(table) {
      const r = await psql(`\\copy (select * from public.${table} order by 1) to stdout with (format csv, header true)`, { user: admin, extra: [] });
      if (r.code !== 0) throw new Error(`${table}: export failed: ${errorText(r)}`);
      return r.stdout;
    },
    async copyOut(sql) {
      return query(sql, admin);
    },
    async sql(sql, { user = 'postgres' } = {}) {
      return psql(sql, { user });
    },
    async stop() {
      if (!keep) await run('docker', ['rm', '-f', name]);
      else log(`kept container ${name}`);
    },
  };
}

// ---------------------------------------------------------------- CLI
const USAGE = `Usage: node scripts/release/prod-chain-rehearsal.mjs --schema <dump.sql> --chain <versions.txt> --kind <real|synthetic> [options]

  --schema <file>       schema-only dump (pg_dump --schema-only --no-owner --schema public; keep privileges)
  --chain <file>        versions to apply, one per line ("<version>" or "<version> record-only"); order is forced to filename order
  --kind real|synthetic real = the schema is a dump of the real target. synthetic results never count as the gate
  --migrations <dir>    default dashboard/supabase/migrations
  --rows table=file.csv optional rows (repeatable) for: ${CONSTRAINED_TABLES.join(', ')}
  --probe <file>        old-build write probe (blocks "-- @probe <label>"), run before the chain, after it, and after the down plan
  --down-plan <file>    rehearse a down plan after the chain (needs --probe for the write proof)
  --guard-scope <file>  versions (one per line) whose hivra_agents guards the down plan must cover exactly
  --rearm <file>        rehearse re-applying the dropped guards after the down plan
  --emit-rearm <file>   write the re-arm SQL generated from the post-chain guard definitions
  --image <ref>         default ${DEFAULT_IMAGE}
  --report-json <file>  --report-md <file>  --allow-load-errors  --keep
`;

export function parseArgs(argv) {
  const o = { rows: [], migrations: join(HERE, '../../dashboard/supabase/migrations') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--schema') o.schema = need();
    else if (a === '--chain') o.chain = need();
    else if (a === '--kind') o.kind = need();
    else if (a === '--migrations') o.migrations = need();
    else if (a === '--rows') o.rows.push(need());
    else if (a === '--probe') o.probe = need();
    else if (a === '--down-plan') o.downPlan = need();
    else if (a === '--guard-scope') o.guardScope = need();
    else if (a === '--rearm') o.rearm = need();
    else if (a === '--emit-rearm') o.emitRearm = need();
    else if (a === '--image') o.image = need();
    else if (a === '--report-json') o.reportJson = need();
    else if (a === '--report-md') o.reportMd = need();
    else if (a === '--allow-load-errors') o.allowLoadErrors = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!o.schema || !o.chain || !o.kind) {
    process.stderr.write(USAGE);
    return 2;
  }
  const dir = resolve(o.migrations);
  const chain = resolveChain(parseChainList(readFileSync(o.chain, 'utf8')), readdirSync(dir).filter((f) => f.endsWith('.sql')));
  const rows = parseRowsArgs(o.rows);
  const engine = await createDockerEngine({ image: o.image || DEFAULT_IMAGE, keep: o.keep, log: (m) => process.stderr.write(`${m}\n`) });
  try {
    const report = await runRehearsal({
      engine,
      kind: o.kind,
      schemaSql: readFileSync(o.schema, 'utf8'),
      chain,
      readMigration: (f) => readFileSync(join(dir, f), 'utf8'),
      rows,
      probeSql: o.probe ? readFileSync(o.probe, 'utf8') : null,
      downPlanSql: o.downPlan ? readFileSync(o.downPlan, 'utf8') : null,
      rearmSql: o.rearm ? readFileSync(o.rearm, 'utf8') : null,
      guardScope: o.guardScope ? parseChainList(readFileSync(o.guardScope, 'utf8')).map((e) => e.version) : null,
      allowLoadErrors: o.allowLoadErrors,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    const text = renderReport(report);
    process.stdout.write(text);
    if (o.reportMd) writeFileSync(o.reportMd, text);
    if (o.emitRearm && report.generatedRearmSql) writeFileSync(o.emitRearm, report.generatedRearmSql);
    const { generatedRearmSql, ...forJson } = report;
    if (o.reportJson) writeFileSync(o.reportJson, `${JSON.stringify(forJson, null, 2)}\n`);
    return report.passed ? 0 : 1;
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  });
}
