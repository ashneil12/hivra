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

  it.each(SLUGS)("/compare/%s closes with the copy's closing row", async (slug) => {
    expect(SLUGS).toHaveLength(9);
    const { container } = await renderComparison(slug);
    const closing = [...container.querySelectorAll("h2")].filter((h2) => h2.textContent === "Ready to give your agent a computer?");
    expect(closing).toHaveLength(1);
    const section = closing[0].closest("section");
    expect(section?.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(section?.querySelector('a[href="/agents"]')).not.toBeNull();
    expect([...(section?.querySelectorAll("a") ?? [])].map((a) => a.textContent)).toEqual(
      expect.arrayContaining(["Explore Hivra pricing", "Compare all options", "Browse features"]),
    );
    expect(container.textContent).not.toContain("stop managing infra");
    expect(container.textContent).not.toContain("Ready to leave server maintenance behind?");
  });

  // Competitor numbers: Hetzner, Railway and Render were re-read on their vendors' own pages (2026-09-24,
  // 2026-10-09 and again for the 2026-10-20 audit). Update these with the copy when a vendor changes its prices.
  it("quotes the competitor prices that were verified, not the stale ones", async () => {
    const selfHosted = await comparisonText("vs-self-hosted");
    expect(selfHosted).toMatch(/Hetzner CX23, with 2 vCPU and 4 GB RAM, is €5\.49 per month before VAT and a public IPv4 address/);
    expect(selfHosted).toMatch(/From €5\.49\/mo before VAT and a public IPv4 address \(unmanaged\)/);
    // The same server, in dollars and with Hetzner's own supply caveat, as the tools pages quote it (audit C1).
    expect(selfHosted).toContain("(Hetzner's price adjustment page lists the same server at $6.49 in US dollars for Germany and Finland)");
    expect(selfHosted).toContain("Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look.");
    expect(selfHosted).toContain("or $6.49 in US dollars for Germany and Finland. Hetzner says supply in this range is limited");

    const railway = await comparisonText("vs-railway");
    expect(railway).toMatch(/Usage-based: \$20\/vCPU and \$10\/GB RAM per month, plus plan fee/);
    expect(railway).not.toMatch(/\$22/);

    const render_ = await comparisonText("vs-render");
    expect(render_).toMatch(/Standard web service, listed at \$25 monthly with 1 CPU and 2 GB of RAM/);
    expect(render_).toMatch(/5 GB persistent disk costing \$1\.25/);
    expect(render_).toMatch(/around \$26\.25 before AI usage/);
    expect(render_).toMatch(/\$85\/mo \(2 CPU, 4 GB\) plus disk/);
    expect(render_).toMatch(/one-click Hermes template/);
    expect(render_).toMatch(/Free sleeps after 15 idle minutes; paid plans stay up/);

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
    expect(alternatives).toMatch(/Yes: 7-day money-back guarantee on card payments/);
    for (const slug of SLUGS) {
      const text = await comparisonText(slug);
      expect(text).not.toMatch(/with JSON export|Chats and memory as one JSON file/);
    }
  });

  // F-15: nothing measured backs an hour count or an hourly rate for setting up
  // a server, and the pages used to give three different answers. The reader's
  // own hours go into the calculator instead.
  it("states no setup-hour or hourly-rate figure for self-hosting, and sends readers to the calculator", async () => {
    for (const slug of ["vs-self-hosted", "ai-agent-hosting-alternatives"]) {
      const { container } = await renderComparison(slug);
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\d+\s*(?:-|–)\s*\d+\+?\s*hours?|\$\d+\s*\/\s*hour|by our estimate|multi-day project/i);
      expect(container.querySelector('a[href="/tools/ai-agent-hosting-cost-calculator"]')).not.toBeNull();
      cleanup();
    }
  });

  // F-29: the options table must not say something about every alternative that
  // the page's own sections contradict (OpenClaw has its own memory, browser
  // tools and scheduler; Hermes ships its own dashboard and cron), and must not
  // state other providers' guarantees.
  it("scopes the alternatives table to the options the page covers", async () => {
    const { container } = await renderComparison("ai-agent-hosting-alternatives");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/None in any alternative|on all alternatives|for alternatives\b/);
    // The audit of 2026-10-20 found "None in the options above" false: Cloudways lists Hermes as generally
    // available and Hermes brings its own dashboard to any host.
    expect(text).not.toMatch(/None in the options above/);
    expect(text).toMatch(/Hermes brings its own dashboard on any host/);
    expect(text).toMatch(/Varies by provider/);
    expect(text).toMatch(/Hermes has its own cron and OpenClaw has its own scheduler/);
    // Fly describes Sprites as persistent computers, so only E2B is called a short-lived sandbox.
    expect(text).toMatch(/E2B is aimed at short-lived code sandboxes, while Fly describes Sprites as persistent computers/);
    expect(container.querySelector("h1")?.textContent).not.toMatch(/\bEvery option\b/i);
    cleanup();
    const index = render(<ComparePage />);
    expect(index.container.textContent).not.toMatch(/here is every option/i);
  });

  it("does not say Hivra cannot run OpenClaw, or that it imports OpenClaw itself", async () => {
    const text = await comparisonText("openclaw-to-hermes");
    expect(text).toMatch(/Hivra can host it on a paid Hivra Cloud computer, just as it hosts Hermes/);
    // No agent is "the paid one" (owner decision 2026-10-21): the answer states the rule for every computer.
    expect(text).toMatch(/No\. Hivra can host OpenClaw as well as Hermes\. Every Hivra Cloud computer needs a paid plan\./);
    expect(text).not.toMatch(/Hivra supports paid OpenClaw deployments|supported paid computer/);
    expect(text).toMatch(/hermes claw migrate/);
    expect(text).toMatch(/Hivra itself has no import tool/);
    expect(text).toMatch(/not affiliated with the OpenClaw project/);
    // Hermes' own command does import memory and settings, so the page must not say nothing converts.
    expect(text).not.toMatch(/No automatic conversion of OpenClaw memory/);
    // OpenClaw has its own memory and scheduler (its docs and Hermes' migration
    // guide both say so); the old copy claimed it had neither.
    expect(text).not.toMatch(/Session-scoped by default|Not supported natively|no native long-term memory/i);
  });

  it("does not state what the vendors' own pages contradict or no longer show (audit 2026-10-20)", async () => {
    const railway = await comparisonText("vs-railway");
    // Railway has service metrics and logs, community Hermes templates and a scheduler of its own for jobs.
    expect(railway).not.toMatch(/Agent dashboard & monitoring\s*Built-in\s*None/);
    expect(railway).not.toMatch(/DIY from scratch|Requires custom Docker setup|Separate Railway cron service/);
    expect(railway).toMatch(/Community one-click Hermes templates exist/);

    const selfHosted = await comparisonText("vs-self-hosted");
    expect(selfHosted).not.toMatch(/None\. You build it|sometimes breaking|You script it/);
    expect(selfHosted).toMatch(/Hermes ships its own dashboard/);

    const xcloud = await comparisonText("vs-xcloud");
    expect(xcloud).not.toMatch(/More than 30 listed|at the time/);
    expect(xcloud).toMatch(/30\+ stated/);

    const hostinger = await comparisonText("vs-hostinger");
    expect(hostinger).not.toMatch(/No, proprietary|quicker/);
    // Hostinger's managed plan and KVM 2 were re-read on 2026-10-21 ($4.99 and $8.79, both shown as sale prices):
    // the superseded figures are gone and the page says they are sale prices to confirm.
    expect(hostinger).not.toMatch(/\$5\.99|\$143\.76|\$8\.99|since we checked/);
    expect(hostinger).toMatch(/promotion is \$4\.99 a month on a 24-month commitment/);
    expect(hostinger).toMatch(/\$119\.76 for 24 months, our arithmetic/);
    expect(hostinger).toMatch(/KVM 2 at \$8\.79\/mo/);
    expect(hostinger).toMatch(/shows both the managed plan and the KVM 2 VPS at sale prices, so confirm the current figures/);
  });
});
