/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { DeferredGTM } from "../DeferredGTM";
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from "@/lib/consent/cookie-consent";

jest.mock("@next/third-parties/google", () => ({
  GoogleTagManager: ({ gtmId }: { gtmId: string }) => (
    <div data-testid="gtm-tag" data-gtm-id={gtmId} />
  ),
  GoogleAnalytics: ({ gaId }: { gaId: string }) => (
    <div data-testid="ga4-tag" data-ga-id={gaId} />
  ),
}));

describe("DeferredGTM", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("defers Google tags until after the page is interactive", () => {
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);

    expect(screen.queryByTestId("gtm-tag")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(screen.getByTestId("gtm-tag")).toHaveAttribute("data-gtm-id", "GTM-T6GPHP4N");
    expect(screen.getByTestId("ga4-tag")).toHaveAttribute("data-ga-id", "G-ML3NFRHMYF");
  });

  it("does not emit a direct GA4 tag when no measurement ID is configured", () => {
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" />);

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(screen.getByTestId("gtm-tag")).toHaveAttribute("data-gtm-id", "GTM-T6GPHP4N");
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
  });

  describe("inside a Hivra desktop app", () => {
    beforeEach(() => {
      window.localStorage.clear();
      Object.defineProperty(window.navigator, "userAgent", {
        value: "Mozilla/5.0 AppleWebKit/605.1.15 (KHTML, like Gecko) HivraMac/0.2.1",
        configurable: true,
      });
    });
    afterEach(() => {
      window.localStorage.clear();
      delete (window.navigator as unknown as Record<string, unknown>).userAgent;
    });

    function storeChoice(choice: "accepted" | "rejected") {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ choice, version: CONSENT_VERSION, timestamp: 1 }));
    }

    it.each([
      ["no choice is stored", null],
      ["analytics was rejected", "rejected" as const],
    ])("loads no Google tags when %s", (_label, choice) => {
      if (choice) storeChoice(choice);
      render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId("gtm-tag")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
    });

    it("loads them once the person has accepted analytics", () => {
      storeChoice("accepted");
      render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId("gtm-tag")).toBeInTheDocument();
      expect(screen.getByTestId("ga4-tag")).toBeInTheDocument();
    });
  });
});
