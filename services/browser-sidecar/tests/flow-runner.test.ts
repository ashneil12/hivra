import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FlowRunner } from "../src/playwright/flow-runner.js";
import { fakeConfig, fakePage, fakeSessionManager, silentLogger } from "./_fakes.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { SessionManager } from "../src/playwright/session-manager.js";

const FLOWS_DIR = `/tmp/test-flows-${Date.now()}`;

// A page on which every locator wait times out, as when an element never appears.
function pageWithMissingElement() {
  return fakePage({
    locator: vi.fn(() => ({
      first: () => ({
        waitFor: vi.fn(async () => {
          throw new Error("Timeout exceeded waiting for locator");
        }),
      }),
    })),
  });
}

function sessionWithPage(page: unknown): SessionManager {
  const session = { session_id: "s", identity: "vex", page, created_at: 0, last_used_at: 0 };
  return { get: vi.fn(() => session) } as unknown as SessionManager;
}

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

  // Regression: login_clerk's code-field probe times out when Clerk shows no
  // code step. The timeout must not fail the flow, and the gated IMAP step must
  // not run (here it would throw "IMAP not configured" and fail the flow).
  it("an optional wait_for that times out records false and the gated steps are skipped", async () => {
    const yaml = `id: test_optional_probe\nsteps:\n  - id: probe\n    type: wait_for\n    optional: true\n    args: { selector: "input[name=code]", timeout_ms: 10, into: code_field_found }\n  - id: gated_imap\n    type: imap_wait_code\n    when: code_field_found\n    args: { into: clerk_code }\n  - id: after\n    type: log\n    args: { message: "reached" }\n`;
    await writeFile(join(FLOWS_DIR, "test_optional_probe.yaml"), yaml);
    const flowRunner = new FlowRunner(config, logger, sessionWithPage(pageWithMissingElement()));
    const result = await flowRunner.run({ session_id: "s", flow_id: "test_optional_probe" });
    expect(result.ok).toBe(true);
    expect(result.output?.code_field_found).toBe(false);
    expect(result.output).not.toHaveProperty("clerk_code");
  });

  it("an optional wait_for that succeeds records true and the gated step runs", async () => {
    const yaml = `id: test_probe_found\nsteps:\n  - id: probe\n    type: wait_for\n    optional: true\n    args: { selector: "input[name=code]", timeout_ms: 10, into: code_field_found }\n  - id: gated\n    type: get_text\n    when: code_field_found\n    args: { selector: "h1", into: gated_text }\n`;
    await writeFile(join(FLOWS_DIR, "test_probe_found.yaml"), yaml);
    const flowRunner = new FlowRunner(config, logger, sessionWithPage(fakePage()));
    const result = await flowRunner.run({ session_id: "s", flow_id: "test_probe_found" });
    expect(result.ok).toBe(true);
    expect(result.output?.code_field_found).toBe(true);
    expect(result.output?.gated_text).toBe("fake text");
  });

  it("a required step that times out still fails the flow", async () => {
    const yaml = `id: test_required_timeout\nsteps:\n  - id: must_be_there\n    type: wait_for\n    args: { selector: "input[name=code]", timeout_ms: 10 }\n  - id: never\n    type: log\n    args: { message: "not reached" }\n`;
    await writeFile(join(FLOWS_DIR, "test_required_timeout.yaml"), yaml);
    const flowRunner = new FlowRunner(config, logger, sessionWithPage(pageWithMissingElement()));
    const result = await flowRunner.run({ session_id: "s", flow_id: "test_required_timeout" });
    expect(result.ok).toBe(false);
    expect(result.failed_step).toBe("must_be_there");
  });

  afterAll(async () => {
    await rm(FLOWS_DIR, { recursive: true, force: true });
  });
});
