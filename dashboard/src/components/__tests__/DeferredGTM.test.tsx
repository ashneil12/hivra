/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { DeferredGTM } from "../DeferredGTM";
import { CONSENT_STORAGE_KEY, writeStoredConsent } from "@/lib/consent/cookie-consent";

jest.mock("@next/third-parties/google", () => ({
  GoogleTagManager: ({ gtmId }: { gtmId: string }) => (
    <div data-testid="gtm-tag" data-gtm-id={gtmId} />
  ),
  GoogleAnalytics: ({ gaId }: { gaId: string }) => (
    <div data-testid="ga4-tag" data-ga-id={gaId} />
  ),
}));

type W = Window & Record<string, unknown> & { gtag?: jest.Mock };

describe("DeferredGTM", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.localStorage.clear();
    document.cookie = `${CONSENT_STORAGE_KEY}=; Max-Age=0; Path=/`;
    delete (window as W)["ga-disable-G-ML3NFRHMYF"];
    delete (window as W).gtag;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("loads nothing before the visitor has accepted analytics", () => {
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("gtm-tag")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
  });

  it("defers Google tags until idle for a visitor who already accepted", () => {
    writeStoredConsent("accepted");
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
    expect(screen.queryByTestId("gtm-tag")).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("gtm-tag")).toHaveAttribute("data-gtm-id", "GTM-T6GPHP4N");
    expect(screen.getByTestId("ga4-tag")).toHaveAttribute("data-ga-id", "G-ML3NFRHMYF");
  });

  it("loads the tags when the visitor accepts on the banner", () => {
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
    act(() => {
      writeStoredConsent("accepted");
    });
    expect(screen.getByTestId("ga4-tag")).toBeInTheDocument();
  });

  it("stops GA collecting when consent is withdrawn after loading", () => {
    writeStoredConsent("accepted");
    const gtag = jest.fn();
    (window as W).gtag = gtag;
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    act(() => {
      writeStoredConsent("rejected");
    });
    expect((window as W)["ga-disable-G-ML3NFRHMYF"]).toBe(true);
    expect(gtag).toHaveBeenCalledWith("consent", "update", expect.objectContaining({ analytics_storage: "denied" }));
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
  });

  it("grants analytics storage again when a visitor who withdrew accepts again", () => {
    writeStoredConsent("accepted");
    const gtag = jest.fn();
    (window as W).gtag = gtag;
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" gaId="G-ML3NFRHMYF" />);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    act(() => {
      writeStoredConsent("rejected");
    });
    act(() => {
      writeStoredConsent("accepted");
    });
    // GA's init script does not run a second time, so without this update GA
    // would stay in the denied state until the page reloads.
    expect(gtag).toHaveBeenLastCalledWith("consent", "update", { analytics_storage: "granted" });
    expect((window as W)["ga-disable-G-ML3NFRHMYF"]).toBeUndefined();
    expect(screen.getByTestId("ga4-tag")).toBeInTheDocument();
  });

  it("does not emit a direct GA4 tag when no measurement ID is configured", () => {
    writeStoredConsent("accepted");
    render(<DeferredGTM gtmId="GTM-T6GPHP4N" />);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("gtm-tag")).toHaveAttribute("data-gtm-id", "GTM-T6GPHP4N");
    expect(screen.queryByTestId("ga4-tag")).not.toBeInTheDocument();
  });
});
