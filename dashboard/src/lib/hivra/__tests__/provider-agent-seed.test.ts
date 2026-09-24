/** @jest-environment node */
// ATT-05: an agent on a computer in the owner's own cloud gets the same launch
// seeds as on Hivra Cloud. The combined guest script runs for real in bash
// with stand-in parts, so a failed part can never hide another's success.
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import {
  buildProviderAgentSeedScript,
  parseProviderAgentSeedOutput,
  providerAgentSeedsDue,
  seedProviderAgent,
  type ProviderAgentSeedRow,
} from "../provider-agent-seed";
import { MAX_PROVIDER_GUEST_SEED_BYTES } from "@/lib/infrastructure/first-boot-ssh";
import { CURATED_SKILLS } from "@/data/curated-skills";

jest.mock("@/lib/account-memory", () => ({ getAccountMemory: jest.fn(async () => "") }));

const TEMPLATE_SKILL = CURATED_SKILLS.find((skill) => skill.category !== "bankr" && typeof skill.content === "string" && skill.content.trim())!;
const ROW: ProviderAgentSeedRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "codex", name: "Researcher", status: "running", computer_substrate: "provider-vm",
  goal: null, context: "Track competitor pricing", personality: null, emoji: null, template_skills: [TEMPLATE_SKILL.id],
  bootstrapped_at: null, bankr_skills_seeded_at: null, template_skills_seeded_at: null,
};

describe("providerAgentSeedsDue", () => {
  it("lists every seed a new provider agent still needs, like Hivra Cloud does", () => {
    expect(providerAgentSeedsDue(ROW)).toEqual(["bootstrap", "bankr-skills", "template-skills"]);
    expect(providerAgentSeedsDue({ ...ROW, bootstrapped_at: "2026-09-24T10:00:00Z", template_skills: [] })).toEqual(["bankr-skills"]);
  });

  it("does nothing for Proxmox agents, dashboard runtimes, or a computer that isn't running", () => {
    expect(providerAgentSeedsDue({ ...ROW, computer_substrate: "proxmox-kvm" })).toEqual([]);
    expect(providerAgentSeedsDue({ ...ROW, type: "openclaw" })).toEqual([]);
    expect(providerAgentSeedsDue({ ...ROW, status: "provisioning" })).toEqual([]);
  });
});

const hasBash = spawnSync("bash", ["--version"]).status === 0;
(hasBash ? describe : describe.skip)("combined guest script", () => {
  const run = (script: string) => spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });

  it("confirms only the parts whose own script printed its success marker", () => {
    const script = buildProviderAgentSeedScript([
      { part: "bootstrap", script: "set -e\necho HIVRA_SEED_OK\n" },
      { part: "bankr-skills", script: "set -e\nexit 7\necho HIVRA_BANKR_SKILLS_OK\n" },
      { part: "template-skills", script: "set -e\necho HIVRA_BANKR_SKILLS_OK\n" },
    ]);
    expect(script.startsWith("set -e\n")).toBe(true);
    const result = run(script);
    expect(result.status).toBe(0);
    expect(parseProviderAgentSeedOutput(result.stdout, ["bootstrap", "bankr-skills", "template-skills"])).toEqual(["bootstrap", "template-skills"]);
  });

  it("carries payload bytes only as base64, so quotes and $ in content never reach the shell", () => {
    const hostile = "set -e\nprintf '%s\\n' \"it's $HOME \\`id\\`\" >/dev/null\necho HIVRA_SEED_OK\n";
    const script = buildProviderAgentSeedScript([{ part: "bootstrap", script: hostile }]);
    expect(script).not.toContain("it's");
    expect(parseProviderAgentSeedOutput(run(script).stdout, ["bootstrap"])).toEqual(["bootstrap"]);
  });

  it("confirms nothing when the script didn't finish", () => {
    expect(parseProviderAgentSeedOutput("HIVRA_PROVIDER_SEED_PART bootstrap\n", ["bootstrap"])).toEqual([]);
    expect(parseProviderAgentSeedOutput("HIVRA_PROVIDER_SEED_PART bankr-skills\nHIVRA_PROVIDER_SEED_DONE\n", ["bootstrap"])).toEqual([]);
  });
});

describe("seedProviderAgent", () => {
  it("sends the identity, Bankr and template seeds in one connection and returns what the computer confirmed", async () => {
    const run = jest.fn<Promise<{ ok: true; stdout: string }>, [{ userId: string; agentId: string }, string]>(async () => ({ ok: true,
      stdout: "HIVRA_PROVIDER_SEED_PART bootstrap\nHIVRA_PROVIDER_SEED_PART template-skills\nHIVRA_PROVIDER_SEED_DONE\n" }));
    const result = await seedProviderAgent("user_1", ROW, { run, sharedMemory: async () => "" });
    expect(result).toEqual({ attempted: ["bootstrap", "bankr-skills", "template-skills"], confirmed: ["bootstrap", "template-skills"] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ userId: "user_1", agentId: ROW.id });
    const script = run.mock.calls[0][1];
    // The whole Bankr suite fits with room to grow.
    expect(Buffer.byteLength(script)).toBeLessThan(MAX_PROVIDER_GUEST_SEED_BYTES / 2);
    // The identity part is the same guest script the Proxmox lane runs, and
    // the provider launch's model settings are not rewritten.
    const bootstrap = gunzipSync(Buffer.from(/printf '%s' '([A-Za-z0-9+/=]+)'/.exec(script)![1], "base64")).toString("utf8");
    expect(bootstrap).toContain('"$BUX/SOUL.md"');
    expect(bootstrap).toContain("HIVRA:BOOTSTRAP:START");
    expect(bootstrap).not.toContain("llm-provider.json");
  });

  it("confirms nothing when the computer can't be reached, so the next poll tries again", async () => {
    const run = jest.fn(async () => ({ ok: false as const, error: "unreachable" as const }));
    expect(await seedProviderAgent("user_1", ROW, { run, sharedMemory: async () => "" })).toEqual({
      attempted: ["bootstrap", "bankr-skills", "template-skills"], confirmed: [] });
  });

  it("makes no connection when nothing is due", async () => {
    const run = jest.fn();
    await seedProviderAgent("user_1", { ...ROW, bootstrapped_at: "x", bankr_skills_seeded_at: "x", template_skills_seeded_at: "x" }, { run });
    expect(run).not.toHaveBeenCalled();
  });
});
