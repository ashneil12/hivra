/**
 * Token geo-policy at the server: every route that starts a NEW token action
 * refuses a blocked request with 403 `token_geo_blocked` before it creates
 * anything, while existing access and card payments are untouched. The same
 * routes with the dormant (empty) policy behave exactly as before.
 */
import { NextRequest } from "next/server";

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
// The real admin check, observed: the dormant policy must never reach it.
const mockIsOpsAdminUser = jest.fn();
jest.mock("@/lib/ops-access", () => {
  const actual = jest.requireActual("@/lib/ops-access");
  return { ...actual, isOpsAdminUser: (...args: unknown[]) => mockIsOpsAdminUser(...args) };
});
jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { settingsWrite: {}, secretWrite: {} },
  enforceAuthenticatedRouteRateLimit: () => null,
}));

const mockCreateYearlyQuote = jest.fn();
const mockGetActiveYearlyQuotes = jest.fn();
jest.mock("@/lib/billing/yearly-token-quotes", () => ({
  ActiveYearlyQuoteTokenMismatchError: class extends Error {},
  createYearlyTokenQuote: (...args: unknown[]) => mockCreateYearlyQuote(...args),
  getActiveYearlyTokenQuote: jest.fn(async () => null),
  getActiveYearlyTokenQuotes: (...args: unknown[]) => mockGetActiveYearlyQuotes(...args),
  getPendingYearlyTokenQuotes: jest.fn(async () => []),
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(async () => null),
}));

const mockEnsureDepositWallet = jest.fn();
const mockGetDepositCredential = jest.fn();
jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  ensureBankrDepositWalletForUser: (...args: unknown[]) => mockEnsureDepositWallet(...args),
  getBankrDepositWalletCredentialForUser: (...args: unknown[]) => mockGetDepositCredential(...args),
}));

const mockCreateManagedVeniceQuote = jest.fn();
jest.mock("@/lib/billing/managed-venice-token-quotes", () => ({
  ManagedVeniceTokenQuotePriceError: class extends Error {},
  ManagedVeniceTopUpExceedsHiddenCapError: class extends Error {},
  createManagedVeniceTokenQuote: jest.fn(),
  createManagedVeniceTokenQuoteForUsdTarget: (...args: unknown[]) => mockCreateManagedVeniceQuote(...args),
}));
jest.mock("@/lib/billing/crypto-payment-sessions", () => ({
  ActiveCryptoPaymentSessionError: class extends Error {},
  activeCryptoPaymentSessionResponse: jest.fn(),
  assertNoActiveCryptoPaymentSession: jest.fn(async () => undefined),
}));

const mockCreateDepositQuote = jest.fn();
jest.mock("@/lib/billing/deposit-quotes", () => ({
  createDepositQuote: (...args: unknown[]) => mockCreateDepositQuote(...args),
  getActiveDepositQuotes: jest.fn(async () => []),
}));
const mockRefreshHolding = jest.fn();
jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  getTokenVerificationWallet: jest.fn(async () => ({ address: "0xabc" })),
  // No legacy lock wallet, so verifying a wallet changes no withdrawal
  // destination and needs no fresh sign-in check (wallet/verify route tests).
  getHermesLockWallet: jest.fn(async () => null),
  refreshPrimaryHermesTokenHolding: (...args: unknown[]) => mockRefreshHolding(...args),
}));
const mockEvaluate = jest.fn();
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: (...args: unknown[]) => mockEvaluate(...args),
}));

const mockCreateCryptoTopUp = jest.fn();
jest.mock("@/lib/billing/crypto-topups", () => ({
  createCryptoTopUpIntent: (...args: unknown[]) => mockCreateCryptoTopUp(...args),
  isCryptoTopUpAssetKey: (value: unknown) => value === "usdc_base",
}));

const mockConvert = jest.fn();
jest.mock("@/lib/billing/token-access", () => ({
  ...jest.requireActual("@/lib/billing/token-access"),
  convertGrandfatheredUserToHivra: (...args: unknown[]) => mockConvert(...args),
}));

