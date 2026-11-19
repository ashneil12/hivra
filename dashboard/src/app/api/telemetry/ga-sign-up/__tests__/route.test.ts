import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockGetUser = jest.fn();
const mockSend = jest.fn();
const mockWarn = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
  clerkClient: async () => ({ users: { getUser: (id: string) => mockGetUser(id) } }),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));
jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args), info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/telemetry/ga-measurement-protocol", () => {
  const actual = jest.requireActual("@/lib/telemetry/ga-measurement-protocol");
  return { ...actual, sendGaMeasurementProtocolEvent: (...args: unknown[]) => mockSend(...args) };
});

import { POST } from "../route";
import { GOOGLE_ANALYTICS_ID } from "@/lib/telemetry/ga-config";

const ACCEPTED = encodeURIComponent(JSON.stringify({ choice: "accepted", version: 1, timestamp: 1 }));
const REJECTED = encodeURIComponent(JSON.stringify({ choice: "rejected", version: 1, timestamp: 1 }));
const SESSION_COOKIE = `_ga_${GOOGLE_ANALYTICS_ID.replace(/^G-/, "")}`;

function request(cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new NextRequest("https://hivra.cloud/api/telemetry/ga-sign-up", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "hivra.cloud",
      Origin: "https://hivra.cloud",
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: "{}",
  });
}

const withGa = {
  hh_cookie_consent: ACCEPTED,
  _ga: "GA1.1.1234567890.1731830000",
  [SESSION_COOKIE]: "GS2.1.s1731830000$o2$g1$t1731830100$j0$l0$h0",
};

async function reason(response: Response) {
  return (await response.json()).data;
}

describe("POST /api/telemetry/ga-sign-up", () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY = "true";
    process.env.GA_MEASUREMENT_PROTOCOL_API_SECRET = "test-mp-value";
    mockAuth.mockResolvedValue({ userId: "user_1" });
    mockGetUser.mockResolvedValue({
      createdAt: Date.now() - 5 * 60 * 1000,
      externalAccounts: [{ provider: "oauth_google" }],
      primaryEmailAddressId: "idn_1",
      unsafeMetadata: { heard_about: "other", heard_about_other: "a friend called Sam" },
    });
    mockSend.mockResolvedValue({ ok: true });
  });
  afterAll(() => {
    process.env = env;
  });

  it("is hidden while the switch is off", async () => {
    process.env.NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY = "";
    const response = await POST(request(withGa));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("feature_disabled");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a request from another origin", async () => {
    const response = await POST(request(withGa, { Origin: "https://box-1.hermesos.cloud", "Sec-Fetch-Site": "same-site" }));
    expect(response.status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("needs a signed-in user", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    expect((await POST(request(withGa))).status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends GA4's sign_up with the visitor's GA ids and nothing personal", async () => {
    const response = await POST(request(withGa));
    expect(response.status).toBe(200);
    expect(await reason(response)).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      measurementId: GOOGLE_ANALYTICS_ID,
      apiSecret: "test-mp-value",
      clientId: "1234567890.1731830000",
      sessionId: "1731830000",
      name: "sign_up",
      // The free-text "other" detail never reaches GA.
      params: { method: "google", heard_about: "other" },
    });
    expect(JSON.stringify(mockSend.mock.calls[0])).not.toMatch(/user_1|Sam|idn_1/);
  });

  it("uses email as the method for a password sign-up and sends without a session id when there is none", async () => {
    mockGetUser.mockResolvedValue({ createdAt: Date.now(), externalAccounts: [], primaryEmailAddressId: "idn_1", unsafeMetadata: {} });
    await POST(request({ hh_cookie_consent: ACCEPTED, _ga: "GA1.1.1000.2000" }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ clientId: "1000.2000", sessionId: null, params: { method: "email" } }));
  });

  it.each([
    ["no stored consent", { _ga: withGa._ga }, "no_consent"],
    ["rejected analytics", { ...withGa, hh_cookie_consent: REJECTED }, "no_consent"],
    ["no GA cookie", { hh_cookie_consent: ACCEPTED }, "no_ga_cookie"],
    ["a malformed GA cookie", { hh_cookie_consent: ACCEPTED, _ga: "not-a-ga-cookie" }, "no_ga_cookie"],
  ])("sends nothing with %s", async (_label, cookies, expected) => {
    const response = await POST(request(cookies as Record<string, string>));
    expect(response.status).toBe(202);
    expect(await reason(response)).toEqual({ sent: false, reason: expected });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("sends nothing for an account older than an hour", async () => {
    mockGetUser.mockResolvedValue({ createdAt: Date.now() - 2 * 60 * 60 * 1000, externalAccounts: [], unsafeMetadata: {} });
    const response = await POST(request(withGa));
    expect(await reason(response)).toEqual({ sent: false, reason: "not_a_new_account" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("logs and sends nothing when the Measurement Protocol secret is missing", async () => {
    delete process.env.GA_MEASUREMENT_PROTOCOL_API_SECRET;
    const response = await POST(request(withGa));
    expect(await reason(response)).toEqual({ sent: false, reason: "not_configured" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("GA_MEASUREMENT_PROTOCOL_API_SECRET"), expect.objectContaining({ failureType: "ga_mp_secret_missing" }));
  });

  it("logs a refused send", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 400 });
    const response = await POST(request(withGa));
    expect(await reason(response)).toEqual({ sent: false, reason: "send_failed" });
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ failureType: "ga_mp_send_failed", status: 400 }), undefined);
  });
});
