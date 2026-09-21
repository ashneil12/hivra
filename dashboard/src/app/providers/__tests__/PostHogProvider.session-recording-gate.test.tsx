/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";
import { usePathname } from "next/navigation";

// Navigation-time session-replay suppression (PostHogPageView's
// applyRouteRecordingPolicy effect): stop replay when entering a sensitive
// route, and resume on leaving ONLY replay we ourselves stopped — never
// force-starting recording posthog decided to keep off (sampling, consent,
// remote config, localhost). RTL + React are imported statically and the
// provider in beforeAll (after the posthog mock initializes, and without
// jest.resetModules) so the component, React, and RTL share one react instance.
// Module-level `replaySuppressedByRoute` persists across tests, so each test
// first re-establishes an unsuppressed baseline before its real assertion.

const mockPosthog = {
  init: jest.fn(),
  set_config: jest.fn(),
  stopSessionRecording: jest.fn(),
  startSessionRecording: jest.fn(),
  sessionRecordingStarted: jest.fn(() => false),
  capture: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  __loaded: true,
};

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: mockPosthog,
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

const usePathnameMock = usePathname as jest.Mock;
const originalLocation = window.location;

let PostHogProvider: React.ComponentType<{ children: React.ReactNode }>;

function setHostname(hostname: string, pathname = "/") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      hostname,
      pathname,
      origin: `https://${hostname}`,
      href: `https://${hostname}${pathname}`,
    },
  });
}

// The route policy mirrors posthog-js's lazy-recorder readiness check
// (window.__PosthogExtensions__.initSessionRecording) before resuming replay —
// calling startSessionRecording() earlier makes posthog-js throw "Called on
// script loaded before session recording is available".
function setRecorderReady(ready: boolean) {
  const w = window as Window & {
    __PosthogExtensions__?: { initSessionRecording?: unknown };
  };
  if (ready) {
    w.__PosthogExtensions__ = { initSessionRecording: jest.fn() };
  } else {
    delete w.__PosthogExtensions__;
  }
}

const element = () => React.createElement(PostHogProvider, null);

function mountAt(pathname: string) {
  usePathnameMock.mockReturnValue(pathname);
  return render(element());
}

function navigate(rerender: (ui: React.ReactElement) => void, pathname: string) {
  usePathnameMock.mockReturnValue(pathname);
  rerender(element());
}

