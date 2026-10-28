/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render, within } from "@testing-library/react";

import ComparePage, { metadata as compareMetadata } from "../page";
import ComparisonPage, { generateMetadata, generateStaticParams } from "../[slug]/page";
import { COMPARE_DIRECTORY } from "@/lib/compare/directory";
import { COMPETITOR_FACTS, COMPETITOR_FACTS_CHECKED, formatCheckedMonth } from "@/lib/compare/competitor-facts";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { STAYS_ON } from "@/lib/compare/shared-copy";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({
  __esModule: true,
  default: ({ items }: { items: { id: string; label: string }[] }) => (
    <nav aria-label="Article contents">
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// What the October 2026 copy gives each page: the finished browser title, the h1 and the section headings in order.
// Titles are the copy's own, except Nous: the copy's title is 76 characters and the rule for a finished title is 70.
const STANDARD = ["The real choice", "What you are actually paying for", "Where Hivra fits", "When the alternative is worth choosing"];
const TAIL = ["At a glance", "Things a comparison chart cannot tell you"];
const DECISION = ["How to make the decision"];
const SOURCES = "Where these numbers come from";
const END = ["Common questions", "Ready to give your agent a computer?", "Related"];

// Each page has its own description (155 characters at most). Those that quote a price end with the freshness stamp.
const STAMP = `Prices as of ${formatCheckedMonth()}.`;
const ENTRY = "$9.99 a month for 2 vCPU and 4 GB of RAM";

const PAGES: Record<string, { title: string; h1: string; description: string; headings: string[] }> = {
  "ai-agent-hosting-alternatives": {
    title: "AI agent hosting in 2026: choose the kind of computer first | Hivra",
    h1: "AI agent hosting in 2026: choose the kind of computer first",
    description: `Fly Sprites, E2B, Railway, DigitalOcean, Cloudways, Orgo, a VPS or Hivra: which kind of computer suits an AI agent. ${STAMP}`,
    headings: [...STANDARD, "Other categories worth comparing", ...TAIL, SOURCES, ...END],
  },
  "openclaw-to-hermes": {
    title: "Moving from OpenClaw to Hermes on Hivra | Hivra",
    h1: "Moving from OpenClaw to Hermes on Hivra",
    description:
      "Hivra can host OpenClaw or Hermes on a paid computer. Hermes has its own command to move an OpenClaw setup. What carries over and what you rebuild.",
    headings: [
      ...STANDARD,
      "A migration that does not lose your working setup",
      "What will not transfer automatically",
      ...TAIL,
      "Where these facts come from",
      ...END,
    ],
  },
  "vs-agent-37": {
    title: "Agent 37 vs Hivra: a meter or a monthly computer? | Hivra",
    h1: "Agent 37 vs Hivra: a meter or a monthly computer?",
    description: `Hivra is ${ENTRY}. Agent 37 meters the same size at $4.76 a month, always on. Where each wins. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-hostinger": {
    title: "Hostinger vs Hivra: prepaid savings or managed agent computers | Hivra",
    h1: "Hostinger vs Hivra: prepaid savings or managed agent computers",
    description: `Hostinger's prepaid 24-month sale price against Hivra at ${ENTRY}, and when its VPS wins. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-nous-hermes-cloud": {
    title: "Nous Hermes Cloud vs Hivra: official cloud or multi-agent home | Hivra",
    h1: "Nous Hermes Cloud vs Hivra: the official cloud or a multi-agent home",
    description: `Nous Hermes Cloud meters Hermes by the second; Hivra is ${ENTRY}. Not affiliated with Nous. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-railway": {
    title: "Railway vs Hivra: a platform for apps or a home for an agent | Hivra",
    h1: "Railway vs Hivra: a platform for apps or a home for an agent",
    description: `Railway deploys apps; Hivra hosts a persistent agent from ${ENTRY}. How the two differ. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-render": {
    title: "Running Hermes on Render or on Hivra | Hivra",
    h1: "Running Hermes on Render or on Hivra",
    description: `Render's $25 Standard Hermes template: its README warns of no default login. Hivra is ${ENTRY}. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-self-hosted": {
    title: "Self-hosting Hermes or using Hivra: control has a cost | Hivra",
    h1: "Self-hosting Hermes or using Hivra: control has a cost",
    description: `Hetzner costs less each month; Hivra is ${ENTRY} and handles upkeep. When self-hosting wins. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
  "vs-xcloud": {
    title: "xCloud vs Hivra: look beyond the promotional hardware | Hivra",
    h1: "xCloud vs Hivra: look beyond the promotional hardware",
    description: `xCloud's $9.99 promotion is 4 vCPU and 6 GB of RAM; Hivra is ${ENTRY}. Renewal and beta terms. ${STAMP}`,
    headings: [...STANDARD, ...DECISION, ...TAIL, SOURCES, ...END],
  },
};

const DIRECTORY_HEADINGS = [
  ...STANDARD,
  "Compare the providers",
  "What does each host cost?",
  "Things a comparison chart cannot tell you",
  "Common questions",
  "Ready to give your agent a computer?",
];

const SLUGS = generateStaticParams().map(({ slug }) => slug);
const BLOG_SLUGS = new Set(BLOG_ARTICLES_LIST.map((article) => article.slug));
const FEATURE_SLUGS = new Set(["openclaw-alternative", "persistent-memory"]);
const SITE_ROUTES = new Set(["/pricing", "/agents", "/features", "/compare", "/terms", "/tools/ai-agent-hosting-cost-calculator"]);

async function renderComparison(slug: string) {
  return render(await ComparisonPage({ params: Promise.resolve({ slug }) }));
}

function h2s(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h2")].map((h2) => h2.textContent ?? "");
}

function faqSchema(container: HTMLElement): { name: string; text: string }[] {
  const script = container.querySelector('script[type="application/ld+json"]');
  const graph = JSON.parse(script?.textContent ?? "{}")["@graph"] as Array<{ "@type": string; mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }> }>;
  const faq = graph.find((node) => node["@type"] === "FAQPage");
  return (faq?.mainEntity ?? []).map((item) => ({ name: item.name, text: item.acceptedAnswer.text }));
}

describe("comparison pages follow the supplied copy", () => {
  afterEach(cleanup);

  it("covers exactly the nine detail pages the copy supplies", () => {
    expect([...SLUGS].sort()).toEqual(Object.keys(PAGES).sort());
  });

  it.each(Object.entries(PAGES))("/compare/%s has the copy's title, h1 and section order", async (slug, expected) => {
    const { container } = await renderComparison(slug);
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    // An absolute title: the layout template must not add " | Hivra" a second time.
    expect(metadata.title).toEqual({ absolute: expected.title });
    expect((metadata.openGraph as { title?: string }).title).toBe(expected.title);
    expect((metadata.twitter as { title?: string }).title).toBe(expected.title);
    expect(metadata.description).toBe(expected.description);
    expect((metadata.openGraph as { description?: string }).description).toBe(expected.description);
    expect((metadata.twitter as { description?: string }).description).toBe(expected.description);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe(expected.h1);
    expect(h2s(container)).toEqual(expected.headings);
  });

  it("/compare has the copy's title, h1 and section order, and equal literals in page.tsx and the copy", () => {
    const { container } = render(<ComparePage />);
    expect(compareMetadata.title).toEqual({ absolute: "Hivra compared with the alternatives | Hivra" });
    expect(compareMetadata.title).toEqual({ absolute: COMPARE_DIRECTORY.browserTitle });
    expect(compareMetadata.description).toBe(COMPARE_DIRECTORY.metaDescription);
    expect(compareMetadata.description).toBe(
      `Hivra compared with Agent 37, Hostinger, xCloud, Nous Hermes Cloud, self-hosting, Railway and Render, with a dated price table. ${STAMP}`,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Hivra compared with the alternatives");
    expect(h2s(container)).toEqual(DIRECTORY_HEADINGS);
  });

  it("lists the nine comparison pages on /compare, in the copy's order, each name a real link", () => {
    const { container } = render(<ComparePage />);
    const links = [...container.querySelectorAll("ol li > p > a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Agent 37", "/compare/vs-agent-37"],
      ["Hostinger", "/compare/vs-hostinger"],
      ["xCloud", "/compare/vs-xcloud"],
      ["Nous Hermes Cloud", "/compare/vs-nous-hermes-cloud"],
      ["Self-hosted VPS", "/compare/vs-self-hosted"],
      ["Railway", "/compare/vs-railway"],
      ["Render", "/compare/vs-render"],
      ["OpenClaw to Hermes", "/compare/openclaw-to-hermes"],
      ["Broader hosting choices", "/compare/ai-agent-hosting-alternatives"],
    ]);
  });

  it("keeps the dated price table on /compare as a real table with a source link per row", () => {
    const { container } = render(<ComparePage />);
    const table = container.querySelector('table[aria-label="Price table"]') as HTMLElement;
    expect(table).not.toBeNull();
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Provider",
      "Price for the size",
      "Billing and what it leaves out",
      "Source",
    ]);
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.querySelector('th[scope="row"]')?.textContent).toBeTruthy();
      expect(row.querySelector("td:last-child a")).not.toBeNull();
    }
    expect(container.textContent).toContain(`as of ${formatCheckedMonth()}`);
  });

  it.each(SLUGS)("/compare/%s has a real 'At a glance' table with Hivra and Alternative columns", async (slug) => {
    const { container } = await renderComparison(slug);
    const table = [...container.querySelectorAll("table")].find((t) => /compared$/.test(t.getAttribute("aria-label") ?? "")) as HTMLElement;
    expect(table).toBeDefined();
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Criterion", "Hivra", "Alternative"]);
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      expect(row.querySelector('th[scope="row"]')?.textContent).toBeTruthy();
      const cells = [...row.querySelectorAll("td")];
      expect(cells).toHaveLength(2);
      for (const cell of cells) expect(cell.textContent?.trim()).toBeTruthy();
    }
  });

  it.each(SLUGS)("/compare/%s: FAQPage JSON-LD mirrors the visible questions and answers exactly", async (slug) => {
    const { container } = await renderComparison(slug);
    const schema = faqSchema(container);
    expect(schema).toHaveLength(2);
    const visible = [...container.querySelectorAll("details")].map((details) => ({
      name: details.querySelector("summary")?.childNodes[0]?.textContent ?? "",
      text: details.querySelector("p")?.textContent ?? "",
    }));
    expect(visible).toEqual(schema);
  });

  it("gives /compare its own FAQPage JSON-LD that mirrors the visible answers", () => {
    const { container } = render(<ComparePage />);
    const visible = [...container.querySelectorAll("details")].map((details) => ({
      name: details.querySelector("summary")?.childNodes[0]?.textContent ?? "",
      text: details.querySelector("p")?.textContent ?? "",
    }));
    expect(faqSchema(container)).toEqual(visible);
    expect(visible.map((item) => item.name)).toEqual(["What does Hivra charge?", "Is self-hosting a legitimate alternative?"]);
  });

  it.each(SLUGS)("/compare/%s: breadcrumb is Home / Compare and every link goes to a real page", async (slug) => {
    const { container } = await renderComparison(slug);
    const crumbs = within(container.querySelector('nav[aria-label="Breadcrumb"]') as HTMLElement);
    expect(crumbs.getByText("Home")).toHaveAttribute("href", "/");
    expect(crumbs.getByText("Compare")).toHaveAttribute("href", "/compare");
    const unknown: string[] = [];
    for (const a of container.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      if (/^https:\/\//.test(href) || href.startsWith("#") || href === "/") continue;
      const known =
        SITE_ROUTES.has(href) ||
        (href.startsWith("/compare/") && SLUGS.includes(href.slice("/compare/".length))) ||
        (href.startsWith("/blog/") && BLOG_SLUGS.has(href.slice("/blog/".length))) ||
        (href.startsWith("/features/") && FEATURE_SLUGS.has(href.slice("/features/".length)));
      if (!known) unknown.push(href);
    }
    expect(unknown).toEqual([]);
  });

  it.each([...SLUGS, ""])("/compare/%s: no leaked markup, notes, placeholders, process language or token copy", async (slug) => {
    const { container } = slug ? await renderComparison(slug) : render(<ComparePage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\*\*|`|\]\(|\[Link|\[Button|\[[A-Z][^\]]{3,}\]/);
    expect(text).not.toMatch(/Editorial checks|not website copy|Implementation notes|Prepublication/i);
    // Process language from the supplied draft: nothing the page says is about "the source" or the rewrite.
    expect(text).not.toMatch(/source material|source capture|supplied (?:site|source|October)|comparison source|source comparison|not checked live|for this rewrite|before publishing/i);
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|HermesOS|airdrop|snapshot|litepaper|tokenomics|launchpad|Bankr/i);
    expect(text).not.toMatch(/[–—]/);
    // Plans are described by price and size, never by the colliding names.
    expect(text).not.toMatch(/\b(?:Starter|Power|Pro) (?:plan|size|tier)\b|\bHivra (?:Starter|Pro|Power)\b/);
    expect(text).not.toMatch(/free trial|no card|card required/i);
  });

  it.each(SLUGS)("/compare/%s: states the guarantee in full and never as a bare 7 days", async (slug) => {
    const text = await (async () => (await renderComparison(slug)).container.textContent ?? "")();
    const mentions = text.match(/7[- ]day[^.;]*/gi) ?? [];
    for (const mention of mentions) expect(mention).toMatch(/money-back guarantee on card payments/);
    expect(text).not.toMatch(/seven-day|eligible|at checkout|7 days, card payments only/i);
  });

  it("dates the freshness stamp with a machine readable time element", async () => {
    for (const slug of Object.keys(COMPETITOR_FACTS)) {
      const { container } = await renderComparison(slug);
      const time = container.querySelector("#fact-sources time");
      expect(time?.getAttribute("datetime")).toBe(COMPETITOR_FACTS_CHECKED);
      expect(time?.textContent).toBe(formatCheckedMonth());
      cleanup();
    }
  });

  it("keeps the caveat that comparison charts go stale on every page, with the month the figures were read", async () => {
    for (const slug of SLUGS) {
      const { container } = await renderComparison(slug);
      const note = [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Things a comparison chart cannot tell you");
      expect(note?.textContent).toContain(`in ${formatCheckedMonth()}.`);
      expect(note?.textContent).toContain("before you buy");
      cleanup();
    }
  });

  // The page cannot claim live checking: Hostinger has moved prices since and Nous shows its per-size prices only after sign-in.
  it("says the vendor figures were collected, may have changed since, and never that they were read or verified live", async () => {
    for (const slug of [...SLUGS, ""]) {
      const { container } = slug ? await renderComparison(slug) : render(<ComparePage />);
      const note = [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Things a comparison chart cannot tell you");
      const text = note?.textContent ?? "";
      expect([slug, /collected from each provider's published pages in /.test(text)]).toEqual([slug, true]);
      expect([slug, /may have changed since/.test(text)]).toEqual([slug, true]);
      expect(text).not.toMatch(/were read from|own pages|verified live|checked live/);
      cleanup();
    }
  });

  it("states the limits of the price table on /compare: published pages, Hostinger's two sale prices, Nous behind its Portal sign-in", () => {
    const { container } = render(<ComparePage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/from each provider's published pages, as of /);
    expect(text).not.toMatch(/straight from each provider/);
    expect(text).toMatch(/Hostinger shows its managed plan and its KVM 2 VPS at sale prices, so check its pages/);
    expect(text).not.toMatch(/Hostinger has since shown lower prices/);
    expect(text).toMatch(/Nous now shows sizes and prices only after you sign in to its Portal, so its row shows the last published figures/);
    // The row is not given a tier name that Nous's own pages no longer show.
    const rows = [...container.querySelectorAll('table[aria-label="Price table"] tbody th')].map((th) => th.textContent);
    expect(rows).toContain("Nous Hermes Cloud");
    expect(rows.filter((row) => /Medium/.test(row ?? ""))).toEqual([]);
  });

  it("shows Hostinger's re-read sale prices and Nous's last published price in the /compare price table", () => {
    const { container } = render(<ComparePage />);
    const table = (container.querySelector('table[aria-label="Price table"]') as HTMLElement).textContent ?? "";
    expect(table).toContain("$4.99/mo, size not published");
    expect(table).toContain("$119.76, our arithmetic");
    expect(table).toContain("$8.79/mo for 2 vCPU and 8 GB RAM");
    expect(table).toContain("Last published: $0.56/day running for 4 vCPU and 2 GB RAM");
    expect(table).toContain("only after you sign in to its Portal");
    for (const stale of ["$5.99", "$143.76", "$8.99"]) expect(table).not.toContain(stale);
  });

  it("uses the approved stays-on sentence for Hivra's always-on cell on /compare/vs-render", async () => {
    const { container } = await renderComparison("vs-render");
    const row = [...container.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("th")?.textContent === "Always-on (no sleep)");
    expect(row?.querySelector("td")?.textContent).toBe(STAYS_ON);
    expect(container.textContent).not.toMatch(/never paused/i);
  });

  it("names the vendor pages the Railway and self-hosting figures come from, each a real https link", async () => {
    const expected: Record<string, RegExp[]> = {
      "vs-railway": [/^https:\/\/railway\.com\/pricing$/, /^https:\/\/docs\.railway\.com\//],
      "vs-self-hosted": [/^https:\/\/docs\.hetzner\.com\//, /^https:\/\/www\.hetzner\.com\//],
    };
    for (const [slug, patterns] of Object.entries(expected)) {
      const { container } = await renderComparison(slug);
      const section = container.querySelector("#fact-sources") as HTMLElement;
      expect(section).not.toBeNull();
      expect(section.querySelector("time")?.getAttribute("datetime")).toBe(COMPETITOR_FACTS_CHECKED);
      const hrefs = [...section.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
      for (const pattern of patterns) expect([slug, hrefs.some((href) => pattern.test(href))]).toEqual([slug, true]);
      for (const href of hrefs) expect(href).toMatch(/^https:\/\//);
      cleanup();
    }
  });

  it("keeps the copy's colon in each provider row, so the name still reads 'Agent 37: metered raw compute'", () => {
    const { container } = render(<ComparePage />);
    const first = container.querySelector("ol li > p") as HTMLElement;
    expect(first.textContent).toMatch(/^Agent 37: metered raw compute, a free tier/);
    // The row's arrow is the straight one: every target is a page on this site.
    expect(container.querySelectorAll("ol li > svg").length).toBe(9);
  });

  it("opens the table of contents on every section a reader can jump to", async () => {
    const { container } = await renderComparison("vs-agent-37");
    const nav = within(container.querySelector('nav[aria-label="Article contents"]') as HTMLElement);
    for (const heading of [...STANDARD, ...DECISION, ...TAIL, SOURCES, "Common questions"]) {
      const link = nav.getByText(heading);
      const target = container.querySelector(link.getAttribute("href") as string);
      expect(target).not.toBeNull();
    }
  });
});
