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
  AGENT_COPY_BANNED_PATTERNS,
  AGENT_SEO_ENTRIES,
  CLI_RUN_AGENT_SLUGS,
  agentDeployHref,
  unqualifiedKeepRunningClaims,
} from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { BLOG_ARTICLES } from "@/lib/blog-data";

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

function metadataStrings(meta: Metadata): string[] {
  const og = (meta.openGraph ?? {}) as Record<string, unknown>;
  const tw = (meta.twitter ?? {}) as Record<string, unknown>;
  return [meta.title, meta.description, og.title, og.description, tw.title, tw.description].filter(
    (value): value is string => typeof value === "string",
  );
}

function expectNoBannedClaims(where: string, text: string) {
  for (const { pattern, reason } of AGENT_COPY_BANNED_PATTERNS) {
    const match = text.match(pattern);
    if (match) throw new Error(`${where} says "${match[0]}" (${reason})`);
  }
  const lower = text.toLowerCase();
  for (const phrase of ["free trial", "card required", "never sleeps"]) {
    expect(lower).not.toContain(phrase);
  }
}

// Rendered text one block per line, so sentences from neighbouring elements
// never run together.
function blockText(main: HTMLElement): string {
  return [...main.querySelectorAll("h1, h2, h3, p, li, summary")].map((el) => el.textContent ?? "").join("\n");
}

