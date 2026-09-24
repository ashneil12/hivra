/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import PricingPage, { metadata } from "../page";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";
import { HOMEPAGE_FAQ } from "@/components/landing/public-home-content";
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

describe("/pricing page", () => {
  it("is indexable on its own URL, not the homepage canonical", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/pricing");
    expect(String(metadata.title)).not.toMatch(/\| Hivra/);
  });

  it("has one H1 and shows the same ladder as the homepage", () => {
    render(<PricingPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const plan of HOSTED_MACHINES) {
      expect(screen.getByRole("article", { name: new RegExp(plan.name) })).toBeInTheDocument();
    }
    expect(screen.getByRole("article", { name: "Free" })).toBeInTheDocument();
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
      expect(screen.getByText(HOMEPAGE_FAQ[0].q)).toBeInTheDocument();
    });

    it("does not write a locale cookie or localStorage entry for a first-time visitor", () => {
      render(<PricingPage />);

      expect(document.cookie).not.toContain(`${LOCALE_COOKIE_NAME}=`);
      expect(window.localStorage.getItem(LOCALE_COOKIE_NAME)).toBeNull();
    });
  });

  it("makes no trial or card-required claim", () => {
    const { container } = render(<PricingPage />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/free trial|card required|never sleeps/i);
    expect(String(metadata.description)).not.toMatch(/free trial|card required/i);
  });
});
