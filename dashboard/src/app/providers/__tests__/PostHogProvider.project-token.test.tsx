/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// Regression guard: the PostHog project token must come from the environment
// ONLY, and a missing key must mean analytics OFF.
//
// History: `posthog.init()` fell back to a hardcoded literal
// (`phc_zNoQ…` — the PRODUCTION project). No Vercel project set
// NEXT_PUBLIC_POSTHOG_KEY, so canary, every preview build, and any local
// `next start` all initialized posthog against PRODUCTION analytics. A
// misconfigured deploy was indistinguishable from a correct one, and the failure
// mode was silent corruption of the prod funnel.
//
// Two invariants, both load-bearing:
//   1. No key  -> posthog.init() is NEVER called, and the shared client wrappers
//      are disabled (rather than queueing forever against an init that can't run).
//   2. Key set -> init() is called with EXACTLY that key. No literal may reappear.

const mockPosthog = {
  init: jest.fn(),
  set_config: jest.fn(),
  stopSessionRecording: jest.fn(),
  startSessionRecording: jest.fn(),
  sessionRecordingStarted: jest.fn(() => false),
  opt_in_capturing: jest.fn(),
  opt_out_capturing: jest.fn(),
  capture: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  __loaded: true,
};

jest.mock("posthog-js", () => ({ __esModule: true, default: mockPosthog }));
jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

const mockDisablePostHogClient = jest.fn();
jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
  identifyUserClient: jest.fn(),
  resetIfIdentifiedClient: jest.fn(),
  flushPostHogQueue: jest.fn(),
  disablePostHogClient: () => mockDisablePostHogClient(),
}));

const originalLocation = window.location;

/** A non-localhost host: localhost never captures regardless of the key. */
function setLocation(hostname = "canary.hermesos.cloud", pathname = "/") {
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

/** Run posthog's deferred init synchronously so assertions don't race it. */
function installImmediateIdleCallback() {
  (
    window as unknown as { requestIdleCallback: (cb: () => void) => number }
  ).requestIdleCallback = (cb) => {
    cb();
    return 0;
  };
}

async function loadProviderWith(key: string | undefined) {
  const prev = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const prevToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (key === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = key;
  }
  delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

  jest.resetModules();
  mockPosthog.init.mockClear();
  mockDisablePostHogClient.mockClear();

  installImmediateIdleCallback();
  const mod = await import("../PostHogProvider");

  process.env.NEXT_PUBLIC_POSTHOG_KEY = prev;
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = prevToken;
  return mod;
}

describe("PostHog project token resolution", () => {
  beforeEach(() => setLocation());

  it("does NOT initialize posthog when no project token is configured", async () => {
    const mod = await loadProviderWith(undefined);

    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mod.analyticsEnabled).toBe(false);
  });

  it("disables the shared capture wrappers when no token is configured", async () => {
    await loadProviderWith(undefined);

    // Without this the app's captureClient() call sites would enqueue into a
    // buffer that nothing ever drains, because flushPostHogQueue() only runs
    // from inside init().
    expect(mockDisablePostHogClient).toHaveBeenCalledTimes(1);
  });

  it("initializes with EXACTLY the env-provided token", async () => {
    const mod = await loadProviderWith("phc_canary_project_token");

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.init).toHaveBeenCalledWith(
      "phc_canary_project_token",
      expect.any(Object)
    );
    expect(mod.analyticsEnabled).toBe(true);
    expect(mockDisablePostHogClient).not.toHaveBeenCalled();
  });

  it("never falls back to the hardcoded production project token", async () => {
    await loadProviderWith(undefined);
    await loadProviderWith("");

    const tokens = mockPosthog.init.mock.calls.map((call) => call[0]);
    expect(tokens).not.toContain(
      "phc_zNoQPCQxtRRysXyyxdCwnMyXSvDW8bEPGosSzZRXCQKn"
    );
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });

  it("consent grant/revoke are inert when analytics is off", async () => {
    const mod = await loadProviderWith(undefined);

    // The banner still calls these; they must not stash a pending action that
    // only a never-running init() could replay, nor touch the uninit client.
    expect(() => mod.grantAnalyticsConsent()).not.toThrow();
    expect(() => mod.revokeAnalyticsConsent()).not.toThrow();
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(mockPosthog.opt_out_capturing).not.toHaveBeenCalled();
    expect(mockPosthog.stopSessionRecording).not.toHaveBeenCalled();
  });
});
