/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// Regression coverage for #352: session replay must never START on a sensitive
// route, including the onboarding/plan-pick page /dashboard/welcome, and the
// suppression must be decided at the moment init() actually runs — not at
// module-load time. init() is deferred up to ~2s via requestIdleCallback, so a
// returning visitor whose persisted remote recording config would start the
// recorder can land on (or navigate to) a sensitive route before init runs;
// the disable flag + synchronous stop have to be computed from the LIVE
// pathname inside initPosthog, not from the path captured at import time.
//
// Each case re-imports the module (jest.resetModules) so module-level state —
// including `replaySuppressedByRoute` — starts fresh and posthog.init() re-runs
// against the current window.location.

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

// Capture the deferred init callback so we can run it manually AFTER mutating
// window.location — this is what reproduces the requestIdleCallback race: the
// route the visitor is on when init fires differs from the route at import.
let deferredInit: (() => void) | undefined;

function installDeferredIdleCallback() {
  deferredInit = undefined;
  (
    window as unknown as {
      requestIdleCallback: (cb: () => void) => number;
    }
  ).requestIdleCallback = (cb) => {
    deferredInit = cb;
    return 0;
  };
}

// Run init synchronously inside the import (the common no-race case).
function installImmediateIdleCallback() {
  (
    window as unknown as {
      requestIdleCallback: (cb: () => void) => number;
    }
  ).requestIdleCallback = (cb) => {
    cb();
    return 0;
  };
}

describe("PostHogProvider — /dashboard/welcome sensitive-route suppression (#352)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("never starts recording when landing directly on /dashboard/welcome", async () => {
    installImmediateIdleCallback();
    setLocation("hermesos.cloud", "/dashboard/welcome");

    await import("../PostHogProvider");

    // Recording must be prevented from STARTING, not merely stopped after the
    // recorder is already in flight.
    expect(mockPosthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ disable_session_recording: true })
    );
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("suppresses recording even when /dashboard/welcome is a sub-path (/dashboard/welcome/plan)", async () => {
    installImmediateIdleCallback();
    setLocation("hermesos.cloud", "/dashboard/welcome/plan");

    await import("../PostHogProvider");

    expect(mockPosthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ disable_session_recording: true })
    );
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("leaves replay untouched on a safe route that merely contains 'welcome' as a non-dashboard segment", async () => {
    installImmediateIdleCallback();
    // /welcome (without the /dashboard prefix) is NOT in the sensitive list, so
    // the welcome entry must not over-suppress unrelated marketing routes.
    setLocation("hermesos.cloud", "/welcome");

    await import("../PostHogProvider");

    expect(mockPosthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ disable_session_recording: false })
    );
    expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  describe("deferred-init race (#352 root cause)", () => {
    it("suppresses recording when the visitor is on a sensitive route at INIT time even though import happened on a safe route", async () => {
      installDeferredIdleCallback();
      // Import while on a safe route: module-load-time path is non-sensitive.
      setLocation("hermesos.cloud", "/dashboard");
      await import("../PostHogProvider");
      expect(deferredInit).toBeDefined();
      // init() has NOT run yet (deferred). Before it fires, the visitor is on a
      // sensitive route — the persisted recorder config would otherwise start
      // here.
      expect(mockPosthog.init).not.toHaveBeenCalled();

      setLocation("hermesos.cloud", "/sign-in");
      deferredInit!();

      // The disable flag must be derived from the LIVE pathname at init, not the
      // safe path captured at import — otherwise the recorder starts on /sign-in.
      expect(mockPosthog.init).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ disable_session_recording: true })
      );
      expect(mockPosthog.stopSessionRecording).toHaveBeenCalled();
      expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    });

    it("does NOT suppress when the visitor is on a safe route at INIT time even though import happened on a sensitive route", async () => {
      installDeferredIdleCallback();
      // Import while on a sensitive route, then navigate to a safe route before
      // the deferred init fires: init must respect the live (safe) path and not
      // leave recording wrongly disabled.
      setLocation("hermesos.cloud", "/sign-in");
      await import("../PostHogProvider");
      expect(deferredInit).toBeDefined();

      setLocation("hermesos.cloud", "/dashboard");
      deferredInit!();

      expect(mockPosthog.init).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ disable_session_recording: false })
      );
      // Nothing we suppressed to resume, and posthog's own start decision must
      // not be overridden on a safe landing.
      expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
      expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    });

    it("re-asserts the stop if the deferred recorder starts capture on /dashboard/welcome after init", async () => {
      jest.useFakeTimers();
      try {
        installDeferredIdleCallback();
        setLocation("hermesos.cloud", "/dashboard/welcome");
        await import("../PostHogProvider");
        deferredInit!();

        expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);

        // The lazy recorder script lands after our synchronous stop and the
        // persisted remote config restarts capture on the sensitive route.
        mockPosthog.sessionRecordingStarted.mockReturnValue(true);
        jest.advanceTimersByTime(1_000);

        // The watchdog re-asserts the stop and never force-starts replay on the
        // sensitive route.
        expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(2);
        expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  });
});
