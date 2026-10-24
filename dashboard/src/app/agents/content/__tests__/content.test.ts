import { findBannedClaims } from "@/lib/tools/copy-rules";
import {
  ENTRY_PLAN_SIZE,
  FREE_ACCOUNT_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { AGENT_SEO_ENTRIES, getAgentSeoEntry } from "@/lib/hivra/agent-seo-catalog";
import { modelAccessModes } from "@/lib/launch/model-access";
import { PROFILE_DETAILS } from "@/lib/launch/contracts";
import { AGENT_PAGE_CONTENT, HUB_CONTENT } from "..";
import { agentPageCopy, hubCopy } from "../copy-text";
import { resolveLinks, resolveTarget } from "../links";
import { linkHrefs, parseInline, plainText, slugifyHeading } from "../markup";
import { AI_USAGE_NOTE, REFUND_SENTENCE, STAYS_ON, fill } from "../shared";

describe("inline markup", () => {
  it("parses bold, code and links, and nests code and links inside bold", () => {
    expect(parseInline("Run it in `tmux` now")).toEqual([
      { type: "text", value: "Run it in " },
      { type: "code", value: "tmux" },
      { type: "text", value: " now" },
    ]);
    expect(parseInline("**start inside `tmux`** please")).toEqual([
      {
        type: "bold",
        children: [
          { type: "text", value: "start inside " },
          { type: "code", value: "tmux" },
        ],
      },
      { type: "text", value: " please" },
    ]);
    expect(parseInline("**You can inspect [the source](https://example.com/x).**")).toEqual([
      {
        type: "bold",
        children: [
          { type: "text", value: "You can inspect " },
          { type: "link", label: "the source", href: "https://example.com/x" },
          { type: "text", value: "." },
        ],
      },
    ]);
  });

  it("strips the markup to the words a reader sees, and lists link targets", () => {
    const text = "**Hivra hosts the dashboard;** read the [published terms](/terms) and `tmux` notes.";
    expect(plainText(text)).toBe("Hivra hosts the dashboard; read the published terms and tmux notes.");
    expect(linkHrefs(text)).toEqual(["/terms"]);
    expect(plainText("$9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month")).toBe("$9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month");
  });

  it("makes heading ids the way the contents list links to them", () => {
    expect(slugifyHeading("What can you use it for?")).toBe("what-can-you-use-it-for");
    expect(slugifyHeading("Your agent doesn't need to live on your laptop")).toBe("your-agent-doesnt-need-to-live-on-your-laptop");
    expect(slugifyHeading("Choose an agent")).toBe("choose-an-agent");
  });
});

describe("copy tokens", () => {
  it("fills prices and sizes from billing and fails on an unknown token", () => {
    expect(fill("{entry}")).toBe("$9.99 a month for 2 vCPU and 4 GB of RAM");
    expect(fill("{larger}")).toBe("$19.99 a month for 4 vCPU and 8 GB of RAM");
    expect(fill("{entryCompute} / {largerCompute}")).toBe(`${ENTRY_PLAN_SIZE} / ${LARGER_PLAN_SIZE}`);
    expect(fill("{browserAdd}")).toBe("1 vCPU and 2 GB of RAM");
    expect(() => fill("{nope}")).toThrow(/Unknown copy token/);
  });

  it("keeps the shared sentences the owner approved", () => {
    expect(AI_USAGE_NOTE).toBe("The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.");
    expect(REFUND_SENTENCE).toBe(`There is a ${MONEY_BACK_GUARANTEE}, subject to the [published terms](/terms).`);
    expect(MONEY_BACK_GUARANTEE).toBe("7-day money-back guarantee on card payments");
  });
});

describe("link targets", () => {
  it("maps the md's intended destinations to routes that exist", () => {
    const claude = getAgentSeoEntry("claude-code")!;
    // /launch?agent=claude-code is an intended destination; the page links sign-up with the agent named.
    expect(resolveTarget("deploy", claude)).toBe("/sign-up?agentType=claude-code");
    expect(resolveTarget("deploy")).toBe("/sign-up");
    expect(resolveTarget("pricing")).toBe("/pricing");
    expect(resolveTarget("agents")).toBe("/agents");
    expect(resolveTarget("features")).toBe("/features");
    expect(resolveTarget("directory")).toBe("#choose-an-agent");
    expect(resolveLinks(HUB_CONTENT.closing.links, undefined, "x").map((link) => [link.kind, link.href])).toEqual([
      ["primary", "/sign-up"],
      ["secondary", "/pricing"],
      ["secondary", "/features"],
    ]);
  });
});

const PAGES = AGENT_SEO_ENTRIES.map((entry) => ({ slug: entry.slug, content: AGENT_PAGE_CONTENT[entry.slug] }));
const ALL_COPY: [string, string[]][] = [
  ["hub", hubCopy(HUB_CONTENT)],
  ...PAGES.map(({ slug, content }): [string, string[]] => [slug, agentPageCopy(content)]),
];

describe.each(ALL_COPY)("%s copy", (_name, strings) => {
  it("has no dash, no markup left over, no placeholder and no unfilled token", () => {
    const text = strings.join("\n");
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\*\*|`|\{\w+\}|\[[^\]]*\]/);
    expect(text).not.toMatch(/\bTODO\b|\bTBD\b|lorem|placeholder/i);
    for (const line of strings) expect(line.trim()).toBe(line);
  });

  it("uses British English", () => {
    const text = strings.join("\n");
    expect(text).not.toMatch(/\b(?:color|behavior|favorite|center|organize|optimize|customize|analyze|authorize|synchronize|license|catalog|canceled)(?:s|d|ing)?\b/i);
  });

  it("passes the shared banned-claim rules", () => {
    expect(findBannedClaims(strings.join("\n"))).toEqual([]);
  });

  it("states $19.99 only with its size, and writes prices the way billing does", () => {
    const text = strings.join("\n");
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).filter((line) => line.includes("$19.99"))) {
      expect(sentence).toMatch(/4 vCPU and 8 GB of RAM/);
    }
    // "/month" and "/mo" belong in compact labels; the md's prose price form is "$9.99 a month".
    expect(text).not.toMatch(/\$\d+\.\d\d\/mo(?:nth)?\b.*\bvCPU/);
    expect(text).not.toMatch(/\bannual\b|\bper year\b|\/yr\b|\$79\b|\$149\b/i);
    expect(text).not.toMatch(/\b(?:Starter|Pro|Power) plan\b/);
  });
});

describe("what each page says about AI usage, credits and where the agent runs", () => {
  const copyOf = (slug: string) => agentPageCopy(AGENT_PAGE_CONTENT[slug as keyof typeof AGENT_PAGE_CONTENT]).join("\n");

  it("offers Hivra credits only to agents whose launch accepts them", () => {
    const profileOf = (slug: string) => (slug === "hermes" ? "hermes" : slug) as keyof typeof PROFILE_DETAILS;
    for (const { slug } of PAGES) {
      const mentionsCredits = /Hivra credits/.test(copyOf(slug));
      const accepts = modelAccessModes(profileOf(slug) as never).includes("credits");
      // Claude Code takes its own sign-in only (modelAccessModes), so its page never mentions Hivra credits.
      expect({ slug, mentionsCredits }).toEqual({ slug, mentionsCredits: accepts });
    }
    expect(modelAccessModes("claude-code")).toEqual(["native"]);
    expect(copyOf("claude-code")).toMatch(/does not include or replace your Anthropic subscription/);
  });

  it("says the plan does not include AI usage on every page where a key or sign-in is part of the story", () => {
    for (const slug of ["codex", "hermes", "aeon", "openclaw", "agent-zero"]) expect(copyOf(slug)).toContain(AI_USAGE_NOTE);
    expect(hubCopy(HUB_CONTENT).join("\n")).toContain(AI_USAGE_NOTE);
  });

  it("adds 'subject to the provider's terms' to the Claude and ChatGPT sign-in promises", () => {
    expect(copyOf("claude-code")).toMatch(/subject to the provider's terms/);
    expect(copyOf("codex")).toMatch(/subject to the provider's terms/);
    expect(hubCopy(HUB_CONTENT).join("\n")).toMatch(/subject to the provider's terms/);
  });

  it("matches 'Hermes runs on Hivra Cloud only' to the launch rules", () => {
    expect(PROFILE_DETAILS.hermes.ownServer).toBe(false);
    expect(copyOf("hermes")).toContain("Hermes runs on Hivra Cloud only.");
    // No page claims a free tier, a trial or a no-card start.
    for (const { slug } of PAGES) expect(copyOf(slug)).not.toMatch(/free (?:tier|plan)|trial|no card/i);
  });

  // Owner decision 2026-10-21: a computer Hivra Cloud runs for you is paid, for every agent alike. The old pages
  // said only OpenClaw and Agent Zero "need a paid size" (the retired minPlan floor), which read as if the other
  // agents host for free. Every page now says the one rule; the free-account sentence goes only where a free
  // account can connect a server for that agent (Hermes runs on Hivra Cloud only, so it gets the short rule).
  it("states one paid-computer rule on every agent page and singles out no agent as the paid one", () => {
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE).toBe("Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM.");
    expect(FREE_ACCOUNT_SENTENCE).toBe("A free account works with a computer or server you connect yourself.");
    expect(HOSTED_COMPUTE_NEEDS_PLAN).toBe(`${HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE} ${FREE_ACCOUNT_SENTENCE}`);
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SHORT).toBe("Every Hivra Cloud computer needs a paid plan.");
    for (const { slug } of PAGES) {
      const copy = copyOf(slug);
      const ownServer = PROFILE_DETAILS[slug as keyof typeof PROFILE_DETAILS].ownServer;
      if (ownServer) {
        expect(copy).toContain(HOSTED_COMPUTE_NEEDS_PLAN);
      } else {
        expect(copy).toContain(HOSTED_COMPUTE_NEEDS_PLAN_SHORT);
        expect(copy).not.toContain(FREE_ACCOUNT_SENTENCE);
      }
      expect(copy).not.toMatch(/needs a paid size/);
    }
    expect(hubCopy(HUB_CONTENT).join("\n")).toContain("Every Hivra Cloud computer needs a paid plan, and a paid computer stays available after you close your laptop.");
    expect(hubCopy(HUB_CONTENT).join("\n")).toContain(`Every computer that Hivra Cloud runs for you needs a paid plan, from ${fill("{entry}")}. ${FREE_ACCOUNT_SENTENCE}`);
  });

  it("keeps the Aeon dashboard line to what the code does: it takes an agent place and none of the shared CPU and RAM", () => {
    expect(copyOf("aeon")).toContain("A small dashboard computer that counts as one of your agents but uses none of your plan's shared CPU and RAM.");
    expect(hubCopy(HUB_CONTENT).join("\n")).toContain("The dashboard computer counts as one of your agents but uses none of your plan's shared CPU and RAM.");
    expect(copyOf("aeon")).not.toMatch(/background jobs consum/i);
  });

  // Decision C5: Ash's hero sentences say a computer "stays available" or "stays on", and so does the Codex browser
  // title (reworded 2026-10-21). A headline cannot carry the paid qualifier, but the paragraph around it can, so it
  // ends with the repo-approved sentence.
  it("follows the hero sentences that say a computer stays on with the approved paid-plan sentence", () => {
    expect(STAYS_ON).toBe("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    for (const slug of ["claude-code", "codex", "openclaw"] as const) {
      const hero = plainText(AGENT_PAGE_CONTENT[slug].lead[1]);
      expect(hero).toMatch(/stays (?:on|available)/);
      expect(hero.endsWith(STAYS_ON)).toBe(true);
    }
  });

  it("describes the Telegram tab for Claude Code and never for Codex", () => {
    expect(copyOf("claude-code")).toContain("Telegram tab, under Manage");
    expect(copyOf("codex")).not.toMatch(/Telegram/);
  });
});

describe("the md's own structure", () => {
  it("keeps six questions on most pages and seven where the md has seven", () => {
    expect(Object.fromEntries(PAGES.map(({ slug, content }) => [slug, content.faqs.length]))).toEqual({
      "claude-code": 6,
      codex: 7,
      hermes: 7,
      aeon: 6,
      openclaw: 7,
      "agent-zero": 6,
    });
    for (const { content } of PAGES) {
      expect(new Set(content.faqs.map((faq) => faq.q)).size).toBe(content.faqs.length);
    }
  });

  it("lists the other five agents as related, once each, and never the agent itself", () => {
    for (const { slug, content } of PAGES) {
      expect(content.related.slugs).toHaveLength(5);
      expect(new Set(content.related.slugs).size).toBe(5);
      expect(content.related.slugs).not.toContain(slug);
    }
    expect(AGENT_PAGE_CONTENT.aeon.related.heading).toBe("More to explore");
  });

  it("pins the headings the md gives each page", () => {
    expect(Object.fromEntries(PAGES.map(({ slug, content }) => [slug, content.h1]))).toEqual({
      "claude-code": "Your Claude Code workspace shouldn't close with your laptop.",
      codex: "Codex, with a computer you can come back to.",
      hermes: "A place for your Hermes agent to live.",
      aeon: "Give Aeon a schedule. Let your GitHub do the work.",
      openclaw: "OpenClaw, on call even when you're not online.",
      "agent-zero": "Give Agent Zero a computer of its own.",
    });
    expect(Object.fromEntries(PAGES.map(({ slug, content }) => [slug, content.closing.heading]))).toEqual({
      "claude-code": "Put the laptop away. Leave the computer running.",
      codex: "Keep the repository moving.",
      hermes: "Give Hermes a home, then let it grow with the work.",
      aeon: "Set the routine once. Get on with your day.",
      openclaw: "Message your agent. It can handle the rest of its schedule.",
      "agent-zero": "Give the agent room to work, without giving it your whole machine.",
    });
    // The button labels of the opening and the closing rows, as the md writes them.
    expect(Object.fromEntries(PAGES.map(({ slug, content }) => [slug, content.heroLinks.map((link) => link.label)]))).toEqual({
      "claude-code": ["Deploy Claude Code", "View pricing"],
      codex: ["Deploy Codex", "See pricing"],
      hermes: ["Deploy Hermes", "See pricing"],
      aeon: ["Deploy Aeon", "See pricing"],
      openclaw: ["Deploy OpenClaw", "See pricing"],
      "agent-zero": ["Deploy Agent Zero", "See pricing"],
    });
    expect(Object.fromEntries(PAGES.map(({ slug, content }) => [slug, content.closing.links.map((link) => link.label)]))).toEqual({
      "claude-code": ["Deploy Claude Code", "See pricing", "Explore all agents"],
      codex: ["Deploy Codex", "View pricing", "See all agents"],
      hermes: ["Deploy Hermes", "Explore plans", "See other agents"],
      aeon: ["Deploy Aeon", "See plans", "Explore other agents"],
      openclaw: ["Deploy OpenClaw", "View pricing", "Explore all agents"],
      "agent-zero": ["Deploy Agent Zero", "See pricing", "Compare agents"],
    });
    expect(HUB_CONTENT.heroLinks.map((link) => link.label)).toEqual(["Explore agents", "See pricing"]);
    expect(HUB_CONTENT.closing.links.map((link) => link.label)).toEqual(["Start now", "Compare plans", "Explore Hivra features"]);
    expect(HUB_CONTENT.h1).toBe("Pick your agent. We'll give it a computer.");
    expect(HUB_CONTENT.directory.cards.map((card) => card.name)).toEqual(["Claude Code", "Codex", "Hermes", "Aeon", "OpenClaw", "Agent Zero"]);
  });

  it("has four numbered steps on every agent page", () => {
    for (const { content } of PAGES) {
      const steps = content.sections.flatMap((section) => section.blocks).filter((block) => block.kind === "steps");
      expect(steps).toHaveLength(1);
      expect(steps[0].kind === "steps" && steps[0].steps).toHaveLength(4);
      for (const step of steps[0].kind === "steps" ? steps[0].steps : []) expect(step.title).not.toMatch(/^\d/);
    }
  });

  it("links only to routes the app has: terms, the repository, and the targets above", () => {
    const hrefs = [
      ...hubCopyMarkup(),
      ...PAGES.flatMap(({ content }) => pageMarkup(content)),
    ].flatMap(linkHrefs);
    expect([...new Set(hrefs)].sort()).toEqual(["/terms", "https://github.com/ashneil12/hivra"]);
  });
});

function pageMarkup(content: (typeof PAGES)[number]["content"]): string[] {
  return [
    ...content.lead,
    ...content.sections.flatMap((section) =>
      section.blocks.flatMap((block) => {
        switch (block.kind) {
          case "prose":
            return block.paragraphs;
          case "terms":
            return block.items.flatMap((item) => [item.term, item.text]);
          case "list":
            return block.items;
          case "steps":
            return block.steps.flatMap((step) => step.paragraphs);
        }
      }),
    ),
    ...content.faqs.map((faq) => faq.a),
  ];
}

function hubCopyMarkup(): string[] {
  return [
    ...HUB_CONTENT.lead,
    ...HUB_CONTENT.intro.paragraphs,
    ...HUB_CONTENT.intro.topics.flatMap((topic) => topic.paragraphs),
    ...HUB_CONTENT.directory.cards.map((card) => card.body),
    ...HUB_CONTENT.choose.paragraphs,
    ...HUB_CONTENT.boundaries.items.flatMap((item) => [item.term, item.text]),
    HUB_CONTENT.closing.paragraph,
  ];
}
