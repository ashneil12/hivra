/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render } from "@testing-library/react";

import ComparePage, { metadata as compareMetadata } from "../page";
import ComparisonPage, { generateMetadata, generateStaticParams } from "../[slug]/page";
import {
  MAX_META_DESCRIPTION_LENGTH,
  findBannedClaims,
  metadataCopy,
  metadataDescriptions,
  renderedCopy,
} from "../../features/__tests__/public-claims";

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

async function renderComparison(slug: string) {
  const element = await ComparisonPage({ params: Promise.resolve({ slug }) });
  return render(element);
}

async function comparisonText(slug: string) {
  const { container } = await renderComparison(slug);
  return container.textContent ?? "";
}

describe("comparison page claims", () => {
  afterEach(cleanup);

  it("makes no banned claim on /compare", () => {
    const { container } = render(<ComparePage />);
    const copy = [...renderedCopy(container), ...metadataCopy(compareMetadata)];
    expect(findBannedClaims("/compare", copy)).toEqual([]);
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
  });

  it.each(SLUGS)("makes no banned claim on /compare/%s, in the page, the JSON-LD or the metadata", async (slug) => {
    const { container } = await renderComparison(slug);
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const copy = [...renderedCopy(container), ...metadataCopy(metadata)];
    expect(findBannedClaims(`/compare/${slug}`, copy)).toEqual([]);
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
  });

  // Competitor numbers re-checked on each vendor's own page on 2026-09-24.
  // Update these with the copy when a vendor changes its prices.
  it("quotes the competitor prices that were verified, not the stale ones", async () => {
    const selfHosted = await comparisonText("vs-self-hosted");
    expect(selfHosted).toMatch(/CX23 \(2 vCPU, 4 GB\) costs €5\.49\/mo before VAT/);
    expect(selfHosted).toMatch(/CX33 \(€8\.49\/month, 4 vCPU 8 GB RAM\)/);
    expect(selfHosted).toMatch(/DigitalOcean's equivalent Droplets are \$24-48\/month/);

    const railway = await comparisonText("vs-railway");
    expect(railway).toMatch(/\$20 per vCPU and \$10 per GB of RAM per month/);
    expect(railway).toMatch(/\$0\.15 per GB of volume storage/);
    expect(railway).not.toMatch(/\$22/);

    const render_ = await comparisonText("vs-render");
    expect(render_).toMatch(/Starter compute plan \(\$7\/month\) has 512 MB RAM/);
    expect(render_).toMatch(/Standard compute plan at \$25\/month gives 1 CPU and 2 GB RAM/);
    expect(render_).toMatch(/Pro compute plan at \$85\/month gives 2 CPU and 4 GB RAM/);
    expect(render_).toMatch(/\$0\.25\/GB\/month/);
    expect(render_).toMatch(/after 15 minutes without inbound traffic/);

    for (const slug of SLUGS) {
      const text = await comparisonText(slug);
      expect(text).not.toMatch(/CX22|€7\.49|214,000|214k|700\+/);
    }
  });

  it("keeps every meta description short enough that search results show all of it", async () => {
    const tooLong: string[] = [];
    const check = (label: string, descriptions: string[]) => {
      for (const description of descriptions) {
        if (description.length > MAX_META_DESCRIPTION_LENGTH) tooLong.push(`${label} (${description.length}): ${description}`);
      }
    };
    check("/compare", metadataDescriptions(compareMetadata));
    for (const slug of SLUGS) {
      check(`/compare/${slug}`, metadataDescriptions(await generateMetadata({ params: Promise.resolve({ slug }) })));
    }
    expect(tooLong).toEqual([]);
  });

  it("states the two sellable sizes inline and scopes the JSON export to Claude Code and Codex", async () => {
    const alternatives = await comparisonText("ai-agent-hosting-alternatives");
    expect(alternatives).toMatch(/\$9\.99\/month for 2 vCPU and 4 GB RAM, or \$19\.99\/month for 4 vCPU and 8 GB RAM/);
    expect(alternatives).toMatch(/Yes, 7 days, card payments only/);
    for (const slug of SLUGS) {
      const text = await comparisonText(slug);
      expect(text).not.toMatch(/with JSON export|Chats and memory as one JSON file/);
    }
  });

  it("does not say Hivra cannot run OpenClaw, or that it imports OpenClaw itself", async () => {
    const text = await comparisonText("openclaw-to-hermes");
    expect(text).toMatch(/Hivra can host OpenClaw itself/);
    expect(text).toMatch(/hermes claw migrate/);
    expect(text).toMatch(/Hivra itself has no import tool/);
    expect(text).toMatch(/not affiliated with the OpenClaw project/);
    // OpenClaw has its own memory and scheduler (its docs and Hermes' migration
    // guide both say so); the old copy claimed it had neither.
    expect(text).not.toMatch(/Session-scoped by default|Not supported natively|no native long-term memory/i);
  });
});
