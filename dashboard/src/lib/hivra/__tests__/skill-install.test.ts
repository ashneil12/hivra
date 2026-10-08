import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { CURATED_SKILLS } from "@/data/curated-skills";

import {
  installCuratedSkillsOnBox,
  collectSkillFilesForIds,
  isInstallableCuratedId,
  listInstallableSkillMeta,
} from "../skill-install";
import { bankrSkillSlug } from "../bankr-skills-seed";
import { skillFrontmatterProblem } from "../skill-file";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  __esModule: true,
  runProxmoxHostScript: jest.fn(),
}));

const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;

// Pull real catalog fixtures so the test tracks the actual data shape.
const installable = listInstallableSkillMeta();
const FIRST = installable[0];
const SECOND = installable[1];
// An id that exists in the catalog but has NO inline content (contentless), if any.
const CONTENTLESS = CURATED_SKILLS.find((s) => !s.content || !String(s.content).trim());

describe("listInstallableSkillMeta / isInstallableCuratedId", () => {
  it("only surfaces entries with non-empty content, stripped of the SKILL.md body", () => {
    expect(installable.length).toBeGreaterThan(0);
    for (const m of installable) {
      expect(isInstallableCuratedId(m.id)).toBe(true);
      // metadata only — no content field leaks to the client shape
      expect(Object.keys(m).sort()).toEqual(["category", "description", "id", "installedAs", "name"]);
    }
  });

  it("rejects unknown and contentless ids", () => {
    expect(isInstallableCuratedId("nope-not-a-real-id")).toBe(false);
    if (CONTENTLESS) expect(isInstallableCuratedId(CONTENTLESS.id)).toBe(false);
  });
});

describe("collectSkillFilesForIds", () => {
  it("maps installable ids to {slug, content} via the bankr slug scheme", () => {
    const { files, skipped } = collectSkillFilesForIds([FIRST.id]);
    expect(skipped).toEqual([]);
    expect(files).toHaveLength(1);
    const entry = CURATED_SKILLS.find((s) => s.id === FIRST.id)!;
    expect(files[0].slug).toBe(bankrSkillSlug(entry.identifier));
    expect(files[0].content).toBe(entry.content);
    expect(files[0].id).toBe(FIRST.id);
  });

  it("dedupes repeated ids and reports unknown/contentless ids as skipped", () => {
    const ids = [FIRST.id, FIRST.id, "ghost-id"];
    if (CONTENTLESS) ids.push(CONTENTLESS.id);
    const { files, skipped } = collectSkillFilesForIds(ids);
    expect(files).toHaveLength(1);
    expect(skipped).toContain("ghost-id");
    if (CONTENTLESS) expect(skipped).toContain(CONTENTLESS.id);
  });

  it("writes only SKILL.md files Codex can load, for every skill the picker offers", () => {
    const { files, skipped, unloadable } = collectSkillFilesForIds(installable.map((s) => s.id));
    expect(skipped).toEqual([]);
    expect(unloadable).toEqual([]);
    expect(files).toHaveLength(installable.length);
    const problems = files
      .map((f) => ({ id: f.id, problem: skillFrontmatterProblem(f.content) }))
      .filter((result) => result.problem !== null);
    expect(problems).toEqual([]);
  });

  it("produces unique slugs across many requested skills (no on-disk collisions)", () => {
    const ids = installable.slice(0, 10).map((s) => s.id);
    const { files } = collectSkillFilesForIds(ids);
    const slugs = files.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("installCuratedSkillsOnBox", () => {
  beforeEach(() => mockedRunScript.mockReset());

  it("gates non-codex/claude-code agent types without touching SSH", async () => {
    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "aeon", ip: "10.250.20.42" },
      [FIRST.id],
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.installed).toEqual([]);
    expect(res.error).toMatch(/unsupported/i);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid box ip without touching SSH", async () => {
    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "codex", ip: "" },
      [FIRST.id],
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ip/i);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("writes the right slug + content into the codex per-CLI dir on success", async () => {
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_BANKR_SKILLS_OK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "codex", ip: "10.250.20.42" },
      [FIRST.id],
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.installed).toEqual([FIRST.id]);
    expect(mockedRunScript).toHaveBeenCalledTimes(1);

    const sentScript = mockedRunScript.mock.calls[0][0] as string;
    const entry = CURATED_SKILLS.find((s) => s.id === FIRST.id)!;
    const slug = bankrSkillSlug(entry.identifier);
    // The host script wraps the guest script base64 — decode it to assert on the
    // actual writes (codex → .agents/skills, slug dir, SKILL.md, real content).
    const b64 = sentScript.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| ssh/)?.[1];
    expect(b64).toBeTruthy();
    const guest = Buffer.from(b64!, "base64").toString("utf8");
    expect(guest).toContain('ROOT="$BUX/.agents/skills"');
    expect(guest).toContain(`mkdir -p "$ROOT/${slug}"`);
    expect(guest).toContain(`> "$ROOT/${slug}/SKILL.md"`);
    const contentB64 = Buffer.from(entry.content as string, "utf8").toString("base64");
    expect(guest).toContain(contentB64);
  });

  it("writes into the claude-code per-CLI dir for claude-code boxes", async () => {
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "ok HIVRA_BANKR_SKILLS_OK",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "claude-code", ip: "10.250.20.42" },
      [FIRST.id, SECOND.id],
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.installed).toEqual([FIRST.id, SECOND.id]);
    const guest = Buffer.from(
      (mockedRunScript.mock.calls[0][0] as string).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| ssh/)![1],
      "base64",
    ).toString("utf8");
    expect(guest).toContain('ROOT="$BUX/.claude/skills"');
  });

  it("reports the requested-but-unknown ids as skipped while still installing the valid ones", async () => {
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_BANKR_SKILLS_OK",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "codex", ip: "10.250.20.42" },
      [FIRST.id, "ghost-id"],
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.installed).toEqual([FIRST.id]);
    expect(res.skipped).toContain("ghost-id");
  });

  it("fails (nothing installed) when the SSH write doesn't report the marker", async () => {
    mockedRunScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "connection refused",
      error: "ssh failed",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "codex", ip: "10.250.20.42" },
      [FIRST.id],
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.installed).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it("succeeds trivially (no SSH) when only unknown ids are requested", async () => {
    const res = await installCuratedSkillsOnBox(
      { id: "a", type: "codex", ip: "10.250.20.42" },
      ["ghost-id"],
      {},
    );
    // Nothing installable, but there WAS an unknown id → not a clean no-op.
    expect(res.ok).toBe(false);
    expect(res.installed).toEqual([]);
    expect(res.skipped).toEqual(["ghost-id"]);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });
});
