/**
 * first-run-audit-tally — read N verdict files, decide whether the 19/20 bar is met.
 *
 * The bar (Ash): "new signup → first agent deployed → first real outcome, working
 * clean 19 out of 20 times, zero manual intervention."
 *
 * Two rules make the number honest:
 *
 *   1. A run that failed because the HARNESS's environment broke (a datacenter
 *      runner IP tripping the free-tier abuse gate, a missing secret) is NOT a
 *      product failure. It is excluded from the denominator and reported loudly.
 *      If too many runs are excluded the sample is not a sample and we say so.
 *
 *   2. A run whose teardown leaked infrastructure is an ALARM regardless of its
 *      pass/fail verdict. A green audit that leaves a billing VM behind is worse
 *      than a red one.
 *
 * Usage:
 *   npm run audit:first-run:tally                     # reads e2e/.first-run-audit
 *   npm run audit:first-run:tally -- path/to/dir
 *   npm run audit:first-run:tally -- run-a.json run-b.json
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_STAGES, VERDICT_SCHEMA, type AuditVerdict } from '../e2e/first-run-audit/verdict';

const BAR_NUMERATOR = 19;
const BAR_DENOMINATOR = 20;

function collectFiles(inputs: string[]): string[] {
  const targets = inputs.length > 0 ? inputs : ['e2e/.first-run-audit'];
  const files: string[] = [];
  for (const target of targets) {
    let stats;
    try {
      stats = statSync(target);
    } catch {
      console.error(`[tally] no such path: ${target}`);
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(target)) {
        if (entry.startsWith('run-') && entry.endsWith('.json')) files.push(join(target, entry));
      }
    } else {
      files.push(target);
    }
  }
  return files.sort();
}

function readVerdict(path: string): AuditVerdict | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AuditVerdict;
    if (parsed.schema !== VERDICT_SCHEMA) {
      console.error(`[tally] skipping ${path}: unknown schema "${parsed.schema}"`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.error(`[tally] unreadable ${path}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function bar(count: number, max: number, width = 28): string {
  if (max === 0) return '';
  return '█'.repeat(Math.max(1, Math.round((count / max) * width)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function main(): void {
  const files = collectFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.error('[tally] no verdict files found.');
    process.exitCode = 1;
    return;
  }

  const verdicts = files.map(readVerdict).filter((v): v is AuditVerdict => v !== null);
  if (verdicts.length === 0) {
    console.error('[tally] no readable verdicts.');
    process.exitCode = 1;
    return;
  }

  const passes = verdicts.filter((v) => v.verdict === 'pass');
  const productFailures = verdicts.filter(
    (v) => v.verdict === 'fail' && v.failure?.category === 'product',
  );
  const excluded = verdicts.filter(
    (v) => v.verdict === 'fail' && v.failure && v.failure.category !== 'product',
  );
  const leaks = verdicts.filter((v) => v.teardown.instances_survived.length > 0);

  const counted = passes.length + productFailures.length;

  console.log('═'.repeat(66));
  console.log('  HIVRA FIRST-RUN AUDIT — TALLY');
  console.log('═'.repeat(66));
  console.log(`  runs found          ${verdicts.length}`);
  console.log(`  targets             ${[...new Set(verdicts.map((v) => v.target))].join(', ')}`);
  console.log(
    `  outcome levels      ${[...new Set(verdicts.map((v) => v.outcome_level))].join(', ')}`,
  );
  console.log('');
  console.log(`  ✓ pass              ${passes.length}`);
  console.log(`  ✗ product failure   ${productFailures.length}`);
  console.log(`  – excluded          ${excluded.length}  (harness env / harness bug)`);
  console.log('');
  console.log(`  PASS RATE           ${passes.length}/${counted}  (${pct(passes.length, counted)})`);
  console.log('─'.repeat(66));

  // ── Failure-stage histogram ────────────────────────────────────────────────
  const histogram = new Map<string, number>();
  for (const verdict of productFailures) {
    const key = `${verdict.failure!.stage} / ${verdict.failure!.reason}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  if (histogram.size > 0) {
    console.log('  FAILURE STAGES (product)');
    const max = Math.max(...histogram.values());
    const ordered = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, count] of ordered) {
      console.log(`    ${String(count).padStart(3)}  ${bar(count, max)}  ${key}`);
    }
    console.log('─'.repeat(66));
  }

  if (excluded.length > 0) {
    console.log('  EXCLUDED (not counted against the bar)');
    for (const verdict of excluded) {
      console.log(
        `    ${verdict.run_id}  ${verdict.failure!.category}  ${verdict.failure!.stage} / ${verdict.failure!.reason}`,
      );
    }
    console.log('─'.repeat(66));
  }

  // ── How far runs got ───────────────────────────────────────────────────────
  console.log('  FURTHEST STAGE REACHED');
  for (const stage of AUDIT_STAGES) {
    const count = verdicts.filter((v) => v.stage_reached === stage).length;
    if (count > 0) console.log(`    ${String(count).padStart(3)}  ${stage}`);
  }
  console.log('─'.repeat(66));

  // ── Timings ────────────────────────────────────────────────────────────────
  const durations = passes.map((v) => v.duration_ms);
  if (durations.length > 0) {
    const readyTimes = passes
      .map((v) => v.timings_ms.instance_ready)
      .filter((n): n is number => typeof n === 'number');
    console.log('  TIMINGS (passing runs)');
    console.log(`    median total        ${(median(durations) / 60_000).toFixed(1)} min`);
    console.log(`    slowest total       ${(Math.max(...durations) / 60_000).toFixed(1)} min`);
    if (readyTimes.length) {
      console.log(`    median boot→ready   ${(median(readyTimes) / 60_000).toFixed(1)} min`);
    }
    console.log('─'.repeat(66));
  }

  // ── Telemetry blindness ────────────────────────────────────────────────────
  // A run that captured zero analytics events still proves the product (the
  // workspace assertion reads the browser's network stack, not PostHog). But it
  // cannot contribute a funnel, so say so rather than let a reader infer that
  // the funnel was empty because nothing happened.
  //
  // Since browser-signals.ts, a blind run is NO LONGER expected: the audit browser
  // is no longer read as a bot by posthog-js, so silence now means something is
  // actually wrong — either the target sets no NEXT_PUBLIC_POSTHOG_KEY (analytics
  // is off by design; there is no fallback token any more) or posthog changed its
  // bot filter. Both are worth a loud line rather than a shrug.
  const blind = verdicts.filter((v) => !v.telemetry.posthog_captured).length;
  if (blind > 0) {
    console.log('  TELEMETRY');
    console.log(
      `    ${blind}/${verdicts.length} runs captured no PostHog events (funnel unavailable).` +
        '\n    Verdicts are unaffected (the workspace proof reads the network stack).' +
        '\n    Investigate: does the target set NEXT_PUBLIC_POSTHOG_KEY, and does' +
        '\n    e2e/first-run-audit/browser-signals.ts still defeat posthog\'s bot filter?',
    );
    console.log('─'.repeat(66));
  }

  // ── How the workspace was proven ───────────────────────────────────────────
  const proven = verdicts.filter((v) => v.workspace?.iframe_document_status);
  if (proven.length > 0) {
    const errored = proven.filter((v) => (v.workspace!.iframe_document_status ?? 0) >= 400).length;
    console.log('  WORKSPACE IFRAME');
    console.log(
      `    ${proven.length - errored}/${proven.length} boxes served the chat surface with a non-error status.`,
    );
    console.log('─'.repeat(66));
  }

  // ── The thing that actually matters for activation ─────────────────────────
  const configured = verdicts.filter((v) => v.instance.inference_configured).length;
  const withInstance = verdicts.filter((v) => v.instance.id).length;
  if (withInstance > 0) {
    console.log('  INFERENCE CONFIGURED ON BOOT');
    console.log(
      `    ${configured}/${withInstance} boxes booted with a provider+model. ` +
        `${withInstance - configured} could not have answered a question without the user pasting a key.`,
    );
    console.log('─'.repeat(66));
  }

  // ── Leaks: an alarm, not a statistic ───────────────────────────────────────
  if (leaks.length > 0) {
    console.log('  ⚠  LEAKED INFRASTRUCTURE');
    for (const verdict of leaks) {
      for (const survivor of verdict.teardown.instances_survived) {
        console.log(`    run ${verdict.run_id}: instance ${survivor.id} survived teardown`);
      }
    }
    console.log('    → run: npm run audit:first-run:cleanup');
    console.log('─'.repeat(66));
  }

  // ── The verdict on the verdicts ────────────────────────────────────────────
  const requiredPasses = Math.ceil((BAR_NUMERATOR / BAR_DENOMINATOR) * counted);
  const meetsBar = counted > 0 && passes.length >= requiredPasses;

  if (counted < BAR_DENOMINATOR) {
    console.log(
      `  ⏳ SAMPLE INCOMPLETE — ${counted}/${BAR_DENOMINATOR} counted runs. ` +
        `Need ${BAR_DENOMINATOR - counted} more before the bar means anything.`,
    );
  }

  if (leaks.length > 0) {
    console.log('  ❌ NOT CERTIFIED — the harness leaked infrastructure. Fix that first.');
    process.exitCode = 1;
  } else if (counted < BAR_DENOMINATOR && productFailures.length > 0) {
    // A short workflow_dispatch run is a smoke test, not a certification
    // campaign. It cannot prove the 19/20 bar, but a product failure is still
    // a real failed smoke and must make the workflow red. Previously a single
    // failed run printed SAMPLE INCOMPLETE and exited zero, masking the broken
    // first-agent WebSocket behind a green GitHub Actions badge.
    console.log(
      `  ❌ SMOKE FAILED — ${productFailures.length}/${counted} counted run(s) had a product failure. ` +
        'Fix the failure before starting the 20-run certification campaign.',
    );
    process.exitCode = 1;
  } else if (counted >= BAR_DENOMINATOR && meetsBar) {
    console.log(
      `  ✅ BAR MET — ${passes.length}/${counted} ≥ ${BAR_NUMERATOR}/${BAR_DENOMINATOR}. ` +
        'Gate is green for the reactivation campaign.',
    );
  } else if (counted >= BAR_DENOMINATOR) {
    console.log(
      `  ❌ BAR NOT MET — ${passes.length}/${counted}, need ≥ ${requiredPasses}. ` +
        'Fix the top failure stage above and re-run.',
    );
    process.exitCode = 1;
  }

  if (excluded.length > counted / 4 && excluded.length > 0) {
    console.log(
      `  ⚠  ${excluded.length} of ${verdicts.length} runs were excluded as harness/environment ` +
        'failures. Fix the harness environment — this sample is not trustworthy.',
    );
  }
  console.log('═'.repeat(66));
}

main();
