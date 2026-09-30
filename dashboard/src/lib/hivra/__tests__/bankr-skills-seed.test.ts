import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

import {
  bankrSkillSlug,
  bankrSkillsDirForType,
  buildBankrSkillsGuestScript,
  buildBankrSkillsHostScript,
  collectBankrSkillFiles,
  seedBankrSkillsOntoBox,
  type BankrSkillFile,
} from "../bankr-skills-seed";
import { skillFrontmatterProblem } from "../skill-file";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  __esModule: true,
  runProxmoxHostScript: jest.fn(),
}));

const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;

describe("bankrSkillsDirForType", () => {
  it("maps CLI agent types to their per-CLI skills dir", () => {
    expect(bankrSkillsDirForType("claude-code")).toBe(".claude/skills");
    // Codex uses the OpenAI skills spec dir, NOT ~/.codex/skills.
    expect(bankrSkillsDirForType("codex")).toBe(".agents/skills");
  });

  it("returns null for out-of-scope / unknown agent types", () => {
    expect(bankrSkillsDirForType("aeon")).toBeNull();
    expect(bankrSkillsDirForType("hermes")).toBeNull();
    expect(bankrSkillsDirForType(null)).toBeNull();
    expect(bankrSkillsDirForType(undefined)).toBeNull();
  });
});

describe("bankrSkillSlug", () => {
  it("strips the catalog prefix and is filesystem-safe", () => {
    expect(bankrSkillSlug("BankrBot/skills/0xwork")).toBe("0xwork");
  });

  it("disambiguates skills that share a leaf name", () => {
    const a = bankrSkillSlug("BankrBot/skills/bankr-twitter-agent");
    const b = bankrSkillSlug("BankrBot/skills/skills/bankr-twitter-agent");
    expect(a).not.toBe(b);
    expect(b).toBe("skills-bankr-twitter-agent");
  });
});

describe("collectBankrSkillFiles", () => {
  const files = collectBankrSkillFiles();

  it("collects vendored Bankr skills", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("only includes non-empty content", () => {
    expect(files.every((f) => f.content.trim().length > 0)).toBe(true);
  });

  it("produces unique slugs (no on-disk collisions)", () => {
    const slugs = files.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("writes only SKILL.md files Codex can load", () => {
    const problems = files
      .map((f) => ({ slug: f.slug, problem: skillFrontmatterProblem(f.content) }))
      .filter((result) => result.problem !== null);
    expect(problems).toEqual([]);
  });

  it("seeds one twitter-agent skill, not upstream's nested copy", () => {
    const slugs = files.map((f) => f.slug);
    expect(slugs).toContain("bankr-twitter-agent");
    expect(slugs).not.toContain("skills-bankr-twitter-agent");
  });
});

describe("buildBankrSkillsGuestScript", () => {
  const files: BankrSkillFile[] = [
    { slug: "alpha", content: "# Alpha\nbody" },
    { slug: "beta", content: "# Beta\nbody with 'single quotes' inside" },
  ];
  const script = buildBankrSkillsGuestScript(".agents/skills", files);

  it("writes under the given per-CLI dir", () => {
    expect(script).toContain('ROOT="$BUX/.agents/skills"');
  });

  it("writes a SKILL.md per skill into its slug dir", () => {
    expect(script).toContain('mkdir -p "$ROOT/alpha"');
    expect(script).toContain('> "$ROOT/alpha/SKILL.md"');
    expect(script).toContain('mkdir -p "$ROOT/beta"');
    expect(script).toContain('> "$ROOT/beta/SKILL.md"');
  });

  it("base64-wraps content so no markdown (even with quotes) reaches the shell", () => {
    // base64 alphabet has no single quotes, so embedding it inside single quotes is safe.
    const betaB64 = Buffer.from(files[1].content, "utf8").toString("base64");
    expect(betaB64).not.toContain("'");
    expect(script).toContain(`printf '%s' '${betaB64}' | base64 -d`);
  });

  it("emits the success marker the caller greps for", () => {
    expect(script.trim().endsWith("echo HIVRA_BANKR_SKILLS_OK")).toBe(true);
  });
});

describe("buildBankrSkillsHostScript", () => {
  const host = buildBankrSkillsHostScript("10.250.20.42", "echo hi");

  it("uses the provisioner's host->guest key", () => {
    expect(host).toContain("KEY=/etc/hivra/keys/vm-orchestrator");
  });

  it("streams the payload over stdin (not as an ssh argv) to avoid ARG_MAX", () => {
    // The large suite must not be inlined into the inner ssh command.
    expect(host).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| ssh /);
    expect(host).toContain('"base64 -d | sudo bash"');
    expect(host).not.toMatch(/ssh [^|]*"echo /);
  });
});

describe("seedBankrSkillsOntoBox", () => {
  beforeEach(() => mockedRunScript.mockReset());

  it("skips unsupported agent types without touching SSH", async () => {
    const res = await seedBankrSkillsOntoBox({ id: "a", type: "aeon", ip: "10.240.0.1" }, {});
    expect(res).toEqual({ ok: false, count: 0, skipped: "unsupported_type" });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid box ip", async () => {
    const res = await seedBankrSkillsOntoBox({ id: "a", type: "codex", ip: "" }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ip/i);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("returns ok with a count when the box reports the success marker", async () => {
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_BANKR_SKILLS_OK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const res = await seedBankrSkillsOntoBox({ id: "a", type: "claude-code", ip: "10.250.20.42" }, {});
    expect(res.ok).toBe(true);
    expect(res.count).toBeGreaterThan(0);
    expect(mockedRunScript).toHaveBeenCalledTimes(1);
  });

  it("reports failure when the success marker is absent", async () => {
    mockedRunScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "boom",
      error: "ssh failed",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const res = await seedBankrSkillsOntoBox({ id: "a", type: "codex", ip: "10.250.20.42" }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
