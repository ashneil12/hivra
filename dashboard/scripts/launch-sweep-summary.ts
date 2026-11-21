/**
 * Print the launch sweep's results as a Markdown table, and exit non-zero when
 * a launch customers use is broken or something was left running.
 *
 *   npm run test:launch-sweep:summary              # every result in e2e/.launch-sweep
 *   npm run test:launch-sweep:summary -- <runId>   # one run
 *
 * LAUNCH_SWEEP_VERDICT_FILE=<path> also writes the verdict counts as JSON, which
 * scripts/release/launch-sweep-status.mjs publishes as the commit's status.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import { readResults, sweepMarkdown, sweepVerdict, verdictCounts } from '../e2e/launch-sweep/result';

const outDir = process.env.LAUNCH_SWEEP_OUT_DIR?.trim() || 'e2e/.launch-sweep';
const all = readResults(outDir);
// Default to the newest run, so older runs in the same folder don't mix in.
const latest = [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.runId;
const runId = process.argv[2] || process.env.LAUNCH_SWEEP_RUN_ID || latest;
const results = all.filter((row) => !runId || row.runId === runId);
const markdown = sweepMarkdown(results);
process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

const verdict = sweepVerdict(results);
const verdictFile = process.env.LAUNCH_SWEEP_VERDICT_FILE?.trim();
if (verdictFile) writeFileSync(verdictFile, `${JSON.stringify({ runId, ...verdictCounts(results) }, null, 2)}\n`);
if (results.length === 0 || !verdict.ok) process.exit(1);
