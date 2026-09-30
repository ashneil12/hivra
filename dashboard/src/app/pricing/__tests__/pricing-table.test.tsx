/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import PricingPage from "../page";
import {
  HOSTED_SIZES,
  PRICES_AS_OF,
  PRICING_ROWS,
  buildPricingOffers,
  formatPricesAsOf,
} from "../pricing-content";
import { MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { PLANS } from "@/lib/subscription/plans";
import { findBannedClaims } from "@/lib/tools/copy-rules";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

type JsonNode = Record<string, unknown>;

function pricingGraph(container: HTMLElement): JsonNode[] {
  const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? "{}")["@graph"];
}

function tableRows(): Array<{ header: string; cells: string[] }> {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => ({
      header: within(row).getByRole("rowheader").textContent ?? "",
      cells: within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    }));
}

describe("/pricing table", () => {
  it("pins the prices and sizes to the date they were checked", () => {
    // If a price or size in PLANS changes, this fails: update PRICING_ROWS'
    // expectations here and move PRICES_AS_OF to the day it was checked.
    expect(PRICES_AS_OF).toBe("2026-09-30");
    expect(formatPricesAsOf()).toBe("30 September 2026");
    expect(PRICING_ROWS.map(({ key, option, vcpu, ram, price }) => ({ key, option, vcpu, ram, price }))).toEqual([
      { key: "self-host", option: "Self-host", vcpu: "Your server", ram: "Your server", price: "$0" },
      { key: "operator", option: "Hivra Cloud, 2 vCPU and 4 GB", vcpu: "2", ram: "4 GB", price: "$9.99" },
      { key: "fleet", option: "Hivra Cloud, 4 vCPU and 8 GB", vcpu: "4", ram: "8 GB", price: "$19.99" },
    ]);
  });

  it("reads every hosted row from PLANS, the plans checkout sells", () => {
    const hosted = PRICING_ROWS.filter((row) => row.monthly);
    expect(hosted.map((row) => row.key)).toEqual(HOSTED_SIZES.map((size) => size.planKey));
    for (const row of hosted) {
      const plan = PLANS[row.key as "operator" | "fleet"];
      expect(row.price).toBe(`$${(plan.price / 100).toFixed(2)}`);
      expect(row.priceAmount).toBe((plan.price / 100).toFixed(2));
      expect(row.vcpu).toBe(String(plan.totalCpu));
      expect(row.ram).toBe(`${plan.totalRam / 1024} GB`);
      expect(row.refund).toBe(MONEY_BACK_GUARANTEE);
    }
  });

  it("renders a semantic table with column headers, row headers and the as-of date", () => {
    render(<PricingPage />);
    const table = screen.getByRole("table", { name: "Hivra sizes and prices, in US dollars" });

    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Size",
      "vCPU",
      "RAM",
      "Price per month",
      "Billing",
      "Refund",
    ]);
    for (const header of within(table).getAllByRole("columnheader")) expect(header).toHaveAttribute("scope", "col");
    for (const header of within(table).getAllByRole("rowheader")) expect(header).toHaveAttribute("scope", "row");

    expect(tableRows()).toEqual(
      PRICING_ROWS.map((row) => ({
        header: row.option,
        cells: [row.vcpu, row.ram, `${row.price} ${row.priceFor}`, row.billing, row.refund],
      })),
    );

    const asOf = screen.getByText(/^Prices as of/);
    expect(asOf).toHaveTextContent("Prices as of 30 September 2026.");
    expect(asOf.querySelector("time")).toHaveAttribute("datetime", "2026-09-30");
  });

  it("publishes Offer JSON-LD that matches the table row for row", () => {
    const { container } = render(<PricingPage />);
    const app = pricingGraph(container).find((node) => node["@type"] === "SoftwareApplication") as JsonNode;
    const offers = app.offers as JsonNode[];
    const rows = tableRows();

    expect(offers).toHaveLength(rows.length);
    offers.forEach((offer, index) => {
      const row = PRICING_ROWS[index];
      const shown = rows[index];
      expect(offer["@type"]).toBe("Offer");
      expect(offer.name).toBe(shown.header);
      expect(offer.priceCurrency).toBe("USD");
      // The JSON-LD price is the visible price without its dollar sign.
      expect(`$${offer.price}`).toBe(shown.cells[2].split(" ")[0]);
      expect(offer.url).toBe("https://hivra.cloud/pricing#pricing-table");
      if (row.monthly) {
        expect(offer.priceSpecification).toEqual({
          "@type": "UnitPriceSpecification",
          price: offer.price,
          priceCurrency: "USD",
          billingDuration: "P1M",
        });
        expect(offer.description).toContain(`${row.vcpu} vCPU and ${row.ram.replace(" GB", "")} GB`);
        expect(offer.description).toContain(shown.cells[4]);
      } else {
        expect(offer).not.toHaveProperty("priceSpecification");
        expect(offer.price).toBe("0");
      }
    });
  });

  it("builds offers from the rows alone, so another origin gets the same numbers", () => {
    const offers = buildPricingOffers("https://example.test");
    expect(offers.map((offer) => [offer.name, offer.price])).toEqual([
      ["Self-host", "0"],
      ["Hivra Cloud, 2 vCPU and 4 GB", "9.99"],
      ["Hivra Cloud, 4 vCPU and 8 GB", "19.99"],
    ]);
    expect(offers.every((offer) => String(offer.url).startsWith("https://example.test/pricing"))).toBe(true);
  });

  it("states the pool, the paid-size and Hermes limits without banned claims in the table, offers or notes", () => {
    const { container } = render(<PricingPage />);
    const table = screen.getByRole("table");
    const offers = JSON.stringify(buildPricingOffers("https://hivra.cloud"));
    const text = [table.textContent ?? "", offers, container.textContent ?? ""].join("\n");

    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/per computer|each computer|free trial|hosted free|annual|yearly|\/yr/i);
    expect(screen.getByText("OpenClaw and Agent Zero need a paid size. Hermes runs on Hivra Cloud only.")).toBeInTheDocument();
    expect(screen.getByText(/Each plan is a pool of CPU and memory for your agents/)).toBeInTheDocument();
  });
});
