/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const grant = jest.fn();
const revoke = jest.fn();
jest.mock("@/app/providers/PostHogProvider", () => ({
  grantAnalyticsConsent: () => grant(),
  revokeAnalyticsConsent: () => revoke(),
}));

import {
  CookieConsentBanner,
  OPEN_COOKIE_PREFERENCES_EVENT,
} from "../CookieConsentBanner";
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  readStoredConsent,
} from "@/lib/consent/cookie-consent";

function mockGeo(consentRequired: boolean, ok = true) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok,
    json: async () => ({ country: consentRequired ? "DE" : "US", consentRequired }),
  });
}

describe("CookieConsentBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    document.cookie = `${CONSENT_STORAGE_KEY}=; Max-Age=0; Path=/`;
  });

  it("consent-required region: first layer shows Accept all + Reject all + Manage preferences, and does NOT grant before a choice", async () => {
    mockGeo(true);
    render(<CookieConsentBanner />);
    expect(await screen.findByText("Accept all")).toBeInTheDocument();
    expect(screen.getByText("Reject all")).toBeInTheDocument();
    expect(screen.getByText("Manage preferences")).toBeInTheDocument();
    expect(grant).not.toHaveBeenCalled();
  });

  it("Accept all grants analytics, persists 'accepted', and hides the banner", async () => {
    mockGeo(true);
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByText("Accept all"));
    expect(grant).toHaveBeenCalledTimes(1);
    expect(readStoredConsent()?.choice).toBe("accepted");
    await waitFor(() => expect(screen.queryByText("Accept all")).not.toBeInTheDocument());
  });

  it("Reject all revokes analytics, persists 'rejected', and hides the banner", async () => {
    mockGeo(true);
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByText("Reject all"));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(readStoredConsent()?.choice).toBe("rejected");
    await waitFor(() => expect(screen.queryByText("Reject all")).not.toBeInTheDocument());
  });

  it("non-required region: grants by default, leads with Accept, and keeps opt-out behind Manage preferences (no bare opt-out button)", async () => {
    mockGeo(false);
    render(<CookieConsentBanner />);
    expect(await screen.findByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Manage preferences")).toBeInTheDocument();
    // Stickier than the old single full-opt-out: no first-layer reject/opt-out.
    expect(screen.queryByText("Reject all")).not.toBeInTheDocument();
    expect(screen.queryByText("Opt out")).not.toBeInTheDocument();
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("non-required region: persists the implied accept on first display so the notice is shown once and does not recur", async () => {
    mockGeo(false);
    render(<CookieConsentBanner />);
    // Banner is visible this session...
    expect(await screen.findByText("Accept")).toBeInTheDocument();
    // ...but the choice is already stored, so a reload would NOT re-show it
    // (the stored-choice early-return path).
    await waitFor(() => expect(readStoredConsent()?.choice).toBe("accepted"));
  });

  it("Manage preferences: toggling analytics OFF and saving revokes + persists 'rejected'", async () => {
    mockGeo(false); // starts granted in a non-required region
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByText("Manage preferences"));

    const toggle = screen.getByRole("switch", { name: /Product analytics & session replay/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByText("Save preferences"));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(readStoredConsent()?.choice).toBe("rejected");
    await waitFor(() =>
      expect(screen.queryByText("Save preferences")).not.toBeInTheDocument()
    );
  });

  it("strictly-necessary category is always on and has no toggle", async () => {
    mockGeo(true);
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByText("Manage preferences"));
    expect(screen.getByText("Strictly necessary")).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    // Exactly one toggle exists (the analytics bucket); necessary is locked.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("does not render or grant when a stored choice already exists", async () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "accepted", version: CONSENT_VERSION, timestamp: 1 })
    );
    mockGeo(true);
    const { container } = render(<CookieConsentBanner />);
    await waitFor(() =>
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    );
    expect(grant).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reopens the preferences panel via the OPEN_COOKIE_PREFERENCES event even after a stored choice", async () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "accepted", version: CONSENT_VERSION, timestamp: 1 })
    );
    mockGeo(true);
    render(<CookieConsentBanner />);
    // Initially hidden because a choice is stored.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent(window, new Event(OPEN_COOKIE_PREFERENCES_EVENT));

    // Panel is now open with the toggle pre-filled from the stored "accepted".
    const toggle = await screen.findByRole("switch", {
      name: /Product analytics & session replay/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Save preferences")).toBeInTheDocument();
  });
});
