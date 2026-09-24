/** @jest-environment jsdom */
//
// Identity stitching at the Clerk auth boundary (PostHogIdentify).
//
// The 2026-07 PostHog audit (project 368999) found 140/187 (75%) of persons
// hitting /get-started/activate had NO pre-auth pageviews under the same
// person_id: the old PostHogIdentify called posthog.reset() unconditionally
// for every `!isSignedIn` visitor, regenerating the anonymous distinct_id on
// every entry into sign-up/sign-in/get-started/checkout — so the eventual
// identify(clerkUserId) merged a nearly-empty anon person and orphaned the
// landing pageviews. These tests pin the corrected contract:
//
//   - anonymous pre-auth visitor  → NO reset (the load-bearing fix)
//   - genuinely signed-out state  → reset (identified persistence cleared)
//   - signed-in, different id     → identify(clerkUserId, {email, name})
//   - signed-in, same id          → no identify spam on remounts
//   - fresh Clerk signup          → signup_completed exactly once (localStorage
//                                   guard; jsdom provides REAL localStorage, so
//                                   each test seeds/clears it explicitly)
//
// Kept separate from PostHogProvider.test.tsx, which uses jest.resetModules()
// in its beforeEach — that invalidates React's hooks dispatcher between the
// dynamic import and render() (the dual-React trap). This file imports the
// provider statically, like PostHogProvider.attribution-capture.test.tsx.
//
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

const mockCapture = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();
const mockGetDistinctId = jest.fn(() => "anon-device-id");
const mockIsIdentified = jest.fn(() => false);

