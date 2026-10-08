import { spawnSync } from "node:child_process";
import path from "node:path";

const dashboardRoot = path.resolve(__dirname, "..");

// node:test suites for guest runtime adapters: the Guacamole token, the staged
// and sealed desktop brokers, and the Agent Zero editor lifecycle.
// They sit outside jest's roots, so jest runs each one under `node --test` and
// checks its TAP summary. scripts/check-test-wiring.cjs requires this listing.
const suites = [
  "runtime-adapters/windows-rdp/guacamole-json-token.test.mjs",
  "runtime-adapters/remote-desktop/broker.test.cjs",
  "runtime-adapters/remote-desktop/sealed-broker.test.cjs",
  "runtime-adapters/agent-zero-native/editor-lifecycle.test.cjs",
];

it.each(suites)("%s passes under node --test", (suite) => {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dashboardRoot, suite)], {
    cwd: dashboardRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${suite} failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stdout).toMatch(/^# fail 0$/m);
  expect(result.stdout).toMatch(/^# pass [1-9]\d*$/m);
}, 65_000);
