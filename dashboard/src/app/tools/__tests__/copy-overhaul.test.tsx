/** @jest-environment jsdom */
// The copy overhaul of 2026-10-20 for /tools and its six tool pages: the wording the owner supplied
// (batch 05) is pinned here, page by page, together with the places where the repo's own rules
// required a different sentence. Behaviour of the tools is covered by the component tests.
import "@testing-library/jest-dom";
import React from "react";
import { render, within } from "@testing-library/react";

import ToolsIndexPage, { metadata as hubMetadata } from "../page";
import ToolPage, { generateMetadata } from "../[slug]/page";
import { MONEY_BACK_GUARANTEE, formatPlanSize, PLAN_DISPLAY } from "@/lib/blog/plan-facts";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { modelAccessModes } from "@/lib/launch/model-access";
import { HETZNER_LIMITED_NOTE, TOOLS_CLOSING, TOOLS_HUB, TOOL_ENTRIES } from "@/lib/tools/tool-catalog";

jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="public-site">{children}</div>,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("next/image", () => {
  const MockImage = ({ src, alt, width, height, className }: { src: string; alt: string; width: number; height: number; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image in jsdom
    <img src={src} alt={alt} width={width} height={height} className={className} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

// Browser titles and search descriptions exactly as the copy gives them (batch 05 headers).
const MD_META: Record<string, { title: string; description: string }> = {
  tools: {
    title: "Free Tools for Running AI Agents | Hivra",
    description:
      "Free tools for people who run AI agents: keep-awake commands, a tmux cheat sheet, Claude plan and limit calculators, a survival check and hosting costs.",
  },
  "agent-survival-check": {
    title: "Keep Claude Code Running 24/7: Agent Survival Check | Hivra",
    description:
      "Answer a few questions about your setup and find out if Claude Code keeps running when you close your laptop. Covers sleep, SSH drops, tmux and reboots.",
  },
  "ai-agent-hosting-cost-calculator": {
    title: "AI Agent Hosting Cost Calculator: VPS vs Managed | Hivra",
    description:
      "Work out what running an AI agent 24/7 costs on a VPS you manage versus a managed computer. It counts your time as well as the server bill.",
  },
  "claude-code-limit-reset-calculator": {
    title: "When Does Claude Code Usage Limit Reset? Calculator | Hivra",
    description:
      "Enter your first prompt time and see when your Claude Code five-hour window reopens. Plus why waiting five hours never clears the weekly limit.",
  },
  "claude-code-plan-calculator": {
    title: "Claude Code Plan Calculator: Pro vs Max | Hivra",
    description:
      "Estimate your Claude Code usage and see which Anthropic plan fits: Pro at $20, Max 5x at $100, or Max 20x at $200 a month. With an API cost comparison.",
  },
  "keep-mac-awake": {
    title: "Caffeinate Mac: Keep Your Mac Awake, Command Builder | Hivra",
    description:
      "Build the exact caffeinate command to keep a Mac awake while Claude Code or Codex runs, with the Linux version and a list of what it can't cover.",
  },
  "tmux-cheat-sheet": {
    title: "tmux Cheat Sheet: Commands and Keys for AI Agents | Hivra",
    description:
      "A tmux cheat sheet with copy buttons: sessions, windows, panes, detach and attach, copy mode and logging, plus commands for AI coding agents.",
  },
};

function metaValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const text = (container: HTMLElement) => container.textContent ?? "";

/** Words that belong to the owner's notes to the implementer, never to a page. */
const LEAKS = /Example results|original tool|Editorial and implementation|\[(?:link|button|field)\]|\[(?:Link|Button):|before publishing|Check the current pricing/i;

describe("browser titles, descriptions and social titles come from the copy", () => {
  it("gives /tools the finished title and the same string to Open Graph and Twitter", () => {
    expect(hubMetadata.title).toEqual({ absolute: MD_META.tools.title });
    expect(hubMetadata.description).toBe(MD_META.tools.description);
    expect(metaValue(hubMetadata.openGraph, "title")).toBe(MD_META.tools.title);
    expect(metaValue(hubMetadata.twitter, "title")).toBe(MD_META.tools.title);
  });

  it.each(TOOL_ENTRIES)("$slug", async (entry) => {
    const expected = MD_META[entry.slug];
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    expect(metadata.title).toEqual({ absolute: expected.title });
    expect(metadata.description).toBe(expected.description);
    expect(metaValue(metadata.openGraph, "title")).toBe(expected.title);
    expect(metaValue(metadata.openGraph, "description")).toBe(expected.description);
    expect(metaValue(metadata.twitter, "title")).toBe(expected.title);
    // The base title still fits before the brand, and the finished one is exactly that plus the brand.
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.browserTitle.length).toBeLessThanOrEqual(60);
  });
});

describe("the closing block is the same on every page and follows the repo's wording", () => {
  const sentences = [
    `If you want the computer to stay on after you leave your desk, Hivra offers a managed computer starting at ${formatPlanSize("entry")}.`,
    `A paid ${PLAN_DISPLAY.entry} computer stays on and is not paused for inactivity.`,
    "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
    // Claude Code takes only the owner's own sign-in (lib/launch/model-access.ts), and every page can end in a Run Claude
    // Code on Hivra button, so the "or pay with Hivra credits" above is followed by the one case where it does not hold.
    "Claude Code uses your own Anthropic sign-in, not Hivra credits.",
  ];

  it("builds the price and size from the plan facts and keeps the owner's approved sentences", () => {
    expect(TOOLS_CLOSING.offer).toBe(sentences[0]);
    expect(TOOLS_CLOSING.offer).toBe(
      "If you want the computer to stay on after you leave your desk, Hivra offers a managed computer starting at $9.99 a month for 2 vCPU and 4 GB of RAM.",
    );
    expect(TOOLS_CLOSING.staysOn).toBe("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(TOOLS_CLOSING.aiUsage).toBe(sentences[2]);
    expect(TOOLS_CLOSING.claudeCodeSignIn).toBe(sentences[3]);
    expect(TOOLS_CLOSING.guarantee).toBe(MONEY_BACK_GUARANTEE);
  });

  // The extra sentence is true only while the launch offers Claude Code no credits; this fails if that changes.
  it("says Claude Code takes no Hivra credits only because its launch offers none", () => {
    expect(modelAccessModes("claude-code")).toEqual(["native"]);
    for (const profile of ["codex", "hermes"] as const) expect(modelAccessModes(profile)).toContain("credits");
  });

  const closing = (container: HTMLElement) => within(container).getByRole("region", { name: "Get started" });

  it("renders on /tools under the heading 'Computers that stay on.'", () => {
    const { container } = render(<ToolsIndexPage />);
    const block = closing(container);
    expect(within(block).getByRole("heading", { level: 2, name: "Computers that stay on." })).toBeInTheDocument();
    for (const sentence of sentences) expect(block).toHaveTextContent(sentence);
    const guarantee = within(block).getByRole("link", { name: MONEY_BACK_GUARANTEE });
    expect(guarantee).toHaveAttribute("href", "/terms");
    expect(block).toHaveTextContent(`There is a ${MONEY_BACK_GUARANTEE}.`);
    expect(within(block).getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/sign-up");
    expect(within(block).getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "/pricing");
    expect(text(block)).not.toMatch(/seven-day|eligible|at checkout|\(2 vCPU, 4 GB\)|supported model account/i);
    expect(text(container)).not.toMatch(LEAKS);
  });

  it.each(TOOL_ENTRIES)("renders on $slug under 'When you need a computer that stays on'", async (entry) => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const block = closing(container);
    expect(within(block).getByRole("heading", { level: 2, name: "When you need a computer that stays on" })).toBeInTheDocument();
    for (const sentence of sentences) expect(block).toHaveTextContent(sentence);
    expect(within(block).getByRole("link", { name: MONEY_BACK_GUARANTEE })).toHaveAttribute("href", "/terms");
    expect(text(block)).not.toMatch(/seven-day|eligible|at checkout|\(2 vCPU, 4 GB\)|supported model account/i);
    expect(findBannedClaims(text(block))).toEqual([]);
    // The word "keep running" is a run-level claim; the block makes none, so nothing here needs a tmux qualifier.
    expect(unqualifiedKeepRunningClaims(text(block), /Hivra|managed|always-on/i)).toEqual([]);
    expect(text(container)).not.toMatch(LEAKS);
  });
});

describe("/tools", () => {
  it("opens with the owner's H1, two paragraphs and the heading for the directory", () => {
    const { container } = render(<ToolsIndexPage />);
    const h1 = container.querySelector("h1") as HTMLElement;
    expect(h1).toHaveTextContent("Free tools for people building with AI agents");
    expect(text(container)).toContain("Free. No signup.");

    const intro = Array.from(container.querySelectorAll("header p")).map((p) => p.textContent);
    expect(intro).toEqual([
      "Running an agent often means solving problems that have little to do with AI. Your laptop sleeps halfway through a task. Your Claude usage limit arrives sooner than expected. A cheap server turns into a maintenance chore. Or you simply forget which tmux command gets you back into yesterday's session.",
      "We built these free tools to make those decisions easier. They are practical, independent checks you can use without creating an account. Each calculator tells you what it assumes, and each command builder tells you what it cannot fix. Sometimes the sensible answer is to keep using the machine you already have. That is fine by us.",
    ]);
    // "cannot" is italic in the copy.
    expect(container.querySelector("header em")).toHaveTextContent("cannot");

    expect(within(container).getByRole("heading", { level: 2, name: TOOLS_HUB.directoryHeading })).toBeInTheDocument();
    expect(TOOLS_HUB.directoryHeading).toBe("Pick the problem you are trying to solve");
    const names = within(container).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(names).toEqual([
      "Claude Code Plan Calculator",
      "Agent Survival Check",
      "AI Agent Hosting Cost Calculator",
      "Claude Code Limit Reset Calculator",
      "Keep Mac Awake Command Builder",
      "tmux Cheat Sheet for AI Coding Agents",
    ]);
    expect(findBannedClaims(text(container))).toEqual([]);
  });

  it("keeps the See also links", () => {
    const { container } = render(<ToolsIndexPage />);
    const related = within(container).getByRole("heading", { name: "See also:" }).parentElement as HTMLElement;
    expect(within(related).getByRole("link", { name: /Hivra pricing/ })).toHaveAttribute("href", "/pricing");
    expect(within(related).getByRole("link", { name: /Run Claude Code on Hivra/ })).toHaveAttribute("href", "/agents/claude-code");
  });
});

// The words above each tool, as the owner supplied them. `note` is the callout; marks are removed.
interface MdIntro {
  h1: string;
  lede: string;
  body: string[];
  note?: string;
}

const MD_INTRO: Record<string, MdIntro> = {
  "agent-survival-check": {
    h1: "Will your agent still be running tomorrow morning?",
    lede: "A long-running agent is only as reliable as the computer and terminal session underneath it. Claude Code can be midway through a job when your laptop sleeps, your SSH connection drops or the server restarts. Having the right model does not help when its process has stopped.",
    body: [
      "Use this check to describe where your agent runs, how you keep its session alive and what happens when something fails. You will get a practical risk assessment and an ordered list of fixes. It is not a live health monitor, and its score is not a prediction of uptime. If an ordinary VPS with tmux and a restart service solves your problem, we will tell you that rather than pretending you need managed hosting.",
    ],
  },
  "ai-agent-hosting-cost-calculator": {
    h1: "What does it really cost to keep an AI agent running?",
    lede: "A five-dollar server sounds hard to beat. It often is, particularly if you are comfortable maintaining Linux and already have a machine online. But the invoice from your hosting provider is not always the whole cost. Installation, updates, backups, troubleshooting and the odd late-night restart take time too.",
    body: [
      "This calculator lets you compare a VPS you manage with a managed Hivra computer over twelve months. You choose the server, put a value on your time and decide whether backups and other extras belong in the comparison. You can also set your time cost to zero. The result should help you decide, not simply point you towards Hivra.",
    ],
    note: "The model bill is separate in both cases. Neither a VPS nor Hivra's hosting plan includes unlimited Claude, Codex or API inference. We also do not quietly bundle backups into Hivra's entry-level price when they are not included.",
  },
  "claude-code-limit-reset-calculator": {
    h1: "When will Claude Code let you work again?",
    lede: "A Claude Code limit can arrive in the middle of an otherwise productive session. You remember when you started, but not necessarily when the window ends, and the message about weekly usage can look deceptively similar.",
    body: [
      "Put in the time of your first message and this calculator will show a possible end to your five-hour session window on your own clock. If you know your weekly reset, you can add that separately. The important distinction is that waiting five hours does not clear a weekly allowance.",
    ],
    note: "Anthropic's own usage screen and the reset time in Claude Code remain authoritative. This tool estimates timing from an explicitly stated first-message assumption; it cannot see your account or grant additional usage.",
  },
  "claude-code-plan-calculator": {
    h1: "Which Claude Code plan makes sense for your work?",
    lede: "If you use Claude Code every day, it is tempting to move straight from Pro to the most expensive Max plan. But paying for more headroom only makes sense if the allowance is the thing slowing you down.",
    body: [
      "Tell the calculator how often you work, which models you use and, most importantly, roughly when Pro stops you during a five-hour session. It will compare Pro, Max 5x and Max 20x using the published session multipliers, then show an indicative API cost for the same workload.",
    ],
    note: "There is an important limit to the result: Anthropic does not publish a universal message or token allowance that makes the exact fit predictable. The plan verdicts are estimates based on your own experience, not promises that you will stay under a particular limit. Weekly limits are a separate problem and are not given a made-up multiplier.",
  },
  "keep-mac-awake": {
    h1: "Keep your Mac awake while an agent works",
    lede: "If you are running Claude Code, Codex or another CLI agent locally, your Mac going to sleep can interrupt the job. macOS already includes a small tool called caffeinate that can help, and in many cases it is all you need.",
    body: [
      "Choose your operating system, whether you are plugged in, what you want to run and how long you need it awake. The builder will give you a command you can copy, a way to check it and an explanation of its limits.",
    ],
    note: "The crucial catch: keeping a computer awake is not the same as keeping an agent reliable. It will not prevent reboots, recover from a failed tool call or guarantee that a MacBook stays running with its lid closed. This page tells you where those boundaries are instead of promising an overnight run it cannot deliver.",
  },
  "tmux-cheat-sheet": {
    h1: "tmux commands worth keeping nearby",
    lede: "You do not need to learn every corner of tmux to make it useful. Start a named session, run your agent, detach, then return later from another terminal or device. That handful of commands solves one of the most irritating problems with long-running CLI work: losing the terminal that was holding everything together.",
    body: [
      "This reference covers sessions, windows, panes, copy mode, logging and a few practical setups for Claude Code and Codex. The commands are here to copy, not memorise. We also explain the underlying behaviour, because tmux protects you from terminal disconnects, not from a sleeping computer, a reboot or an agent crash.",
    ],
    note: "In the key combinations below, Ctrl-b d means press Ctrl and b together, release them, then press d. Ctrl-b is the default tmux prefix.",
  },
};

describe.each(Object.entries(MD_INTRO))("/tools/%s opens with the owner's words", (slug, md) => {
  it("has the owner's H1, lede, body and note, and none of the old introduction", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(md.h1);

    const lede = container.querySelector("header p");
    expect(lede?.textContent).toBe(md.lede);

    const intro = container.querySelector("main > header")!.nextElementSibling as HTMLElement;
    const body = Array.from(intro.querySelectorAll("p"));
    expect(body.map((p) => p.textContent)).toEqual([...md.body, ...(md.note ? [md.note] : [])]);
    if (md.note) expect(container.querySelector('aside[role="note"]')).toHaveTextContent(md.note);
    else expect(container.querySelector('aside[role="note"]')).toBeNull();

    // The one-line card text from /tools is not repeated on the tool's own page.
    const entry = TOOL_ENTRIES.find((candidate) => candidate.slug === slug)!;
    expect(text(container)).not.toContain(entry.subhead);
    expect(text(container)).not.toMatch(LEAKS);
  });
});

// Places where the wording is not the owner's, because a repo rule or the 2026-10-20 audit required
// it. Each one is listed in the lane's ledger as a deviation.
describe("/tools/agent-survival-check wording the audit and the repo rules changed", () => {
  it("uses British spelling in the label, qualifies the sign-in promises and does not promise the unit restarts a crash", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "agent-survival-check" }) }));
    const page = text(container);
    expect(page).toContain("Laptop sleep behaviour");
    expect(page).not.toMatch(/behavior/);

    // Both sign-in promises (the bridge under the tool and the FAQ answer) carry the provider's terms.
    // (The FAQ answer is also in the page's structured data, so count what is visible.)
    const visible = Array.from(container.querySelectorAll("p")).map((p) => p.textContent).join("\n");
    const signIns = visible.match(/with your own (?:Anthropic )?sign-in \(subject to the provider's terms\)/g) ?? [];
    expect(signIns).toHaveLength(2);
    expect(page).not.toMatch(/with your own (?:Anthropic )?sign-in[,.]/);

    // A tmux session whose last window closes ends the tmux server with exit code 0, which Restart=on-failure
    // never restarts, and that is the crash the card describes. The unit says Restart=always, the page says what
    // the unit is set to do and asks the reader to test it.
    expect(page).toContain("is set to restart it on failure");
    // The test kills the tmux session, which is the crash; `systemctl stop` is the one way to end the unit, so
    // the page names both and does not tell the reader to stop the agent "on purpose" and expect it back.
    expect(page).toContain(
      "Test it once: run tmux kill-session -t agent, wait ten seconds, then run tmux ls to check a new session is back. To stop the agent for good, run sudo systemctl stop agent.",
    );
    expect(page).not.toContain("by stopping the agent on purpose");
    expect(page).not.toMatch(/detached tmux session and restarts it on failure/);
    expect(page).toContain("Restart=always");
    expect(page).not.toContain("Restart=on-failure");
  });

  it("spells data centre the British way", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "agent-survival-check" }) }));
    const page = text(container);
    expect(page).toContain("Wired or data centre");
    expect(page).not.toMatch(/datacenter/i);
  });
});