// Every internal link inside <main> must point at a page that exists on this
// build (/pricing is a static route; blog and agent slugs come from their
// registries).
function expectInternalLinksResolve(main: HTMLElement) {
  for (const anchor of main.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("/")) continue;
    const pathname = href.split(/[?#]/)[0];
    if (pathname === "/pricing") continue;
    const blog = pathname.match(/^\/blog\/([^/]+)$/);
    if (blog) {
      expect(BLOG_ARTICLES[blog[1]]).toBeDefined();
      continue;
    }
    const agent = pathname.match(/^\/agents\/([^/]+)$/);
    if (agent) {
      expect(AGENT_SEO_ENTRIES.some((entry) => entry.slug === agent[1])).toBe(true);
      continue;
    }
    if (pathname.startsWith("/compare/")) {
      expect(fs.readFileSync(path.join(APP_DIR, "compare", "[slug]", "page.tsx"), "utf8")).toContain(`"${pathname.slice("/compare/".length)}"`);
      continue;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    expect(fs.existsSync(path.join(APP_DIR, ...segments, "page.tsx"))).toBe(true);
  }
}

describe("/agents hub", () => {
  it("renders one H1, a self-canonical and the full ItemList", () => {
    const { container } = render(<AgentsIndexPage />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Agents you can deploy today.");

    expect(hubMetadata.alternates?.canonical).toBe("https://hivra.cloud/agents");
    expect((hubMetadata.openGraph as { url?: string }).url).toBe("https://hivra.cloud/agents");
    expect(String(hubMetadata.title)).not.toMatch(/\|\s*Hivra/);
    expect(String(hubMetadata.title).length).toBeLessThanOrEqual(55);
    expect(String(hubMetadata.description).length).toBeLessThanOrEqual(155);

    const graph = readJsonLd(container);
    const itemList = graph.find((node) => node["@type"] === "ItemList") as { itemListElement: { url: string; name: string }[] };
    expect(itemList.itemListElement.map((item) => item.url)).toEqual(
      AGENT_SEO_ENTRIES.map((entry) => `https://hivra.cloud/agents/${entry.slug}`),
    );
    expect(graph.some((node) => node["@type"] === "BreadcrumbList")).toBe(true);
  });

  it("links every agent page, sends signed-out visitors to sign-up and offers /pricing", () => {
    const { container } = render(<AgentsIndexPage />);
    const main = container.querySelector("main")!;
    const hrefs = [...main.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    for (const entry of AGENT_SEO_ENTRIES) expect(hrefs).toContain(`/agents/${entry.slug}`);
    expect(hrefs).toContain("/get-started?plan=operator");
    expect(hrefs).toContain("/pricing");
    expect(hrefs.some((href) => href?.startsWith("/dashboard"))).toBe(false);
    expectInternalLinksResolve(main);
  });

  it("makes none of the banned claims in the page or its metadata", () => {
    const { container } = render(<AgentsIndexPage />);
    const text = [container.querySelector("main")!.textContent ?? "", ...metadataStrings(hubMetadata)].join("\n");
    expectNoBannedClaims("/agents", text);
    expect(text).toContain("7-day money-back guarantee on card payments");
    expect(text).toContain("Hivra is independent and is not affiliated with Anthropic, OpenAI, Nous Research");
  });

  it("only promises Claude Code and Codex keep working when the run is started inside tmux", () => {
    const { container } = render(<AgentsIndexPage />);
    const text = blockText(container.querySelector("main")!);
    expect(unqualifiedKeepRunningClaims(text, /Claude Code|Codex/)).toEqual([]);
    expect(text).not.toMatch(/close the laptop and the work keeps going/i);
    expect(text).toMatch(/A Claude Code or Codex run you start inside tmux in the computer's Terminal tab keeps going/);
    // Aeon's work runs on the owner's GitHub Actions, not on the computer.
    expect(text).toMatch(/Aeon's tasks run on your own GitHub Actions/);
    expect(text).not.toMatch(/\bthe box\b|Box Terminal/i);
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
    const meta = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    const url = `https://hivra.cloud/agents/${entry.slug}`;
    expect(meta.alternates?.canonical).toBe(url);
    expect((meta.openGraph as { url?: string }).url).toBe(url);
    expect(meta.title).toBe(entry.metaTitle);
    expect(meta.description).toBe(entry.metaDescription);
    expect((meta.twitter as { images?: string[] }).images).toEqual([`${url}/opengraph-image`]);

    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(entry.h1);

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
    const faq = graph.find((node) => node["@type"] === "FAQPage") as { mainEntity: { name: string }[] };
    expect(faq.mainEntity.map((q) => q.name)).toEqual(entry.faqs.map((q) => q.q));
    const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList") as { itemListElement: { item: string }[] };
    expect(crumbs.itemListElement.map((c) => c.item)).toEqual(["https://hivra.cloud", "https://hivra.cloud/agents", url]);

    // Every table-of-contents target exists.
    for (const id of ["overview", "what-you-get", "how-it-works", "self-hosted-vs-managed", "common-questions"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: CTAs reach sign-up with the runtime preselected, plus /pricing", async (entry) => {
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const main = container.querySelector("main")!;
    const hrefs = [...main.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((href) => href === agentDeployHref(entry)).length).toBeGreaterThanOrEqual(2);
    expect(hrefs).toContain("/pricing");
    expect(hrefs).toContain("/agents");
    for (const blogSlug of entry.relatedBlogSlugs) expect(hrefs).toContain(`/blog/${blogSlug}`);
    expect(hrefs.some((href) => href?.startsWith("/dashboard"))).toBe(false);
    expectInternalLinksResolve(main);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: makes none of the banned claims and keeps the non-affiliation line", async (entry) => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    const { container } = render(await AgentPage({ params: Promise.resolve({ slug: entry.slug }) }));
    const text = [container.querySelector("main")!.textContent ?? "", ...metadataStrings(meta)].join("\n");
    expectNoBannedClaims(`/agents/${entry.slug}`, text);
    expect(text).toContain(entry.affiliation);
    expect(text).toContain("7-day money-back guarantee on card payments");
  });

  it.each(CLI_RUN_AGENT_SLUGS.map((slug) => [slug]))(
    "%s: the rendered page promises only tmux (or Telegram) runs keep going, and says nothing about browser runs",
    async (slug) => {
      const meta = await generateMetadata({ params: Promise.resolve({ slug }) });
      const { container } = render(await AgentPage({ params: Promise.resolve({ slug }) }));
      const text = [blockText(container.querySelector("main")!), ...metadataStrings(meta)].join("\n");
      expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
      expect(text).toMatch(/inside tmux in the computer's Terminal tab/);
      expect(text).not.toMatch(/stops when you close|browser chat/i);
    },
  );
});
