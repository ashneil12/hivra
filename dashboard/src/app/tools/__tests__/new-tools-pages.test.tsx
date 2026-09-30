/** @jest-environment jsdom */
// Rendered text, metadata and structured data of the two newer tool pages,
// scanned against the public-copy rules: keep-mac-awake and tmux-cheat-sheet.
import "@testing-library/jest-dom";
import React from "react";
import { render, within } from "@testing-library/react";

import ToolsIndexPage, { metadata as hubMetadata } from "../page";
import ToolPage, { generateMetadata } from "../[slug]/page";
import { TOOLS_HUB, getToolEntry, nonAffiliationLine, toolOgImage } from "@/lib/tools/tool-catalog";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import sitemap from "@/app/sitemap";

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

const NEW_SLUGS = ["keep-mac-awake", "tmux-cheat-sheet"] as const;

type Graph = { "@graph": Record<string, unknown>[] };
const readJsonLd = (container: HTMLElement): Graph[] =>
  Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.innerHTML));

function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => everyString(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => everyString(item, out));
  return out;
}

describe.each(NEW_SLUGS)("/tools/%s", (slug) => {
  const entry = getToolEntry(slug)!;

  it("renders one H1 with the head-query wording, the tool, the method, the examples, the FAQ and a cite block", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(entry.h1);
    expect(within(container).getByRole("region", { name: entry.name })).toBeInTheDocument();

    const method = container.querySelector("#method") as HTMLElement;
    expect(within(method).getByRole("heading", { level: 2, name: entry.method!.heading })).toBeInTheDocument();
    expect(method).toHaveTextContent("Last verified 2026-09-30.");
    for (const paragraph of entry.method!.paragraphs) expect(method).toHaveTextContent(paragraph.text.slice(0, 60));
    for (const source of entry.method!.paragraphs.flatMap((paragraph) => paragraph.sources ?? [])) {
      const links = Array.from(method.querySelectorAll(`a[href="${source.url}"]`));
      expect(links.length).toBeGreaterThanOrEqual(1);
      expect(links[0]).toHaveTextContent(source.label);
    }
    expect(within(method).getByRole("heading", { level: 2, name: "Worked examples" })).toBeInTheDocument();
    expect(within(method).getAllByRole("article")).toHaveLength(entry.examples!.length);
    for (const example of entry.examples!) expect(method).toHaveTextContent(example.title);

    const cite = within(method).getByTestId("cite-block");
    expect(cite).toHaveTextContent(`Hivra, "${entry.name}", https://hivra.cloud/tools/${slug}, facts last verified 2026-09-30.`);
    expect(cite).toHaveTextContent(`<a href="https://hivra.cloud/tools/${slug}">Hivra</a>`);
    // Brand anchor only: the snippet's link text never carries the topic.
    expect(cite.textContent).toMatch(/>Hivra<\/a>/);
    for (const faq of entry.faqs) expect(container).toHaveTextContent(faq.q);
  });

  it("links the survival check and the other new tool, and is linked from the hub", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    expect(container.querySelector('a[href="/tools/agent-survival-check"]')).not.toBeNull();
    const other = NEW_SLUGS.find((candidate) => candidate !== slug)!;
    expect(container.querySelector(`a[href="/tools/${other}"]`)).not.toBeNull();
    expect(container.querySelector(`a[href="/tools/${slug}"]`)).toBeNull();

    const hub = render(<ToolsIndexPage />);
    const links = hub.container.querySelectorAll(`a[href="/tools/${slug}"]`);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent(entry.name);
  });

  it("makes no banned claim in its rendered text, and qualifies every keep-running sentence", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    const text = container.textContent ?? "";
    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/\bWindows\b/);
    expect(text).not.toMatch(/[–—]/);
    const blocks = [...container.querySelectorAll("p, li, h2, h3, pre, figcaption")].map((el) => el.textContent ?? "").join("\n");
    expect(unqualifiedKeepRunningClaims(blocks, /Hivra|managed|always-on/i)).toEqual([]);
    expect(unknownDashboardNames(blocks)).toEqual([]);
    expect(text).not.toMatch(/\b(?:box|instance|runtime)s?\b/i);
  });

  it("makes no banned claim in its metadata, social card or structured data", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    const strings = [...everyString(metadata), ...everyString(toolOgImage(slug)), ...readJsonLd(container).flatMap((graph) => everyString(graph))];
    expect(strings.length).toBeGreaterThan(20);
    for (const text of strings) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      expect(text).not.toMatch(/\bWindows\b/);
    }
  });

  it("has the base URL as canonical, and no rating invented in its structured data", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect((metadata.alternates as { canonical: string }).canonical).toBe(`https://hivra.cloud/tools/${slug}`);
    expect(metadata.title).toBe(entry.metaTitle);
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    const [schema] = readJsonLd(container);
    expect(schema["@graph"].map((node) => node["@type"])).toEqual(["WebApplication", "BreadcrumbList", "FAQPage"]);
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/aggregateRating|ratingValue|reviewCount|"review"/);
    expect(json).toContain('"price":"0"');
  });

  it("names every vendor it discusses in its non-affiliation line", async () => {
    const { container } = render(await ToolPage({ params: Promise.resolve({ slug }) }));
    expect(container).toHaveTextContent(nonAffiliationLine(entry.vendors));
  });
});

describe("the hub, the sitemap and llms.txt carry the two new tools", () => {
  it("lists them on the hub with no banned claim in the hub's text or metadata", () => {
    const { container } = render(<ToolsIndexPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("Keep Mac Awake Command Builder");
    expect(text).toContain("tmux Cheat Sheet for AI Coding Agents");
    expect(findBannedClaims(text)).toEqual([]);
    const strings = [...everyString(hubMetadata), ...everyString(TOOLS_HUB), ...readJsonLd(container).flatMap((graph) => everyString(graph))];
    for (const item of strings) expect({ item, hits: findBannedClaims(item) }).toEqual({ item, hits: [] });
    const list = readJsonLd(container)[0]["@graph"][0] as { mainEntity: { itemListElement: { url: string }[] } };
    const urls = list.mainEntity.itemListElement.map((item) => item.url);
    expect(urls).toContain("https://hivra.cloud/tools/keep-mac-awake");
    expect(urls).toContain("https://hivra.cloud/tools/tmux-cheat-sheet");
  });

  it("puts both in the sitemap through the catalog", () => {
    const urls = sitemap().map((item) => item.url);
    expect(urls).toContain("https://hivra.cloud/tools/keep-mac-awake");
    expect(urls).toContain("https://hivra.cloud/tools/tmux-cheat-sheet");
  });
});