const mockCreateChallenge = jest.fn();
const mockVerifyChallenge = jest.fn();
jest.mock("@/lib/billing/wallet-verification", () => ({
  createWalletVerificationChallenge: (...args: unknown[]) => mockCreateChallenge(...args),
  isWalletClaimedByAnotherAccount: jest.fn(async () => false),
  getPendingWalletChallengeAddress: jest.fn(async () => "0x000000000000000000000000000000000000dead"),
  verifyWalletChallenge: (...args: unknown[]) => mockVerifyChallenge(...args),
}));

const mockCheckoutCreate = jest.fn();
jest.mock("@/lib/billing/credits", () => ({
  getCreditAccountStripeCustomerId: jest.fn(async () => "cus_existing"),
  setCreditAccountStripeCustomerId: jest.fn(),
}));
jest.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: mockCheckoutCreate } }, customers: { create: jest.fn() } }),
}));

import { auth } from "@clerk/nextjs/server";

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import * as yearlyRoute from "../yearly-token-quote/route";
import * as managedVeniceQuoteRoute from "../managed-venice/hermesos/quote/route";
import * as cardTopUpRoute from "../managed-venice/card/top-up/route";
import * as depositQuoteRoute from "../wallet/quote/route";
import * as cryptoTopUpRoute from "../crypto/top-up/route";
import * as tokenAccessRoute from "../token-access/route";
import * as challengeRoute from "../wallet/challenge/route";
import * as verifyRoute from "../wallet/verify/route";
import * as refreshRoute from "../wallet/refresh/route";

const USER = "user_geo";
const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";
const DEPOSIT = "0x000000000000000000000000000000000000dead";

function post(path: string, body: unknown, country?: string) {
  return new NextRequest(`https://canary.hermesos.cloud${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(country ? { "x-vercel-ip-country": country } : {}),
    },
  });
}

function get(path: string, country?: string) {
  return new NextRequest(`https://canary.hermesos.cloud${path}`, {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });
}

/** Chainable supabase stand-in resolving to `result`. */
function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "limit", "order", "in", "gte", "lte"]) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn(async () => result);
  builder.single = jest.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

let storedCountry: string | null = null;
let existingQualifications: unknown[] = [];
let verifiedWallets: unknown[] = [];

/** The token-action requests, each with the spy that proves it created something. */
const TOKEN_ACTIONS = [
  {
    name: "yearly token quote",
    call: (country?: string) => yearlyRoute.POST(post("/api/billing/yearly-token-quote", { tier: "pro" }, country)),
    created: () => mockCreateYearlyQuote,
  },
  {
    name: "managed-Venice token top-up quote",
    call: (country?: string) =>
      managedVeniceQuoteRoute.POST(
        post("/api/billing/managed-venice/hermesos/quote", { targetPaidMicroUsd: 50_000_000 }, country)
      ),
    created: () => mockCreateManagedVeniceQuote,
  },
  {
    name: "deposit (hold-for-tier) quote",
    call: (country?: string) => depositQuoteRoute.POST(post("/api/billing/wallet/quote", { tier: "pro" }, country)),
    created: () => mockCreateDepositQuote,
  },
  {
    name: "crypto top-up",
    call: (country?: string) =>
      cryptoTopUpRoute.POST(post("/api/billing/crypto/top-up", { asset: "usdc_base", packageCredits: 1000 }, country)),
    created: () => mockCreateCryptoTopUp,
  },
  {
    name: "conversion to $HIVRA",
    call: (country?: string) => tokenAccessRoute.POST(post("/api/billing/token-access", { action: "convert" }, country)),
    created: () => mockConvert,
  },
  {
    name: "new wallet verification challenge",
    call: (country?: string) =>
      challengeRoute.POST(post("/api/billing/wallet/challenge", { address: DEPOSIT, chainId: 8453 }, country)),
    created: () => mockCreateChallenge,
  },
  {
    name: "new wallet verification",
    call: (country?: string) =>
      verifyRoute.POST(post("/api/billing/wallet/verify", { challengeId: "ch_1", signature: "0xsig" }, country)),
    created: () => mockVerifyChallenge,
  },
] as const;

