import fs from "fs";
import path from "path";

import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  PLAN_SUMMARY,
} from "@/lib/blog/plan-facts";
import {
  CLI_RUN_LIFETIME,
  SERVER_SIDE_AGENTS_KEEP_WORKING,
  falseCliRunClaims,
  unknownDashboardNames,
} from "@/lib/blog/runtime-facts";
import { resizeFloor } from "@/lib/hivra/agent-catalog";
import { PLANS } from "@/lib/subscription/plans";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";

// Blog copy is rendered on the page and shipped as FAQPage JSON-LD, so a false
// product claim here reaches search engines as structured data.

function articleCopy(article: (typeof BLOG_ARTICLES_LIST)[number]): string {
  return [
    article.title,
    article.metaTitle ?? "",
    article.metaDescription,
    article.tagline,
    article.intro,
    article.shortAnswer ?? "",
    ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    ...article.faqs.flatMap(({ q, a }) => [q, a]),
  ].join("\n");
}

import {
  hivraSentences,
  BANNED_ANYWHERE,
  BANNED_ABOUT_HIVRA,
  hostsVendorCli,
  bareYesHivraLaptopRows,
  bannedAnywhere,
  hivraTablePricesWithoutSize,
  bannedAboutHivra,
} from "@/lib/blog/claim-rules";

// Copy the blog carried before the 2026-09-24 review. Each must still be
// caught, so a loosened pattern cannot let the old claims back in unnoticed.
const KNOWN_FALSE_ANYWHERE = [
  "- **A machine that stays on.** The VM stays up on a paid plan. No tmux required, though the terminal tab is right there if you want it.",
  "The agent stalls until the usage window resets, then continues; the session and the box stay alive.",
  "The agents are the official unmodified runtimes, so Claude Code or Hermes behave exactly as they would on your own box.",
  "- Is it the official CLI, unmodified, not a fork or a wrapper?",
  "The comparison in this article assumes the managed platform runs the same software you would install yourself.",
  "Plans start at $9.99/month, and every paid plan comes with a 7-day money-back guarantee.",
  "Hivra does not claim a built-in Telegram connection for Claude Code.",
  // The keep-running copy the 24/7 posts carried before the 2026.09.24.1
  // runtime. Each says a browser run stops with its tab, which is false on
  // updated computers.
  "On Hivra the computer stays on and keeps your files, sessions and login. A Claude Code or Codex run you start in the browser chat or the agent terminal stops when you close that tab.",
  "For Claude Code and Codex, start long runs from the agent's Telegram tab or inside tmux, because a run started in the browser chat stops when you close that tab.",
  "A managed box stays up, but on Hivra a run started in the browser chat or the agent terminal still stops when you close that tab; start long runs inside tmux in the Box Terminal.",
  "| Keeps running with the laptop closed | Yes, inside tmux | Yes for runs started from Telegram or inside tmux; a browser chat run stops with its tab |",
  // The opposite promise, false on computers without the runtime update.
  "A run you start in the browser chat keeps going after you close the tab.",
  // The retired survives-anything claims.
  "Survives laptop sleep: Yes",
  "Close your laptop. It keeps working.",
];
const KNOWN_FALSE_ABOUT_HIVRA = [
  "Hivra fills that gap by handling server provisioning, Docker configuration, networking, SSL termination, monitoring, and backups.",
  "Hivra deploys a fully configured Hermes instance in one click, without any of the steps below.",
  "Sign up to Hivra and the gap between wanting it and having it goes from hours to minutes.",
  "On Hivra you can download an agent's chats and memory as one JSON file.",
];
const KNOWN_FALSE_TABLES = [
  "| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Survives laptop sleep | Yes | Yes |",
  "| Option | Cash per month | Survives laptop sleep |\n|---|---|---|\n| Managed (Hivra) | From $9.99 | Yes |",
];
const KNOWN_TRUE_ABOUT_HIVRA = [
  "Hivra restarts the agent if it crashes; backups are not guaranteed.",
  "On Hivra, Claude Code and Codex agents also have an Export data link that downloads chats plus memory as one JSON file.",
  "| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Keeps running with the laptop closed | Yes, inside tmux | Yes, inside tmux in the Terminal tab or sent through Telegram |",
  CLI_RUN_LIFETIME,
  SERVER_SIDE_AGENTS_KEEP_WORKING,
];