describe("/tools/ai-agent-hosting-cost-calculator wording the repo rules changed", () => {
  it("no longer says your own login is the only way to pay for the model", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "ai-agent-hosting-cost-calculator" }) }));
    const visible = Array.from(container.querySelectorAll("p, summary + p")).map((p) => p.textContent).join("\n");
    const aiUsage = "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";

    // The bridge under the tool, the assumptions and the FAQ answer all say it the owner's way.
    expect(visible.split(aiUsage).length - 1).toBeGreaterThanOrEqual(2);
    expect(visible).toContain("Model usage bills separately on all three.");
    expect(visible).toContain("On Hivra the plan does not include AI usage either: bring your own account or key where the agent supports it, or pay with Hivra credits.");
    expect(visible).toContain("If you sign in with your own Claude or ChatGPT account, that is subject to the provider's terms.");
    expect(visible).not.toMatch(/your own model login|you bring your own Claude or ChatGPT login or API key either way|through your own account on all three/);

    // The live verdict is what the calculator computes, not the sample sentence in the owner's draft.
    expect(visible).toMatch(/The server was never the cost\. At \$50\/hour, your hours are \$1,950 of the \$2,035 DIY total\./);
    expect(visible).not.toContain("In this example");
  });

  it("gives the Hetzner CX23 price in the FAQ with the same limited-supply note as the preset hint", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "ai-agent-hosting-cost-calculator" }) }));
    const visible = Array.from(container.querySelectorAll("p, summary + p")).map((p) => p.textContent).join("\n");
    const note = "Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look.";

    // One copy under the default CX23 preset and one in the FAQ answer (the same answer feeds the FAQ markup).
    expect(HETZNER_LIMITED_NOTE).toBe(note);
    expect(visible.split(note).length - 1).toBeGreaterThanOrEqual(2);
    expect(visible).toContain(`plus $0.60 for its IPv4 address, before tax. ${note} DigitalOcean and Vultr list`);
  });
});

