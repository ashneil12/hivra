import { buildLlmsTxt, LLMS_TXT_SECTIONS } from "../llms-txt";

const SITE = "https://example.test";

describe("buildLlmsTxt", () => {
  it("opens with the H1 product line and a short description blurb", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.startsWith("# Hivra\n")).toBe(true);
    expect(txt).toMatch(/\n> Hivra \(formerly HermesOS\) is managed cloud hosting/);
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
        expect(txt).toContain(`(${SITE}${link.path})`);
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

  it("ends with a single trailing newline", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.endsWith("\n\n")).toBe(false);
  });
});
