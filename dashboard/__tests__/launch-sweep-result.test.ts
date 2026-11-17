import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SweepFailure, SweepRecorder, readResults, sweepMarkdown, sweepVerdict } from "../e2e/launch-sweep/result";
import { SWEEP_CHAT_ANSWER, SWEEP_CHAT_PROMPT, SWEEP_TARGETS, selectedTargets } from "../e2e/launch-sweep/targets";

function recorder(profileId: string, tile: string, knownBroken?: string) {
  return new SweepRecorder({ runId: "r1", baseUrl: "https://canary.example", profileId, tile, kind: "agent", knownBroken });
}

describe("launch sweep results", () => {
  it("fails the run only for customer-facing breakage, not known-broken or not-offered tiles", () => {
    const pass = recorder("hermes-computer", "Hermes");
    pass.done("chat");
    pass.result.passed = true;
    const known = recorder("aeon", "Aeon", "fails at the host step");
    known.fail(new SweepFailure("ready", "product", "host step"), "ready");
    const absent = recorder("nuphos", "Nuphos");
    absent.fail(new SweepFailure("choose", "not_offered", "no tile"), "choose");

    expect(sweepVerdict([pass.result, known.result, absent.result]).ok).toBe(true);

    const broken = recorder("agent-zero", "Agent Zero");
    broken.fail(new SweepFailure("ready", "product", "gateway sign-in check timed out"), "ready");
    const verdict = sweepVerdict([pass.result, broken.result]);
    expect(verdict.ok).toBe(false);
    expect(verdict.broken.map(row => row.tile)).toEqual(["Agent Zero"]);
    expect(sweepMarkdown([pass.result, broken.result])).toContain("| Agent Zero | **Fail** | nothing |");
  });

  it("fails the run when teardown leaves anything running", () => {
    const row = recorder("openclaw", "OpenClaw");
    row.result.passed = true;
    row.result.teardown = { agentsLeft: 1, instancesLeft: 0, accountDeleted: false };
    expect(sweepVerdict([row.result]).leaked).toHaveLength(1);
  });

  it("writes and reads results for one run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-"));
    try {
      const row = recorder("codex", "Codex");
      row.fail(new Error("boom\nstack"), "chat");
      row.write(dir);
      const read = readResults(dir, "r1");
      expect(read).toHaveLength(1);
      expect(read[0].failure).toEqual({ stage: "chat", category: "product", reason: "boom" });
      expect(readResults(dir, "other")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch sweep targets", () => {
  it("asks a question whose answer is not in the question", () => {
    expect(SWEEP_CHAT_PROMPT).not.toContain(SWEEP_CHAT_ANSWER);
  });

  it("has one entry per profile and filters by id or tile name", () => {
    const ids = SWEEP_TARGETS.map(target => target.profileId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(selectedTargets("agent-zero, OpenClaw").map(target => target.profileId)).toEqual(["openclaw", "agent-zero"]);
    expect(selectedTargets("")).toHaveLength(SWEEP_TARGETS.length);
  });
});
