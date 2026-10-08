import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONSTRAINED_TABLES,
  DEFAULT_IMAGE,
  buildAtomicApply,
  createDockerEngine,
  parseChainList,
  resolveChain,
} from './prod-chain-rehearsal.mjs';

// Build a SYNTHETIC production-shaped schema, for proving the rehearsal harness
// before a real dump exists.
//
//   baseline  = every migration NOT in the chain list, applied in filename order
//               through the same atomic wrapper (this is "canary minus the
//               missing files"; the chain files are exactly what production lacks)
//   overlay   = fixtures/prod-chain/synthetic-prod-overlay.sql: older variants of
//               objects that production already has under the same names, and
//               objects only production has
//   rows      = fixtures/prod-chain/synthetic-prod-rows.sql: invented rows for
//               the five constrained tables, exported as CSV
//
// Output: <out>/schema.sql (pg_dump --schema-only --no-owner --schema public)
// and <out>/<table>.csv. A rehearsal run on these is labelled SYNTHETIC.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'prod-chain');

export async function buildSyntheticProd({ migrationsDir, chainText, outDir, image = DEFAULT_IMAGE, log = () => {}, keep = false }) {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const chain = resolveChain(parseChainList(chainText), files);
  const inChain = new Set(chain.map((e) => e.file));
  const baseline = files.filter((f) => !inChain.has(f));
  const engine = await createDockerEngine({ image, keep, log });
  try {
    await engine.prepare();
    for (let i = 0; i < baseline.length; i += 1) {
      const f = baseline[i];
      const w = buildAtomicApply({ fileName: f, sql: readFileSync(join(migrationsDir, f), 'utf8'), nameGuard: false });
      const res = await engine.apply(w.version, w.wrapped);
      if (!res.ok) throw new Error(`baseline file ${i + 1}/${baseline.length} ${f} failed: ${res.error}`);
      log(`baseline ${i + 1}/${baseline.length} ${f}`);
    }
    const overlay = await engine.sql(readFileSync(join(FIXTURES, 'synthetic-prod-overlay.sql'), 'utf8'));
    if (overlay.code !== 0) throw new Error(`overlay failed: ${overlay.stderr.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 2).join(' | ')}`);
    const seed = await engine.sql(readFileSync(join(FIXTURES, 'synthetic-prod-rows.sql'), 'utf8'), { user: 'postgres' });
    if (seed.code !== 0) throw new Error(`row seed failed: ${seed.stderr.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 2).join(' | ')}`);
    mkdirSync(outDir, { recursive: true });
    const counts = {};
    for (const t of CONSTRAINED_TABLES) {
      writeFileSync(join(outDir, `${t}.csv`), await engine.copyOutCsv(t));
      counts[t] = Number(await engine.copyOut(`select count(*) from public.${t}`));
    }
    writeFileSync(join(outDir, 'schema.sql'), await engine.dumpPublicSchema());
    return { baselineFiles: baseline.length, chainFiles: chain.length, counts };
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [chainFile, outDir, migrationsArg] = process.argv.slice(2);
  if (!chainFile || !outDir) {
    process.stderr.write('Usage: node scripts/release/prod-chain-synthetic.mjs <chain.txt> <out-dir> [migrations-dir]\n');
    process.exitCode = 2;
  } else {
    buildSyntheticProd({
      migrationsDir: resolve(migrationsArg || join(HERE, '../../dashboard/supabase/migrations')),
      chainText: readFileSync(chainFile, 'utf8'),
      outDir: resolve(outDir),
      log: (m) => process.stderr.write(`${m}\n`),
    }).then((r) => process.stdout.write(`${JSON.stringify(r)}\n`), (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
  }
}
