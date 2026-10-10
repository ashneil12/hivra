/**
 * Managed Venice token deposits with $HIVRA ACTIVATED at a test address:
 *   - a quote is issued in one token; a new user's $HermesOS deposit quote is
 *     refused server-side;
 *   - settlement credits only the quote's token, with the same deposit bonus,
 *     and the lot and financial events record that token;
 *   - a transfer in the other token is never credited and is surfaced as a
 *     wrong-token reconciliation item for operator recovery.
 * End to end through the real reconciler and settlement, against the memory DB
 * and a Base RPC fake.
 */
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));

import {
  createManagedVeniceTokenQuote,
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
} from "@/lib/billing/managed-venice-token-quotes";
import { reconcileManagedVeniceTokenQuote } from "@/lib/billing/managed-venice-token-reconciliation";
import { computeUserTokenAccess, TokenNotAllowedError } from "@/lib/billing/token-access";
import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import {
  createBaseRpcFake,
  createManagedVeniceMemoryDb,
  managedVeniceQuoteRow,
  TEST_DEPOSIT_ADDRESS,
  type FakeTransfer,
} from "@/test-utils/managed-venice-memory-db";

const HIVRA = "0x2222222222222222222222222222222222222222";
const ANCHOR_BLOCK = 5_000_000;
const ANCHOR_TIME = "2026-05-16T10:35:00.000Z";
const QUOTED = 1000n * 10n ** 18n;

function blockAt(iso: string) {
  return ANCHOR_BLOCK + Math.floor((Date.parse(iso) - Date.parse(ANCHOR_TIME)) / 2000);
}
function transfer(txHash: string, token: string, iso: string): FakeTransfer {
  return { txHash, amountRaw: QUOTED, block: blockAt(iso), to: TEST_DEPOSIT_ADDRESS, tokenAddress: token };
}
function seed(token: "hermesos" | "hivra") {
  return createManagedVeniceMemoryDb({
    managed_venice_token_quotes: [
      managedVeniceQuoteRow({ token_key: token, token_address: token === "hivra" ? HIVRA : HERMESOS_TOKEN_ADDRESS }),
    ],
  });
}
async function reconcileAt(memory: ReturnType<typeof seed>, transfers: FakeTransfer[], iso: string) {
  const rpc = createBaseRpcFake({ latestBlock: ANCHOR_BLOCK, latestTimestamp: ANCHOR_TIME, transfers });
  rpc.setLatestBlock(blockAt(iso));
  return reconcileManagedVeniceTokenQuote({
    quoteId: "quote_1",
    userId: "user_1",
    db: memory.db,
    rpcUrl: "https://base.test",
    fetchImpl: rpc.fetchImpl,
    minConfirmations: 3,
    now: new Date(iso),
  });
}

describe("managed Venice deposits after $HIVRA activation", () => {
  it("refuse a $HermesOS deposit quote for a new user, server-side", async () => {
    const memory = createManagedVeniceMemoryDb();
    await expect(
      createManagedVeniceTokenQuote(
        {
          userId: "new_user",
          tokenAmountRaw: QUOTED,
          depositAddress: TEST_DEPOSIT_ADDRESS,
          token: "hermesos",
          access: computeUserTokenAccess({ phase: "active", cohort: null, now: new Date() }),
        },
        memory.db
      )
    ).rejects.toBeInstanceOf(TokenNotAllowedError);
    expect(memory.tables.managed_venice_token_quotes ?? []).toHaveLength(0);
  });

  it("credit a $HIVRA quote with a $HIVRA transfer, with the same bonus, recording the token", async () => {
    const memory = seed("hivra");
    const result = await reconcileAt(memory, [transfer("0xhivra", HIVRA, "2026-05-16T10:21:00.000Z")], "2026-05-16T10:25:00.000Z");
    expect(result.status).toBe("settled");
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({
        transaction_hash: "0xhivra",
        source: "hivra_deposit",
        token_key: "hivra",
        token_address: HIVRA,
        // paid 50 + launch bonus 10: the same bonus as a $HermesOS deposit.
        original_value_micro_usd: 60_000_000,
      }),
    ]);
    expect(memory.tables.managed_venice_financial_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "token_deposit", wallet_type: "hivra" }),
        expect.objectContaining({ event_type: "subsidy_applied", wallet_type: "hivra", discount_micro_usd: 10_000_000 }),
      ])
    );
  });

  it("never credit a $HermesOS transfer to a $HIVRA quote, and flag it for operator recovery", async () => {
    const memory = seed("hivra");
    const wrong = transfer("0xwrong", HERMESOS_TOKEN_ADDRESS, "2026-05-16T10:21:00.000Z");
    await reconcileAt(memory, [wrong], "2026-05-16T10:25:00.000Z");
    await reconcileAt(memory, [wrong], "2026-05-16T10:26:00.000Z"); // surfaced once

    expect(memory.tables.managed_venice_token_lots ?? []).toHaveLength(0);
    expect(memory.tables.managed_venice_token_quotes[0]).toMatchObject({ transaction_hash: null });
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.wrongToken,
        token_address: HERMESOS_TOKEN_ADDRESS,
        status: "open",
      }),
    ]);
  });

  it("settle a grandfathered $HermesOS quote with $HermesOS and flag a $HIVRA transfer beside it", async () => {
    const memory = seed("hermesos");
    const result = await reconcileAt(
      memory,
      [
        transfer("0xhivra_wrong", HIVRA, "2026-05-16T10:21:00.000Z"),
        transfer("0xhermesos", HERMESOS_TOKEN_ADDRESS, "2026-05-16T10:22:00.000Z"),
      ],
      "2026-05-16T10:25:00.000Z"
    );
    expect(result.status).toBe("settled");
    expect(memory.tables.managed_venice_token_lots).toEqual([
      expect.objectContaining({ transaction_hash: "0xhermesos", source: "hermesos_deposit", token_key: "hermesos" }),
    ]);
    expect(memory.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({ reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.wrongToken, token_address: HIVRA }),
    ]);
  });
});
