import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only object diff of the `public` schema between two Supabase projects
// (normally the Canary DB and the production DB) for the prod cutover packet
// (docs/release/PROD-CUTOVER-PACKET.md). It compares OBJECTS, not migration
// ledger rows: production's ledger is known to be unreliable.
//
// Every query goes through the Supabase Management API with
// {"read_only": true}, which runs as supabase_read_only_user inside a
// read-only transaction. The script never sends DDL/DML and has no write mode.
// Project refs come from the environment so they stay out of this public repo.
//
// Usage:
//   HIVRA_CANARY_DB_REF=<ref> HIVRA_PROD_DB_REF=<ref> \
//     node scripts/release/prod-schema-diff.mjs [--json out.json] [--snapshot-a a.json --snapshot-b b.json]
// Token: $SUPABASE_ACCESS_TOKEN, else ~/.supabase/access-token (never printed).

export const QUERIES = {
  tables: `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')`,
  views: `select c.relname as name, c.relkind as kind, md5(pg_get_viewdef(c.oid)) as h
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v','m')`,
  columns: `select a.attrelid::regclass::text as t, a.attname as c,
      format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
      pg_get_expr(d.adbin, d.adrelid) as def
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped`,
  functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
      md5(coalesce(p.prosrc, '')) as h, p.prosecdef as secdef,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
      p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f','p')
      and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')`,
  policies: `select tablename as t, policyname as name, permissive, cmd,
      array_to_string(roles, ',') as roles, md5(coalesce(qual, '')) as qual_h,
      md5(coalesce(with_check, '')) as check_h
    from pg_policies where schemaname = 'public'`,
  // has_table_privilege, not information_schema.role_table_grants: the read-only
  // role only sees grants it is party to in information_schema.
  table_grants: `select c.relname as t, r.grantee,
      concat_ws(',', case when has_table_privilege(r.grantee, c.oid, 'SELECT') then 'SELECT' end,
        case when has_table_privilege(r.grantee, c.oid, 'INSERT') then 'INSERT' end,
        case when has_table_privilege(r.grantee, c.oid, 'UPDATE') then 'UPDATE' end,
        case when has_table_privilege(r.grantee, c.oid, 'DELETE') then 'DELETE' end) as privs
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(grantee)
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
  triggers: `select c.relname as t, tg.tgname as name, md5(pg_get_triggerdef(tg.oid)) as h
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not tg.tgisinternal`,
  constraints: `select c.relname as t, k.conname as name, k.contype as type, md5(pg_get_constraintdef(k.oid)) as h
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`,
  indexes: `select tablename as t, indexname as name, md5(indexdef) as h from pg_indexes where schemaname = 'public'`,
  enums: `select t.typname as name, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
    from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' group by t.typname`,
  extensions: `select extname as name, extversion as version from pg_extension`,
  buckets: `select id as name, public from storage.buckets`,
  // Not diffed: planner row estimates (-1 = never analysed) used by
  // prod-migration-risk.mjs to flag constraints added to tables holding data.
  row_estimates: `select c.relname as name, c.reltuples::bigint as rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')`,
};

// Key and comparable value per row, per category.
const SHAPES = {
  tables: [(r) => r.name, (r) => `rls=${r.rls} force=${r.force_rls}`],
  views: [(r) => r.name, (r) => `${r.kind}:${r.h}`],
  columns: [(r) => `${r.t}.${r.c}`, (r) => `${r.type}${r.not_null ? ' not null' : ''}${r.def ? ` default ${r.def}` : ''}`],
  functions: [(r) => r.sig, (r) => `body=${r.h} secdef=${r.secdef} config=${r.config}`],
  function_grants: [(r) => r.sig, (r) => `anon=${r.anon_exec} authenticated=${r.auth_exec} service_role=${r.service_exec}`],
  policies: [(r) => `${r.t}.${r.name}`, (r) => `${r.permissive} ${r.cmd} to ${r.roles} using=${r.qual_h} check=${r.check_h}`],
  table_grants: [(r) => `${r.t}:${r.grantee}`, (r) => r.privs],
  triggers: [(r) => `${r.t}.${r.name}`, (r) => r.h],
  constraints: [(r) => `${r.t}.${r.name}`, (r) => `${r.type}:${r.h}`],
  indexes: [(r) => `${r.t}.${r.name}`, (r) => r.h],
  enums: [(r) => r.name, (r) => r.labels],
  extensions: [(r) => r.name, (r) => r.version],
  buckets: [(r) => r.name, (r) => `public=${r.public}`],
};

export function diffCategory(rowsA = [], rowsB = [], [key, value]) {
  const a = new Map(rowsA.map((r) => [key(r), value(r)]));
  const b = new Map(rowsB.map((r) => [key(r), value(r)]));
  const onlyA = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyB = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort()
    .map((k) => ({ key: k, a: a.get(k), b: b.get(k) }));
  return { countA: a.size, countB: b.size, onlyA, onlyB, changed };
}

