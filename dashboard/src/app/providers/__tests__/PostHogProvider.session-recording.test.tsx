/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// Direct-landing session-replay suppression: when landing on a sensitive
// route, recording must never START at all — init() passes
// disable_session_recording so posthog never kicks off the lazy
// recorder-script load (the in-flight-script race behind the recurring
// "Called on script loaded before session recording is available" throw) —
// and applyRouteRecordingPolicy still stops replay in the post-init `else`
// branch. Each case re-imports the module (jest.resetModules) so module-level
// state — including `replaySuppressedByRoute` — starts fresh and
// posthog.init() re-runs against a fresh window.location. Navigation /
// resume behaviour lives in PostHogProvider.session-recording-gate.test.tsx.

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
  PostHogProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

const originalLocation = window.location;

// Marks posthog-js's lazy recorder script as loaded (the readiness signal the
// route policy checks before calling startSessionRecording — see
// isSessionRecorderReady). Keeping it "ready" by default keeps these suites
// timer-free; the not-ready case is exercised explicitly below.
function setRecorderReady(ready: boolean) {
  const w = window as Window & {
    __PosthogExtensions__?: { initSessionRecording?: unknown };
  };
  if (ready) {
    w.__PosthogExtensions__ = { initSessionRecording: () => {} };
  } else {
    delete w.__PosthogExtensions__;
  }
}

function setLocation(hostname: string, pathname: string) {
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

// The routes #128 intended to keep out of session replays.
const SENSITIVE_PATHS = [
  "/sign-in",
  "/sign-up",
  "/dashboard/billing",
  "/dashboard/wallet",
  "/dashboard/settings",
  "/dashboard/chat",
  "/dashboard/instances/abc123/console",
  "/token",
  "/get-started/activate",
];

// Routes that look similar but must keep recording (no over-suppression).
const SAFE_PATHS = [
  "/",
  "/dashboard",
  "/dashboard/instances",
  "/dashboard/instances/abc123",
  "/dashboard/insights",
  "/get-started",
  "/stats",
];

describe("PostHog init() session-replay suppression (direct landing)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // init is deferred via requestIdleCallback for perf — run it synchronously
    // so assertions don't have to chase timers.
    (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (cb) => {
      cb();
      return 0;
    };
    setRecorderReady(true);
  });

  afterEach(() => {
    setRecorderReady(false);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  describe("production host", () => {
    it.each(SENSITIVE_PATHS)(
      "never starts recording when landing on sensitive route %s",
      async (pathname) => {
        setLocation("hermesos.cloud", pathname);
        await import("../PostHogProvider");

        // Recording must be prevented from STARTING (not merely stopped):
        // otherwise posthog's lazy recorder-script load is already in flight
        // before the stop, and its onload callback either resurrects capture
        // on the sensitive page or throws.
        expect(mockPosthog.init).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ disable_session_recording: true })
        );
        expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
        expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
      }
    );

    it.each(SAFE_PATHS)(
      "leaves replay untouched when landing on safe route %s",
      async (pathname) => {
        setLocation("hermesos.cloud", pathname);
        await import("../PostHogProvider");

        // Nothing to suppress and nothing we suppressed to resume, so the
        // route policy must not touch posthog's own recording decision.
        expect(mockPosthog.init).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ disable_session_recording: false })
        );
        expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
        expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
      }
    );

    it("does not throw when posthog's recorder-script loader throws from stop (script loaded without registering)", async () => {
      // posthog 1.318.x: a recorder script that fired `load` without
      // registering __PosthogExtensions__.initSessionRecording makes every
      // stop/start (set_config → startIfEnabledOrStop → loader callback)
      // throw synchronously in OUR call stack. The policy must swallow it.
      mockPosthog.stopSessionRecording.mockImplementation(() => {
        throw new Error("Called on script loaded before session recording is available");
      });
      setLocation("hermesos.cloud", "/token");

      await expect(import("../PostHogProvider")).resolves.toBeDefined();
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
      expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();

      mockPosthog.stopSessionRecording.mockReset();
    });
  });

  describe("recorder script not yet loaded (lazy load in flight)", () => {
    it("still stops replay immediately on a sensitive landing and never starts it", async () => {
      // The stop must NOT wait for the recorder script: disable_session_recording
      // has to be set before the recorder could start. Only the resume path is
      // gated on readiness.
      jest.useFakeTimers();
      try {
        setRecorderReady(false);
        setLocation("hermesos.cloud", "/dashboard/billing");
        await import("../PostHogProvider");

        expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
        expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();

        // Readiness watchdog retries must never turn into a start on a
        // sensitive route, even long after the retry budget is exhausted.
        jest.advanceTimersByTime(60_000);
        expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  });

  describe("localhost", () => {
    it("disables recording at init and never force-starts it, even on a safe route", async () => {
      setLocation("localhost", "/dashboard");
      await import("../PostHogProvider");

      expect(mockPosthog.init).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ disable_session_recording: true })
      );
      // The localhost branch stops recording; the route policy is never invoked.
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
      expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    });
  });
});
