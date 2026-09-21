/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { DeferredGTM } from "../DeferredGTM";

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
});