describe("PostHog navigation session-replay suppression", () => {
  beforeAll(async () => {
    // Imported here (not statically) so the posthog mock object is initialized
    // first, and without resetModules so react stays shared with RTL.
    ({ PostHogProvider } = await import("../PostHogProvider"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPosthog.__loaded = true;
    mockPosthog.sessionRecordingStarted.mockReturnValue(false);
    setHostname("hermesos.cloud"); // non-localhost so the policy is active
    setRecorderReady(true); // lazy recorder loaded — the common steady state
  });

  afterEach(() => {
    setRecorderReady(false);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("stops replay when navigating into a sensitive route", () => {
    const { rerender } = mountAt("/dashboard"); // safe baseline (resumes if needed)
    mockPosthog.stopSessionRecording.mockClear();
    mockPosthog.startSessionRecording.mockClear();

    navigate(rerender, "/dashboard/billing");
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("resumes replay it stopped when leaving a sensitive route", () => {
    const { rerender } = mountAt("/dashboard/wallet"); // suppressed: flag = true
    mockPosthog.stopSessionRecording.mockClear();
    mockPosthog.startSessionRecording.mockClear();

    navigate(rerender, "/dashboard"); // leaving → resume what we stopped
    expect(mockPosthog.startSessionRecording).toHaveBeenCalled();
    expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
  });

  it("does not start replay it never stopped (safe route, never suppressed)", () => {
    const { rerender } = mountAt("/dashboard"); // ensure unsuppressed baseline
    mockPosthog.stopSessionRecording.mockClear();
    mockPosthog.startSessionRecording.mockClear();

    navigate(rerender, "/stats"); // safe → posthog's own decision is respected
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
  });

  it("stays suppressed when moving between two sensitive routes", () => {
    const { rerender } = mountAt("/dashboard/billing"); // suppressed
    mockPosthog.stopSessionRecording.mockClear();
    mockPosthog.startSessionRecording.mockClear();

    navigate(rerender, "/sign-in"); // still sensitive → stop again, never resume
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("never touches recording on localhost", () => {
    setHostname("localhost");
    mountAt("/dashboard/billing");
    expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  // posthog 1.318.x: stop/startSessionRecording are set_config calls which
  // re-run the lazy recorder-script loader; if the recorder script ever fired
  // `load` without registering itself, the loader callback throws "Called on
  // script loaded before session recording is available" synchronously in OUR
  // call. The route policy must swallow it (the disable_session_recording flip
  // already happened inside set_config) and keep its suppression state sound.
  describe("recorder script loaded without registering (loader throws)", () => {
    it("swallows the throw on stop and still resumes after leaving the sensitive route", () => {
      const { rerender } = mountAt("/dashboard"); // safe baseline
      mockPosthog.stopSessionRecording.mockClear();
      mockPosthog.startSessionRecording.mockClear();
      mockPosthog.stopSessionRecording.mockImplementationOnce(() => {
        throw new Error("Called on script loaded before session recording is available");
      });

      expect(() => navigate(rerender, "/dashboard/billing")).not.toThrow();
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();

      // The suppression was still registered, so leaving resumes as usual.
      navigate(rerender, "/dashboard");
      expect(mockPosthog.startSessionRecording).toHaveBeenCalledTimes(1);
    });

    it("swallows the throw on resume and still clears the suppression flag", () => {
      const { rerender } = mountAt("/dashboard/billing"); // suppressed baseline
      mockPosthog.stopSessionRecording.mockClear();
      mockPosthog.startSessionRecording.mockClear();
      mockPosthog.startSessionRecording.mockImplementationOnce(() => {
        throw new Error("Called on script loaded before session recording is available");
      });

      expect(() => navigate(rerender, "/dashboard")).not.toThrow();
      expect(mockPosthog.startSessionRecording).toHaveBeenCalledTimes(1);

      // Flag cleared despite the throw (set_config applied the flip before
      // throwing): further safe-route navigation must not force-start again.
      navigate(rerender, "/stats");
      expect(mockPosthog.startSessionRecording).toHaveBeenCalledTimes(1);
    });
  });

  // stopSessionRecording() can't cancel an in-flight recorder-script load, and
  // posthog's onload callback unconditionally restarts capture. The policy
  // re-asserts the stop shortly after suppressing if the recorder reports it
  // started anyway — and only while the suppression is still ours.
  describe("recorder script finishes loading after we stopped (in-flight race)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("re-asserts the stop when recording comes back while still on the sensitive route", () => {
      const { rerender } = mountAt("/dashboard"); // safe baseline
      jest.useFakeTimers();
      mockPosthog.stopSessionRecording.mockClear();

      navigate(rerender, "/dashboard/billing");
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);

      // The lazy recorder script "lands" after our stop and restarts capture.
      mockPosthog.sessionRecordingStarted.mockReturnValue(true);
      jest.advanceTimersByTime(1_000);
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(2);
    });

    it("does not re-assert after leaving the sensitive route (resume clears the timers)", () => {
      const { rerender } = mountAt("/dashboard"); // safe baseline
      jest.useFakeTimers();
      mockPosthog.stopSessionRecording.mockClear();
      mockPosthog.startSessionRecording.mockClear();

      navigate(rerender, "/dashboard/billing");
      navigate(rerender, "/dashboard"); // resume before any timer fires

      mockPosthog.sessionRecordingStarted.mockReturnValue(true);
      jest.advanceTimersByTime(10_000);
      // Only the initial sensitive-route stop; the resumed recording (now
      // posthog's own decision) must not be stopped behind its back.
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);
      expect(mockPosthog.startSessionRecording).toHaveBeenCalledTimes(1);
    });
  });
});
