/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

import DocsHubPage from "../page";
import DocPage, { generateMetadata, generateStaticParams } from "../[slug]/page";
import { DOCS, DOC_SECTIONS } from "@/lib/docs/registry";
import { getSiteUrls } from "@/lib/seo-urls";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({
  __esModule: true,
  default: () => <nav aria-label="Article contents" />,
}));
jest.mock("@/components/markdown/CodeBlock", () => ({
  CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

afterEach(cleanup);

describe("/docs", () => {
  it("links every doc from the hub, under its section", () => {
    render(<DocsHubPage />);
    for (const section of DOC_SECTIONS) {
      expect(screen.getByRole("heading", { level: 2, name: section.title })).toBeInTheDocument();
      for (const slug of section.docs) {
        expect(document.querySelector(`a[href="/docs/${slug}"]`)).not.toBeNull();
      }
    }
  });

  it("renders every doc page with its title and every block heading", async () => {
    expect(generateStaticParams().map(({ slug }) => slug).sort()).toEqual(Object.keys(DOCS).sort());
    for (const doc of Object.values(DOCS)) {
      render(await DocPage({ params: Promise.resolve({ slug: doc.slug }) }));
      expect(screen.getByRole("heading", { level: 1, name: doc.title })).toBeInTheDocument();
      for (const block of doc.blocks) expect(screen.getByRole("heading", { level: 2, name: block.heading })).toBeInTheDocument();
      const metadata = await generateMetadata({ params: Promise.resolve({ slug: doc.slug }) });
      expect(metadata.description).toBe(doc.metaDescription);
      expect(metadata.alternates?.canonical).toBe(`https://hivra.cloud/docs/${doc.slug}`);
      cleanup();
    }
  });

  it("lists the hub and every doc in the sitemap", () => {
    const urls = getSiteUrls().map((entry) => entry.url);
    expect(urls).toContain("https://hivra.cloud/docs");
    for (const slug of Object.keys(DOCS)) expect(urls).toContain(`https://hivra.cloud/docs/${slug}`);
  });
});