describe("/tools/claude-code-limit-reset-calculator wording the repo rules changed", () => {
  it("italicises 'possible', spells behaviour the British way, keeps the plain privacy sentence and qualifies the sign-in promise", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "claude-code-limit-reset-calculator" }) }));
    const page = text(container);
    expect(container.querySelector("em")).toHaveTextContent("possible");
    expect(page).not.toMatch(/behavior/);
    expect(page).toContain("the widely reported behaviour: the first message of a session opens the window");
    // The owner's draft asked for a check ("verify that no analytics or backend calls receive these values").
    // The tool makes no network call and keeps no URL state, so the page says so plainly.
    expect(page).toContain("Nothing you enter leaves your browser.");
    expect(page).not.toMatch(/designed to calculate in your browser|verify that no analytics/);
    expect(page).toContain("with your own Anthropic login (subject to the provider's terms), and paid plans are not paused for inactivity.");
  });
});

describe("/tools/claude-code-plan-calculator wording the repo rules changed", () => {
  it("qualifies the promise to put your own Claude login on a Hivra computer, and leaves the calculator's figures alone", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "claude-code-plan-calculator" }) }));
    const page = text(container);
    expect(page).toContain(
      "Put the same Claude login on an always-on computer (subject to the provider's terms), start long runs inside tmux or from Telegram, and the hours you pay for keep working after you close the laptop.",
    );
    // The figures come from lib/tools/claude-plan-facts.ts, dated September 2026, and are not changed by the copy.
    // The API rates were read again in October 2026: Sonnet 5.5's cache read is $0.10 and the Haiku row is Haiku 5.5.
    expect(page).toContain("Sonnet 5.5 is $2, $10, $0.10 and $2.50.");
    expect(page).toContain("Last checked September 2026.");
    expect(page).toContain("The API rates were checked against Anthropic's pricing table again in October 2026.");
    expect(page).toContain("Haiku 5.5 ($0.10 and $0.50 for prompts up to 100,000 tokens, $0.50 and $2.50 above that)");
    expect(page).not.toMatch(/Haiku 4\.5/);
    // The paragraph that prints the Haiku prices cites the pricing table they come from.
    const haikuParagraph = TOOL_ENTRIES.find((entry) => entry.slug === "claude-code-plan-calculator")
      ?.method?.paragraphs.find((paragraph) => paragraph.text.includes("Haiku 5.5"));
    expect(haikuParagraph?.sources?.map((source) => source.url)).toContain(
      "https://platform.claude.com/docs/en/about-claude/pricing",
    );
    expect(page).toMatch(/\$376\/month/);
    // A normal three-hour day is $8.69 on Sonnet 5.5 and $17.39 on Opus 5.5, so the page no longer calls it close to $13.
    expect(page).toContain("A normal three-hour day comes to about $8.69 on Sonnet 5.5 and $17.39 on Opus 5.5, either side of Anthropic's $13 enterprise average.");
    expect(page).toContain("With our assumptions, a normal three-hour day comes to about $8.69 on Sonnet 5.5 and $17.39 on Opus 5.5, either side of that average");
    expect(page).not.toMatch(/close to Anthropic's \$13|close to that average/);
    // The worked examples that rest on Sonnet 5.5 follow the calculator: $12.55 and $452, not $19.42 and $534.
    expect(page).toContain("API list price, estimated: $12.55/mo");
    expect(page).toContain("API list price, estimated: $452/mo");
    expect(page).not.toMatch(/19\.42|\$534|13\.46/);
    // No token surface exists on this page, whatever the switch says.
    expect(page).not.toMatch(/\$HIVRA|\$HermesOS|Bankr|litepaper|airdrop|snapshot/i);
  });
});

