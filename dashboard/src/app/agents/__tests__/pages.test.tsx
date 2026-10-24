/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import type { Metadata } from "next";

import AgentsIndexPage, { metadata as hubMetadata } from "../page";
import AgentPage, { dynamicParams, generateMetadata, generateStaticParams } from "../[slug]/page";
import {
  AGENTS_HUB_AFFILIATION,
  AGENT_COPY_BANNED_PATTERNS,
  AGENT_SEO_ENTRIES,
  CLI_RUN_AGENT_SLUGS,
  agentDeployHref,
  agentPageTitle,
  unqualifiedKeepRunningClaims,
} from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { HUB_CONTENT, getAgentPageContent } from "../content";
import { plainText, slugifyHeading } from "../content/markup";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// The table of contents is a scroll-tracking client island (framer-motion,
// matchMedia, IntersectionObserver); its links are covered by the section ids below.
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({
  __esModule: true,
  default: ({ items }: { items: { id: string; label: string }[] }) => (
    <nav aria-label="Article sections">
      {items.map(({ id, label }) => (
        <a key={id} href={`#${id}`}>
          {label}
        </a>
      ))}
    </nav>
  ),
}));

beforeAll(() => {
  // The public header reads matchMedia; jsdom does not implement it.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

const APP_DIR = path.resolve(__dirname, "..", "..");

function readJsonLd(container: HTMLElement): Record<string, unknown>[] {
  const scripts = [...container.ownerDocument.querySelectorAll('script[type="application/ld+json"]')];
  expect(scripts).toHaveLength(1);
  const parsed = JSON.parse(scripts[0].textContent ?? "{}") as { "@graph"?: Record<string, unknown>[] };
  return parsed["@graph"] ?? [];
}

function titleOf(meta: Metadata): string {
  const title = meta.title as { absolute?: string } | string | null | undefined;
  return typeof title === "string" ? title : (title?.absolute ?? "");
}

function metadataStrings(meta: Metadata): string[] {
  const og = (meta.openGraph ?? {}) as Record<string, unknown>;
  const tw = (meta.twitter ?? {}) as Record<string, unknown>;
  return [titleOf(meta), meta.description, og.title, og.description, tw.title, tw.description].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function expectNoBannedClaims(where: string, text: string) {
  for (const { pattern, reason } of AGENT_COPY_BANNED_PATTERNS) {
    const match = text.match(pattern);
    if (match) throw new Error(`${where} says "${match[0]}" (${reason})`);
  }
  // The shared rules the /tools and blog pages are scanned against.
  expect(findBannedClaims(text).map((hit) => `${where}: ${hit.match} (${hit.why})`)).toEqual([]);
  const lower = text.toLowerCase();
  for (const phrase of ["free trial", "card required", "never sleeps", "seven-day"]) {
    expect(lower).not.toContain(phrase);
  }
  // Nothing leaks from the markup or the implementer notes.
  expect(text).not.toMatch(/\*\*|`|\[[^\]]*\]\(|\{\w+\}|\bundefined\b|\bnull\b/);
  expect(text).not.toMatch(/\[(?:Link|Button|Live|Replace|Existing|Current)/i);
}

// Rendered text one block per line, so sentences from neighbouring elements
// never run together.
function blockText(main: HTMLElement): string {
  return [...main.querySelectorAll("h1, h2, h3, p, li, summary, dt, dd")].map((el) => el.textContent ?? "").join("\n");
}

// Every internal link inside <main> must point at a page that exists on this
// build (/pricing, /features and /terms are static routes; agent slugs come from the registry).
function expectInternalLinksResolve(main: HTMLElement) {
  for (const anchor of main.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      expect(main.querySelector(href)).not.toBeNull();
      continue;
    }
    if (!href.startsWith("/")) continue;
    const pathname = href.split(/[?#]/)[0];
    const agent = pathname.match(/^\/agents\/([^/]+)$/);
    if (agent) {
      expect(AGENT_SEO_ENTRIES.some((entry) => entry.slug === agent[1])).toBe(true);
      continue;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    // Clerk's pages live in an optional catch-all route (sign-up/[[...sign-up]]).
    const catchAll = path.join(APP_DIR, ...segments, `[[...${segments[segments.length - 1]}]]`, "page.tsx");
    expect(fs.existsSync(path.join(APP_DIR, ...segments, "page.tsx")) || fs.existsSync(catchAll)).toBe(true);
  }
}

describe("/agents hub", () => {
  it("renders one H1, a self-canonical and the full ItemList", () => {
    const { container } = render(<AgentsIndexPage />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Pick your agent. We'll give it a computer.");

    expect(hubMetadata.alternates?.canonical).toBe("https://hivra.cloud/agents");
    expect((hubMetadata.openGraph as { url?: string }).url).toBe("https://hivra.cloud/agents");

    const graph = readJsonLd(container);
    const itemList = graph.find((node) => node["@type"] === "ItemList") as { itemListElement: { url: string; name: string }[] };
    expect(itemList.itemListElement.map((item) => item.url)).toEqual(
      AGENT_SEO_ENTRIES.map((entry) => `https://hivra.cloud/agents/${entry.slug}`),
    );
    expect(graph.some((node) => node["@type"] === "BreadcrumbList")).toBe(true);
  });

  it("publishes Ash's finished browser title once, and the same title to Open Graph and Twitter", () => {
    const title = "Deploy AI Agents: Claude Code, Codex, Hermes and More | Hivra";
    // An absolute title skips the root layout's " | Hivra" template, so the brand appears once.
    expect(hubMetadata.title).toEqual({ absolute: title });
    expect((hubMetadata.openGraph as { title?: string }).title).toBe(title);
    expect((hubMetadata.twitter as { title?: string }).title).toBe(title);
    expect(title.match(/\|\s*Hivra/g)).toHaveLength(1);
    expect(hubMetadata.description).toBe(
      "Give Claude Code, Codex, Hermes, Aeon, OpenClaw or Agent Zero a cloud computer. Keep your own accounts and choose managed hosting from $9.99/mo.",
    );
    expect(String(hubMetadata.description).length).toBeLessThanOrEqual(155);
    expect((hubMetadata.openGraph as { description?: string }).description).toBe(hubMetadata.description);
  });

  // F-21: the intro said "private cloud VM" and "the provisioning" while the summary under it says
  // "private computer". The page now follows Ash's directory copy, which talks about a computer in the cloud.
  it("calls the thing an agent runs on a computer in its opening", () => {
    const { container } = render(<AgentsIndexPage />);
    const intro = container.querySelector("main header")?.textContent ?? "";
    expect(intro).toContain("Hivra gives each deployment a computer in the cloud");
    expect(intro).not.toMatch(/provisioning|\bthe machine\b/i);
  });

  it("links every agent page, sends signed-out visitors to sign-up and offers /pricing, /features and the directory anchor", () => {
    const { container } = render(<AgentsIndexPage />);
    const main = container.querySelector("main")!;
    const hrefs = [...main.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    for (const entry of AGENT_SEO_ENTRIES) expect(hrefs).toContain(`/agents/${entry.slug}`);
    expect(hrefs).toContain("/sign-up");
    expect(hrefs).toContain("/pricing");
    expect(hrefs).toContain("/features");
    expect(hrefs).toContain("#choose-an-agent");
    expect(main.querySelector("#choose-an-agent h2")).toHaveTextContent("Choose an agent");
    expect(hrefs.some((href) => href?.startsWith("/dashboard"))).toBe(false);
    expect(hrefs.some((href) => href?.startsWith("/launch"))).toBe(false);
    expectInternalLinksResolve(main);
  });

  it("links the repository for the source and self-hosting, and names no licence", () => {
    const { container } = render(<AgentsIndexPage />);
    const repoLinks = [...container.querySelectorAll('main a[href="https://github.com/ashneil12/hivra"]')];
    expect(repoLinks.map((a) => a.textContent)).toEqual(["Hivra's source", "self-hosting"]);
    for (const link of repoLinks) expect(link).toHaveAttribute("target", "_blank");
    expect(container.querySelector("main")!.textContent).not.toMatch(/public domain|licen[cs]e|\b(?:MIT|Apache|GPL)\b/i);
  });

  it("makes none of the banned claims in the page or its metadata", () => {
    const { container } = render(<AgentsIndexPage />);
    const text = [blockText(container.querySelector("main")!), ...metadataStrings(hubMetadata)].join("\n");
    expectNoBannedClaims("/agents", text);
    expect(text).toContain(MONEY_BACK_GUARANTEE);
    expect(text).toContain(AGENTS_HUB_AFFILIATION);
    expect(text).toContain("Hivra is an independent hosting service and is not affiliated with or endorsed by Anthropic, OpenAI, Nous Research");
    // The refund sentence links the published terms.
    expect(container.querySelector('main a[href="/terms"]')).toHaveTextContent("published terms");
  });

  it("says the plan does not include AI usage, and that Claude Code and Codex sign-ins are subject to the provider's terms", () => {
    const { container } = render(<AgentsIndexPage />);
    const text = blockText(container.querySelector("main")!);
    expect(text).toContain("The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.");
    expect(text).toContain("subject to the provider's terms");
    // The Hivra-credits promise sits behind "where the agent supports it", never as a blanket claim.
    expect(text).not.toMatch(/unlimited/i);
  });

  it("only promises Claude Code and Codex keep working when the run is started inside tmux", () => {
    const { container } = render(<AgentsIndexPage />);
    const text = blockText(container.querySelector("main")!);
    expect(unqualifiedKeepRunningClaims(text, /Claude Code|Codex/)).toEqual([]);
    expect(text).not.toMatch(/close the laptop and the work keeps going/i);
    expect(text).toMatch(/Long terminal-based coding jobs can continue in tmux/);
    expect(text).toMatch(/closing a browser tab does not make an ordinary interactive command persistent by itself/);
    expect(text).toContain("A paid Hivra computer isn't paused for inactivity.");
    // Aeon's work runs on the owner's GitHub Actions, not on the computer.
    expect(text).toMatch(/the scheduled tasks execute through your GitHub Actions/);
    expect(text).toContain("The dashboard computer counts as one of your agents but uses none of your plan's shared CPU and RAM.");
    // The hub states the paid rule once in its opening and once with the price.
    expect(text).toContain("Every Hivra Cloud computer needs a paid plan, and a paid computer stays available after you close your laptop.");
    expect(text).toContain("Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.");
    expect(text).not.toMatch(/\bthe box\b|Box Terminal/i);
  });

  it("lists the six agents in the directory with a tagline, a good fit and a link each", () => {
    const { container } = render(<AgentsIndexPage />);
    const rows = [...container.querySelectorAll("#choose-an-agent li")];
    expect(rows).toHaveLength(AGENT_SEO_ENTRIES.length);
    HUB_CONTENT.directory.cards.forEach((card, index) => {
      const row = rows[index];
      expect(row.querySelector("h3")).toHaveTextContent(card.name);
      expect(row.textContent).toContain(card.tagline);
      expect(row.textContent).toContain(`Good fit: ${card.goodFit}`);
      expect(row.querySelector("a")).toHaveAttribute("href", `/agents/${card.slug}`);
      expect(row.querySelector("a")).toHaveTextContent(card.linkLabel);
    });
  });
});

describe("/agents/[slug]", () => {
  it("prerenders exactly the catalog slugs and 404s the rest", async () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual(AGENT_SEO_ENTRIES.map((entry) => ({ slug: entry.slug })));
    await expect(generateMetadata({ params: Promise.resolve({ slug: "not-an-agent" }) })).resolves.toEqual({});
    await expect(AgentPage({ params: Promise.resolve({ slug: "not-an-agent" }) })).rejects.toThrow();
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: renders one H1, a self-canonical and its JSON-LD", async (entry) => {
    const agent = getAgent(entry.slug)!;
    const content = getAgentPageContent(entry.slug)!;
    const meta = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    const url = `https://hivra.cloud/agents/${entry.slug}`;
    expect(meta.alternates?.canonical).toBe(url);
    expect((meta.openGraph as { url?: string }).url).toBe(url);
    // The finished title, brand included, published once and the same to Open Graph and Twitter.
    expect(meta.title).toEqual({ absolute: agentPageTitle(entry) });
    expect((meta.openGraph as { title?: string }).title).toBe(agentPageTitle(entry));
    expect((meta.twitter as { title?: string }).title).toBe(agentPageTitle(entry));
    expect(agentPageTitle(entry).match(/\|\s*Hivra/g)).toHaveLength(1);
    expect(meta.description).toBe(entry.metaDescription);
    expect((meta.twitter as { images?: string[] }).images).toEqual([`${url}/opengraph-image`]);

    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(content.h1);

    const graph = readJsonLd(container);
    const app = graph.find((node) => node["@type"] === "SoftwareApplication") as {
      name: string;
      offers: { price: string; priceCurrency: string };
    };
    expect(app.name).toBe(`${agent.name} on Hivra`);
    expect(app.offers).toMatchObject({ "@type": "Offer", price: "9.99", priceCurrency: "USD" });
    // The price is per month, and the node carries no invented rating or review.
    expect(app.offers).toMatchObject({
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "9.99",
        priceCurrency: "USD",
        unitText: "MONTH",
        billingDuration: "P1M",
      },
    });
    expect(app).not.toHaveProperty("aggregateRating");
    expect(app).not.toHaveProperty("review");
    const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList") as { itemListElement: { item: string }[] };
    expect(crumbs.itemListElement.map((c) => c.item)).toEqual(["https://hivra.cloud", "https://hivra.cloud/agents", url]);
  });

  // FAQPage JSON-LD mirrors the visible questions and answers exactly.
  it.each(AGENT_SEO_ENTRIES)("$slug: the FAQ JSON-LD says exactly what the page shows", async (entry) => {
    const content = getAgentPageContent(entry.slug)!;
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const faq = readJsonLd(container).find((node) => node["@type"] === "FAQPage") as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    const details = [...container.querySelectorAll("#common-questions details")];
    expect(details).toHaveLength(content.faqs.length);
    expect(faq.mainEntity).toHaveLength(content.faqs.length);
    details.forEach((detail, index) => {
      const question = detail.querySelector("summary")!.textContent!.replace(/\+$/, "");
      const answer = detail.querySelector("div")!.textContent!;
      expect(question).toBe(faq.mainEntity[index].name);
      expect(answer).toBe(faq.mainEntity[index].acceptedAnswer.text);
      expect(faq.mainEntity[index].acceptedAnswer.text).toBe(plainText(content.faqs[index].a));
    });
    // A "Common questions" heading, as in the md.
    expect(container.querySelector("#common-questions h2")).toHaveTextContent("Common questions");
  });

  // A two-sentence heading breaks between its sentences, not inside the second one. The words and the space
  // between the sentences stay as the md writes them.
  it("sets each sentence of a two-sentence heading on its own line without changing its words", async () => {
    const aeon = getAgentPageContent("aeon")!;
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: "aeon" }) }));
    const h1 = container.querySelector("h1")!;
    expect([...h1.querySelectorAll(":scope > span")].map((span) => span.textContent)).toEqual([
      "Give Aeon a schedule.",
      "Let your GitHub do the work.",
    ]);
    expect(h1.textContent).toBe(aeon.h1);
    cleanup();
    // One sentence stays plain text.
    const single = render(await AgentPage({ params: Promise.resolve({ slug: "codex" }) }));
    expect(single.container.querySelector("h1 > span")).toBeNull();
    expect(single.container.querySelector("h1")!.textContent).toBe(getAgentPageContent("codex")!.h1);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: shows every section of the copy, in order, with a contents link to each", async (entry) => {
    const content = getAgentPageContent(entry.slug)!;
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const body = container.querySelector("main")!;
    const headings = [...body.querySelectorAll("article h2, section > h2")].map((h2) => h2.textContent);
    const expected = [...content.sections.map((section) => section.heading), "Common questions", content.closing.heading];
    expect(headings.filter((heading) => expected.includes(heading ?? ""))).toEqual(expected);
    const nav = body.querySelector('nav[aria-label="Article sections"]')!;
    const labels = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(labels).toEqual([...content.sections.map((section) => `#${slugifyHeading(section.heading)}`), "#common-questions"]);
    for (const href of labels) expect(body.querySelector(href!)).not.toBeNull();
    // Numbered steps keep the md's "1." markers.
    const steps = content.sections.flatMap((section) => section.blocks).find((block) => block.kind === "steps");
    expect(steps).toBeDefined();
    const markers = [...body.querySelectorAll("ol li > span[aria-hidden]")].map((span) => span.textContent);
    expect(markers).toEqual(["1.", "2.", "3.", "4."]);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: CTAs reach sign-up with the runtime preselected, plus /pricing and the other agents", async (entry) => {
    const content = getAgentPageContent(entry.slug)!;
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const main = container.querySelector("main")!;
    const hrefs = [...main.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((href) => href === agentDeployHref(entry)).length).toBeGreaterThanOrEqual(2);
    expect(hrefs).toContain("/pricing");
    expect(hrefs).toContain("/agents");
    for (const slug of content.related.slugs) expect(hrefs).toContain(`/agents/${slug}`);
    expect(hrefs).not.toContain(`/agents/${entry.slug}`);
    expect(hrefs.some((href) => href?.startsWith("/dashboard"))).toBe(false);
    expect(hrefs.some((href) => href?.startsWith("/launch"))).toBe(false);
    expectInternalLinksResolve(main);
    // The first button is the deploy button, in the header and in the closing row.
    const labels = [...main.querySelectorAll('a[data-kind="primary"]')].map((a) => a.textContent);
    expect(labels).toEqual([content.heroLinks[0].label, content.closing.links[0].label]);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: closes with the md's heading, affiliation line and related agents", async (entry) => {
    const content = getAgentPageContent(entry.slug)!;
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const main = container.querySelector("main")!;
    expect([...main.querySelectorAll("h2")].map((h2) => h2.textContent)).toContain(content.closing.heading);
    expect(main.textContent).toContain(content.affiliation);
    const related = [...main.querySelectorAll("h2")].find((h2) => h2.textContent === content.related.heading)!;
    expect(related).toBeDefined();
    expect([...related.parentElement!.querySelectorAll("a")].map((a) => a.textContent)).toEqual(
      content.related.slugs.map((slug) => getAgent(slug)!.name),
    );
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: makes none of the banned claims and keeps the non-affiliation line", async (entry) => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const text = [blockText(container.querySelector("main")!), ...metadataStrings(meta)].join("\n");
    expectNoBannedClaims(`/agents/${entry.slug}`, text);
    expect(text).toContain(getAgentPageContent(entry.slug)!.affiliation);
    // The refund is the shared card-payments wording wherever a page mentions it (the md has it on three agent pages).
    if (/money-back/i.test(text)) {
      expect(text).toContain(MONEY_BACK_GUARANTEE);
      expect(container.querySelector('main a[href="/terms"]')).toHaveTextContent("published terms");
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: has no placeholder, annotation or leaked implementer note on the page", async (entry) => {
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const text = container.querySelector("main")!.textContent ?? "";
    expect(text).not.toMatch(/\[[^\]]*\]/);
    expect(text).not.toMatch(/editorial checks|not website copy|implementation notes/i);
    expect(text).not.toMatch(/[–—]/);
  });

  it.each(CLI_RUN_AGENT_SLUGS.map((slug) => [slug]))(
    "%s: the rendered page promises only tmux (or Telegram) runs keep going, and says nothing about browser runs",
    async (slug) => {
      const content = getAgentPageContent(slug)!;
      const meta = await generateMetadata({ params: Promise.resolve({ slug }) });
      const { container } = render(await AgentPage({ params: Promise.resolve({ slug }) }));
      const questions = new Set(content.faqs.map((faq) => faq.q));
      // A question such as "Will Claude Code keep running when I shut my laptop?" is not a promise; its
      // answer, which names tmux, is scanned with everything else.
      const text = [blockText(container.querySelector("main")!), ...metadataStrings(meta)]
        .join("\n")
        .split("\n")
        .filter((line) => !questions.has(line.replace(/\+$/, "")))
        .join("\n");
      expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
      expect(text).toMatch(/\b(?:inside|within) tmux in (?:the computer's|the|Hivra's) Terminal tab/);
      expect(text).not.toMatch(/stops when you close|browser chat/i);
    },
  );

  it("Aeon names the GitHub token permissions and says the tasks run on GitHub Actions, on the page", async () => {
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: "aeon" }) }));
    const text = container.querySelector("main")!.textContent ?? "";
    expect(text).toContain("Secrets, Actions, Contents and Workflows");
    expect(text).toContain("scheduled workloads run through your own GitHub Actions");
    expect(text).toContain("Hivra cannot exempt those jobs from GitHub's Actions limits or pricing.");
  });

  it("Hermes says it runs on Hivra Cloud only, and every page says a Hivra Cloud computer needs a paid plan", async () => {
    const read = async (slug: string) => {
      const { container } = render(await AgentPage({ params: Promise.resolve({ slug }) }));
      const text = container.querySelector("main")!.textContent ?? "";
      cleanup();
      return text;
    };
    expect(await read("hermes")).toContain("Hermes runs on Hivra Cloud only.");
    // The paid rule is the same for every agent (owner decision 2026-10-21); no page says one agent "needs a paid size".
    for (const { slug } of AGENT_SEO_ENTRIES) {
      const text = await read(slug);
      expect(text).toMatch(/Every (?:computer that )?Hivra Cloud (?:runs for you )?(?:computer )?needs a paid plan/);
      expect(text).not.toMatch(/needs a paid size/);
      // The step headings do not single out OpenClaw or Agent Zero as the paid ones either.
      expect(text).not.toMatch(/Pick a paid plan|Choose Agent Zero and a paid plan/);
    }
    // The cost answers carry the rule from the shared sentence, not their own "hosting starts at" wording.
    for (const slug of ["aeon", "claude-code", "hermes"]) {
      const text = await read(slug);
      expect(text).not.toMatch(/(?:Managed|Hivra) hosting starts at/);
    }
    expect(await read("openclaw")).toContain("Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.");
    expect(await read("agent-zero")).toContain("Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.");
  });
});
