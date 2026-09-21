/**
 * Locks in the partial-failure recovery semantics of
 * detectAndActivateYearlyDeposit:
 *
 *   - Subscription row is inserted FIRST.
 *   - Quote consume runs SECOND.
 *
 * The previous order (consume → insert) had a BLOCKER bug: if the
 * insert failed, the quote was already 'consumed' so the next cron
 * tick (which only loads `status='active'` quotes) would never
 * re-examine the user. They'd pay in $HERMESOS, get no tier.
 */

const fetchHermesTokenBalanceMock = jest.fn();
const consumeYearlyTokenQuoteMock = jest.fn();
const insertSubscriptionMock = jest.fn();
const checkExistingSubMock = jest.fn();
// The write-once conversion stamp: update(hermes_subscriptions)
//   .eq("user_id", …).is("upgraded_at", null)
const stampUpgradeMock = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === "hermes_subscriptions") {
        return {
          update: jest.fn((payload: Record<string, unknown>) => ({
            eq: jest.fn((eqCol: string, eqVal: unknown) => ({
              is: jest.fn(async (isCol: string, isVal: unknown) =>
                stampUpgradeMock(payload, { eq: [eqCol, eqVal], is: [isCol, isVal] })
              ),
            })),
          })),
        };
      }
      if (table !== "yearly_token_subscriptions") {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        select: jest.fn(() => ({
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => checkExistingSubMock()),
        })),
        insert: jest.fn((row: Record<string, unknown>) => ({
          select: jest.fn(() => ({
            single: jest.fn(async () => insertSubscriptionMock(row)),
          })),
        })),
      };
    }),
  },
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  HERMESOS_TOKEN_ADDRESS: "0xtoken",
  HERMESOS_TOKEN_DECIMALS: 18,
  fetchHermesTokenBalance: (...args: unknown[]) =>
    fetchHermesTokenBalanceMock(...(args as [])),
  formatRawTokenBalance: (raw: string) => raw,
  normalizeNumericToBigIntString: (raw: string) => raw,
}));

jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: jest.fn(),
}));

jest.mock("@/lib/billing/bankr-withdraw", () => ({
  mintScopedTransferApiKey: jest.fn(),
  submitBankrTransfer: jest.fn(),
}));

jest.mock("@/lib/billing/yearly-token-quotes", () => ({
  consumeYearlyTokenQuote: (...args: unknown[]) =>
    consumeYearlyTokenQuoteMock(...(args as [])),
}));

jest.mock("@/lib/billing/treasury-gas", () => ({
  ensureLockWalletHasGas: jest.fn(),
}));

import { detectAndActivateYearlyDeposit } from "@/lib/billing/yearly-sweep";
import type { YearlyTokenQuote } from "@/lib/billing/yearly-token-quotes";

const baseQuote = {
  id: "quote_1",
  userId: "user_1",
  tier: "pro",
  tokensRequiredRaw: 100n,
  depositAddress: "0xdeposit",
  priceUsdAtQuote: 0.1,
  usdTargetCents: 1000,
} as unknown as YearlyTokenQuote;

describe("detectAndActivateYearlyDeposit — partial-failure recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkExistingSubMock.mockReturnValue({ data: null, error: null });
  });

  it("inserts the subscription row BEFORE consuming the quote (BLOCKER fix order)", async () => {
    const callOrder: string[] = [];

    fetchHermesTokenBalanceMock.mockResolvedValue({ balanceRaw: "200" });
    insertSubscriptionMock.mockImplementation(async () => {
      callOrder.push("insert");
      return { data: { id: "sub_1" }, error: null };
    });
    consumeYearlyTokenQuoteMock.mockImplementation(async () => {
      callOrder.push("consume");
    });

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("activated");
    expect(result.subscriptionId).toBe("sub_1");
    expect(callOrder).toEqual(["insert", "consume"]);
  });

  it("still returns activated if the quote consume fails after a successful insert (user has tier; consume retried later)", async () => {
    fetchHermesTokenBalanceMock.mockResolvedValue({ balanceRaw: "200" });
    insertSubscriptionMock.mockResolvedValue({
      data: { id: "sub_2" },
      error: null,
    });
    consumeYearlyTokenQuoteMock.mockRejectedValue(new Error("db blip"));

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("activated");
    expect(result.subscriptionId).toBe("sub_2");
    // The error field surfaces the soft failure for operator visibility,
    // but the user already has their tier so this isn't a hard error.
    expect(result.error).toMatch(/quote_consume_post_insert_failed/);
  });

  it("returns error and does NOT consume the quote if the insert fails", async () => {
    fetchHermesTokenBalanceMock.mockResolvedValue({ balanceRaw: "200" });
    insertSubscriptionMock.mockResolvedValue({
      data: null,
      error: { message: "fk error" },
    });

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("error");
    // Critical regression guard: insert failure must NOT consume the
    // quote. Otherwise the user pays and gets nothing on retry.
    expect(consumeYearlyTokenQuoteMock).not.toHaveBeenCalled();
  });

  it("treats an existing active sub as already_active without re-consuming or re-inserting", async () => {
    checkExistingSubMock.mockReturnValueOnce({
      data: { id: "sub_existing" },
      error: null,
    });

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("already_active");
    expect(consumeYearlyTokenQuoteMock).not.toHaveBeenCalled();
    expect(insertSubscriptionMock).not.toHaveBeenCalled();
    expect(stampUpgradeMock).not.toHaveBeenCalled();
  });
});

describe("detectAndActivateYearlyDeposit — conversion stamp (upgraded_at write-once)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkExistingSubMock.mockReturnValue({ data: null, error: null });
    fetchHermesTokenBalanceMock.mockResolvedValue({ balanceRaw: "200" });
    insertSubscriptionMock.mockResolvedValue({ data: { id: "sub_1" }, error: null });
    consumeYearlyTokenQuoteMock.mockResolvedValue(undefined);
    stampUpgradeMock.mockResolvedValue({ error: null });
  });

  it("stamps upgraded_at/upgrade_source='token_payment' on the user's hermes_subscriptions row, gated write-once", async () => {
    const now = new Date("2026-06-10T12:00:00.000Z");

    const result = await detectAndActivateYearlyDeposit(baseQuote, { now });

    expect(result.outcome).toBe("activated");
    expect(stampUpgradeMock).toHaveBeenCalledTimes(1);
    const [payload, filters] = stampUpgradeMock.mock.calls[0];
    expect(payload).toEqual({
      upgraded_at: now.toISOString(),
      upgrade_source: "token_payment",
    });
    // Write-once guard: the update is filtered to rows never stamped before.
    expect(filters.eq).toEqual(["user_id", "user_1"]);
    expect(filters.is).toEqual(["upgraded_at", null]);
  });

  it("does NOT stamp when the subscription insert fails", async () => {
    insertSubscriptionMock.mockResolvedValue({
      data: null,
      error: { message: "fk error" },
    });

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("error");
    expect(stampUpgradeMock).not.toHaveBeenCalled();
  });

  it("activation still succeeds when the stamp write blows up (best-effort analytics)", async () => {
    stampUpgradeMock.mockRejectedValue(new Error("db blip"));

    const result = await detectAndActivateYearlyDeposit(baseQuote);

    expect(result.outcome).toBe("activated");
    expect(consumeYearlyTokenQuoteMock).toHaveBeenCalled();
  });
});
