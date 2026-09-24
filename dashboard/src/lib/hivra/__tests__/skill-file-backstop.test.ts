/** @jest-environment node */
// The write-time backstop: even if a broken SKILL.md reaches the catalog, the
// Bankr seed, the skill picker and template seeding write only files Codex can
// load, and a picked skill that can't be repaired fails with a clear error
// instead of vanishing. The catalog here is a fixture with each broken shape.
jest.mock("@/data/curated-skills", () => ({
  CURATED_SKILLS: [
    { id: "bankr-ok", name: "OK", description: "Fine.", identifier: "BankrBot/skills/ok", category: "bankr", content: "---\nname: ok\ndescription: Fine.\n---\n# OK\n" },
    { id: "bankr-unclosed", name: "Trails", description: "Swaps.", identifier: "BankrBot/skills/trails", category: "bankr", content: "---\n\nname: trails\ndescription: Swaps.\n\n# Trails\n" },
    { id: "bankr-bare", name: "Agent Framework", description: "Agents on X.", identifier: "BankrBot/skills/skills/bankr-twitter-agent", category: "bankr", content: "# Skill: twitter-agent\n" },
    { id: "bankr-broken", name: "Broken", description: "Nope.", identifier: "BankrBot/skills/broken", category: "bankr", content: "---\nname: [broken\n---\n" },
    { id: "picked-broken", name: "Picked Broken", description: "Nope.", identifier: "x/picked-broken", category: "dev", content: "---\ndescription: no name here\n---\n" },
    { id: "picked-ok", name: "Picked OK", description: "Fine.", identifier: "x/picked-ok", category: "dev", content: "---\nname: picked-ok\ndescription: Fine.\n---\n" },
  ],
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ __esModule: true, runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/account-memory", () => ({ getAccountMemory: jest.fn(async () => "") }));

import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

import { collectBankrSkillFiles } from "../bankr-skills-seed";
import { seedProviderAgent, type ProviderAgentSeedRow } from "../provider-agent-seed";
import { collectSkillFilesForIds, installCuratedSkillsOnBox } from "../skill-install";
import { skillFrontmatterProblem } from "../skill-file";

const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
const mockedWarn = log.warn as jest.MockedFunction<typeof log.warn>;

const TRAILS_REPAIRED = "---\nname: trails\ndescription: Swaps.\n---\n\n# Trails\n";
const BARE_REPAIRED = "---\nname: skills-bankr-twitter-agent\ndescription: Agents on X.\n---\n\n# Skill: twitter-agent\n";

beforeEach(() => {
  mockedRunScript.mockReset();
  mockedWarn.mockReset();
});

describe("collectBankrSkillFiles", () => {
  it("repairs the broken shapes and leaves out, with a warning, what can't be repaired", () => {
    const files = collectBankrSkillFiles();
    expect(files).toEqual([
      { slug: "ok", content: "---\nname: ok\ndescription: Fine.\n---\n# OK\n" },
      { slug: "trails", content: TRAILS_REPAIRED },
      { slug: "skills-bankr-twitter-agent", content: BARE_REPAIRED },
    ]);
    expect(files.every((f) => skillFrontmatterProblem(f.content) === null)).toBe(true);
    expect(mockedWarn).toHaveBeenCalledWith(
      expect.stringMatching(/can't be loaded/),
      expect.objectContaining({ failureType: "skill_file_unloadable", identifier: "BankrBot/skills/broken" }),
    );
  });
});

describe("collectSkillFilesForIds", () => {
  it("returns repaired files and reports picked skills that can't be repaired", () => {
    const { files, skipped, unloadable } = collectSkillFilesForIds(["bankr-unclosed", "picked-broken", "picked-ok", "ghost"]);
    expect(files.map((f) => [f.id, f.content])).toEqual([
      ["bankr-unclosed", TRAILS_REPAIRED],
      ["picked-ok", "---\nname: picked-ok\ndescription: Fine.\n---\n"],
    ]);
    expect(skipped).toEqual(["ghost"]);
    expect(unloadable).toEqual(["picked-broken"]);
  });
});

describe("installCuratedSkillsOnBox", () => {
  const agent = { id: "a", type: "codex", ip: "10.250.20.42" };

  it("refuses the whole install with a clear error, before touching the computer", async () => {
    const res = await installCuratedSkillsOnBox(agent, ["picked-ok", "picked-broken"], {});
    expect(res).toEqual({
      ok: false,
      installed: [],
      skipped: [],
      unloadable: ["picked-broken"],
      error: "Couldn't install Picked Broken: its skill file is broken, so your agent couldn't use it. Nothing was installed.",
    });
    expect(mockedRunScript).not.toHaveBeenCalled();

    const both = await installCuratedSkillsOnBox(agent, ["picked-broken", "bankr-broken"], {});
    expect(both.error).toBe(
      "Couldn't install Picked Broken and Broken: their skill files are broken, so your agent couldn't use them. Nothing was installed.",
    );
  });

  it("writes the repaired file, not the broken one", async () => {
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "HIVRA_BANKR_SKILLS_OK\n", stderr: "" } as Awaited<
      ReturnType<typeof runProxmoxHostScript>
    >);
    const res = await installCuratedSkillsOnBox(agent, ["bankr-unclosed", "bankr-bare"], {});
    expect(res).toEqual({ ok: true, installed: ["bankr-unclosed", "bankr-bare"], skipped: [] });
    const outer = (mockedRunScript.mock.calls[0][0] as string).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| ssh/)![1];
    const guest = Buffer.from(outer, "base64").toString("utf8");
    const written = [...guest.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) =>
      Buffer.from(m[1], "base64").toString("utf8"),
    );
    expect(written).toEqual([TRAILS_REPAIRED, BARE_REPAIRED]);
  });
});

describe("seedProviderAgent template skills", () => {
  const row: ProviderAgentSeedRow = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "codex", status: "running", computer_substrate: "provider-vm",
    bootstrapped_at: "2026-09-24T10:00:00Z", bankr_skills_seeded_at: "2026-09-24T10:00:00Z", template_skills_seeded_at: null,
    template_skills: ["picked-ok", "picked-broken"],
  };

  const confirmingRun = () =>
    jest.fn<Promise<{ ok: true; stdout: string }>, [{ userId: string; agentId: string }, string]>(async () => ({
      ok: true,
      stdout: "HIVRA_PROVIDER_SEED_PART template-skills\nHIVRA_PROVIDER_SEED_DONE\n",
    }));

  it("holds the part back when a template skill can't be loaded, as Hivra Cloud does", async () => {
    const run = confirmingRun();
    expect(await seedProviderAgent("user_1", row, { run })).toEqual({ attempted: [], confirmed: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("seeds the template skills once they all load", async () => {
    const run = confirmingRun();
    const result = await seedProviderAgent("user_1", { ...row, template_skills: ["picked-ok"] }, { run });
    expect(result).toEqual({ attempted: ["template-skills"], confirmed: ["template-skills"] });
  });
});
