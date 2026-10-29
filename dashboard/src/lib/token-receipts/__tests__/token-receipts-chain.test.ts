import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";

import { SAFE_RECEIVED_TOPIC, TRANSFER_TOPIC, type ChainLog, type ChainTx, type TokenReceiptsBase, type ValidatedReceipt } from "../token-receipts";
import { loadTokenReceipts, type TokenReceiptsChainReader } from "../token-receipts-chain";

const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args), error: jest.fn() } }));
// Outside a Next request there is no data cache: run the callback directly.
jest.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));

const HIVRA = "0x1111111111111111111111111111111111111111";
const SAFE = "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C";
const FOUNDER = "0x672b58B6d10413Fe69ab0907db5B17712BD45f7A";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const POOL = "0x3333333333333333333333333333333333333333";
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const E18 = 10n ** 18n;
const NOW = new Date("2026-11-20T00:00:00Z");

const topic = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint): ChainLog => ({ address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: word(value) });
const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
const tx = (day: string, logs: ChainLog[]): ChainTx => ({ status: "success", blockNumber: 1n, timestamp: at(day), to: null, input: "0x", logs });
const entry = (day: string, kind: ValidatedReceipt["kind"], n: number): ValidatedReceipt => ({ date: { iso: `${day}T00:00:00.000Z`, dateOnly: true }, kind, txHash: HASH(n), note: null, lock: null });

function base(receipts: ValidatedReceipt[]): TokenReceiptsBase {
  return {
    hivraAddress: HIVRA,
    hermesosAddress: HERMESOS_TOKEN.publishedAddress,
    treasurySafe: SAFE,
    fee: { totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 },
    founder: {
      wallet: FOUNDER, heldTokens: "11.34 billion", headStartDays: 14, weeklyCapTokens: "500 million", maxPriceImpactPct: 5, weeks: 3,
      saleStart: { iso: "2026-11-04T00:00:00.000Z", dateOnly: true }, saleDay: null, burnDate: null, burnAddress: DEAD,
    },
    weeklyCapWei: 500_000_000n * E18,
    receipts,
  };
}

function reader(txs: Record<string, ChainTx | null | Error>, balances: Awaited<ReturnType<TokenReceiptsChainReader["getBalances"]>> | Error = { safeEthWei: E18, safeHivraWei: 10n * E18, founderHermesosWei: 9_000_000_000n * E18 }): TokenReceiptsChainReader {
  return {
    getTransaction: jest.fn(async (hash: string) => {
      const found = txs[hash];
      if (found instanceof Error) throw found;
      return found ?? null;
    }),
    getBalances: jest.fn(async () => {
      if (balances instanceof Error) throw balances;
      return balances;
    }),
  };
}

describe("loadTokenReceipts", () => {
  it("shows verified lines with their on-chain amounts, totals them and fills the founder weeks", async () => {
    const receipts = [
      entry("2026-11-12", "founder-sale", 4),
      entry("2026-11-05", "founder-sale", 3),
      entry("2026-11-05", "fee-claim", 2),
      entry("2026-11-04", "fee-claim", 1),
    ];
    const served = await loadTokenReceipts(base(receipts), {
      now: NOW,
      reader: reader({
        [HASH(1)]: tx("2026-11-04", [{ address: SAFE, topics: [SAFE_RECEIVED_TOPIC, topic(POOL)], data: word(E18 / 2n) }]),
        [HASH(2)]: tx("2026-11-05", [transfer(HIVRA, POOL, SAFE, 100n * E18), { address: SAFE, topics: [SAFE_RECEIVED_TOPIC, topic(POOL)], data: word(E18 / 4n) }]),
        [HASH(3)]: tx("2026-11-05", [transfer(HERMESOS_TOKEN.address, FOUNDER, POOL, 450_000_000n * E18)]),
        [HASH(4)]: tx("2026-11-12", [transfer(HERMESOS_TOKEN.address, FOUNDER, POOL, 600_000_000n * E18)]),
      }),
    });
    expect(served.chainComplete).toBe(true);
    expect(served.receipts.map((r) => [r.txHash, r.check])).toEqual([[HASH(4), "verified"], [HASH(3), "verified"], [HASH(2), "verified"], [HASH(1), "verified"]]);
    expect(served.totals).toEqual({
      feesReceived: [{ token: "ETH", wei: 3n * E18 / 4n }, { token: "HIVRA", wei: 100n * E18 }],
      liquidityAdded: [],
      founderSoldWei: 1_050_000_000n * E18,
      founderBurnedWei: 0n,
    });
    expect(served.founderWeeks?.rows.map((row) => [row.week, row.soldWei, row.overCap, row.upcoming])).toEqual([
      [1, 450_000_000n * E18, false, false],
      [2, 600_000_000n * E18, true, false],
      [3, 0n, false, false],
    ]);
    expect(served.balances.founderHermesosWei).toBe(9_000_000_000n * E18);
    expect(served.checkedAt).toBe(NOW.toISOString());
  });

  it("leaves out and logs an entry Base does not have or that does not match, never showing it", async () => {
    const served = await loadTokenReceipts(base([entry("2026-11-05", "fee-claim", 1), entry("2026-11-05", "founder-burn", 2)]), {
      now: NOW,
      reader: reader({
        [HASH(1)]: null,
        [HASH(2)]: tx("2026-11-05", [transfer(HERMESOS_TOKEN.address, FOUNDER, POOL, E18)]),
      }),
    });
    expect(served.receipts).toEqual([]);
    expect(served.chainComplete).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith("Token receipts rejected", expect.objectContaining({
      problems: expect.stringMatching(/fee-claim 0x0+1: Base has no such transaction; founder-burn 0x0+2: no \$HermesOS went from the founder wallet/),
    }));
  });

  it("lists an entry it could not read as not checked, outside the totals", async () => {
    const served = await loadTokenReceipts(base([entry("2026-11-05", "founder-sale", 1)]), {
      now: NOW,
      reader: reader({ [HASH(1)]: new Error("fetch failed") }, new Error("fetch failed")),
    });
    expect(served.chainComplete).toBe(false);
    expect(served.receipts).toEqual([expect.objectContaining({ txHash: HASH(1), check: "unchecked" })]);
    expect(served.totals.founderSoldWei).toBe(0n);
    expect(served.balances).toEqual({ safeEthWei: null, safeHivraWei: null, founderHermesosWei: null });
    expect(served.founderWeeks?.rows.every((row) => row.soldWei === 0n)).toBe(true);
  });

  it("has no founder weeks until the sale start is set", async () => {
    const plain = base([]);
    plain.founder = { ...plain.founder!, saleStart: null };
    expect((await loadTokenReceipts(plain, { now: NOW, reader: reader({}) })).founderWeeks).toBeNull();
  });
});
