/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render } from "@testing-library/react";

import FeaturesPage, { metadata as featuresMetadata } from "../page";
import FeaturePage, { generateMetadata, generateStaticParams } from "../[slug]/page";
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

async function renderFeature(slug: string) {
  const element = await FeaturePage({ params: Promise.resolve({ slug }) });
  return render(element);
}

describe("feature page claims", () => {
  afterEach(cleanup);

  it("catches every claim these pages used to make, and leaves true copy alone", () => {
    for (const claim of KNOWN_FALSE_CLAIMS) {
      expect(findBannedClaims("fixture", [claim])).not.toEqual([]);
    }
    expect(findBannedClaims("fixture", KNOWN_TRUE_CLAIMS)).toEqual([]);
  });

  it("makes no banned claim on /features", () => {
    const { container } = render(<FeaturesPage />);
    const copy = [...renderedCopy(container), ...metadataCopy(featuresMetadata)];
    expect(findBannedClaims("/features", copy)).toEqual([]);
  });

  it.each(SLUGS)("makes no banned claim on /features/%s, in the page, the JSON-LD or the metadata", async (slug) => {
    const { container } = await renderFeature(slug);
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const copy = [...renderedCopy(container), ...metadataCopy(metadata)];
    expect(findBannedClaims(`/features/${slug}`, copy)).toEqual([]);
  });

  it.each(SLUGS)("links /features/%s to the pricing page", async (slug) => {
    const { container } = await renderFeature(slug);
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
  });

  it("does not present Hivra as Hermes-only on the OpenClaw page", async () => {
    const { container } = await renderFeature("openclaw-alternative");
    const text = container.textContent ?? "";
    // Hivra hosts OpenClaw itself (agent catalog, paid plans).
    expect(text).toMatch(/run OpenClaw itself/);
    expect(text).toMatch(/Claude Code, Codex/);
    // The only OpenClaw import is Hermes' own command, and the page says so.
    expect(text).toMatch(/hermes claw migrate/);
    expect(text).toMatch(/manual step/);
    expect(container.querySelector('a[href="https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw"]')).not.toBeNull();
    expect(text).toMatch(/not affiliated with the OpenClaw project/);
  });

  it("says agents run side by side and orchestration is not shipped", async () => {
    const { container } = await renderFeature("multi-agent");
    const text = container.textContent ?? "";
    expect(text).toMatch(/orchestration is planned, not shipped/);
    expect(text).not.toMatch(/Multi-Agent Coordination/i);
  });

  it("titles /features/multi-agent by account, since each agent runs on its own computer", async () => {
    const { container } = await renderFeature("multi-agent");
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "multi-agent" }) });
    expect(metadata.title).toBe("Run Multiple AI Agents From One Account");
    expect(container.querySelector("h1")?.textContent).toBe("One account. Several agents, each on its own computer.");
    // The two sizes checkout sells, stated inline rather than via /pricing,
    // which shows a preview ladder.
    expect(container.textContent).toMatch(/\$9\.99\/mo for 2 vCPU and 4 GB RAM, or \$19\.99\/mo for 4 vCPU and 8 GB RAM/);
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

  it("describes the browser, schedules and exports the product actually ships", async () => {
    const browser = (await renderFeature("browser-automation")).container.textContent ?? "";
    expect(browser).toMatch(/persistent Chromium/);
    expect(browser).toMatch(/Chrome DevTools Protocol/);
    expect(browser).toMatch(/live view/);
    cleanup();

    const tasks = (await renderFeature("scheduled-tasks")).container.textContent ?? "";
    expect(tasks).toMatch(/hourly, daily, weekly or monthly/);
    expect(tasks).toMatch(/Telegram, Discord, or email/);
    cleanup();

    const memory = (await renderFeature("persistent-memory")).container.textContent ?? "";
    expect(memory).toMatch(/file explorer/);
    expect(memory).toMatch(/Claude Code and Codex agents (?:also have|add) an Export data link/);
  });
});