// Obviously fake admin identities: the repo is public and no real admin is named.
const ADMIN_EMAIL = "ops-admin@example.test";
const OPS_ENV_KEYS = ["OPS_ADMIN_USER_IDS", "OPS_ADMIN_EMAILS", "CLERK_SECRET_KEY"] as const;
const originalOpsEnv: Record<string, string | undefined> = {};
const originalFetch = global.fetch;
const clerkFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOpsAdminUser.mockImplementation(jest.requireActual("@/lib/ops-access").isOpsAdminUser);
  for (const key of OPS_ENV_KEYS) originalOpsEnv[key] = process.env[key];
  delete process.env.OPS_ADMIN_USER_IDS;
  delete process.env.OPS_ADMIN_EMAILS;
  process.env.CLERK_SECRET_KEY = "sk_test_geo";
  clerkFetch.mockReset();
  global.fetch = clerkFetch as unknown as typeof fetch;
  storedCountry = null;
  existingQualifications = [];
  verifiedWallets = [];
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: USER });
  mockFrom.mockImplementation((table: string) => {
    if (table === "signup_risk_assessments") {
      return query({ data: storedCountry ? { country_code: storedCountry } : null, error: null });
    }
    if (table === "token_tier_qualifications") return query({ data: existingQualifications, error: null });
    if (table === "user_wallets") return query({ data: verifiedWallets, error: null });
    return query({ data: [], error: null });
  });

  const credential = { evmAddress: DEPOSIT, normalizedEvmAddress: DEPOSIT, bankrWalletId: "wlt_1" };
  mockGetDepositCredential.mockResolvedValue(credential);
  mockEnsureDepositWallet.mockResolvedValue({ status: "provisioned", credential });
  mockCreateYearlyQuote.mockResolvedValue({
    id: "yq_1",
    tier: "pro",
    usdTargetCents: 4900,
    priceUsdAtQuote: "0.000002",
    tokensRequiredRaw: 1n,
    tokensRequiredDisplay: "1",
    tokenKey: "hermesos",
    depositAddress: DEPOSIT,
  });
  mockGetActiveYearlyQuotes.mockResolvedValue([
    { id: "yq_old", tier: "pro", tokensRequiredRaw: 1n, tokenKey: "hermesos", depositAddress: DEPOSIT },
  ]);
  mockCreateManagedVeniceQuote.mockResolvedValue({ id: "mvq_1", tokenAmountRaw: "1" });
  mockCreateDepositQuote.mockResolvedValue({ id: "dq_1", tier: "pro", tokensRequiredRaw: 1n });
  mockCreateCryptoTopUp.mockResolvedValue({
    referenceId: "ct_1",
    asset: { network: "Base", symbol: "USDC" },
    amountDisplay: "10",
    depositAddress: DEPOSIT,
  });
  mockConvert.mockResolvedValue({
    phase: "active",
    grandfathered: true,
    allowedTokens: ["hermesos", "hivra"],
    paymentToken: "hivra",
    convertedAt: new Date("2026-10-02T00:00:00Z"),
    conversionGraceEndsAt: new Date("2026-10-05T00:00:00Z"),
  });
  mockCreateChallenge.mockResolvedValue({
    id: "ch_1",
    normalizedAddress: DEPOSIT,
    chainId: 8453,
    message: "Sign this",
    expiresAt: "2026-09-24T12:10:00.000Z",
  });
  mockVerifyChallenge.mockResolvedValue({ status: "verified", wallet: { address: DEPOSIT }, challenge: { id: "ch_1" } });
  mockCheckoutCreate.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/1" });
  mockRefreshHolding.mockResolvedValue({
    status: "refreshed",
    snapshot: { id: "snap_1", balanceRaw: "5", qualifiesBaseTier: true },
    balances: { hermesos: 5n },
  });
  mockEvaluate.mockResolvedValue({ configured: true, warnings: [], pro: null, power: null });
});

function refresh(country?: string) {
  return refreshRoute.POST(post("/api/billing/wallet/refresh", {}, country));
}

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of OPS_ENV_KEYS) {
    if (originalOpsEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalOpsEnv[key];
  }
  jest.restoreAllMocks();
});

