import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "unavailable",
  isBillingV2ServerEnabled: () => true,
}));
jest.mock("@/lib/billing/crypto-availability", () => ({ isCryptoBillingEnabled: () => true }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: () => null,
  RATE_LIMIT_PRESETS: { secretWrite: {} },
}));
jest.mock("@/lib/billing/token-access", () => {
  const actual = jest.requireActual("@/lib/billing/token-access");
  return {
    ...actual,
    resolveUserTokenAccess: jest.fn(),
    convertGrandfatheredUserToHivra: jest.fn(),
  };
});

import { GET, POST } from "../route";
import {
  TokenConversionError,
  computeUserTokenAccess,
  convertGrandfatheredUserToHivra,
  resolveUserTokenAccess,
} from "@/lib/billing/token-access";

const NOW = new Date("2026-10-02T12:00:00Z");
const member = computeUserTokenAccess({
  phase: "active",
  cohort: { user_id: "u", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
  now: NOW,
});

function post(body: unknown) {
  return new NextRequest("http://localhost/api/billing/token-access", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "u" });
});

it("reports a grandfathered user's access and that they can convert", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(member);
  const body = await (await GET()).json();
  expect(body.data).toMatchObject({
    phase: "active",
    grandfathered: true,
    allowedTokens: ["hermesos", "hivra"],
    paymentToken: "hermesos",
    canConvert: true,
    conversionGraceHours: 72,
  });
});

it("reports dormant access as $HermesOS-only and not convertible", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(
    computeUserTokenAccess({ phase: "dormant", cohort: null, now: NOW })
  );
  const body = await (await GET()).json();
  expect(body.data).toMatchObject({ phase: "dormant", allowedTokens: ["hermesos"], canConvert: false });
});

it("converts on request and maps refusals to 409/503", async () => {
  (convertGrandfatheredUserToHivra as jest.Mock).mockResolvedValueOnce(member);
  expect((await POST(post({ action: "convert" }))).status).toBe(200);

  (convertGrandfatheredUserToHivra as jest.Mock).mockRejectedValueOnce(
    new TokenConversionError("not_grandfathered", "This account already uses $HIVRA.")
  );
  expect((await POST(post({ action: "convert" }))).status).toBe(409);

  (convertGrandfatheredUserToHivra as jest.Mock).mockRejectedValueOnce(
    new TokenConversionError("price_unavailable", "later")
  );
  expect((await POST(post({ action: "convert" }))).status).toBe(503);

  expect((await POST(post({ action: "other" }))).status).toBe(400);
});

it("requires sign-in", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  expect((await GET()).status).toBe(401);
  expect((await POST(post({ action: "convert" }))).status).toBe(401);
});
