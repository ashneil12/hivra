import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SweepFailure, SweepRecorder, readResults, sweepMarkdown, sweepVerdict, verdictCounts } from "../e2e/launch-sweep/result";
import { SWEEP_CHAT_ANSWER, SWEEP_CHAT_PROMPT, SWEEP_TARGETS, selectedTargets } from "../e2e/launch-sweep/targets";
import { PRIVATE_ONLY_QUESTION } from "../e2e/launch-sweep/private-only";
import { softwareEvidenceFromResponse } from "../e2e/launch-sweep/software";
import { UNIVERSAL_CATALOG_MANIFESTS } from "../src/lib/hivra/catalog-manifests/manifests/index";

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

  it("counts the verdict for the commit status, and an empty run is not a pass", () => {
    const pass = recorder("hermes-computer", "Hermes");
    pass.result.passed = true;
    const known = recorder("aeon", "Aeon", "fails at the host step");
    known.fail(new SweepFailure("ready", "product", "host step"), "ready");
    const broken = recorder("agent-zero", "Agent Zero");
    broken.fail(new SweepFailure("ready", "product", "timed out"), "ready");

    expect(verdictCounts([pass.result, known.result])).toEqual({
      ok: true, total: 2, passed: 1, knownBroken: 1, broken: 0, leaked: 0, privateOnlyFailed: 0,
    });
    expect(verdictCounts([pass.result, broken.result])).toMatchObject({ ok: false, broken: 1 });
    expect(verdictCounts([])).toMatchObject({ ok: false, total: 0 });
  });

  it("fails the run when teardown leaves anything running", () => {
    const row = recorder("openclaw", "OpenClaw");
    row.result.passed = true;
    row.result.teardown = { agentsLeft: 1, instancesLeft: 0, accountDeleted: false };
    expect(sweepVerdict([row.result]).leaked).toHaveLength(1);
  });

  it("lists the private-models check per agent and fails the run when it broke", () => {
    const passed = recorder("hermes-computer", "Hermes");
    passed.result.passed = true;
    passed.result.privateOnly = { state: "passed", savedModel: "deepseek-v4-1-flash", replySeconds: 12 };
    const off = recorder("codex", "Codex");
    off.result.passed = true;
    off.result.privateOnly = { state: "not_offered", reason: "this agent does not use the managed gateway" };
    expect(sweepVerdict([passed.result, off.result]).ok).toBe(true);

    const failed = recorder("openclaw", "OpenClaw");
    failed.result.passed = true;
    failed.result.privateOnly = { state: "failed", reason: "turning the setting on answered HTTP 403", savedModel: "deepseek-v4-1-flash" };
    const verdict = sweepVerdict([passed.result, off.result, failed.result]);
    expect(verdict.ok).toBe(false);
    expect(verdict.broken).toHaveLength(0);
    expect(verdict.privateOnlyFailed.map(row => row.tile)).toEqual(["OpenClaw"]);

    const markdown = sweepMarkdown([passed.result, off.result, failed.result]);
    expect(markdown).toContain("## Launch sweep: every launch works, private models only failed on 1");
    expect(markdown).toContain("| Hermes | Pass | Still answered in 12s on deepseek-v4-1-flash |");
    expect(markdown).toContain("| Codex | Not offered | this agent does not use the managed gateway |");
    expect(markdown).toContain("| OpenClaw | **Fail** | turning the setting on answered HTTP 403 |");
  });

  it("writes and reads results for one run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-"));
    try {
      const row = new SweepRecorder({
        runId: "r1",
        baseUrl: "https://canary.example",
        profileId: "it-tools",
        tile: "IT Tools",
        kind: "agent",
        checkoutSha: "d".repeat(40),
        expectedCanarySha: "a".repeat(40),
        expectedProvisionerVersion: "2026.01.01.1",
        catalog: {
          manifestSha256: "b".repeat(64),
          runtimeKind: "docker-web",
          hostPort: 3201,
          healthPath: "/",
          runtimeRefs: ["corentinth/it-tools:latest"],
        },
      });
      row.fail(new Error("boom\nstack"), "chat");
      row.write(dir);
      const read = readResults(dir, "r1");
      expect(read).toHaveLength(1);
      expect(read[0].failure).toEqual({ stage: "chat", category: "product", reason: "boom" });
      expect(read[0].checkoutSha).toBe("d".repeat(40));
      expect(read[0].expectedCanarySha).toBe("a".repeat(40));
      expect(read[0].expectedProvisionerVersion).toBe("2026.01.01.1");
      expect(read[0].catalog).toMatchObject({
        manifestSha256: "b".repeat(64),
        runtimeKind: "docker-web",
        hostPort: 3201,
        runtimeRefs: ["corentinth/it-tools:latest"],
      });
      expect(readResults(dir, "other")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch sweep targets", () => {
  it("asks questions whose answers are not in the questions, and not each other's", () => {
    expect(SWEEP_CHAT_PROMPT).not.toContain(SWEEP_CHAT_ANSWER);
    expect(PRIVATE_ONLY_QUESTION.prompt).not.toContain(PRIVATE_ONLY_QUESTION.answer);
    expect(PRIVATE_ONLY_QUESTION.answer).not.toBe(SWEEP_CHAT_ANSWER);
    expect(SWEEP_CHAT_PROMPT).not.toContain(PRIVATE_ONLY_QUESTION.answer);
  });

  it("has one entry per profile and filters by id or tile name", () => {
    const ids = SWEEP_TARGETS.map(target => target.profileId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(selectedTargets("agent-zero, OpenClaw").map(target => target.profileId)).toEqual(["openclaw", "agent-zero"]);
    expect(selectedTargets("")).toHaveLength(SWEEP_TARGETS.length);
  });

  it("reduces the owner software API response to compact sweep evidence", () => {
    expect(softwareEvidenceFromResponse({ supported: false })).toEqual({ supported: false });
    expect(softwareEvidenceFromResponse({
      supported: true,
      app: "it-tools",
      cli: null,
      observedAt: "2026-01-01T00:00:00Z",
      view: { kind: "current", installed: "sha256:" + "c".repeat(64) },
    })).toEqual({
      supported: true,
      name: "it-tools",
      state: "current",
      installed: "sha256:" + "c".repeat(64),
      observedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("attaches reproducible manifest evidence to every universal-catalog target", () => {
    const catalogTargets = SWEEP_TARGETS.filter((target) => target.catalog);
    expect(catalogTargets).toHaveLength(UNIVERSAL_CATALOG_MANIFESTS.length);
    expect(catalogTargets.map((target) => target.profileId)).toContain("it-tools");
    for (const target of catalogTargets) {
      expect(target.catalog!.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(target.catalog!.runtimeRefs.length).toBeGreaterThan(0);
      if (target.proof === "app-open" || target.proof === "agent-ui-chat") {
        expect(target.catalog!.hostPort).not.toBeNull();
        expect(target.catalog!.healthPath).toMatch(/^\//);
      }
    }
    expect(SWEEP_TARGETS.find((target) => target.profileId === "claude-code")!.catalog).toBeUndefined();
  });

  it("lists idle use per agent, lightest first, and names agents it couldn't read", () => {
    const base = { minutes: 10, cpuPercentMax: 3, vcpus: 2, memoryMbMax: 900, memoryMbSize: 4096, memoryIncludesCache: true, diskUsedGb: 6.2, diskAllocatedGb: 40 };
    const heavy = recorder("openclaw", "OpenClaw");
    heavy.result.passed = true;
    heavy.result.idle = { ...base, samples: 16, cpuPercentMedian: 2.1, memoryMbMedian: 1300 };
    const light = recorder("ubuntu-server", "Linux computer");
    light.result.passed = true;
    light.result.idle = { ...base, samples: 16, cpuPercentMedian: 0.4, memoryMbMedian: 310 };
    const unread = recorder("omarchy", "Omarchy");
    unread.result.passed = true;
    unread.result.idle = { ...base, samples: 0, cpuPercentMedian: null, memoryMbMedian: null, note: "usage answered HTTP 404" };

    const markdown = sweepMarkdown([heavy.result, light.result, unread.result]);
    expect(markdown).toContain("### Idle use (10 min");
    expect(markdown.indexOf("| Linux computer | 310 MB")).toBeLessThan(markdown.indexOf("| OpenClaw | 1300 MB"));
    expect(markdown).toContain("No idle reading: Omarchy (usage answered HTTP 404).");
  });
});