/** Clerk's GET /users/{id} answering with a verified primary email. */
function clerkPrimaryEmail(email: string) {
  clerkFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      id: USER,
      primary_email_address_id: "idn_1",
      email_addresses: [{ id: "idn_1", email_address: email, verification: { status: "verified" } }],
    }),
  });
}

describe("dormant policy (no country listed)", () => {
  beforeEach(() => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
  });

  it.each(TOKEN_ACTIONS)("$name proceeds for a GB request exactly as before", async ({ call, created }) => {
    storedCountry = "GB";
    const headerGet = jest.spyOn(Headers.prototype, "get");
    const response = await call("GB");
    expect(response.status).toBe(200);
    expect(created()).toHaveBeenCalledTimes(1);
    // Nothing reads a country: not the header, no stored-country or existing-access query.
    expect(headerGet).not.toHaveBeenCalledWith("x-vercel-ip-country");
    expect(mockFrom).not.toHaveBeenCalledWith("signup_risk_assessments");
    expect(mockFrom).not.toHaveBeenCalledWith("token_tier_qualifications");
  });

  it.each(TOKEN_ACTIONS)("$name makes no admin lookup, even with ops admins configured", async ({ call, created }) => {
    process.env.OPS_ADMIN_USER_IDS = USER;
    process.env.OPS_ADMIN_EMAILS = ADMIN_EMAIL;
    clerkPrimaryEmail(ADMIN_EMAIL);
    storedCountry = "GB";
    const response = await call("GB");
    expect(response.status).toBe(200);
    expect(created()).toHaveBeenCalledTimes(1);
    expect(mockIsOpsAdminUser).not.toHaveBeenCalled();
    expect(clerkFetch).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalledWith("signup_risk_assessments");
  });

  it("wallet refresh calls the tier evaluator with exactly the arguments it always did", async () => {
    storedCountry = "GB";
    expect((await refresh("GB")).status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledWith({ userId: USER, balances: { hermesos: 5n } });
  });
});

