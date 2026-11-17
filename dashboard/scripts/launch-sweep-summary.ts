/**
 * Print the launch sweep's results as a Markdown table, and exit non-zero when
 * a launch customers use is broken or something was left running.
 *
 *   npm run test:launch-sweep:summary              # every result in e2e/.launch-sweep
 *   npm run test:launch-sweep:summary -- <runId>   # one run
 */
import { appendFileSync } from 'node:fs';

import { readResults, sweepMarkdown, sweepVerdict } from '../e2e/launch-sweep/result';

const outDir = process.env.LAUNCH_SWEEP_OUT_DIR?.trim() || 'e2e/.launch-sweep';
const runId = process.argv[2] || process.env.LAUNCH_SWEEP_RUN_ID || undefined;
const results = readResults(outDir, runId);
const markdown = sweepMarkdown(results);
process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

const verdict = sweepVerdict(results);
if (results.length === 0 || !verdict.ok) process.exit(1);
