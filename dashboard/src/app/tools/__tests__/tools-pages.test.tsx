/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, within } from "@testing-library/react";

import ToolsIndexPage, { metadata as hubMetadata } from "../page";
import ToolPage, { dynamicParams, generateMetadata, generateStaticParams } from "../[slug]/page";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";
import { findBannedClaims } from "@/lib/tools/copy-rules";

const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
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

type Graph = { "@graph": Record<string, unknown>[] };

function readJsonLd(container: HTMLElement): Graph[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.innerHTML));
}

function metaValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

describe("/tools hub", () => {
  it("renders one H1, every tool once, both calls to action and no banned claims", () => {
    const { container } = render(<ToolsIndexPage />);

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    for (const entry of TOOL_ENTRIES) {
      const links = Array.from(container.querySelectorAll(`a[href="/tools/${entry.slug}"]`));
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveTextContent(entry.name);
    }
    expect(container.querySelector('a[href="/get-started?plan=operator"]')).not.toBeNull();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(container).toHaveTextContent("Hivra is independent and is not affiliated with Anthropic or OpenAI.");
    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);

    const [schema] = readJsonLd(container);
    const types = schema["@graph"].map((node) => node["@type"]);
    expect(types).toEqual(["CollectionPage", "BreadcrumbList"]);
    expect(readJsonLd(container)).toHaveLength(1);
  });

  it("has a self-canonical, its own social card and a title without the brand suffix", () => {
    expect(hubMetadata.title).toBe("Free Tools for Running AI Agents");
    expect(metaValue(hubMetadata.alternates, "canonical")).toBe("https://hivra.cloud/tools");
    expect(metaValue(hubMetadata.openGraph, "url")).toBe("https://hivra.cloud/tools");
    expect(metaValue(hubMetadata.twitter, "images")).toEqual(["https://hivra.cloud/tools/opengraph-image"]);
  });
});

describe("/tools/[slug]", () => {
  it("prerenders exactly the catalog's slugs and 404s anything else", async () => {
    expect(generateStaticParams()).toEqual(TOOL_ENTRIES.map((entry) => ({ slug: entry.slug })));
    expect(dynamicParams).toBe(false);
    await expect(ToolPage({ params: Promise.resolve({ slug: "not-a-tool" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata({ params: Promise.resolve({ slug: "not-a-tool" }) })).toEqual({});
  });

  it.each(TOOL_ENTRIES)("$slug renders one H1, the tool, its FAQ schema and no banned claims", async (entry) => {
    const page = await ToolPage({ params: Promise.resolve({ slug: entry.slug }) });
    const { container } = render(page);

    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(entry.h1);
    expect(within(container).getByRole("region", { name: entry.name })).toBeInTheDocument();
    for (const faq of entry.faqs) expect(container).toHaveTextContent(faq.q);

    // Both calls to action, and the vendor line.
    expect(container.querySelector('a[href="/get-started?plan=operator"]')).not.toBeNull();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(container).toHaveTextContent("Hivra is independent and is not affiliated with");

    // Related links: one per destination, never the page itself.
    const relatedHrefs = entry.relatedLinks.map((link) => link.href);
    expect(new Set(relatedHrefs).size).toBe(relatedHrefs.length);
    expect(container.querySelector(`a[href="/tools/${entry.slug}"]`)).toBeNull();

    const schemas = readJsonLd(container);
    expect(schemas).toHaveLength(1);
    const graph = schemas[0]["@graph"];
    expect(graph.map((node) => node["@type"])).toEqual(["WebApplication", "BreadcrumbList", "FAQPage"]);
    expect((graph[2].mainEntity as unknown[]).length).toBe(entry.faqs.length);

    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
  });

  it.each(TOOL_ENTRIES)("$slug has a self-canonical and its own social card", async (entry) => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
    const url = `https://hivra.cloud/tools/${entry.slug}`;
    expect(metadata.title).toBe(entry.metaTitle);
    expect(metadata.description).toBe(entry.metaDescription);
    expect(metaValue(metadata.alternates, "canonical")).toBe(url);
    expect(metaValue(metadata.openGraph, "url")).toBe(url);
    expect(metaValue(metadata.twitter, "images")).toEqual([`${url}/opengraph-image`]);
  });
});
