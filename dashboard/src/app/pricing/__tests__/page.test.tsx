/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import PricingPage, { metadata } from "../page";
import { HOSTED_SIZES, PRICING_FAQ } from "../pricing-content";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";
import { PLANS } from "@/lib/subscription/plans";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

function jsonLd(container: HTMLElement): string {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? "").join("\n");
}

describe("/pricing page", () => {
  it("is indexable on its own URL, not the homepage canonical", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/pricing");
    expect(String(metadata.title)).not.toMatch(/\| Hivra/);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
  });

  it("has one H1 and shows self-hosting plus the two sizes checkout sells, read from its plans", () => {
    render(<PricingPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Self-host" })).toBeInTheDocument();
    expect(HOSTED_SIZES.map((size) => size.planKey)).toEqual(["operator", "fleet"]);
    for (const size of HOSTED_SIZES) {
      const plan = PLANS[size.planKey];
      expect(size.price).toBe(`$${(plan.price / 100).toFixed(2)}`);
      const card = screen.getByRole("article", { name: `${plan.totalCpu} vCPU, ${plan.totalRam / 1024} GB` });
      expect(card).toHaveTextContent(`${size.price}a month for ${plan.totalCpu} vCPU and ${plan.totalRam / 1024} GB of RAM`);
      // A button that names a paid plan carries that plan into checkout.
      expect(card.querySelector("a")).toHaveAttribute("href", `/get-started?plan=${size.planKey}`);
    }
  });

  // The proposed ladder's perks (snapshots and clones, two months free,
  // unlimited computers, Windows) are not shipped. It stays a labelled preview
  // on the homepage and is never repeated on this indexed page.
  it("repeats none of the preview ladder and makes no banned claim in the page, metadata or JSON-LD", () => {
    const { container } = render(<PricingPage />);
    const text = [container.textContent ?? "", String(metadata.title), String(metadata.description), jsonLd(container)].join("\n");

    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/two months free|unlimited|snapshot/i);
    for (const machine of HOSTED_MACHINES) {
      expect(screen.queryByRole("article", { name: new RegExp(`^${machine.name}$`) })).not.toBeInTheDocument();
    }
    expect(container.querySelector('a[href="/#pricing"]')).not.toBeNull();
  });

  it("marks up the pricing questions it shows", () => {
    const { container } = render(<PricingPage />);
    const schema = JSON.parse(jsonLd(container));
    const faq = schema["@graph"].find((node: { "@type": string }) => node["@type"] === "FAQPage");

    expect(faq.mainEntity.map((entry: { name: string }) => entry.name)).toEqual(PRICING_FAQ.map(({ q }) => q));
    for (const { q } of PRICING_FAQ) expect(screen.getByText(q)).toBeInTheDocument();
  });

  // /pricing used to wrap itself in <LocaleProvider initialLocale="en">, whose
  // mount effect wrote "en" into the visitor's locale cookie and localStorage,
  // silently switching a German visitor's whole site (homepage and dashboard)
  // to English. The page must render English without touching either.
  describe("locale preference", () => {
    function clearLocale() {
      document.cookie = `${LOCALE_COOKIE_NAME}=; Max-Age=0; Path=/`;
      window.localStorage.removeItem(LOCALE_COOKIE_NAME);
    }
    beforeEach(clearLocale);
    afterEach(clearLocale);

    it("leaves a visitor's chosen language in place and still renders the English FAQ", () => {
      document.cookie = `${LOCALE_COOKIE_NAME}=de; Path=/`;
      window.localStorage.setItem(LOCALE_COOKIE_NAME, "de");

      render(<PricingPage />);

      expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=de`);
      expect(document.cookie).not.toContain(`${LOCALE_COOKIE_NAME}=en`);
      expect(window.localStorage.getItem(LOCALE_COOKIE_NAME)).toBe("de");
      expect(screen.getByText(PRICING_FAQ[0].q)).toBeInTheDocument();
    });

    it("does not write a locale cookie or localStorage entry for a first-time visitor", () => {
      render(<PricingPage />);

      expect(document.cookie).not.toContain(`${LOCALE_COOKIE_NAME}=`);
      expect(window.localStorage.getItem(LOCALE_COOKIE_NAME)).toBeNull();
    });
  });
});
