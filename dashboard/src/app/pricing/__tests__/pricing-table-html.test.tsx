/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import PricingPage from "../page";
import { PRICING_ROWS } from "../pricing-content";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// The AI crawlers that matter most do not run JavaScript (technical checklist
// C3), so the prices must be in the server-rendered HTML, not added on hydrate.
describe("/pricing raw server HTML", () => {
  const html = renderToStaticMarkup(<PricingPage />);

  it("contains the table with every row, the as-of date and the refund line", () => {
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect((html.match(/<tr>/g) ?? []).length).toBe(PRICING_ROWS.length + 1);
    for (const row of PRICING_ROWS) {
      expect(html).toContain(`<th scope="row">${row.option}</th>`);
      expect(html).toContain(row.price);
    }
    expect(html).toContain("Prices as of");
    // HTML attribute names are case-insensitive; React writes this one as dateTime.
    expect(html).toMatch(/<time datetime="2026-09-30">30 September 2026<\/time>/i);
    expect(html).toContain("7-day money-back guarantee on card payments");
  });

  it("carries the Offer JSON-LD in the same HTML", () => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks).toHaveLength(1);
    const graph = JSON.parse(blocks[0][1])["@graph"] as Array<{ "@type": string; offers?: Array<{ name: string; price: string }> }>;
    const app = graph.find((node) => node["@type"] === "SoftwareApplication");
    expect(app?.offers?.map((offer) => [offer.name, offer.price])).toEqual(
      PRICING_ROWS.map((row) => [row.option, row.priceAmount]),
    );
  });
});
