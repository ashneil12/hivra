import { spawnSync } from "node:child_process";
import path from "node:path";

const dashboardRoot = path.resolve(__dirname, "..");

// node:test suites for dashboard scripts (release verification, Apple roots,
// the stale-lock build wrapper and litepaper staging).
// They sit outside jest's roots, so jest runs each one under `node --test` and
// checks its TAP summary. scripts/check-test-wiring.cjs requires this listing.
const suites = [
  "scripts/__tests__/verify-canary-release.test.mjs",
  "scripts/fetch-apple-root-certificates.test.mjs",
  "scripts/next-build-with-stale-lock-recovery.test.cjs",
  "scripts/stage-litepaper.test.mjs",
];

it.each(suites)("%s passes under node --test", (suite) => {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dashboardRoot, suite)], {
    cwd: dashboardRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${suite} failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stdout).toMatch(/^# fail 0$/m);
  expect(result.stdout).toMatch(/^# pass [1-9]\d*$/m);
}, 35_000);
