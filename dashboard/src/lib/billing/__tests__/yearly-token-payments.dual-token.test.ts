/** @jest-environment node */
/**
 * Yearly token payments with $HIVRA ACTIVATED at a test address:
 *   - a quote is issued in one token; a new user can only get a $HIVRA quote
 *     ($HermesOS is refused server-side), a grandfathered user keeps $HermesOS;
 *   - settlement credits only the token the quote was issued for;
 *   - a transfer in the other token is not credited and is recorded as a
 *     wrong_token item for operator recovery.
 * The launch block is mocked; the database and chain are in-memory fakes.
 */
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
const mockReportOpsEvent = jest.fn();
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
}));
let mockSupabaseAdmin: unknown = null;
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin;
  },
}));

import { reconcileYearlyTokenQuote } from "@/lib/billing/yearly-token-settlement";
import {
  ActiveYearlyQuoteTokenMismatchError,
  asYearlyTokenQuote,
  createYearlyTokenQuote,
  type YearlyQuoteRow,
} from "@/lib/billing/yearly-token-quotes";
import { computeUserTokenAccess, TokenNotAllowedError } from "@/lib/billing/token-access";
import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import { TEST_DEPOSIT_ADDRESS, txHash, yearlyQuoteRow } from "@/test-utils/yearly-token-memory-db";
import { createYearlyTokenWorld, HOUR_MS, MINUTE_MS, type YearlyTokenWorld } from "@/test-utils/yearly-token-world";

const HIVRA = "0x2222222222222222222222222222222222222222";
const REQUIRED = 1_000n * 10n ** 18n;
const PRICE = { priceUsd: "0.049", lastUpdatedAt: Math.floor(Date.now() / 1000), source: "dexscreener" as const, raw: {} };

