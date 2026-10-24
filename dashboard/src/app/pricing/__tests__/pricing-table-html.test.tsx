/** @jest-environment node */
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: jest.fn() }));
jest.mock("@/lib/compliance/token-surface-view", () => ({
  ...jest.requireActual("@/lib/compliance/token-surface-view"),
  getTokenSurfaceView: jest.fn().mockResolvedValue({ tokenSurfaces: false, geoBlocked: false }),
}));

import PricingPage from "../page";
import { PRICING_COMPARISON, PRICING_ROWS } from "../pricing-content";

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
  let html = "";
  beforeAll(async () => {
    html = renderToStaticMarkup(await PricingPage());
  });

  it("contains the table with every row, the as-of date and the refund line", () => {
    expect(html).toContain("<table");
    expect(html).toContain('id="pricing-table"');
    // A header row plus one row for each of the md's nine criteria.
    expect((html.match(/<tr\b/g) ?? []).length).toBe(PRICING_COMPARISON.rows.length + 1);
    for (const row of PRICING_COMPARISON.rows) expect(html).toContain(row.label);
    for (const row of PRICING_ROWS) expect(html).toContain(row.price);
    expect(html).toContain("Prices as of");
    // HTML attribute names are case-insensitive; React writes this one as dateTime.
    expect(html).toMatch(/<time datetime="2026-10-20">20 October 2026<\/time>/i);
    expect(html).toContain("7-day money-back guarantee on card payments");
  });

  it("carries the offers, the questions and the card copy in the same HTML", () => {
    expect(html).toContain("Choose 2 vCPU and 4 GB");
    expect(html).toContain("Choose 4 vCPU and 8 GB");
    expect(html).toContain("Questions people usually ask");
    expect(html).toContain("Is Hivra free?");
    // The token question stays out of the HTML while the surfaces are off.
    expect(html).not.toContain("HIVRA");
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

// jsdom does no layout, so these guard the stylesheet's own rules: the page's
// layouts must collapse on a narrow screen, and the table itself is the shared
// ComparisonTable (its stacking is covered in components/public-editorial).
describe("/pricing stylesheet", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "pricing.module.css"), "utf8");

  it("collapses the options panel, the prose sections and the closing band on a narrow screen", () => {
    // Three columns on a wide screen: the self-host column is a little wider because it carries the most copy.
    expect(css).toMatch(/\.offers\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.15fr\) repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 1099px\)\s*\{[^@]*\.offers\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(max-width: 899px\)\s*\{[^@]*\.split\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(max-width: 899px\)\s*\{[^@]*\.closing\s*\{\s*grid-template-columns:\s*1fr;/);
  });

  it("rules off the action row across the options panel, only where the columns sit side by side", () => {
    expect(css).toMatch(/\.offer\s*>\s*\.action::before\s*\{[^}]*border-top:\s*1px solid var\(--etched-border\)/);
    expect(css).toMatch(/@media \(max-width: 1099px\)\s*\{[^@]*\.offer\s*>\s*\.action::before\s*\{\s*display:\s*none;/);
  });

  it("never widens the page: no fixed minimum width, no nowrap, no dash", () => {
    expect(css).not.toMatch(/min-width:\s*\d{3,}px/);
    expect(css).not.toMatch(/white-space:\s*nowrap/);
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps long prose at a readable measure", () => {
    expect(css).toMatch(/\.prose\s*>\s*p\s*\{[^}]*max-width:\s*68ch/);
    // The large lede stays within the width of the body text under it.
    expect(css).toMatch(/\.prose\s*>\s*\.lede\s*\{[^}]*max-width:\s*44ch/);
    expect(css).toMatch(/\.answer\s*\{[^}]*max-width:\s*calc\(68ch/);
  });
});
