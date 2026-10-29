/** @jest-environment node */

// Runs the shell harness for ops/observability/configure-agent-otel.sh in CI.
// The harness checks the refusals (symlinks, an unmanaged [otel] block) and
// that a refusal writes no /etc/profile.d file. It runs as a non-root user; the
// CI runner is one, and the harness stands in for runuser itself.

import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const harness = path.join(repoRoot, "ops/observability/test-configure-agent-otel.sh");

describe("configure-agent-otel.sh harness", () => {
  it("passes every refusal and happy-path check", () => {
    const result = spawnSync("bash", [harness], { encoding: "utf8", timeout: 120_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toMatch(/^FAIL /m);
    expect(output).toMatch(/all checks passed/);
    expect(result.status).toBe(0);
  }, 150_000);
});
