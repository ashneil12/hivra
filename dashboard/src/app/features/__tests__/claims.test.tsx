/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import type { Metadata } from "next";

import FeaturesPage, { metadata as featuresMetadata } from "../page";
import FeaturePage, { generateMetadata, generateStaticParams } from "../[slug]/page";
import { ENTRY_PLAN_SIZE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { falseCliRunClaims } from "@/lib/blog/runtime-facts";
import {
  KNOWN_FALSE_CLAIMS,
  KNOWN_TRUE_CLAIMS,
  MAX_META_DESCRIPTION_LENGTH,
  findBannedClaims,
  metadataCopy,
  metadataDescriptions,
  renderedCopy,
} from "./public-claims";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({
  __esModule: true,
  default: () => <nav aria-label="Article contents" />,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const SLUGS = generateStaticParams().map(({ slug }) => slug);

/** What each page must carry, written out from the supplied copy (20 October 2026), not read from the page's own data. */
const COPY: Record<string, { title: string; description: string; eyebrow?: string; h1: string; faqs: number; related: string[] }> = {
  "persistent-memory": {
    title: "Persistent Memory for AI Agents | Hivra",
    description: "Keep a Hermes agent's user notes, task history and reusable skills on a persistent cloud computer, with files you can inspect and export.",
    eyebrow: "Persistent Memory",
    h1: "Pick up where you left off",
    faqs: 7,
    related: ["/features/multi-agent", "/features/scheduled-tasks", "/features/browser-automation"],
  },
  "browser-automation": {
    title: "AI Agent Browser Automation | Hivra",
    description: "Give a Hermes agent a persistent cloud browser for research, forms and website workflows, without keeping your laptop switched on.",
    eyebrow: "Browser Automation",
    h1: "An actual browser for your AI agent",
    faqs: 5,
    related: ["/features/persistent-memory", "/features/scheduled-tasks", "/features/no-docker-hosting"],
  },
  "multi-agent": {
    title: "Host Multiple AI Agents on Hivra",
    description: "Run multiple AI agents on managed cloud computers, with separate memory and tools and a shared hosting resource allowance.",
    eyebrow: "Multiple AI Agents",
    h1: "Separate jobs, one Hivra account",
    faqs: 6,
    related: ["/features/persistent-memory", "/features/scheduled-tasks", "/features/browser-automation"],
  },
  "no-docker-hosting": {
    title: "Host AI Agents Without Docker or VPS Setup | Hivra",
    description: "Deploy Hermes and other supported AI agents on managed cloud computers without maintaining Docker, SSL certificates or your own VPS.",
    h1: "AI Agent Hosting Without Docker",
    faqs: 6,
    related: ["/features/openclaw-alternative", "/features/multi-agent", "/features/persistent-memory"],
  },
  "openclaw-alternative": {
    title: "Managed OpenClaw Hosting and Hermes Alternative | Hivra",
    description: "Host OpenClaw on Hivra or explore Hermes. Keep familiar agent workflows on a persistent cloud computer without managing your own VPS.",
    eyebrow: "OpenClaw on Hivra",
    h1: "Keep the agent, lose the server chores",
    faqs: 6,
    related: ["/features/no-docker-hosting", "/features/persistent-memory", "/features/multi-agent"],
  },
  "scheduled-tasks": {
    title: "Scheduled AI Agent Tasks and Cron Jobs | Hivra",
    description: "Schedule recurring Hermes agent work from the Hivra dashboard. Run research, reporting and monitoring without leaving your laptop on.",
    eyebrow: "Scheduled AI Agent Tasks",
    h1: "Make the recurring work actually recur",
    faqs: 7,
    related: ["/features/persistent-memory", "/features/browser-automation", "/features/multi-agent"],
  },
};

// A plain false positive of the shared list: this sentence DENIES the claim "remembers everything".
// The exemption is for this one sentence on this one page, nothing else (the test below proves both).
const FALSE_POSITIVES = [
  {
    route: "/features/persistent-memory",
    hit: "/features/persistent-memory: memory kept forever or total recall: This is memory you can work with, not a claim that an AI model remembers everything perfectly.",
  },
];

function bannedClaimsOn(route: string, copy: string[]): string[] {
  return findBannedClaims(route, copy).filter((hit) => !FALSE_POSITIVES.some((allowed) => allowed.route === route && allowed.hit === hit));
}

function titleOf(metadata: Metadata): string | undefined {
  const { title } = metadata;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && "absolute" in title) return title.absolute;
  return undefined;
}

/** Everything a crawler reads from the metadata, including a finished (absolute) title. */
function crawlerCopy(metadata: Metadata): string[] {
  return [...metadataCopy(metadata), titleOf(metadata) ?? ""].filter(Boolean);
}

async function renderFeature(slug: string) {
  const element = await FeaturePage({ params: Promise.resolve({ slug }) });
  return render(element);
}

/** The text a reader sees: the page without its JSON-LD script. */
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("script, style").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

describe("feature page claims", () => {
  afterEach(cleanup);

  it("catches every claim these pages used to make, and leaves true copy alone", () => {
    for (const claim of KNOWN_FALSE_CLAIMS) {
      expect(findBannedClaims("fixture", [claim])).not.toEqual([]);
    }
    expect(findBannedClaims("fixture", KNOWN_TRUE_CLAIMS)).toEqual([]);
  });

  it("exempts exactly one sentence of the shared list, and that sentence really trips it", () => {
    expect(FALSE_POSITIVES).toHaveLength(1);
    const [{ route, hit }] = FALSE_POSITIVES;
    expect(findBannedClaims(route, [hit.split(": ").slice(2).join(": ")])).toEqual([hit]);
    // An affirmative claim is still caught on the same page.
    expect(bannedClaimsOn(route, ["Your agent remembers everything."])).not.toEqual([]);
  });

  it("makes no banned claim on /features", () => {
    const { container } = render(<FeaturesPage />);
    const copy = [...renderedCopy(container), ...crawlerCopy(featuresMetadata)];
    expect(bannedClaimsOn("/features", copy)).toEqual([]);
    expect(falseCliRunClaims(visibleText(container))).toEqual([]);
  });

  it.each(SLUGS)("makes no banned claim on /features/%s, in the page, the JSON-LD or the metadata", async (slug) => {
    const { container } = await renderFeature(slug);
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const copy = [...renderedCopy(container), ...crawlerCopy(metadata)];
    expect(bannedClaimsOn(`/features/${slug}`, copy)).toEqual([]);
    expect(falseCliRunClaims(visibleText(container))).toEqual([]);
  });

  it("serves exactly the six feature pages", () => {
    expect(SLUGS).toEqual(Object.keys(COPY));
  });

  it.each(Object.entries(COPY))("gives /features/%s the finished browser title and search description from the copy", async (slug, copy) => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    // An absolute title: the root template adds no second " | Hivra".
    expect(metadata.title).toEqual({ absolute: copy.title });
    expect(metadata.description).toBe(copy.description);
    expect((metadata.openGraph as { title?: unknown }).title).toBe(copy.title);
    expect((metadata.twitter as { title?: unknown }).title).toBe(copy.title);
    expect((metadata.openGraph as { description?: unknown }).description).toBe(copy.description);
    expect(metadata.alternates?.canonical).toBe(`https://hivra.cloud/features/${slug}`);
  });

  it("gives /features its finished browser title and search description from the copy", () => {
    expect(featuresMetadata.title).toEqual({ absolute: "Hivra Features | Persistent AI Agent Hosting" });
    expect(featuresMetadata.description).toBe(
      "Explore Hivra's managed AI agent hosting: persistent memory, cloud browsers, scheduled tasks, multiple agents and simple deployment without Docker.",
    );
    expect((featuresMetadata.openGraph as { title?: unknown }).title).toBe("Hivra Features | Persistent AI Agent Hosting");
    expect(featuresMetadata.alternates?.canonical).toBe("https://hivra.cloud/features");
  });

  it("keeps every meta description short enough that search results show all of it", async () => {
    const tooLong: string[] = [];
    const check = (label: string, descriptions: string[]) => {
      for (const description of descriptions) {
        if (description.length > MAX_META_DESCRIPTION_LENGTH) tooLong.push(`${label} (${description.length}): ${description}`);
      }
    };
    check("/features", metadataDescriptions(featuresMetadata));
    for (const slug of SLUGS) {
      check(`/features/${slug}`, metadataDescriptions(await generateMetadata({ params: Promise.resolve({ slug }) })));
    }
    expect(tooLong).toEqual([]);
  });

  it.each(Object.entries(COPY))("lays out /features/%s with one h1, the breadcrumb, the questions and the related links", async (slug, copy) => {
    const { container } = await renderFeature(slug);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(copy.h1);
    expect(container.querySelector("header span")?.textContent ?? undefined).toBe(copy.eyebrow);
    expect(container.querySelector('nav[aria-label="Breadcrumb"] a[href="/features"]')).not.toBeNull();

    const headings = [...container.querySelectorAll("h2")].map((h2) => h2.textContent);
    expect(headings).toContain("Frequently asked questions");
    expect(headings).not.toContain("Common questions");
    expect(headings).toContain("Related");
    expect(container.querySelectorAll("details")).toHaveLength(copy.faqs);

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of copy.related) expect(hrefs).toContain(href);
    // Every page keeps its two calls to action: the agents directory and pricing.
    expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
  });

  it.each(SLUGS)("writes the FAQPage JSON-LD of /features/%s from the visible questions and answers", async (slug) => {
    const { container } = await renderFeature(slug);
    const graph = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}")["@graph"] as Array<{
      "@type": string;
      mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }>;
    }>;
    const faq = graph.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? [];
    const visible = [...container.querySelectorAll("details")].map((details) => ({
      name: (details.querySelector("summary")?.textContent ?? "").replace(/\+$/, ""),
      text: details.querySelector("p")?.textContent ?? "",
    }));
    expect(faq.map(({ name, acceptedAnswer }) => ({ name, text: acceptedAnswer.text }))).toEqual(visible);
    expect(visible.length).toBeGreaterThan(0);
  });

  it("writes the FAQPage JSON-LD of /features from the visible questions and answers", () => {
    const { container } = render(<FeaturesPage />);
    const graph = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}")["@graph"] as Array<{
      "@type": string;
      mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }>;
    }>;
    const faq = graph.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? [];
    const visible = [...container.querySelectorAll("details")].map((details) => ({
      name: (details.querySelector("summary")?.textContent ?? "").replace(/\+$/, ""),
      text: details.querySelector("p")?.textContent ?? "",
    }));
    expect(faq.map(({ name, acceptedAnswer }) => ({ name, text: acceptedAnswer.text }))).toEqual(visible);
    expect(visible).toHaveLength(4);
  });

  it.each(["/features", ...SLUGS.map((slug) => `/features/${slug}`)])("keeps %s free of dashes, notes, brackets, retired names and token copy", async (route) => {
    const { container } = route === "/features" ? render(<FeaturesPage />) : await renderFeature(route.split("/")[2]);
    const text = visibleText(container);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/Editorial checks|not public website copy|Implementation notes/i);
    // Nothing on the page talks to whoever wrote it ("Don't promise ..."): every sentence is addressed to the reader.
    expect(text).not.toMatch(/\b(?:Don't|Do not|Never) (?:promise|claim|say|imply|state)\b/);
    expect(text).not.toMatch(/\[[^\]]*\]|\{[^}]*\}/);
    // Plans are described by price and size, never by the names that collide between checkout and the ladder.
    expect(text).not.toMatch(/\b(?:Starter|Pro|Power)\b/);
    expect(text).not.toMatch(/seven-day|\beligible\b/i);
    // The only "token" these pages mention is a model token, so no token surface needs a gate here.
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|airdrop|snapshot|litepaper|tokenomics|launchpad|Bankr/i);
    expect(container.querySelector('a[href*="litepaper"], a[href="/token"]')).toBeNull();
    // No operating system is named, so none needs its qualifier.
    expect(text).not.toMatch(/\b(?:Ubuntu|Windows|Omarchy)\b/);
  });

  it("states the two sizes in the prose form, with the size beside every price", async () => {
    const pages = [visibleText(render(<FeaturesPage />).container)];
    cleanup();
    pages.push(visibleText((await renderFeature("multi-agent")).container));
    cleanup();
    for (const text of pages) {
      expect(text).toContain(`$9.99 a month for ${ENTRY_PLAN_SIZE}`);
      expect(text).toContain(`$19.99 a month for ${LARGER_PLAN_SIZE}`);
      expect(text).not.toMatch(/\$\d+(?:\.\d+)?\s?\/\s?mo/);
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (sentence.includes("$19.99")) expect(sentence).toMatch(/4 vCPU and 8 GB/);
      }
    }
  });

  it("words the refund as the card-payments guarantee and links it to the terms", () => {
    const { container } = render(<FeaturesPage />);
    expect(visibleText(container)).toContain(`A ${MONEY_BACK_GUARANTEE} applies under the current terms.`);
    expect(container.querySelector('a[href="/terms"]')?.textContent).toBe("current terms");
  });

  it("says a paid computer stays on only in the approved words, and never offers a free hosted plan or trial", () => {
    const { container } = render(<FeaturesPage />);
    const text = visibleText(container);
    expect(text).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(text).not.toContain("Hivra keeps the computer available when you're offline");
    expect(text).not.toMatch(/free trial|no card|card required|free plan|free tier/i);
  });

  it("keeps model access honest: the plan does not include AI usage, and signing in with your own account is the provider's call", async () => {
    const sentence = "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";
    const directory = visibleText(render(<FeaturesPage />).container);
    cleanup();
    const browser = visibleText((await renderFeature("browser-automation")).container);
    cleanup();
    const hosting = visibleText((await renderFeature("no-docker-hosting")).container);
    for (const text of [directory, browser, hosting]) expect(text).toContain(sentence);
    for (const text of [directory, browser]) expect(text).toContain("Using your own account is subject to the provider's terms.");
    expect(hosting).toContain("approved login method for that framework, subject to the provider's terms");
    // No affiliation or endorsement is implied.
    expect(`${directory}${browser}${hosting}`).not.toMatch(/official partner|endorsed by|in partnership with/i);
  });

  it("says the AI-usage sentence once on each page, with no Hosting-and-inference line beside it", async () => {
    const sentence = "The plan does not include AI usage.";
    const directory = visibleText(render(<FeaturesPage />).container);
    cleanup();
    const browser = visibleText((await renderFeature("browser-automation")).container);
    cleanup();
    const hosting = visibleText((await renderFeature("no-docker-hosting")).container);
    for (const text of [directory, browser, hosting]) expect(text.split(sentence).length - 1).toBe(1);
    // The owner's own "Hosting and inference are separate" lines said the same thing beside the approved sentence.
    for (const text of [browser, hosting]) expect(text).not.toMatch(/Hosting and (?:model )?inference are separate/);
    // "The plan covers ..." no longer sits right against "The plan does not include ...".
    expect(directory).not.toContain("The plan covers the managed computer resources");
  });

  it("answers the /features FAQ on AI work without an API key directly, without repeating the approved sentence", () => {
    const { container } = render(<FeaturesPage />);
    const row = [...container.querySelectorAll("details")].find((details) => (details.querySelector("summary")?.textContent ?? "").startsWith("Will Hivra do the AI work without an API key?"));
    const answer = row?.querySelector("p")?.textContent ?? "";
    expect(answer).toMatch(/^Not as part of the plan\./);
    expect(answer).not.toContain("The plan does not include AI usage.");
    // The JSON-LD carries the same answer.
    const graph = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}")["@graph"] as Array<{
      "@type": string;
      mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }>;
    }>;
    const faq = graph.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? [];
    expect(faq.find(({ name }) => name === "Will Hivra do the AI work without an API key?")?.acceptedAnswer.text).toBe(answer);
  });

  it("does not present Hivra as Hermes-only, and does not claim an OpenClaw import it does not have", async () => {
    const { container } = await renderFeature("openclaw-alternative");
    const text = visibleText(container);
    expect(text).toContain("Hivra is not affiliated with the OpenClaw project.");
    expect(text).toContain("Hivra does not currently offer a one-click OpenClaw import.");
    expect(text).toContain("Moving an existing setup is manual.");
    // No agent is "the paid one": the answer states the rule that holds for every computer Hivra Cloud runs.
    expect(text).toContain(
      "Not on a computer that Hivra Cloud runs for you. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. The OpenClaw software is free. The computer that runs it is what you pay for.",
    );
    expect(text).not.toContain("needs a paid size");
    expect(text).toContain("hosted on a paid Hivra computer, or try Hermes, also on a paid Hivra computer");
    expect(text).toMatch(/Hermes documents a migration utility, hermes claw migrate/);
    expect(text).toContain("--dry-run");
    expect(container.querySelector('a[href="https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw"]')?.getAttribute("target")).toBe("_blank");
    // The comparison is a real table: two data columns, seven rows, row headings.
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(7);
    expect([...container.querySelectorAll("table thead th")].map((th) => th.textContent)).toEqual([
      "What matters to you",
      "OpenClaw on Hivra",
      "Hermes on Hivra",
    ]);
    expect(container.querySelectorAll('table tbody th[scope="row"]')).toHaveLength(7);
  });

  it("says agents run side by side and orchestration is not shipped", async () => {
    const { container } = await renderFeature("multi-agent");
    const text = visibleText(container);
    expect(text).toContain("Hivra does not yet provide built-in orchestration that automatically coordinates an entire team of agents. That capability is planned for the future.");
    expect(text).toContain("Native orchestration is not a launched feature.");
    expect(text).not.toMatch(/Multi-Agent Coordination/i);
    // Account memory is named only for the agents that have it.
    expect(text).toContain("Optional copied account memory for new Claude Code and Codex agents is a separate, explicitly configured feature.");
    expect(container.querySelector("h1")?.textContent).toBe("Separate jobs, one Hivra account");
  });

  it("words the answers that used to read as a hedge or a note to the writer as plain statements to the reader", async () => {
    const openclaw = visibleText((await renderFeature("openclaw-alternative")).container);
    expect(openclaw).toContain("Reconnection may be necessary. Hivra does not promise a zero-step migration of messaging sessions.");
    cleanup();
    const tasks = visibleText((await renderFeature("scheduled-tasks")).container);
    expect(tasks).toContain("Hivra does not publish a fixed task-count cap for paid plans, but practical concurrency depends on your compute allocation");
    expect(tasks).not.toMatch(/Paid plans do not set a fixed task-count cap/);
    cleanup();
    const browser = visibleText((await renderFeature("browser-automation")).container);
    expect(browser).toContain("Hivra offers a live browser view on supported deployments, and browser actions and screenshots can be reviewed in the agent's session history where they are kept.");
  });

  it("describes the browser, schedules and exports the product actually ships", async () => {
    const browser = visibleText((await renderFeature("browser-automation")).container);
    expect(browser).toMatch(/persistent Chromium browser running on the agent's cloud computer/);
    expect(browser).toMatch(/Chrome DevTools Protocol \(CDP\)/);
    expect(browser).toMatch(/live browser view/);
    expect(browser).toMatch(/Browserbase.*Browser Use/);
    cleanup();

    const tasks = visibleText((await renderFeature("scheduled-tasks")).container);
    expect(tasks).toMatch(/Choose an hourly, daily, weekly or monthly schedule/);
    expect(tasks).toMatch(/Telegram, Discord or email/);
    expect(tasks).toMatch(/Run now/);
    expect(tasks).not.toMatch(/natural language|Slack/i);
    cleanup();

    const memory = visibleText((await renderFeature("persistent-memory")).container);
    expect(memory).toMatch(/through the file explorer on supported Hermes deployments/);
    expect(memory).toMatch(/JSON export for Claude Code and Codex chats and memory/);
    expect(memory).toMatch(/does not promise a separate encryption guarantee/);
    // The retention answer says only what holds: it stays while the computer exists, so export before you cancel or delete.
    expect(memory).toContain("It stays with the agent's computer for as long as that computer exists. Export anything you want to keep before you cancel or delete the computer.");
    expect(memory).not.toContain("governed by the relevant product behaviour and terms");
  });

  // Connecting a server of your own is what a free account is for, so it is not a Hetzner-only preview any more
  // (owner decision 2026-10-21). Hermes still runs on Hivra Cloud only (lib/launch/contracts.ts, ownServer false).
  it("names the connect-your-own-server option for the five agents that have it, and Hermes as Hivra Cloud only", async () => {
    const text = visibleText((await renderFeature("no-docker-hosting")).container);
    expect(text).toContain("Hermes runs on Hivra Cloud only.");
    expect(text).toContain(
      "Claude Code, Codex, OpenClaw, Agent Zero and Aeon can also run on a server you connect yourself, such as a Hetzner Cloud project or a Linux server that Hivra can reach over SSH. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.",
    );
    expect(text).toContain("Not on Hivra Cloud today. For Claude Code, Codex, OpenClaw, Agent Zero and Aeon, you can connect your own server or a Hetzner Cloud project and choose where it runs.");
    expect(text).not.toMatch(/\bin preview\b|preview bring-your-own|Hetzner-project deployment option/);
    // Staged rollout is something Hivra can do, not something that happens to every update.
    expect(text).toContain("Hivra can roll a new version out in stages, starting with a single agent.");
    expect(text).toContain("Hivra can stage managed releases, but regressions are possible.");
    expect(text).not.toMatch(/Hivra tests (?:new versions|managed releases)/);
    expect(text).toContain("There is no region selector for standard Hivra Cloud sign-up today.");
    expect(text).toContain("No blanket backup guarantee.");
    expect(text).not.toContain("escape hatch");
  });

  it("says a Hivra Cloud computer needs a paid plan once for all of them, never 'supported paid' for some", async () => {
    for (const slug of SLUGS) {
      const { container } = await renderFeature(slug);
      expect(visibleText(container)).not.toMatch(/supported paid/i);
      cleanup();
    }
  });

  it("closes each page with the copy's own links, not the old shared sign-up band", async () => {
    for (const slug of SLUGS) {
      const { container } = await renderFeature(slug);
      expect(visibleText(container)).not.toContain("Keep your agent running on a computer of its own");
      expect(visibleText(container)).not.toContain("Bring your own AI key.");
      expect(container.querySelector('a[href="/sign-up"]')).toBeNull();
      cleanup();
    }
  });
});
