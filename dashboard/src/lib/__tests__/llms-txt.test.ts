import { NON_AFFILIATION_LINE, SITE_DESCRIPTION } from "../brand-description";
import { buildLlmsTxt, llmsTxtSections, PUBLIC_REPOSITORY_URL } from "../llms-txt";

const LLMS_TXT_SECTIONS = llmsTxtSections("dormant");

const SITE = "https://example.test";

describe("buildLlmsTxt", () => {
  it("opens with the H1 product line and a short description blurb", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.startsWith("# Hivra\n")).toBe(true);
    // The owner's one-line description, word for word (2026-09-30).
    expect(txt).toContain(`\n> ${SITE_DESCRIPTION}\n`);
    expect(SITE_DESCRIPTION).toBe(
      "Hivra (hivra.cloud, formerly HermesOS) is an open-source computer for you and your AI agents, on Hivra Cloud or your own server.",
    );
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
    expect(txt).toContain("Available now on Hivra Cloud:");
    // Windows and Omarchy are listed as available, with the real Windows condition,
    // because the homepage, its meta description and the roadmap say so (owner copy
    // 2026-09-28, commit 2f7fdcea 2026-09-30; truth table row "Ubuntu, Windows and
    // Omarchy computers"). llms.txt must not contradict them.
    expect(txt).toMatch(/Also available: Windows \(on your own Proxmox host, from your own licensed ISO\) and Omarchy\./);
    expect(txt).not.toMatch(/private preview/i);
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

  it("links the free tools hub and the keep-awake builder and tmux cheat sheet with their own notes", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain(`[Free tools](${SITE}/tools): Keep-awake commands, a tmux cheat sheet,`);
    expect(txt).toContain(`[Keep a Mac awake (caffeinate)](${SITE}/tools/keep-mac-awake): Builds the caffeinate (macOS) or systemd-inhibit (Linux) command`);
    expect(txt).toContain(`[tmux cheat sheet](${SITE}/tools/tmux-cheat-sheet): tmux commands and keys with copy buttons`);
  });

  it("says Hermes is Hivra Cloud only and never implies it runs on your own cloud account or server", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain("Hermes runs on Hivra Cloud only.");
    expect(txt).toContain("OpenClaw and Agent Zero need a paid plan.");
    // The retired sentence listed Hermes among agents that launch "on Hivra Cloud
    // or your own cloud account or server".
    expect(txt).not.toMatch(/your own cloud account/i);
    expect(txt).toContain("self-host the platform on your own server");
  });

  it("states plans by price and size, never per computer, and drops the multi-agent promise", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain(
      "Self-host free, or Hivra Cloud at $9.99 a month for 2 vCPU and 4 GB of RAM or $19.99 a month for 4 vCPU and 8 GB of RAM",
    );
    expect(txt).not.toMatch(/computer from \$/i);
    expect(txt).not.toMatch(/multi-agent/i);
    expect(txt).toContain("several agents on one account");
  });

  it("carries the independence line and the public entry points an answer engine needs", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain(`\n${NON_AFFILIATION_LINE}\n`);
    for (const path of ["/agents", "/pricing", "/tools", "/compare"]) {
      expect(txt).toContain(`(${SITE}${path})`);
    }
  });

  it("describes /about by what it covers without implying who funds Hivra", () => {
    const about = LLMS_TXT_SECTIONS.flatMap((section) => section.links).find((link) => link.path === "/about");
    expect(about?.note).toContain("what it costs");
    expect(about?.note).not.toMatch(/paid for|funded|funding/i);
  });

  it("uses the glossary: agents and computers, never boxes, runtimes or instances", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).not.toMatch(/\b(box|boxes|runtime|runtimes|instance|instances)\b/i);
  });

  it("ends with a single trailing newline", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.endsWith("\n\n")).toBe(false);
  });
});

describe("buildLlmsTxt for a viewer the token geo-policy blocks", () => {
  // The project's own token words (docs/litepaper/restrict.py).
  const TOKEN_WORDS = /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b/i;
  const PHASES = ["dormant", "scheduled", "active"] as const;

  it.each(PHASES)("has no token word, sentence or link in the %s phase", (phase) => {
    const txt = buildLlmsTxt({ siteUrl: SITE, phase, restricted: true });
    expect(txt).not.toMatch(TOKEN_WORDS);
    expect(txt).not.toContain("/TOKENOMICS.md");
    expect(txt).not.toContain(`(${SITE}/token)`);
    // The unrestricted copy has them, so the check is not empty.
    expect(buildLlmsTxt({ siteUrl: SITE, phase })).toMatch(TOKEN_WORDS);
  });

  it("is the same map with only the token lines gone", () => {
    const full = buildLlmsTxt({ siteUrl: SITE }).split("\n");
    const restricted = buildLlmsTxt({ siteUrl: SITE, restricted: true }).split("\n");
    const removed = full.filter((line) => !restricted.includes(line));
    // The two paragraphs that end on a token aside, and the two token links.
    expect(removed).toHaveLength(4);
    expect(removed.filter((line) => line.startsWith("- [")).map((line) => line.split("]")[0])).toEqual(["- [Tokenomics", "- [Token"]);
    // Nothing is added: every restricted line but the two reworded paragraphs is in the full map.
    const added = restricted.filter((line) => !full.includes(line));
    expect(added).toHaveLength(2);
    for (const line of added) expect(line).not.toMatch(TOKEN_WORDS);
  });

  it("keeps the papers that are rewritten to token-free copies for this viewer, and every other section", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE, restricted: true });
    for (const path of ["/LITEPAPER.md", "/WHITEPAPER.md", "/agents", "/pricing", "/roadmap", "/privacy"]) {
      expect(txt).toContain(`(${SITE}${path})`);
    }
    for (const section of llmsTxtSections("dormant", { restricted: true })) {
      expect(txt).toContain(`## ${section.heading}`);
    }
    expect(txt).toContain("self-host the platform on your own server, with no Hivra account.");
    expect(txt).not.toMatch(/[–—]/);
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.endsWith("\n\n")).toBe(false);
  });
});
