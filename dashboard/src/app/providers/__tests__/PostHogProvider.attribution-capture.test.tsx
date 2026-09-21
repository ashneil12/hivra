/** @jest-environment jsdom */
//
// First-touch signup attribution: the pageview effect must stash UTM params /
// external referrer + landing page into localStorage exactly once. The billing
// client later forwards the stash to /api/billing/subscribe, which persists it
// write-once on the subscription row.
//
// Kept separate from PostHogProvider.test.tsx, which uses jest.resetModules()
// in its beforeEach — that invalidates React's hooks dispatcher between the
// dynamic import and render() (the dual-React trap). This file imports the
// provider statically, like PostHogProvider.checkout-capture.test.tsx.
//
import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";

const mockCapture = jest.fn();

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    set_config: jest.fn(),
    stopSessionRecording: jest.fn(),
    capture: mockCapture,
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockUsePathname = jest.fn(() => "/");
const mockUseSearchParams = jest.fn(() => new URLSearchParams());

jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useSearchParams: () => mockUseSearchParams(),
}));

import { PostHogProvider } from "../PostHogProvider";
import { flushPostHogQueue } from "@/lib/telemetry/posthog-client";

const STORAGE_KEY = "hermes:signup_attribution";

function setReferrer(value: string) {
  Object.defineProperty(document, "referrer", {
    configurable: true,
    value,
  });
}

describe("PostHogPageView signup-attribution capture", () => {
  beforeEach(() => {
    mockCapture.mockClear();
    window.localStorage.clear();
    mockUsePathname.mockReturnValue("/");
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    setReferrer("");
    // The pageview capture goes through the init-safe client wrapper, which
    // queues until init flushes the queue. jsdom never runs the deferred init,
    // so mark PostHog ready here to mirror a completed init.
    flushPostHogQueue();
  });

  async function renderAndFlush() {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await waitFor(() =>
      expect(mockCapture).toHaveBeenCalledWith("$pageview", expect.any(Object))
    );
  }

  it("stashes UTM params + landing page on a tagged landing", async () => {
    mockUsePathname.mockReturnValue("/pricing");
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams(
        "utm_source=twitter&utm_medium=social&utm_campaign=launch&irrelevant=1"
      )
    );

    const before = Date.now();
    await renderAndFlush();

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.utm_source).toBe("twitter");
    expect(parsed.utm_medium).toBe("social");
    expect(parsed.utm_campaign).toBe("launch");
    expect(parsed).not.toHaveProperty("irrelevant");
    expect(parsed.landing_page).toBe("/pricing");
    expect(parsed.captured_at).toBeGreaterThanOrEqual(before);
  });

  it("stashes an external referrer even without UTM params", async () => {
    setReferrer("https://news.ycombinator.com/item?id=123");

    await renderAndFlush();

    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.referrer).toBe("https://news.ycombinator.com/item?id=123");
    expect(parsed.landing_page).toBe("/");
  });

  it("does NOT stash on an internal navigation with no UTM and same-origin referrer", async () => {
    // jsdom origin is http://localhost — a same-origin referrer is internal.
    setReferrer("http://localhost/dashboard");

    await renderAndFlush();

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("never overwrites an existing stash (first touch wins)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ utm_source: "original", captured_at: 1 })
    );
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams("utm_source=second-touch")
    );

    await renderAndFlush();

    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.utm_source).toBe("original");
  });

  it("truncates oversized UTM values to the server's 256-char cap", async () => {
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams(`utm_source=${"x".repeat(600)}`)
    );

    await renderAndFlush();

    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.utm_source).toHaveLength(256);
  });
});
