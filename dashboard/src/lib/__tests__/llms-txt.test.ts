import { buildLlmsTxt, llmsTxtSections, PUBLIC_REPOSITORY_URL } from "../llms-txt";

const LLMS_TXT_SECTIONS = llmsTxtSections("dormant");

const SITE = "https://example.test";

describe("buildLlmsTxt", () => {
  it("opens with the H1 product line and a short description blurb", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.startsWith("# Hivra\n")).toBe(true);
    expect(txt).toMatch(/\n> Hivra \(formerly HermesOS\) gives AI agents computers of their own\./);
  });

  it("renders every section heading and resolves the home link to the bare site URL", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    for (const section of LLMS_TXT_SECTIONS) {
      expect(txt).toContain(`## ${section.heading}`);
    }
    // Home ("/") resolves to the bare site URL, not "https://example.test/".
    expect(txt).toContain(`[Home](${SITE}):`);
    expect(txt).not.toContain(`(${SITE}/)`);
  });

  it("builds absolute SITE_URL-based links for every non-home page", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    for (const section of LLMS_TXT_SECTIONS) {
      for (const link of section.links) {
        if (link.path === "/") continue;
        const expected = link.path.startsWith("https://") ? link.path : `${SITE}${link.path}`;
        expect(txt).toContain(`(${expected})`);
      }
    }
  });

  it("contains only public marketing/docs paths — no auth/api/dashboard surfaces", () => {
    for (const section of LLMS_TXT_SECTIONS) {
      for (const link of section.links) {
        expect(link.path).not.toMatch(/^\/(dashboard|api|sign-in|sign-up|get-started)/);
      }
    }
  });

  it("separates what is available now from preview, coming and proposed work", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain("Available now:");
    expect(txt).toMatch(/In private preview: Windows[^.]*and Omarchy\./);
    expect(txt).toContain("In preview: DeepSeek.");
    expect(txt).toContain("$HIVRA is a proposed new token and does not exist yet.");
    expect(txt).not.toMatch(/one click|Free tier is live/i);
    // No em or en dashes in the public machine-readable map.
    expect(txt).not.toMatch(/[\u2013\u2014]/);
  });

  it("links the papers, the canonical token page, the source and the self-host quickstart", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    for (const path of ["/LITEPAPER.md", "/WHITEPAPER.md", "/TOKENOMICS.md", "/token"]) {
      expect(txt).toContain(`(${SITE}${path})`);
    }
    expect(txt).toContain(`(${PUBLIC_REPOSITORY_URL})`);
    expect(txt).toContain("(https://github.com/ashneil12/hivra/blob/main/docs/self-host/QUICKSTART.md)");
    expect(txt).toContain(`[Why I'm building Hivra](${SITE}/why-hivra): The founder's note`);
    expect(txt).not.toContain("The evolution of HermesOS into Hivra");
  });

  it("ends with a single trailing newline", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.endsWith("\n\n")).toBe(false);
  });
});