const newUser = computeUserTokenAccess({ phase: "active", cohort: null, now: new Date() });
const grandfathered = computeUserTokenAccess({
  phase: "active",
  cohort: { user_id: "user_1", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
  now: new Date(),
});

function openQuote(world: YearlyTokenWorld, token: "hermesos" | "hivra") {
  return world.memory.insertRow(
    "yearly_token_quotes",
    yearlyQuoteRow({
      tokens_required_raw: REQUIRED.toString(),
      quoted_at: world.at(-10 * MINUTE_MS),
      expires_at: world.at(10 * MINUTE_MS),
      token_key: token,
      token_address: token === "hivra" ? HIVRA : HERMESOS_TOKEN_ADDRESS,
    })
  );
}

function send(world: YearlyTokenWorld, params: { tx: string; token: string; offsetMs: number; amountRaw?: bigint }) {
  world.chain.addTransfer({
    txHash: params.tx,
    amountRaw: params.amountRaw ?? REQUIRED,
    block: world.chain.blockAt(world.nowMs + params.offsetMs),
    to: TEST_DEPOSIT_ADDRESS,
    tokenAddress: params.token,
  });
}

function reconcile(world: YearlyTokenWorld, now = new Date(world.nowMs)) {
  return reconcileYearlyTokenQuote({
    quote: asYearlyTokenQuote(world.quote("yq_1") as unknown as YearlyQuoteRow),
    db: world.memory.db,
    fetchImpl: world.chain.fetchImpl,
    now,
  });
}

beforeEach(() => {
  mockReportOpsEvent.mockReset();
  mockSupabaseAdmin = null;
});

describe("yearly quotes after $HIVRA activation", () => {
  it("refuse a $HermesOS quote for a new user, server-side", async () => {
    mockSupabaseAdmin = createYearlyTokenWorld().memory.db;
    await expect(
      createYearlyTokenQuote({
        userId: "new_user",
        tier: "pro",
        depositAddress: TEST_DEPOSIT_ADDRESS,
        token: "hermesos",
        access: newUser,
        priceQuote: PRICE,
      })
    ).rejects.toBeInstanceOf(TokenNotAllowedError);
  });

  it("issue a new user's quote in $HIVRA at the same USD price", async () => {
    const world = createYearlyTokenWorld();
    mockSupabaseAdmin = world.memory.db;
    const quote = await createYearlyTokenQuote({
      userId: "new_user",
      tier: "pro",
      depositAddress: TEST_DEPOSIT_ADDRESS,
      access: newUser,
      priceQuote: PRICE,
    });
    expect(quote).toMatchObject({ tokenKey: "hivra", tokenAddress: HIVRA, tokenSymbol: "HIVRA", usdTargetCents: 4900 });
    expect(world.memory.tables.yearly_token_quotes[0]).toMatchObject({ token_key: "hivra", token_address: HIVRA });
  });

  it("keep a grandfathered user's quote in $HermesOS", async () => {
    const world = createYearlyTokenWorld();
    mockSupabaseAdmin = world.memory.db;
    const quote = await createYearlyTokenQuote({
      userId: "user_1",
      tier: "power",
      depositAddress: TEST_DEPOSIT_ADDRESS,
      access: grandfathered,
      priceQuote: PRICE,
    });
    expect(quote).toMatchObject({ tokenKey: "hermesos", tokenAddress: HERMESOS_TOKEN_ADDRESS, usdTargetCents: 9900 });
  });
});

describe("an open yearly quote in another token", () => {
  it("is not handed back when the user asks to pay in a different token", async () => {
    const world = createYearlyTokenWorld();
    mockSupabaseAdmin = world.memory.db;
    const common = { userId: "user_1", tier: "pro" as const, depositAddress: TEST_DEPOSIT_ADDRESS, access: grandfathered, priceQuote: PRICE };
    const first = await createYearlyTokenQuote(common);
    expect(first.tokenKey).toBe("hermesos");
    await expect(createYearlyTokenQuote({ ...common, token: "hivra" })).rejects.toBeInstanceOf(
      ActiveYearlyQuoteTokenMismatchError
    );
    // Asking again without a token returns the open quote, as before.
    expect((await createYearlyTokenQuote(common)).id).toBe(first.id);
  });
});

describe("yearly settlement credits only the quote's token", () => {
  it("settles a $HIVRA quote with a $HIVRA transfer and records the token", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, "hivra");
    send(world, { tx: txHash(1), token: HIVRA, offsetMs: -5 * MINUTE_MS });
    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(1) });
    expect(world.subscriptions()[0]).toMatchObject({ token_key: "hivra", token_address: HIVRA });
  });

  it("does not credit a $HermesOS transfer to a $HIVRA quote, and flags it for operator recovery", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, "hivra");
    send(world, { tx: txHash(2), token: HERMESOS_TOKEN_ADDRESS, offsetMs: -5 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "no_match" });
    expect(world.subscriptions()).toHaveLength(0);
    expect(world.items()).toEqual([
      expect.objectContaining({
        reason: "wrong_token",
        transaction_hash: txHash(2),
        token_address: HERMESOS_TOKEN_ADDRESS,
        status: "open",
      }),
    ]);
    expect(mockReportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Yearly token payment arrived in the wrong token" })
    );

    // Surfaced once, however often the range is rescanned; the quote is
    // cancelled when its range closes and the item stays open.
    const later = new Date(world.nowMs + 3 * HOUR_MS);
    world.chain.setLatestBlock(world.chain.blockAt(later.getTime()));
    expect(await reconcile(world, later)).toMatchObject({ status: "cancelled" });
    expect(world.items()).toEqual([expect.objectContaining({ reason: "wrong_token", status: "open" })]);
    expect(world.subscriptions()).toHaveLength(0);
  });

  it("does not credit a $HIVRA transfer to a grandfathered user's $HermesOS quote", async () => {
    const world = createYearlyTokenWorld();
    openQuote(world, "hermesos");
    send(world, { tx: txHash(3), token: HIVRA, offsetMs: -6 * MINUTE_MS });
    send(world, { tx: txHash(4), token: HERMESOS_TOKEN_ADDRESS, offsetMs: -4 * MINUTE_MS });

    expect(await reconcile(world)).toMatchObject({ status: "activated", transactionHash: txHash(4) });
    expect(world.subscriptions()[0]).toMatchObject({ token_key: "hermesos", deposit_tx_hash: txHash(4) });
    expect(world.items()).toEqual([
      expect.objectContaining({ reason: "wrong_token", transaction_hash: txHash(3), token_address: HIVRA }),
    ]);
  });
});