const mockSendGaEvent = jest.fn();
jest.mock("@/lib/telemetry/ga-client", () => ({
  sendGaEvent: (...args: unknown[]) => mockSendGaEvent(...args),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    set_config: jest.fn(),
    stopSessionRecording: jest.fn(),
    capture: mockCapture,
    identify: mockIdentify,
    reset: mockReset,
    get_distinct_id: mockGetDistinctId,
    _isIdentified: mockIsIdentified,
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

type MockUser = {
  id: string;
  createdAt: Date | null;
  lastSignInAt: Date | null;
  primaryEmailAddress: { emailAddress: string } | null;
  fullName: string | null;
};

type UseUserResult =
  | { isLoaded: false; isSignedIn: undefined; user: undefined }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: MockUser };

const mockUseUser = jest.fn<UseUserResult, []>(() => ({
  isLoaded: true,
  isSignedIn: false,
  user: null,
}));

jest.mock("@clerk/nextjs", () => ({
  useUser: () => mockUseUser(),
}));

import { PostHogIdentify } from "../PostHogProvider";
import { flushPostHogQueue } from "@/lib/telemetry/posthog-client";

function makeUser(overrides: Partial<MockUser> & { id: string }): MockUser {
  return {
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    lastSignInAt: new Date(),
    primaryEmailAddress: { emailAddress: "op@example.com" },
    fullName: "Op Erator",
    ...overrides,
  };
}

describe("PostHogIdentify identity stitching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // jsdom provides REAL localStorage — clear the signup guards and the
    // attribution stash so storage-gated branches start from a known state.
    window.localStorage.clear();
    mockGetDistinctId.mockReturnValue("anon-device-id");
    mockIsIdentified.mockReturnValue(false);
    // Identify/reset/capture go through the init-safe client wrapper, which
    // queues until init flushes the queue. jsdom never runs the deferred init,
    // so mark PostHog ready here to mirror a completed init.
    flushPostHogQueue();
  });

  it("does NOT reset an anonymous pre-auth visitor (the stitch fix)", () => {
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false, user: null });
    mockIsIdentified.mockReturnValue(false);

    render(<PostHogIdentify />);

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it("resets when a signed-out visitor still carries an identified distinct_id", () => {
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false, user: null });
    mockIsIdentified.mockReturnValue(true);

    render(<PostHogIdentify />);

    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it("does nothing while Clerk is still loading", () => {
    mockUseUser.mockReturnValue({ isLoaded: false, isSignedIn: undefined, user: undefined });
    mockIsIdentified.mockReturnValue(true);

    render(<PostHogIdentify />);

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it("identifies a signed-in user whose id differs from the current distinct_id", () => {
    const user = makeUser({ id: "user_stitch_identify" });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });
    mockGetDistinctId.mockReturnValue("anon-abc");

    render(<PostHogIdentify />);

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith("user_stitch_identify", {
      email: "op@example.com",
      name: "Op Erator",
    });
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("skips identify when posthog already carries this user's id (no remount spam)", () => {
    const user = makeUser({ id: "user_stitch_same" });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });
    mockGetDistinctId.mockReturnValue("user_stitch_same");

    render(<PostHogIdentify />);

    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it("fires signup_completed exactly once for a fresh signup, with attribution", () => {
    const createdAt = new Date(Date.now() - 60 * 1000);
    const user = makeUser({
      id: "user_fresh_signup",
      createdAt,
      lastSignInAt: createdAt,
    });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });
    window.localStorage.setItem(
      "hermes:signup_attribution",
      JSON.stringify({
        utm_source: "twitter",
        utm_campaign: "launch",
        landing_page: "/pricing",
        captured_at: Date.now(),
        junk_key: "must-not-pass-through",
      })
    );

    const first = render(<PostHogIdentify />);
    first.unmount();
    // Second mount in the same first session (e.g. activate → dashboard
    // layout): the localStorage guard must hold.
    render(<PostHogIdentify />);

    const signupCalls = mockCapture.mock.calls.filter(
      ([event]) => event === "signup_completed"
    );
    expect(signupCalls).toHaveLength(1);
    expect(signupCalls[0][1]).toEqual({
      utm_source: "twitter",
      utm_campaign: "launch",
      landing_page: "/pricing",
      signup_created_at: createdAt.toISOString(),
    });
    expect(
      window.localStorage.getItem("hermes:signup_completed:user_fresh_signup")
    ).not.toBeNull();
    // Google Analytics gets GA4's sign_up once, with no personal data.
    const gaSignups = mockSendGaEvent.mock.calls.filter(([event]) => event === "sign_up");
    expect(gaSignups).toEqual([["sign_up", { method: "clerk" }]]);
  });

  it("fires signup_completed when lastSignInAt is still null right after signup", () => {
    const createdAt = new Date(Date.now() - 10 * 1000);
    const user = makeUser({
      id: "user_fresh_null_lastsignin",
      createdAt,
      lastSignInAt: null,
    });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });

    render(<PostHogIdentify />);

    const signupCalls = mockCapture.mock.calls.filter(
      ([event]) => event === "signup_completed"
    );
    expect(signupCalls).toHaveLength(1);
  });

  it("does NOT fire signup_completed for a returning sign-in", () => {
    const user = makeUser({
      id: "user_returning",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      lastSignInAt: new Date(),
    });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });

    render(<PostHogIdentify />);

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(
      mockCapture.mock.calls.filter(([event]) => event === "signup_completed")
    ).toHaveLength(0);
  });

  it("does NOT fire signup_completed for an old never-returned account (stale lastSignInAt ≈ createdAt)", () => {
    // A user who signed up months ago and never signed in again keeps
    // lastSignInAt ≈ createdAt forever; the recency window must exclude them.
    const createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const user = makeUser({
      id: "user_stale_first_session",
      createdAt,
      lastSignInAt: createdAt,
    });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });

    render(<PostHogIdentify />);

    expect(
      mockCapture.mock.calls.filter(([event]) => event === "signup_completed")
    ).toHaveLength(0);
  });

  it("respects a pre-existing localStorage guard (e.g. event fired on a previous page load)", () => {
    const createdAt = new Date(Date.now() - 5 * 60 * 1000);
    const user = makeUser({
      id: "user_guarded",
      createdAt,
      lastSignInAt: createdAt,
    });
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user });
    window.localStorage.setItem(
      "hermes:signup_completed:user_guarded",
      String(Date.now())
    );

    render(<PostHogIdentify />);

    expect(
      mockCapture.mock.calls.filter(([event]) => event === "signup_completed")
    ).toHaveLength(0);
  });
});