// Columns, policies, grants, triggers, constraints and indexes on a table that
// exists on only one side are implied by that table; report them separately so
// the "shared table" drift stays readable.
function splitByTable(result, tablesOnlyA, tablesOnlyB, tableOf) {
  const inA = new Set(tablesOnlyA);
  const inB = new Set(tablesOnlyB);
  return {
    ...result,
    onlyA: result.onlyA.filter((k) => !inA.has(tableOf(k))),
    onlyB: result.onlyB.filter((k) => !inB.has(tableOf(k))),
    impliedByTableA: result.onlyA.filter((k) => inA.has(tableOf(k))).length,
    impliedByTableB: result.onlyB.filter((k) => inB.has(tableOf(k))).length,
  };
}

export function diffSnapshots(A, B) {
  const withGrants = (s) => ({ ...s, function_grants: (s.functions || []).filter((f) => !f.is_trigger) });
  A = withGrants(A); B = withGrants(B);
  const out = {};
  for (const [cat, shape] of Object.entries(SHAPES)) out[cat] = diffCategory(A[cat], B[cat], shape);
  const tableOf = (k) => k.split(/[.:]/)[0];
  for (const cat of ['columns', 'policies', 'table_grants', 'triggers', 'constraints', 'indexes']) {
    out[cat] = splitByTable(out[cat], out.tables.onlyA, out.tables.onlyB, tableOf);
  }
  out.risks = {
    // SECURITY DEFINER functions any API role can call (Supabase default privileges).
    exposedDefinerA: exposedDefiners(A.functions),
    exposedDefinerB: exposedDefiners(B.functions),
    rlsOffA: (A.tables || []).filter((t) => !t.rls).map((t) => t.name).sort(),
    rlsOffB: (B.tables || []).filter((t) => !t.rls).map((t) => t.name).sort(),
  };
  return out;
}

function exposedDefiners(functions = []) {
  return functions.filter((f) => f.secdef && !f.is_trigger && (f.anon_exec || f.auth_exec)).map((f) => f.sig).sort();
}

export function renderMarkdown(diff, labelA = 'canary', labelB = 'prod') {
  const lines = [`| Category | ${labelA} | ${labelB} | only ${labelA} | only ${labelB} | differ |`, '|---|---:|---:|---:|---:|---:|'];
  for (const cat of Object.keys(SHAPES)) {
    const d = diff[cat];
    const implied = d.impliedByTableA !== undefined ? ` (+${d.impliedByTableA} on ${labelA}-only tables)` : '';
    const impliedB = d.impliedByTableB ? ` (+${d.impliedByTableB} on ${labelB}-only tables)` : '';
    lines.push(`| ${cat} | ${d.countA} | ${d.countB} | ${d.onlyA.length}${implied} | ${d.onlyB.length}${impliedB} | ${d.changed.length} |`);
  }
  const list = (title, items) => {
    lines.push('', `### ${title} (${items.length})`, '');
    lines.push(items.length ? items.map((i) => `- \`${typeof i === 'string' ? i : `${i.key}\` — ${labelA}: ${i.a} / ${labelB}: ${i.b}`}${typeof i === 'string' ? '`' : ''}`).join('\n') : '- none');
  };
  for (const cat of Object.keys(SHAPES)) {
    list(`${cat}: only ${labelA}`, diff[cat].onlyA);
    list(`${cat}: only ${labelB}`, diff[cat].onlyB);
    list(`${cat}: differ`, diff[cat].changed);
  }
  list(`SECURITY DEFINER callable by anon/authenticated on ${labelA}`, diff.risks.exposedDefinerA);
  list(`SECURITY DEFINER callable by anon/authenticated on ${labelB}`, diff.risks.exposedDefinerB);
  list(`RLS disabled on ${labelA}`, diff.risks.rlsOffA);
  list(`RLS disabled on ${labelB}`, diff.risks.rlsOffB);
  return lines.join('\n');
}

async function query(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`query failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function snapshot(ref, token) {
  const out = { takenAt: new Date().toISOString() };
  for (const [cat, sql] of Object.entries(QUERIES)) out[cat] = await query(ref, token, sql);
  return out;
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  let A; let B;
  if (arg('--snapshot-a') && arg('--snapshot-b')) {
    A = JSON.parse(readFileSync(arg('--snapshot-a'), 'utf8'));
    B = JSON.parse(readFileSync(arg('--snapshot-b'), 'utf8'));
  } else {
    const refA = process.env.HIVRA_CANARY_DB_REF;
    const refB = process.env.HIVRA_PROD_DB_REF;
    if (!refA || !refB) throw new Error('Set HIVRA_CANARY_DB_REF and HIVRA_PROD_DB_REF (or pass --snapshot-a/--snapshot-b).');
    const token = process.env.SUPABASE_ACCESS_TOKEN || readFileSync(join(homedir(), '.supabase', 'access-token'), 'utf8').trim();
    A = await snapshot(refA, token);
    B = await snapshot(refB, token);
    if (arg('--save-snapshots')) {
      writeFileSync(`${arg('--save-snapshots')}-canary.json`, JSON.stringify(A));
      writeFileSync(`${arg('--save-snapshots')}-prod.json`, JSON.stringify(B));
    }
  }
  const diff = diffSnapshots(A, B);
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(diff, null, 2));
  process.stdout.write(`Snapshots: canary ${A.takenAt}, prod ${B.takenAt}\n\n${renderMarkdown(diff)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
}
