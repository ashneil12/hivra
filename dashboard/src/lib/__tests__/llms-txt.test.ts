import { COMPUTER_ROADMAP } from "@/app/ecosystem/ecosystem-content";
import { PRICING_INTRO } from "@/app/pricing/pricing-content";
import { HOSTED_COMPUTE_NEEDS_PLAN, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { ECOSYSTEM_STAGES } from "@/lib/ecosystem-map";
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

  it("separates what is available now from conditional, preview, coming and proposed work", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    expect(txt).toContain("Available now on Hivra Cloud:");
    // Omarchy and Windows are never listed as plainly available. The code runs Omarchy as a
    // prepared computer and refuses a launch when no prepared slot exists, and Windows runs on
    // the user's own Proxmox host from their own licensed ISO, so each carries its condition
    // (the homepage, About and the home JSON-LD use the same two phrases).
    expect(txt).toContain(
      "Also offered, with conditions: Omarchy (prepared computer), and Windows on your own server with your licensed image (your own Proxmox host and your own licensed ISO).",
    );
    expect(txt).not.toMatch(/Also available|Windows and Omarchy are available/i);
    expect(txt).not.toMatch(/private preview/i);
    // DeepSeek stays "In preview" here: it is true (the product catalogue keeps DeepSeek Harness in
    // private preview and not launchable) and /why-hivra/evolution groups it under "In preview" too.
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
    // The retired sentence listed Hermes among agents that launch "on Hivra Cloud
    // or your own cloud account or server".
    expect(txt).not.toMatch(/your own cloud account/i);
    expect(txt).toContain("self-host the platform on your own server");
  });

  // Owner decision, 21 October 2026: Hivra runs no free computer. The map used to say only
  // "OpenClaw and Agent Zero need a paid size", which told a reader that Claude Code, Codex,
  // Hermes, Aeon and an Ubuntu computer were launchable on Hivra Cloud without paying. It now says
  // once, in the canonical words, that every computer Hivra Cloud runs is paid, and what a free
  // account is for. The price and size are built from the plan constants, not typed.
  it("says every computer Hivra Cloud runs is paid and what a free account works with, and singles out no agent", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    const rule =
      "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.";
    expect(txt).toContain(rule);
    expect(HOSTED_COMPUTE_NEEDS_PLAN).toBe(rule);
    // The pricing page states the same two sentences, so the map and the page cannot disagree.
    expect(PRICING_INTRO).toContain(rule);
    // It sits in the "Available now on Hivra Cloud" paragraph, before the Hermes limit.
    expect(txt).toContain(`${rule} Hermes runs on Hivra Cloud only.`);
    expect(txt.split(rule)).toHaveLength(2);
    expect(txt).not.toMatch(/\bneed a paid (?:size|plan)\b/i);
    expect(txt).not.toMatch(/OpenClaw and Agent Zero need/);
    // The /pricing note carries the short form.
    const pricing = LLMS_TXT_SECTIONS.flatMap((section) => section.links).find((link) => link.path === "/pricing");
    expect(pricing?.note).toContain(
      "Every Hivra Cloud computer needs a paid plan, and a free account works with a computer or server you connect yourself",
    );
    // No free hosted computer, trial or starter credit is offered anywhere in the map.
    expect(txt).not.toMatch(/free (?:hosted|computer|tier|plan)|free trial|starter credit|promo/i);
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

  it("says what is coming next in the ecosystem page's own words, so the two cannot disagree", () => {
    const txt = buildLlmsTxt({ siteUrl: SITE });
    // The four products the page puts under "Next", read from the same module.
    const next = ECOSYSTEM_STAGES.find((stage) => stage.id === "next")!.products.map((product) => product.name);
    expect(next).toEqual(["Gate", "Exchange", "Arena", "Signal"]);
    expect(txt).toContain("Coming next, planned and not yet available: Gate, Exchange, Arena and Signal on the ecosystem map.");
    // The page says "we intend to explore an Orchestrator, additional computer images including macOS where
    // technically and legally feasible, and custom images": llms.txt says the same, not that they are coming.
    expect(COMPUTER_ROADMAP.paragraph).toContain("we intend to explore an **Orchestrator**");
    expect(txt).toContain(
      "We also intend to explore an Orchestrator, macOS computers where technically and legally feasible, and custom images.",
    );
    expect(txt).not.toMatch(/Coming next: Hivra Orchestrator/);
  });

  it("describes the rewritten pages by what they now say", () => {
    const notes = new Map(LLMS_TXT_SECTIONS.flatMap((section) => section.links).map((link) => [link.path, link.note ?? ""]));
    expect(notes.get("/pricing")).toContain(`with a ${MONEY_BACK_GUARANTEE}. The plan does not include AI usage`);
    expect(notes.get("/ecosystem")).toMatch(/available now, what is planned next and then, and what is still research/);
    expect(notes.get("/why-hivra")).toMatch(/^The founder's note on why AI agents need separate computers/);
    expect(notes.get("/security")).toContain("which versions receive fixes");
    expect(notes.get("/roadmap")).toContain("what is planned next");
    expect(notes.get("/stats")).toContain("dated count of the agents and computers launched on Hivra");
    expect(notes.get("/changelog")).toContain("Not a promise of future features");
    // Never a plan name, a trial, a free hosted plan or a funding word in a note.
    for (const [path, note] of notes) {
      expect([path, note]).toEqual([path, note.replace(/\b(Starter|Power)\b|free trial|no card required|funded|funding/gi, "")]);
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

describe("buildLlmsTxt while the new token surfaces are off", () => {
  it("names no token, ticker, snapshot, airdrop, litepaper or Bankr anywhere, in any phase", () => {
    for (const phase of ["dormant", "scheduled", "active"] as const) {
      const txt = buildLlmsTxt({ siteUrl: SITE, phase, tokenSurfaces: false });
      expect(txt).not.toMatch(/\$HIVRA|\$HermesOS|tokenomics|snapshot|airdrop|litepaper|whitepaper|\bBankr\b|claim/i);
      expect(txt).not.toContain("## Papers");
      expect(txt).not.toMatch(/[\u2013\u2014]/);
    }
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