// Copy the 2026-09-30 review found in the blog. Each must be caught.
const KNOWN_FALSE_2026_09_30 = [
  "Daily encrypted backups cover all three layers.",
  "In the Hivra dashboard, set the schedule using natural language or cron format.",
  "Hivra runs the official CLIs, unmodified, and you sign in with the account you already have.",
  "Both run on Hivra as the official, unmodified CLIs.",
  "For Hivra managed hosting, data is stored but never used to train models and never shared.",
  "Hivra adds zero markup on AI usage either way.",
  "Hivra starts at $9.99/month with no server to manage.",
  "Hivra runs both open-source projects unmodified.",
];
const KNOWN_TRUE_2026_09_30 = [
  "Hivra plans start at $9.99 a month for 2 vCPU and 4 GB of RAM.",
  "On your own Anthropic or OpenAI login, usage bills through that provider with no Hivra markup.",
  "Hivra does not mark up AI usage on your own subscription or API key.",
  "Hivra runs the official CLIs, and you sign in with the account you already have.",
  "| Platform fee | $0 | $9.99/mo (2 vCPU and 4 GB of RAM) or $19.99/mo (4 vCPU and 8 GB of RAM) |",
];

// Posts that pitch Hivra for keeping Claude Code or Codex running. Each must
// carry the one true statement of which runs survive a closed laptop: only what
// holds on every computer, old runtime or new.
const CLI_24_7_POSTS = [
  "claude-max-vs-pro-for-claude-code",
  "keep-claude-code-running-24-7",
  "run-codex-24-7-in-the-cloud",
  "claude-code-vs-codex-24-7",
  "ai-agent-hosting-guide",
  "ai-agent-dies-terminal-closes-fixes",
  "run-ai-agents-24-7",
  "claude-code-remote-control",
];

