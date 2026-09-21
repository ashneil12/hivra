import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FlowRunner } from "../src/playwright/flow-runner.js";
import { fakeConfig, fakeSessionManager, silentLogger } from "./_fakes.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { SessionManager } from "../src/playwright/session-manager.js";

const FLOWS_DIR = `/tmp/test-flows-${Date.now()}`;

describe("flow-runner", () => {
  let config: Config;
  let logger: Logger;
  let sessions: SessionManager;
  let runner: FlowRunner;

  beforeEach(async () => {
    await mkdir(FLOWS_DIR, { recursive: true });
    config = fakeConfig({ FLOWS_DIR }) as Config;
    logger = silentLogger() as unknown as Logger;
    sessions = fakeSessionManager();
    runner = new FlowRunner(config, logger, sessions);
  });

  it("runs a simple goto+log flow", async () => {
    const yaml = `id: test_simple\nsteps:\n  - type: goto\n    args: { url: "https://example.com" }\n  - type: log\n    args: { message: "ok" }\n`;
    await writeFile(join(FLOWS_DIR, "test_simple.yaml"), yaml);
    const result = await runner.run({ session_id: "fake-session-id", flow_id: "test_simple" });
    expect(result.ok).toBe(true);
  });

  it("returns SESSION_NOT_FOUND for unknown session", async () => {
    const yaml = `id: test_x\nsteps: []\n`;
    await writeFile(join(FLOWS_DIR, "test_x.yaml"), yaml);
    const result = await runner.run({ session_id: "missing", flow_id: "test_x" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("SESSION_NOT_FOUND");
  });

  it("rejects flow_id with invalid characters", async () => {
    await expect(runner.loadFlow("../etc/passwd")).rejects.toThrow();
  });

  it("rejects mismatched id in YAML vs requested flow_id", async () => {
    const yaml = `id: actually_other\nsteps: []\n`;
    await writeFile(join(FLOWS_DIR, "test_mismatch.yaml"), yaml);
    await expect(runner.loadFlow("test_mismatch")).rejects.toThrow(/file id mismatch/);
  });

  it("interpolates env, args, and state", async () => {
    process.env.TEST_INTERP_VAL = "envval";
    const yaml = `id: test_interp\nsteps:\n  - type: get_text\n    args: { selector: "h1", into: collected }\n  - type: log\n    args: { message: "env=\${env:TEST_INTERP_VAL} arg=\${args:argv} state=\${state:collected}" }\n`;
    await writeFile(join(FLOWS_DIR, "test_interp.yaml"), yaml);
    const result = await runner.run({
      session_id: "fake-session-id",
      flow_id: "test_interp",
      args: { argv: "argval" },
    });
    expect(result.ok).toBe(true);
  });

  it("terminates early on check_url match with on_match=return_ok", async () => {
    const yaml = `id: test_idempotent\nsteps:\n  - type: goto\n    args: { url: "https://example.com" }\n  - type: check_url\n    args: { contains: "example" }\n    on_match: return_ok\n  - type: fill\n    args: { selector: "input", value: "should-not-run" }\n`;
    await writeFile(join(FLOWS_DIR, "test_idempotent.yaml"), yaml);
    const result = await runner.run({ session_id: "fake-session-id", flow_id: "test_idempotent" });
    expect(result.ok).toBe(true);
  });

  afterAll(async () => {
    await rm(FLOWS_DIR, { recursive: true, force: true });
  });
});
