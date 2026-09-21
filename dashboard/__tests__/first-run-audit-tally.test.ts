import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(process.cwd(), "scripts/first-run-audit-tally.ts");

function verdict(kind: "pass" | "fail") {
  return {
    schema: "hivra.first-run-audit.v1",
    run_id: `smoke-${kind}`,
    verdict: kind,
    outcome_level: "agent_replied",
    stage_reached: kind === "pass" ? "agent_replied" : "workspace_interactive",
    failure:
      kind === "fail"
        ? {
            stage: "agent_replied",
            category: "product",
            reason: "ws_error",
            message: "agent did not answer",
          }
        : null,
    target: "https://canary.hermesos.cloud",
    git_sha: "test",
    started_at: "2026-08-29T00:00:00.000Z",
    finished_at: "2026-08-29T00:01:00.000Z",
    duration_ms: 60_000,
    clerk_user_id: "test-user",
    email: "test@hermesos.cloud",
    agent_name: "test-agent",
    instance: {
      id: "test-instance",
      status: "running",
      provider: "venice",
      host_id: null,
      inference_configured: true,
    },
    stages: [],
    timings_ms: {},
    workspace: null,
    telemetry: {
      posthog_captured: true,
      funnel: [],
      activation_failures: [],
      ops_events: { collected: false, reason: "test", events: [] },
    },
    agent_reply: null,
    teardown: {
      attempted: true,
      instances_destroyed: ["test-instance"],
      instances_survived: [],
      clerk_user_deleted: true,
      clerk_user_retained_for_reaper: false,
      errors: [],
    },
  };
}

function runTally(kind: "pass" | "fail") {
  const dir = mkdtempSync(join(tmpdir(), "hivra-first-run-tally-"));
  const path = join(dir, `run-${kind}.json`);
  writeFileSync(path, `${JSON.stringify(verdict(kind))}\n`, "utf8");
  try {
    return spawnSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-r", "tsconfig-paths/register", script, path],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: "true",
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            module: "commonjs",
            moduleResolution: "node",
          }),
        },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("first-run audit tally smoke verdict", () => {
  it("fails an incomplete smoke sample when its counted run has a product failure", () => {
    const result = runTally("fail");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SMOKE FAILED");
  });

  it("allows an incomplete all-pass smoke sample without claiming certification", () => {
    const result = runTally("pass");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SAMPLE INCOMPLETE");
    expect(result.stdout).not.toContain("BAR MET");
  });
});