describe("blog claims", () => {
  it("catches every claim these posts used to make, and leaves true copy alone", () => {
    for (const claim of KNOWN_FALSE_ANYWHERE) expect(bannedAnywhere(claim)).not.toEqual([]);
    for (const claim of KNOWN_FALSE_ABOUT_HIVRA) expect(bannedAboutHivra(claim)).not.toEqual([]);
    for (const table of KNOWN_FALSE_TABLES) expect(bareYesHivraLaptopRows(table)).not.toEqual([]);
    for (const copy of KNOWN_TRUE_ABOUT_HIVRA) {
      expect(bannedAnywhere(copy)).toEqual([]);
      expect(bannedAboutHivra(copy)).toEqual([]);
      expect(bareYesHivraLaptopRows(copy)).toEqual([]);
    }
    expect(bannedAnywhere(`Paid plans come with a ${MONEY_BACK_GUARANTEE}.`)).toEqual([]);
    for (const claim of KNOWN_FALSE_2026_09_30) expect(bannedAnywhere(claim).concat(bannedAboutHivra(claim))).not.toEqual([]);
    expect(hivraTablePricesWithoutSize("| | Self-hosted | Hivra |\n|---|---|---|\n| Platform fee | $0 | $9.99/mo or $19.99/mo |")).not.toEqual([]);
    expect(
      hivraTablePricesWithoutSize("| | Self-hosted | Hivra |\n|---|---|---|\n| Platform fee | $0 | $9.99/mo (2 vCPU and 4 GB of RAM) |")
    ).toEqual([]);
    for (const copy of KNOWN_TRUE_2026_09_30) {
      expect(bannedAnywhere(copy)).toEqual([]);
      expect(bannedAboutHivra(copy)).toEqual([]);
    }
  });

  it("states no banned claim anywhere in any article", () => {
    const found: string[] = [];
    for (const article of BLOG_ARTICLES_LIST) {
      const copy = articleCopy(article);
      for (const [label, pattern] of BANNED_ANYWHERE) {
        if (pattern.test(copy)) found.push(`${article.slug}: ${label}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("makes no banned plan, speed or availability claim in sentences about Hivra", () => {
    const found: string[] = [];
    for (const article of BLOG_ARTICLES_LIST) {
      for (const sentence of hivraSentences(articleCopy(article))) {
        for (const [label, pattern] of BANNED_ABOUT_HIVRA) {
          if (pattern.test(sentence)) found.push(`${article.slug}: ${label}: ${sentence.slice(0, 160)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("quotes only the prices checkout sells when it prices Hivra", () => {
    const allowed = new Set([ENTRY_PLAN_PRICE, LARGER_PLAN_PRICE]);
    const found: string[] = [];
    for (const article of BLOG_ARTICLES_LIST) {
      for (const sentence of hivraSentences(articleCopy(article))) {
        // Only prices stated after "Hivra" in the sentence price Hivra itself;
        // earlier ones are the DIY side of a comparison.
        const aboutHivra = sentence.slice(Math.max(0, sentence.search(/\bHivra\b/)));
        for (const [price] of aboutHivra.matchAll(/\$\d+(?:\.\d{2})?(?=\/mo| a month|\/month| plan)/g)) {
          if (!allowed.has(price)) found.push(`${article.slug}: ${price}: ${sentence.slice(0, 160)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("derives the plan facts from checkout, and they match the public price ladder", () => {
    expect(ENTRY_PLAN_PRICE).toBe(`$${(PLANS.operator.price / 100).toFixed(2)}`);
    expect(LARGER_PLAN_PRICE).toBe(`$${(PLANS.fleet.price / 100).toFixed(2)}`);
    expect(ENTRY_PLAN_SIZE).toBe(`${PLANS.operator.totalCpu} vCPU and ${PLANS.operator.totalRam / 1024} GB of RAM`);
    expect(LARGER_PLAN_SIZE).toBe(`${PLANS.fleet.totalCpu} vCPU and ${PLANS.fleet.totalRam / 1024} GB of RAM`);

    // The blog names plans by price and size because checkout's names collide
    // with the homepage ladder. That only works while price and size agree.
    const [starter, pro] = HOSTED_MACHINES;
    expect(starter.price).toBe(ENTRY_PLAN_PRICE);
    expect(`${starter.cpu} vCPU and ${starter.ram} of RAM`).toBe(ENTRY_PLAN_SIZE);
    expect(pro.price).toBe(LARGER_PLAN_PRICE);
    expect(`${pro.cpu} vCPU and ${pro.ram} of RAM`).toBe(LARGER_PLAN_SIZE);

    expect(PLAN_SUMMARY).toContain(ENTRY_PLAN_PRICE);
    expect(PLAN_SUMMARY).toContain(MONEY_BACK_GUARANTEE);
  });

  it("states the money-back guarantee for card payments only, and the checkout screen names the same 7-day guarantee", () => {
    const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n.ts"), "utf8");
    expect(MONEY_BACK_GUARANTEE).toBe("7-day money-back guarantee on card payments");
    // This used to assert the full sentence in i18n.ts, but only the retired
    // landing-page pricing block carried it (deleted with that block, which no
    // component read). The live checkout step (getStarted) says "7-day
    // money-back guarantee" without the card limit: an open owner decision, not
    // something this test should pin either way.
    expect(i18n).toContain("7-day money-back guarantee");
  });

  it("never marks a Hivra table cell as surviving a closed laptop with a bare yes", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      bareYesHivraLaptopRows(articleCopy(article)).map((row) => `${article.slug}: ${row}`)
    );
    expect(found).toEqual([]);
  });

  it("says which Claude Code and Codex runs keep going after the laptop closes, on every 24/7 post", () => {
    for (const slug of CLI_24_7_POSTS) {
      const article = BLOG_ARTICLES_LIST.find((candidate) => candidate.slug === slug);
      expect(article).toBeDefined();
      expect(articleCopy(article!)).toContain(CLI_RUN_LIFETIME);
    }
    expect(CLI_RUN_LIFETIME).toMatch(/On a paid Hivra plan the computer stays on and keeps your files, sessions and login/);
    expect(CLI_RUN_LIFETIME).toMatch(/run you start inside tmux in the computer's Terminal tab keeps going after you close the laptop/);
    // Telegram is only verified for Claude Code (bux-tg); never promise it for Codex.
    expect(CLI_RUN_LIFETIME).toMatch(/On Claude Code, work you send through Telegram, connected in the agent's Telegram tab, runs on the computer, not in your browser/);
    expect(CLI_RUN_LIFETIME).not.toMatch(/Codex[^.]*Telegram/);
    // Browser chat and session-tab runs depend on the computer's runtime
    // version, so the statement says nothing about them either way.
    expect(CLI_RUN_LIFETIME).not.toMatch(/browser chat|agent terminal|stops|Box Terminal|\bbox\b/i);
    expect(falseCliRunClaims(CLI_RUN_LIFETIME)).toEqual([]);
    expect(SERVER_SIDE_AGENTS_KEEP_WORKING).not.toMatch(/Claude Code|Codex/);
    // Aeon's scheduled work runs on the owner's GitHub Actions, not on the computer.
    expect(SERVER_SIDE_AGENTS_KEEP_WORKING).toMatch(/Aeon's scheduled tasks run on your own GitHub Actions while the computer hosts its dashboard/);
  });

  // The glossary says "computer" for what Hivra runs an agent on. Generic
  // server talk ("a 2 vCPU box at a budget host") is fine; a sentence about
  // Hivra itself may not call its computer a box or an instance.
  it("never calls a Hivra computer a box or an instance in any article", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      hivraSentences(articleCopy(article))
        .filter((sentence) => /(?<!text )\bbox(?:es)?\b|\binstances?\b/i.test(sentence))
        .map((sentence) => `${article.slug}: ${sentence.slice(0, 160)}`),
    );
    expect(found).toEqual([]);
  });

  it("uses the computer vocabulary and the dashboard's own tab names on the 24/7 and Telegram posts", () => {
    for (const slug of [...CLI_24_7_POSTS, "control-claude-code-from-telegram"]) {
      const copy = articleCopy(BLOG_ARTICLES_LIST.find((candidate) => candidate.slug === slug)!);
      // "box" for the computer (a UI text box is fine).
      expect({ slug, box: copy.match(/Box Terminal|(?<!text )\bbox(?:es)?\b/gi) }).toEqual({ slug, box: null });
      expect({ slug, runtime: copy.match(/\b(?:runtimes?|instances?)\b/gi) }).toEqual({ slug, runtime: null });
      expect({ slug, unknown: unknownDashboardNames(copy) }).toEqual({ slug, unknown: [] });
    }
    // The checker itself: the retired tab name fails, the real ones pass.
    expect(unknownDashboardNames("Start it inside tmux in the Box Terminal tab.")).toEqual(["Box Terminal tab"]);
    expect(unknownDashboardNames("Open the Codex Terminal tab.")).toEqual(["Codex Terminal tab"]);
    expect(unknownDashboardNames("Use the computer's Terminal tab, under Computer, or the Telegram tab under Manage.")).toEqual([]);
    expect(unknownDashboardNames("Open the Claude Code session tab or the agent's Manage tab.")).toEqual([]);
  });

  it("matches the Agent Zero plus OpenClaw plan claim to the launch floors", () => {
    const agentZero = resizeFloor("agent-zero", false);
    const openclawOff = resizeFloor("openclaw", false);
    const openclawOn = resizeFloor("openclaw", true);
    const pool = (plan: { totalCpu: number; totalRam: number }) => ({ cpu: plan.totalCpu, ram: plan.totalRam / 1024 });
    const fits = (a: { cpu: number; ram: number }, b: { cpu: number; ram: number }, plan: { cpu: number; ram: number }) =>
      a.cpu + b.cpu <= plan.cpu && a.ram + b.ram <= plan.ram;
    // Both fit the entry plan with OpenClaw's browser off, but not with it on.
    expect(fits(agentZero, openclawOff, pool(PLANS.operator))).toBe(true);
    expect(fits(agentZero, openclawOn, pool(PLANS.operator))).toBe(false);
    expect(fits(agentZero, openclawOn, pool(PLANS.fleet))).toBe(true);

    const article = BLOG_ARTICLES_LIST.find((candidate) => candidate.slug === "agent-zero-vs-openclaw-hosting");
    const copy = articleCopy(article!);
    expect(copy).toContain(`Both fit on the ${ENTRY_PLAN_PRICE} plan at their minimum size, with OpenClaw's browser off`);
    expect(copy).toContain(
      `Agent Zero at ${agentZero.cpu} vCPU and ${agentZero.ram} GB plus OpenClaw at ${openclawOff.cpu} vCPU and ${openclawOff.ram} GB`
    );
    expect(copy).not.toMatch(/Running both side by side takes the/);
  });

  it("no longer imports the retired card-trial helper", () => {
    const articlesDir = path.join(__dirname, "..", "articles");
    for (const file of fs.readdirSync(articlesDir)) {
      expect(fs.readFileSync(path.join(articlesDir, file), "utf8")).not.toContain("trial-claim");
    }
    expect(fs.existsSync(path.join(__dirname, "..", "trial-claim.ts"))).toBe(false);
  });

  it("states a plan size beside every Hivra price in a table", () => {
    const found = BLOG_ARTICLES_LIST.flatMap((article) =>
      hivraTablePricesWithoutSize(articleCopy(article)).map((row) => `${article.slug}: ${row.slice(0, 160)}`)
    );
    expect(found).toEqual([]);
  });

  it("carries a non-affiliation line on every post that says Hivra runs Claude Code or Codex", () => {
    const missing = BLOG_ARTICLES_LIST.filter(
      (article) => hostsVendorCli(articleCopy(article)) && !/not affiliated with/i.test(articleCopy(article))
    ).map((article) => article.slug);
    expect(missing).toEqual([]);
  });

  it("keeps a non-affiliation line on the posts that host a vendor's agent", () => {
    const expectations: Record<string, RegExp> = {
      "keep-claude-code-running-24-7": /not affiliated with Anthropic/,
      "run-codex-24-7-in-the-cloud": /not affiliated with OpenAI/,
      "claude-code-vs-codex-24-7": /not affiliated with Anthropic or OpenAI/,
      "control-claude-code-from-telegram": /not affiliated with Anthropic/,
      "claude-code-remote-control": /not affiliated with Anthropic or OpenAI/,
      "openclaw-broken-after-update": /not affiliated with the OpenClaw project/,
      "agent-zero-vs-openclaw-hosting": /not affiliated with or endorsed by either project/,
    };
    for (const [slug, pattern] of Object.entries(expectations)) {
      const article = BLOG_ARTICLES_LIST.find((candidate) => candidate.slug === slug);
      expect(article).toBeDefined();
      expect(articleCopy(article!)).toMatch(pattern);
    }
  });
});