describe("policy of ['GB']", () => {
  beforeEach(() => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
  });

  it.each(TOKEN_ACTIONS)("$name is refused for a GB IP: 403 token_geo_blocked, nothing created", async ({ call, created }) => {
    // Positive control for the dormant "header never read" check above.
    const headerGet = jest.spyOn(Headers.prototype, "get");
    const response = await call("GB");
    expect(headerGet).toHaveBeenCalledWith("x-vercel-ip-country");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: GB_NOTICE,
      code: "token_geo_blocked",
      country: "GB",
    });
    expect(created()).not.toHaveBeenCalled();
    // No payment deposit address is provisioned for a refused quote either.
    expect(mockEnsureDepositWallet).not.toHaveBeenCalled();
  });

  it.each(TOKEN_ACTIONS)("$name is refused for a stored GB country behind a non-UK IP", async ({ call, created }) => {
    storedCountry = "GB";
    const response = await call("US");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "token_geo_blocked", error: GB_NOTICE });
    expect(created()).not.toHaveBeenCalled();
  });

  it.each(TOKEN_ACTIONS)("$name proceeds for another country or a missing IP country", async ({ call, created }) => {
    for (const country of ["FR", undefined]) {
      created().mockClear();
      const response = await call(country);
      expect(response.status).toBe(200);
      expect(created()).toHaveBeenCalledTimes(1);
    }
  });

  it("wallet refresh can't gain a NEW tier from a GB IP: the evaluator gets the blocked decision", async () => {
    expect((await refresh("GB")).status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledWith({
      userId: USER,
      balances: { hermesos: 5n },
      tokenGeo: { blocked: true, country: "GB", signal: "ip_country", message: GB_NOTICE },
    });
    mockEvaluate.mockClear();
    expect((await refresh("FR")).status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ tokenGeo: { blocked: false } }));
  });

  describe("existing access is never revoked", () => {
    it("lets a holder with a row for that tier lock a deposit quote (a suspended row re-qualifies against it)", async () => {
      existingQualifications = [{ id: "q_pro" }];
      const response = await depositQuoteRoute.POST(post("/api/billing/wallet/quote", { tier: "pro" }, "GB"));
      expect(response.status).toBe(200);
      expect(mockCreateDepositQuote).toHaveBeenCalledTimes(1);
    });

    it("still returns a blocked user's existing yearly quotes", async () => {
      const response = await yearlyRoute.GET(get("/api/billing/yearly-token-quote", "GB"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.pro).toMatchObject({ id: "yq_old" });
    });

    it("lets an existing tier holder verify a wallet, so moving tokens never costs the tier", async () => {
      existingQualifications = [{ id: "q_pro" }];
      expect((await challengeRoute.POST(post("/api/billing/wallet/challenge", { address: DEPOSIT, chainId: 8453 }, "GB"))).status).toBe(200);
      expect((await verifyRoute.POST(post("/api/billing/wallet/verify", { challengeId: "ch_1", signature: "0xsig" }, "GB"))).status).toBe(200);
      expect(mockCreateChallenge).toHaveBeenCalledTimes(1);
      expect(mockVerifyChallenge).toHaveBeenCalledTimes(1);
    });

    it("lets a legacy lock-wallet holder verify their own wallet to move out of custody", async () => {
      verifiedWallets = [{ verification_method: "bankr", metadata: { bankr: { purpose: "hermesos_lock" } } }];
      const response = await challengeRoute.POST(post("/api/billing/wallet/challenge", { address: DEPOSIT, chainId: 8453 }, "GB"));
      expect(response.status).toBe(200);
    });

    it("refuses a first wallet verification to a user whose only wallet is a payment deposit address", async () => {
      verifiedWallets = [{ verification_method: "bankr", metadata: { bankr: { purpose: "credit_deposit" } } }];
      const response = await challengeRoute.POST(post("/api/billing/wallet/challenge", { address: DEPOSIT, chainId: 8453 }, "GB"));
      expect(response.status).toBe(403);
    });
  });

  describe("ops admins (OPS_ADMIN_USER_IDS / OPS_ADMIN_EMAILS) are exempt", () => {
    it.each(TOKEN_ACTIONS)("$name proceeds for an admin (by user ID) from a UK IP with a stored UK country", async ({ call, created }) => {
      process.env.OPS_ADMIN_USER_IDS = USER;
      storedCountry = "GB";
      const response = await call("GB");
      expect(response.status).toBe(200);
      expect(created()).toHaveBeenCalledTimes(1);
      expect(mockIsOpsAdminUser).toHaveBeenCalled();
      expect(clerkFetch).not.toHaveBeenCalled();
    });

    it.each(TOKEN_ACTIONS)("$name proceeds for an admin (by verified primary email) from a UK IP", async ({ call, created }) => {
      process.env.OPS_ADMIN_EMAILS = ADMIN_EMAIL;
      clerkPrimaryEmail(ADMIN_EMAIL);
      const response = await call("GB");
      expect(response.status).toBe(200);
      expect(created()).toHaveBeenCalledTimes(1);
      expect(clerkFetch).toHaveBeenCalledWith(`https://api.clerk.com/v1/users/${USER}`, expect.anything());
    });

    it.each(TOKEN_ACTIONS)("$name is still refused for a non-admin while admins are configured", async ({ call, created }) => {
      process.env.OPS_ADMIN_USER_IDS = "user_ops_admin_test";
      process.env.OPS_ADMIN_EMAILS = ADMIN_EMAIL;
      clerkPrimaryEmail("customer@example.test");
      const response = await call("GB");
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "token_geo_blocked", error: GB_NOTICE });
      expect(created()).not.toHaveBeenCalled();
    });

    it("wallet refresh gives an admin's evaluator a not-blocked decision from a UK IP", async () => {
      process.env.OPS_ADMIN_USER_IDS = USER;
      expect((await refresh("GB")).status).toBe(200);
      expect(mockEvaluate).toHaveBeenCalledWith({
        userId: USER,
        balances: { hermesos: 5n },
        tokenGeo: { blocked: false },
      });
    });
  });

  it("leaves card payments alone: a GB card top-up goes to Stripe checkout", async () => {
    storedCountry = "GB";
    const response = await cardTopUpRoute.POST(
      post("/api/billing/managed-venice/card/top-up", { amountMicroUsd: 50_000_000 }, "GB")
    );
    expect(response.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalledWith("signup_risk_assessments");
  });
});
