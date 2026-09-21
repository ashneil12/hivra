/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";
import PricingSection from "../PricingSection";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { MARKETING_COPY, SUPPORTED_LOCALES } from "@/lib/i18n";

// Use real links and rendering. Animation mocks previously hid the blank-pricing regression.
describe("PricingSection", () => {
  it("offers the free platform on the customer's own infrastructure", () => {
    render(<PricingSection />);
    const own = within(screen.getByRole("article", { name: "Free platform" }));

    expect(own.getByText("$0")).toBeVisible();
    expect(own.getByText("platform fee")).toBeVisible();
    expect(own.getByText("Your server or cloud")).toBeVisible();
    expect(own.getByRole("link", { name: "Connect your server or cloud" })).toHaveAttribute(
      "href", "/dashboard/infrastructure",
    );
    expect(screen.getByText(/infrastructure and model provider's charges are separate/)).toBeVisible();
  });

  it("shows paid hosted capacity as an optional addition to the free platform", () => {
    render(<PricingSection />);
    const hosted = within(screen.getByRole("article", { name: "Hivra Cloud" }));

    expect(hosted.getByText("Paid")).toBeVisible();
    expect(hosted.getByText("Billed separately")).toBeVisible();
    expect(hosted.getByText("Free")).toBeVisible();
    expect(hosted.getByRole("link", { name: "View hosted options" })).toHaveAttribute(
      "href", "/dashboard/infrastructure",
    );
    expect(screen.getByText(/Adding Hivra Cloud capacity is optional/)).toBeVisible();
    for (const link of screen.getAllByRole("link")) expect(link).not.toHaveAttribute("target");
  });

  it("does not market the retired starter-compute, trial or agent-subscription offer", () => {
    render(<PricingSection />);
    const pricing = screen.getByRole("region", { name: /The platform is free/ });

    expect(pricing).not.toHaveTextContent(/trial|starter agent|starter compute|concurrent|active agent|vCPU|GB RAM|allowance/i);
    expect(pricing).not.toHaveTextContent(/\$9\.99|\$19\.99|HermesOS|40%/);
    expect(screen.queryByRole("article", { name: "Pro" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Power" })).not.toBeInTheDocument();
    expect(pricing.querySelector('a[href*="plan="]')).toBeNull();
  });

  it.each(SUPPORTED_LOCALES)("uses the corrected offer in %s without falling back to old localized tiers", (locale) => {
    render(<LocaleProvider initialLocale={locale}><PricingSection /></LocaleProvider>);
    const articles = screen.getAllByRole("article");

    expect(articles).toHaveLength(2);
    expect(within(articles[0]).getByText("$0")).toBeVisible();
    expect(within(articles[1]).getByRole("heading", { level: 3, name: "Hivra Cloud" })).toBeVisible();
    expect(articles[1]).not.toHaveTextContent(/\$\d/);
    for (const article of articles) {
      expect(article).toBeVisible();
      const link = within(article).getByRole("link");
      expect(link).toBeVisible();
      expect(link).toHaveAttribute("href", "/dashboard/infrastructure");
    }
    for (const retiredTier of MARKETING_COPY[locale].pricing.tiers) {
      expect(screen.queryByRole("link", { name: retiredTier.ctaLabel })).not.toBeInTheDocument();
    }
    if (locale !== "en") {
      expect(screen.queryByText("The platform is free.")).not.toBeInTheDocument();
      expect(screen.queryByText("View hosted options")).not.toBeInTheDocument();
    }
  });
});
