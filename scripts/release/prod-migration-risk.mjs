import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Static risk flags for the migrations a production catch-up would apply, read
// against a production schema snapshot from prod-schema-diff.mjs
// (--save-snapshots). Offline and read-only: it reads migration files with
// `git show <rev>:...` and the snapshot JSON, and talks to no database.
//
// Usage:
//   node scripts/release/prod-migration-risk.mjs --rev <sha> --prod-snapshot snap-prod.json \
//     [--versions-file missing.txt | <version> ...] [--json out.json]
// Versions are 14-digit prefixes of files in dashboard/supabase/migrations at <rev>.
//
// The flags are heuristics for a human reviewer, not proof of safety. A file
// with no flags still has to run inside the atomic wrapper and be verified by
// objects afterwards.

const MIGRATIONS = 'dashboard/supabase/migrations';

// Remove dollar-quoted bodies (functions, DO blocks) and comments so statement
// scans see only top-level SQL. Returns the stripped text and the bodies.
export function stripBodies(sql) {
  const bodies = [];
  let text = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  text = text.replace(/(\$[A-Za-z_]*\$)([\s\S]*?)\1/g, (_, _tag, body) => { bodies.push(body); return ' $body$ '; });
  return { text, bodies };
}

const ident = String.raw`(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?`;

