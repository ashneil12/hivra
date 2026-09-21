/** @jest-environment node */

import { spawnSync } from "node:child_process";

import {
  buildGuestCommandInvocation,
  parseGuestCommandResult,
  runGuestCommandProcess,
} from "../e2e/first-run-audit/guest-command";

const AGENT_ID = "00000000-0000-4000-8000-000000001053";

describe("remote desktop audit guest command", () => {
  it("executes the real operator entrypoint with declared repository dependencies", () => {
    const invocation = buildGuestCommandInvocation(
      process.cwd(),
      "scripts/install-remote-desktop-canary.ts",
      AGENT_ID,
      false,
    );
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.args.join(" ")).not.toContain("tsx");

    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: invocation.env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "") as Record<string, unknown>;
    expect(receipt).toMatchObject({
      protocol: "hivra-remote-desktop-canary-install-plan-v1",
      agentId: AGENT_ID,
      mutatesCanaryGuest: false,
    });
  });

  it("accepts an exact structured receipt while discarding unbounded stderr", () => {
    const program = [
      `process.stderr.write("x".repeat(2 * 1024 * 1024));`,
      `process.stdout.write(JSON.stringify({ok:true,agentId:${JSON.stringify(AGENT_ID)}})+"\\n");`,
    ].join("");

    expect(runGuestCommandProcess(
      process.execPath,
      ["-e", program],
      "fixture.js",
      AGENT_ID,
      { maxBuffer: 1024, timeoutMs: 10_000 },
    )).toMatchObject({ ok: true, agentId: AGENT_ID });
  });

  it("classifies missing stdout without throwing a parser TypeError", () => {
    const error = Object.assign(new Error("redacted"), { code: "ENOBUFS" });
    expect(() => parseGuestCommandResult({
      error,
      signal: null,
      status: null,
      stdout: undefined as unknown as string,
    }, "installer.ts", AGENT_ID)).toThrow("installer.ts failed: host_output_limit");
  });

  it("reports a missing executable as a safe process error code", () => {
    const error = Object.assign(new Error("redacted"), { code: "ENOENT" });
    expect(() => parseGuestCommandResult({
      error,
      signal: null,
      status: null,
      stdout: undefined as unknown as string,
    }, "installer.ts", AGENT_ID)).toThrow("installer.ts failed: host_enoent");
  });

  it("preserves only an allowlisted failure receipt", () => {
    expect(() => parseGuestCommandResult({
      signal: null,
      status: 1,
      stdout: `${JSON.stringify({
        ok: false,
        agentId: AGENT_ID,
        error: "Remote desktop guest installation could not be verified (guest_docker_pull_failed).",
      })}\n`,
    }, "installer.ts", AGENT_ID)).toThrow(
      "installer.ts failed: Remote desktop guest installation could not be verified (guest_docker_pull_failed).",
    );
  });

  it("does not echo arbitrary subprocess output", () => {
    expect(() => parseGuestCommandResult({
      signal: null,
      status: 1,
      stdout: `${JSON.stringify({ error: "secret=value" })}\n`,
    }, "installer.ts", AGENT_ID)).toThrow("installer.ts failed: operator_exit");
  });

  it("preserves a bounded capability failure receipt", () => {
    expect(() => parseGuestCommandResult({
      signal: null,
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        agentId: AGENT_ID,
        error: "Remote desktop capability could not be verified (guest_service_active_hivra_selkies_desktop_failed).",
      }) + "\n",
    }, "installer.ts", AGENT_ID)).toThrow(
      "installer.ts failed: Remote desktop capability could not be verified (guest_service_active_hivra_selkies_desktop_failed).",
    );
  });

  it("accepts only fixed installer errors bound to the expected agent", () => {
    const receipt = JSON.stringify({
      ok: false,
      agentId: AGENT_ID,
      error: "The managed host runtime could not be prepared.",
    });
    expect(() => parseGuestCommandResult({
      signal: null,
      status: 1,
      stdout: receipt,
    }, "installer.ts", AGENT_ID)).toThrow(
      "installer.ts failed: The managed host runtime could not be prepared.",
    );
    expect(() => parseGuestCommandResult({
      signal: null,
      status: 1,
      stdout: receipt,
    }, "installer.ts", "11111111-1111-4111-8111-111111111111")).toThrow(
      "installer.ts failed: operator_exit",
    );
  });
});