describe("/tools/keep-mac-awake wording the repo rules changed", () => {
  it("sets caffeinate in code, states the browser sentence plainly and hedges the laptop-is-enough line the way the owner wrote it", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "keep-mac-awake" }) }));
    const page = text(container);
    expect(container.querySelector("header p code")).toHaveTextContent("caffeinate");

    // The owner's draft asked for a check ("check the deployed implementation before making this privacy claim").
    // No tool component calls the network, and a share link carries only the structured answers, so the hint says that.
    expect(page).toContain("What you type stays in your browser. A share link carries only your answers, and claude or codex.");
    expect(page).not.toMatch(/designed to work in your browser|check the deployed implementation/);

    const cta = within(container).getByTestId("kma-cta");
    expect(cta).toHaveTextContent(
      "For a run you can supervise, a plugged-in laptop with this command may be enough. It costs nothing. The limits below still apply. Check the whole setup with the agent survival check.",
    );
    expect(within(cta).getByRole("link", { name: "Check the whole setup with the agent survival check" })).toHaveAttribute(
      "href",
      "/tools/agent-survival-check",
    );
  });
});

describe("/tools/tmux-cheat-sheet introduction", () => {
  it("opens with the key legend in code and does not repeat it inside the sheet", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug: "tmux-cheat-sheet" }) }));
    const note = container.querySelector('aside[role="note"]') as HTMLElement;
    const codes = Array.from(note.querySelectorAll("code")).map((code) => code.textContent);
    expect(codes).toEqual(["Ctrl-b d", "Ctrl-b"]);
    // It used to be a small note inside the tool; the legend is now said once, before the keys.
    expect(text(container).split("press Ctrl and b together").length - 1).toBe(1);
    expect(container.querySelector("#tool")).not.toHaveTextContent("In the key combinations below");
    // The command builder's session-name field shows the agent's name as its placeholder.
    expect(container.querySelector("#tmux-session")).toHaveAttribute("placeholder", "claude");
  });
});
