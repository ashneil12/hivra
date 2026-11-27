/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { getCardTrialOffer } from "@/lib/billing/card-trial";
import { PLANS } from "@/lib/subscription/plans";
import { HOSTED_COMPETITORS, hostedComparisonPath } from "@/lib/compare/hosted-competitors";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { SITE_URL } from "@/lib/seo-urls";
import PricingPage from "../../pricing/page";
import ComparePage from "../page";
import ComparisonPage, { generateMetadata, generateStaticParams } from "../[slug]/page";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/lib/billing/card-trial", () => ({ getCardTrialOffer: jest.fn() }));
jest.mock("@/lib/compliance/token-surface-view", () => ({ getTokenSurfaceView: async () => null, tokenSurfacesVisible: () => false }));
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({ __esModule: true, default: () => null }));

function products(container: HTMLElement) {
  const graph = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!)["@graph"];
  return graph.filter((item: { "@type": string }) => item["@type"] === "Product");
}

function detail(slug: string) {
  return ComparisonPage({ params: Promise.resolve({ slug }) });
}

afterEach(() => jest.resetAllMocks());

it.each(HOSTED_COMPETITORS)("serves a dated, cited table for every $name tier", async (provider) => {
  expect(generateStaticParams()).toContainEqual({ slug: provider.slug });
  const metadata = await generateMetadata({ params: Promise.resolve({ slug: provider.slug }) });
  expect(metadata.alternates?.canonical).toBe(`${SITE_URL}${hostedComparisonPath(provider.slug)}`);
  const { getAllByRole } = render(await detail(provider.slug));
  const tables = getAllByRole("table");
  expect(tables).toHaveLength(provider.tiers.length);
  for (const table of tables) {
    expect(table.querySelector("time")).toHaveAttribute("datetime", provider.checked);
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(row.lastElementChild?.querySelector("a")).toHaveAttribute("href", expect.stringMatching(/^https:\/\//));
    }
  }
});

it("compares Agent 37's free wake behavior, equal-price CPU advantage and lower-cost 8 GB comparison", async () => {
  const { getByRole, container } = render(await detail("agent37"));
  const free = within(getByRole("table", { name: "Agent 37 Free vs Hivra Cloud" }));
  expect(free.getByText("Sleeps after 15 minutes idle")).toBeVisible();
  expect(free.getByText(/wakes when you message it/i)).toBeVisible();
  expect(free.getAllByText("Not comparable")).toHaveLength(2);
  const plus = within(getByRole("table", { name: "Agent 37 Plus vs Hivra Cloud" }));
  expect(plus.getByText("12 GB")).toHaveAttribute("href", "https://www.agent37.com/personal");
  expect(plus.getByRole("row", { name: /Monthly price per listed CPU/ })).toHaveTextContent("$5.00");
  const pro = within(getByRole("table", { name: "Agent 37 Pro vs Hivra Cloud" }));
  expect(pro.getByRole("row", { name: /Monthly price per listed CPU/ })).toHaveTextContent("$15.00");
  expect(container).toHaveTextContent("twice the listed CPU count and the same RAM at the same monthly price");
  expect(container).toHaveTextContent("for $10.00 less per month");
});

it.each([undefined, 1234])("shares both live sizes with JSON-LD, pricing links and llms.txt (entry override: %s)", async (entryMonthlyCents) => {
  jest.mocked(getCardTrialOffer).mockReturnValue(entryMonthlyCents === undefined ? null : { monthlyCents: entryMonthlyCents });
  const pricing = render(await PricingPage());
  const hub = render(<ComparePage />);
  const comparison = render(await detail("agent37"));
  const schema = products(pricing.container);
  expect(products(hub.container)).toEqual(schema);
  expect(products(comparison.container)).toEqual(schema);
  expect(schema).toHaveLength(2);
  const llms = buildLlmsTxt({ siteUrl: SITE_URL, entryMonthlyCents });
  for (const [index, key] of (["operator", "fleet"] as const).entries()) {
    const plan = PLANS[key];
    const amount = ((key === "operator" ? entryMonthlyCents ?? plan.price : plan.price) / 100).toFixed(2);
    expect(schema[index]).toMatchObject({
      url: `${SITE_URL}/pricing#cloud-${key}`,
      additionalProperty: [{ name: "vCPU", value: plan.totalCpu }, { name: "RAM", value: plan.totalRam / 1024 }],
      offers: { "@type": "Offer", price: amount, priceCurrency: "USD", priceSpecification: { billingDuration: "P1M" } },
    });
    expect(llms).toContain(`/pricing#cloud-${key}): $${amount} USD a month for ${plan.totalCpu} vCPU and ${plan.totalRam / 1024} GB`);
    expect(pricing.container.querySelector(`#cloud-${key}`)).toHaveTextContent(`$${amount}`);
  }
  for (const provider of HOSTED_COMPETITORS) {
    const path = hostedComparisonPath(provider.slug);
    expect(pricing.container.querySelector(`a[href="${path}"]`)).not.toBeNull();
    expect(hub.container.querySelector(`a[href="${path}"]`)).not.toBeNull();
    expect(llms).toContain(`(${SITE_URL}${path})`);
  }
  expect(llms).toContain("no plan-level disk allowance published");
  expect(llms).not.toContain("/pricing#cloud-command");
});
