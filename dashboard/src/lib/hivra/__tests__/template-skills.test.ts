// A small fixture catalog so resolveTemplateSkillIds is deterministic and
// decoupled from the real (evolving) curated catalog.
jest.mock("@/data/curated-skills", () => ({
  CURATED_SKILLS: [
    { id: "sec-1pw", name: "1Password", identifier: "official/security/1password", category: "security", content: "BODY" },
    { id: "aliased", name: "Quotient", installedAs: "quotient-api", identifier: "x/quotient", category: "dev", content: "BODY" },
    { id: "bankr-x", name: "Bankr X", identifier: "BankrBot/skills/x", category: "bankr", content: "BODY" },
    { id: "no-content", name: "Pointer Only", identifier: "x/pointer", category: "dev" },
    { id: "empty-content", name: "Empty", identifier: "x/empty", category: "dev", content: "   " },
  ],
}));

import {
  resolveTemplateSkillIds,
  coerceSkillIds,
  snapshotInstalledTemplateSkillIds,
} from "../template-skills";

describe("resolveTemplateSkillIds", () => {
  it("maps an installed skill name to its catalog id (normalized match)", () => {
    expect(resolveTemplateSkillIds([{ name: "1password" }])).toEqual(["sec-1pw"]);
    // casing / spacing / hyphen drift all normalize to the same token.
    expect(resolveTemplateSkillIds([{ name: "1 Password" }])).toEqual(["sec-1pw"]);
  });

  it("matches via the installedAs alias when the frontmatter name differs", () => {
    expect(resolveTemplateSkillIds([{ name: "quotient-api" }])).toEqual(["aliased"]);
  });

  it("excludes Bankr-category skills (auto-seeded on every box)", () => {
    expect(resolveTemplateSkillIds([{ name: "Bankr X" }])).toEqual([]);
  });

  it("excludes content-free / empty-content catalog entries (not re-seedable)", () => {
    expect(resolveTemplateSkillIds([{ name: "Pointer Only" }, { name: "Empty" }])).toEqual([]);
  });

  it("returns only the installed, eligible ids from a mixed list", () => {
    const ids = resolveTemplateSkillIds([
      { name: "1Password" },
      { name: "quotient-api" },
      { name: "Bankr X" },
      { name: "Pointer Only" },
      { name: "totally-unknown" },
    ]);
    expect(ids.sort()).toEqual(["aliased", "sec-1pw"]);
  });

  it("returns [] for no installed skills", () => {
    expect(resolveTemplateSkillIds([])).toEqual([]);
  });
});

describe("coerceSkillIds", () => {
  it("returns [] for non-array / null / undefined", () => {
    expect(coerceSkillIds(null)).toEqual([]);
    expect(coerceSkillIds(undefined)).toEqual([]);
    expect(coerceSkillIds("nope")).toEqual([]);
    expect(coerceSkillIds({})).toEqual([]);
  });

  it("trims, drops empties + non-strings, and de-dupes preserving order", () => {
    expect(coerceSkillIds([" a ", "b", "a", "", 5, null, "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("snapshotInstalledTemplateSkillIds", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns [] without fetching when the box url is empty", async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    expect(await snapshotInstalledTemplateSkillIds("", "tok")).toEqual([]);
    expect(await snapshotInstalledTemplateSkillIds(null, null)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads /api/skills (Bearer when a token is present) and resolves to ids", async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [{ name: "1Password" }, { name: "Bankr X" }] }),
    });
    global.fetch = spy as unknown as typeof fetch;
    const ids = await snapshotInstalledTemplateSkillIds("https://box.example/", "tok-123");
    expect(ids).toEqual(["sec-1pw"]); // bankr excluded
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe("https://box.example/api/skills"); // trailing slash stripped
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when there's no token (legacy open box)", async () => {
    const spy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ skills: [] }) });
    global.fetch = spy as unknown as typeof fetch;
    await snapshotInstalledTemplateSkillIds("https://box.example", null);
    const opts = spy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("returns [] on a non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await snapshotInstalledTemplateSkillIds("https://box.example", "t")).toEqual([]);
  });

  it("returns [] (never throws) on a transport error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    expect(await snapshotInstalledTemplateSkillIds("https://box.example", "t")).toEqual([]);
  });
});