export function analyseMigration(name, sql, prod) {
  const prodTables = new Map((prod.tables || []).map((t) => [t.name, t]));
  const rows = new Map((prod.row_estimates || []).map((r) => [r.name, Number(r.rows)]));
  const prodFunctions = new Map((prod.functions || []).map((f) => [f.sig.split('(')[0], f]));
  const { text, bodies } = stripBodies(sql);
  const lower = text.toLowerCase();
  const flags = [];
  const add = (code, detail) => { if (!flags.some((f) => f.code === code && f.detail === detail)) flags.push({ code, detail }); };

  const created = [...lower.matchAll(new RegExp(String.raw`create table (if not exists )?${ident}`, 'gi'))];
  for (const m of created) {
    if (prodTables.has(m[2])) add('CREATE_EXISTING_TABLE', `${m[2]} already exists on prod${m[1] ? ' (IF NOT EXISTS silently skips; column/constraint shape is not updated)' : ' (plain CREATE fails)'}`);
  }
  const altered = new Set([...lower.matchAll(new RegExp(String.raw`alter table (?:if exists )?(?:only )?${ident}`, 'gi'))].map((m) => m[1]));
  for (const t of altered) {
    if (!prodTables.has(t)) continue;
    const n = rows.get(t);
    const stmts = lower.split(';').filter((s) => new RegExp(String.raw`alter table (?:if exists )?(?:only )?(?:public\.)?"?${t}"?\b`).test(s));
    const body = stmts.join(';');
    if (/set not null/.test(body) || /add column[^,;]*not null(?![^,;]*default)/.test(body)) add('NOT_NULL_ON_PROD_TABLE', `${t} (~${n ?? '?'} rows)`);
    if (/add constraint[\s\S]*?(check|foreign key|unique)/.test(body) && !/not valid/.test(body)) add('CONSTRAINT_ON_PROD_TABLE', `${t} (~${n ?? '?'} rows): validated against existing rows`);
    if (/drop column|rename column|alter column [^;]* type /.test(body)) add('DESTRUCTIVE_ALTER', t);
    if (/enable row level security/.test(body)) add('RLS_ON_PROD_TABLE', `${t}: old code must use service_role or have policies`);
  }
  if (/\bdrop (table|function|policy|trigger|view|type|index)\b/.test(lower)) add('DROP', 'drops an object (check it is not one prod-only code or the live build uses)');
  if (/(^|;|\s)(insert into|update\s+(?:public\.)?\w+\s+set|delete from)\s/.test(lower)) add('DATA', 'top-level data statement: row effects depend on prod data');
  if (/\bdo\s+\$body\$/.test(lower)) add('DO_BLOCK', 'procedural block: effects not visible to object checks');
  if (bodies.some((b) => /\bexecute\s+(format|'|\w+\s*;)/i.test(b))) add('DYNAMIC_SQL', 'EXECUTE inside a body');
  if (/concurrently/.test(lower)) add('CONCURRENTLY', 'cannot run inside the atomic wrapper');
  const replaced = [...lower.matchAll(new RegExp(String.raw`create (?:or replace )?function ${ident}`, 'gi'))].map((m) => m[1]);
  for (const f of new Set(replaced)) if (prodFunctions.has(f)) add('REPLACES_PROD_FUNCTION', `${f} exists on prod (body/grants change for the live build too)`);
  if (/security definer/i.test(sql) && !/revoke[^;]*from[^;]*anon/i.test(sql)) add('SECDEF_NO_REVOKE', 'SECURITY DEFINER without revoke from anon/authenticated in this file');
  // Table-position references only (auth.users and prose are not prod-only tables).
  const prodOnly = (prod.prodOnlyTables || []).filter((t) => new RegExp(
    String.raw`(?:from|join|table|references|into|update|on)\s+(?:only\s+)?(?:public\.)?"?${t}"?(?:\s|\(|;|,|$)`, 'i',
  ).test(text));
  if (prodOnly.length) add('REFERENCES_PROD_ONLY_TABLE', prodOnly.join(', '));

  const blocking = flags.some((f) => ['NOT_NULL_ON_PROD_TABLE', 'CONSTRAINT_ON_PROD_TABLE', 'DESTRUCTIVE_ALTER', 'CREATE_EXISTING_TABLE', 'CONCURRENTLY', 'REFERENCES_PROD_ONLY_TABLE'].includes(f.code));
  const review = flags.some((f) => ['DATA', 'DO_BLOCK', 'DYNAMIC_SQL', 'DROP', 'REPLACES_PROD_FUNCTION', 'RLS_ON_PROD_TABLE', 'SECDEF_NO_REVOKE'].includes(f.code));
  return { name, verdict: blocking ? 'NOT-AS-IS' : review ? 'REVIEW' : 'ADDITIVE', flags };
}

function listFiles(rev) {
  return execFileSync('git', ['ls-tree', '--name-only', `${rev}:${MIGRATIONS}`], { encoding: 'utf8' })
    .split('\n').filter((f) => /^\d{14}_.*\.sql$/.test(f));
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const rev = arg('--rev') || 'origin/canary';
  const prod = JSON.parse(readFileSync(arg('--prod-snapshot'), 'utf8'));
  if (arg('--canary-snapshot')) {
    const canary = new Set(JSON.parse(readFileSync(arg('--canary-snapshot'), 'utf8')).tables.map((t) => t.name));
    prod.prodOnlyTables = prod.tables.map((t) => t.name).filter((t) => !canary.has(t));
  }
  const flagArgs = new Set(['--rev', '--prod-snapshot', '--canary-snapshot', '--versions-file', '--json']);
  let versions = argv.filter((a, i) => /^\d{14}$/.test(a) && !flagArgs.has(argv[i - 1]));
  if (arg('--versions-file')) versions = readFileSync(arg('--versions-file'), 'utf8').split(/\s+/).filter(Boolean);
  const files = listFiles(rev);
  const results = versions.map((v) => {
    const file = files.find((f) => f.startsWith(`${v}_`));
    if (!file) return { name: v, verdict: 'MISSING-FILE', flags: [] };
    const sql = execFileSync('git', ['show', `${rev}:${MIGRATIONS}/${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return analyseMigration(file.replace(/\.sql$/, ''), sql, prod);
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (arg('--json')) import('node:fs').then((fs) => fs.writeFileSync(arg('--json'), JSON.stringify(results, null, 2)));
  const counts = results.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] || 0) + 1 }), {});
  process.stdout.write(`rev ${rev}: ${results.length} migrations; ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}\n\n`);
  for (const r of results) {
    process.stdout.write(`${r.verdict.padEnd(10)} ${r.name}\n`);
    for (const f of r.flags) process.stdout.write(`             ${f.code}: ${f.detail}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
