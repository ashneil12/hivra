import { keccak256, toFunctionSelector, toHex } from "viem";

import { HERMESOS_TOKEN, type PlatformToken } from "@/lib/billing/token-registry";
import type { HivraMigrationConfig } from "@/lib/claim/hivra-migration-config";
import {
  EXECUTION_SUCCESS_TOPIC,
  EXEC_TRANSACTION_SELECTOR,
  SAFE_RECEIVED_TOPIC,
  TRANSFER_TOPIC,
  checkReceiptOnChain,
  founderWeeks,
  getServedTokenReceiptsBase,
  readPlainHttpsUrl,
  tokenCountToWei,
  tokenReceiptsHref,
  validateTokenReceipts,
  type ChainLog,
  type ChainTx,
  type ReceiptAddresses,
  type ValidatedReceipt,
} from "../token-receipts";
import { formatReceiptDate, formatTokenAmount } from "../token-receipts-format";
import type { TokenReceiptEntry } from "../token-receipts-config";

const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args), error: jest.fn() } }));

const HIVRA = "0x1111111111111111111111111111111111111111";
const SAFE = "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C";
const FOUNDER = "0x672b58b6d10413fe69ab0907db5b17712bd45f7a";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const LOCKER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const WETH = "0x4200000000000000000000000000000000000006";
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const E18 = 10n ** 18n;
const NOW = new Date("2026-12-01T00:00:00Z");

const ADDRESSES: ReceiptAddresses = { treasurySafe: SAFE, founderWallet: FOUNDER, burnAddress: DEAD, hivraAddress: HIVRA };

const topic = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint): ChainLog => ({ address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: word(value) });
const nft = (token: string, from: string, to: string, id: bigint): ChainLog => ({ address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to), word(id)], data: "0x" });
const safeReceived = (value: bigint): ChainLog => ({ address: SAFE, topics: [SAFE_RECEIVED_TOPIC, topic(POOL)], data: word(value) });
const executed: ChainLog = { address: SAFE, topics: [EXECUTION_SUCCESS_TOPIC], data: `${word(1n)}${word(0n).slice(2)}` };

function tx(logs: ChainLog[], overrides: Partial<ChainTx> = {}): ChainTx {
  return { status: "success", blockNumber: 100n, timestamp: Date.parse("2026-11-04T16:00:00Z") / 1000, to: null, input: "0x", logs, ...overrides };
}

function receipt(kind: ValidatedReceipt["kind"], overrides: Partial<ValidatedReceipt> = {}): ValidatedReceipt {
  return { date: { iso: "2026-11-04T00:00:00.000Z", dateOnly: true }, kind, txHash: HASH(1), note: null, lock: null, ...overrides };
}

describe("event topics", () => {
  it("match the event signatures", () => {
    expect(TRANSFER_TOPIC).toBe(keccak256(toHex("Transfer(address,address,uint256)")));
    expect(SAFE_RECEIVED_TOPIC).toBe(keccak256(toHex("SafeReceived(address,uint256)")));
    expect(EXECUTION_SUCCESS_TOPIC).toBe(keccak256(toHex("ExecutionSuccess(bytes32,uint256)")));
    expect(EXEC_TRANSACTION_SELECTOR).toBe(toFunctionSelector("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"));
  });
});

describe("tokenCountToWei", () => {
  it("reads the migration config's counts", () => {
    expect(tokenCountToWei("500M")).toBe(500_000_000n * E18);
    expect(tokenCountToWei("11.34B")).toBe(11_340_000_000n * E18);
    expect(tokenCountToWei("1.5K")).toBe(1_500n * E18);
    expect(tokenCountToWei("500")).toBeNull();
    expect(tokenCountToWei(null)).toBeNull();
  });
});

describe("readPlainHttpsUrl", () => {
  it("accepts a plain https link and refuses anything else", () => {
    expect(readPlainHttpsUrl("https://app.uncx.network/lockers/univ4/chain/8453/position/123")).toBe("https://app.uncx.network/lockers/univ4/chain/8453/position/123");
    expect(readPlainHttpsUrl("http://example.com/lock")).toBeNull();
    expect(readPlainHttpsUrl("https://user:pw@example.com/lock")).toBeNull();
    expect(readPlainHttpsUrl("https://example.com:8443/lock")).toBeNull();
    expect(readPlainHttpsUrl("https://example.com/lock#x")).toBeNull();
    expect(readPlainHttpsUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("validateTokenReceipts", () => {
  const entry = (overrides: Partial<TokenReceiptEntry> = {}): TokenReceiptEntry => ({ date: "2026-11-04", kind: "fee-claim", txHash: HASH(1), note: null, ...overrides });
  const lock = { locker: "UNCX", lockerAddress: LOCKER, url: "https://app.uncx.network/lock/1", unlocksAt: "2027-11-04" };

  it("keeps valid entries newest first and lowercases hashes", () => {
    const { receipts, problems } = validateTokenReceipts([
      entry({ date: "2026-11-01", txHash: HASH(0xab).toUpperCase().replace("0X", "0x") }),
      entry({ date: "2026-11-20T10:00:00Z", kind: "liquidity-lock", txHash: HASH(2), lock }),
      entry({ date: "2026-11-20T10:00:00Z", kind: "liquidity-add", txHash: HASH(2), note: "Week 1 liquidity" }),
    ], { now: NOW });
    expect(problems).toEqual([]);
    expect(receipts.map((r) => r.kind)).toEqual(["liquidity-lock", "liquidity-add", "fee-claim"]);
    expect(receipts[2].txHash).toBe(HASH(0xab));
    expect(receipts[0].lock).toEqual({ locker: "UNCX", lockerAddress: LOCKER, url: "https://app.uncx.network/lock/1", unlocksAt: { iso: "2027-11-04T00:00:00.000Z", dateOnly: true } });
  });

  it("reads a lock that never ends", () => {
    const { receipts } = validateTokenReceipts([entry({ kind: "liquidity-lock", lock: { ...lock, unlocksAt: "never", url: null } })], { now: NOW });
    expect(receipts[0].lock).toMatchObject({ unlocksAt: null, url: null });
  });

  it.each([
    ["a bad date", entry({ date: "2026-02-30" }), "date must be"],
    ["a future date", entry({ date: "2027-01-01" }), "in the future"],
    ["an unknown kind", entry({ kind: "buyback" as TokenReceiptEntry["kind"] }), "kind is not one of"],
    ["a bad hash", entry({ txHash: "0x1234" }), "txHash must be"],
    ["an empty note", entry({ note: "  " }), "note must be"],
    ["a lock without details", entry({ kind: "liquidity-lock" }), "without lock details"],
    ["a lock with a bad address", entry({ kind: "liquidity-lock", lock: { ...lock, lockerAddress: "0x0000000000000000000000000000000000000000" } }), "lockerAddress"],
    ["a lock with a bad checksum", entry({ kind: "liquidity-lock", lock: { ...lock, lockerAddress: "0x4ACDa6e26929acd34b45beDaEE2f7b8a418ce10C" } }), "lockerAddress"],
    ["a lock with an http link", entry({ kind: "liquidity-lock", lock: { ...lock, url: "http://x.example/lock" } }), "lock.url"],
    ["a lock with a bad unlock date", entry({ kind: "liquidity-lock", lock: { ...lock, unlocksAt: "soon" } }), "unlocksAt"],
    ["lock details on another kind", entry({ lock }), "not a liquidity-lock"],
  ])("refuses %s", (_label, bad, message) => {
    const { receipts, problems } = validateTokenReceipts([bad], { now: NOW });
    expect(receipts).toEqual([]);
    expect(problems.join("\n")).toContain(message);
  });

  it("refuses a repeated transaction of the same kind", () => {
    const { receipts, problems } = validateTokenReceipts([entry(), entry()], { now: NOW });
    expect(receipts).toHaveLength(1);
    expect(problems[0]).toContain("repeats");
  });

  it("refuses a founder sale before the sale start's UTC day, but not on it", () => {
    const saleStart = { iso: "2026-11-04T16:00:00.000Z", dateOnly: false };
    const { receipts, problems } = validateTokenReceipts([
      entry({ kind: "founder-sale", date: "2026-11-03", txHash: HASH(1) }),
      entry({ kind: "founder-sale", date: "2026-11-04", txHash: HASH(2) }),
    ], { now: NOW, saleStart });
    expect(receipts.map((r) => r.txHash)).toEqual([HASH(2)]);
    expect(problems[0]).toContain("before founder.saleStart");
  });
});

describe("checkReceiptOnChain", () => {
  it("refuses a reverted transaction and one on another UTC day", () => {
    expect(checkReceiptOnChain(receipt("fee-claim"), tx([safeReceived(E18)], { status: "reverted" }), ADDRESSES)).toEqual({ ok: false, reason: "the transaction reverted" });
    const late = tx([safeReceived(E18)], { timestamp: Date.parse("2026-11-05T00:00:01Z") / 1000 });
    expect(checkReceiptOnChain(receipt("fee-claim"), late, ADDRESSES)).toMatchObject({ ok: false, reason: expect.stringContaining("2026-11-05") });
  });

  describe("fee-claim", () => {
    it("sums ETH and named tokens reaching the Safe, and counts the rest", () => {
      const check = checkReceiptOnChain(receipt("fee-claim"), tx([
        safeReceived(3n * E18 / 10n),
        transfer(HIVRA, POOL, SAFE, 1_000n * E18),
        transfer(HIVRA, POOL, SAFE, 500n * E18),
        transfer(HIVRA, POOL, FOUNDER, 99n * E18),
        transfer(POOL, POOL, SAFE, 5n),
      ]), ADDRESSES);
      expect(check).toEqual({ ok: true, blockNumber: 100n, timestamp: expect.any(Number), amounts: [{ token: "ETH", wei: 3n * E18 / 10n }, { token: "HIVRA", wei: 1_500n * E18 }], positionIds: [], otherTransfers: 1 });
    });

    it("reads SafeReceived from an older Safe that does not index the sender", () => {
      const old: ChainLog = { address: SAFE, topics: [SAFE_RECEIVED_TOPIC], data: `${topic(POOL)}${word(7n).slice(2)}` };
      expect(checkReceiptOnChain(receipt("fee-claim"), tx([old]), ADDRESSES)).toMatchObject({ ok: true, amounts: [{ token: "ETH", wei: 7n }] });
    });

    it("refuses one where nothing reaches the Safe, or SafeReceived comes from another contract", () => {
      const elsewhere = { ...safeReceived(E18), address: POOL };
      expect(checkReceiptOnChain(receipt("fee-claim"), tx([elsewhere, transfer(HIVRA, POOL, FOUNDER, E18)]), ADDRESSES)).toEqual({ ok: false, reason: "nothing it names reached the treasury Safe" });
    });

    it("refuses when no Safe is configured", () => {
      expect(checkReceiptOnChain(receipt("fee-claim"), tx([safeReceived(E18)]), { ...ADDRESSES, treasurySafe: null })).toMatchObject({ ok: false });
    });
  });

  describe("liquidity", () => {
    // execTransaction(to, value, data, operation, ...): the value is the second word, the operation the fourth.
    const execInput = (value: bigint, operation: bigint) => `${EXEC_TRANSACTION_SELECTOR}${word(BigInt(POOL)).slice(2)}${word(value).slice(2)}${word(320n).slice(2)}${word(operation).slice(2)}${"0".repeat(64 * 6)}`;

    it("adds what left the Safe, with the ETH value of a plain execTransaction", () => {
      const check = checkReceiptOnChain(receipt("liquidity-add"), tx([executed, transfer(HIVRA, SAFE, POOL, 200n * E18)], { to: SAFE, input: execInput(E18 / 10n, 0n) }), ADDRESSES);
      expect(check).toMatchObject({ ok: true, amounts: [{ token: "ETH", wei: E18 / 10n }, { token: "HIVRA", wei: 200n * E18 }] });
    });

    it("does not count ETH from a delegatecall", () => {
      const check = checkReceiptOnChain(receipt("liquidity-add"), tx([executed, transfer(WETH, SAFE, POOL, 5n)], { to: SAFE, input: execInput(E18, 1n) }), ADDRESSES);
      expect(check).toMatchObject({ ok: true, amounts: [{ token: "WETH", wei: 5n }] });
    });

    it("refuses an addition the Safe did not execute, or that moved nothing", () => {
      expect(checkReceiptOnChain(receipt("liquidity-add"), tx([transfer(HIVRA, SAFE, POOL, E18)]), ADDRESSES)).toEqual({ ok: false, reason: "the treasury Safe did not execute it" });
      expect(checkReceiptOnChain(receipt("liquidity-add"), tx([executed]), ADDRESSES)).toEqual({ ok: false, reason: "nothing left the treasury Safe" });
    });

    const lockReceipt = receipt("liquidity-lock", { lock: { locker: "UNCX", lockerAddress: LOCKER, url: null, unlocksAt: null } });

    it("records a position the Safe moved into the locker", () => {
      const check = checkReceiptOnChain(lockReceipt, tx([executed, nft(POOL, SAFE, LOCKER, 4242n)]), ADDRESSES);
      expect(check).toMatchObject({ ok: true, positionIds: ["4242"], amounts: [] });
    });

    it("accepts a lock where the locker emits a log", () => {
      expect(checkReceiptOnChain(lockReceipt, tx([executed, { address: LOCKER, topics: [HASH(9)], data: "0x" }]), ADDRESSES)).toMatchObject({ ok: true });
    });

    it("refuses a lock that never touches the named locker", () => {
      expect(checkReceiptOnChain(lockReceipt, tx([executed, nft(POOL, SAFE, POOL, 1n)]), ADDRESSES)).toEqual({ ok: false, reason: "it does not touch the named locker" });
    });
  });

  describe("founder", () => {
    const hermesos = HERMESOS_TOKEN.address;

    it("sums $HermesOS leaving the founder wallet for a sale, leaving burns out", () => {
      const check = checkReceiptOnChain(receipt("founder-sale"), tx([
        transfer(hermesos, FOUNDER, POOL, 400_000_000n * E18),
        transfer(hermesos, FOUNDER, DEAD, 1n),
        transfer(HIVRA, FOUNDER, POOL, E18),
        transfer(hermesos, POOL, FOUNDER, E18),
      ]), ADDRESSES);
      expect(check).toMatchObject({ ok: true, amounts: [{ token: "HermesOS", wei: 400_000_000n * E18 }] });
    });

    it("counts a burn to the burn address or the zero address", () => {
      const check = checkReceiptOnChain(receipt("founder-burn"), tx([
        transfer(hermesos, FOUNDER, DEAD, 5_000_000_000n * E18),
        transfer(hermesos, FOUNDER, "0x0000000000000000000000000000000000000000", 1n * E18),
        transfer(hermesos, FOUNDER, POOL, 7n * E18),
      ]), ADDRESSES);
      expect(check).toMatchObject({ ok: true, amounts: [{ token: "HermesOS", wei: 5_000_000_001n * E18 }] });
    });

    it("refuses a sale or burn by another wallet", () => {
      expect(checkReceiptOnChain(receipt("founder-sale"), tx([transfer(hermesos, POOL, FOUNDER, E18)]), ADDRESSES)).toEqual({ ok: false, reason: "no $HermesOS left the founder wallet" });
      expect(checkReceiptOnChain(receipt("founder-burn"), tx([transfer(hermesos, POOL, DEAD, E18)]), ADDRESSES)).toEqual({ ok: false, reason: "no $HermesOS went from the founder wallet to the burn address" });
    });
  });
});

describe("founderWeeks", () => {
  const saleStart = { iso: "2026-11-04T00:00:00.000Z", dateOnly: true };
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("puts each sale in its week, flags a week over the cap and marks weeks not started", () => {
    const { rows, afterPlanWei } = founderWeeks([
      { timestamp: at("2026-11-04T12:00:00Z"), wei: 300n },
      { timestamp: at("2026-11-10T23:59:59Z"), wei: 300n },
      { timestamp: at("2026-11-11T00:00:00Z"), wei: 100n },
      { timestamp: at("2026-11-25T00:00:00Z"), wei: 9n },
    ], { saleStart, weeks: 3, weeklyCapWei: 500n, now: new Date("2026-11-12T00:00:00Z") });
    expect(rows.map((row) => [row.week, row.soldWei, row.overCap, row.upcoming])).toEqual([
      [1, 600n, true, false],
      [2, 100n, false, false],
      [3, 0n, false, true],
    ]);
    expect(rows[0]).toMatchObject({ startsAt: "2026-11-04T00:00:00.000Z", endsAt: "2026-11-11T00:00:00.000Z" });
    expect(afterPlanWei).toBe(9n);
  });
});

describe("format", () => {
  it("writes token amounts in words above a million and to four decimals below", () => {
    expect(formatTokenAmount(500_000_000n * E18, 18)).toBe("500 million");
    expect(formatTokenAmount(11_340_000_000n * E18, 18)).toBe("11.34 billion");
    expect(formatTokenAmount(1_234_567_800_000_000_000_000n, 18)).toBe("1,234.5678");
    expect(formatTokenAmount(42n * 10n ** 15n, 18)).toBe("0.042");
    expect(formatTokenAmount(1n, 18)).toBe("less than 0.0001");
    expect(formatTokenAmount(0n, 18)).toBe("0");
    expect(formatTokenAmount(2_500_000n, 6)).toBe("2.5");
  });

  it("writes dates in UTC", () => {
    expect(formatReceiptDate("2026-11-04T00:00:00.000Z", true)).toBe("4 November 2026");
    expect(formatReceiptDate("2026-11-04T16:05:00.000Z", false)).toBe("4 November 2026, 16:05 UTC");
  });
});

describe("getServedTokenReceiptsBase", () => {
  const ON = { HIVRA_NEW_TOKEN_SURFACES: "true" };
  const hivra = { address: HIVRA, publishedAddress: HIVRA } as PlatformToken;
  const migration: HivraMigrationConfig = {
    published: false,
    announcedAt: "2026-10-20T16:00:00Z",
    treasurySafe: SAFE,
    fee: { totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 },
    founder: { wallet: FOUNDER, heldTokens: "11.34B", migrated: false, headStartDays: 14, weeklyCapTokens: "500M", maxPriceImpactPct: 5, weeks: 12, saleStart: "2026-11-04", saleDay: null, burnDate: null, burnAddress: DEAD },
    receipts: [],
  };
  const airdrop = { senderAddress: null, snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: { campaignUrl: null, opensAt: null, closesAt: null } };

  it("is hidden while the switch is off or $HIVRA is dormant", () => {
    expect(getServedTokenReceiptsBase({ env: {}, hivra, migration, airdrop, ledger: [], now: NOW })).toBeNull();
    expect(getServedTokenReceiptsBase({ env: ON, hivra: null, migration, airdrop, ledger: [], now: NOW })).toBeNull();
    expect(tokenReceiptsHref({ env: {}, hivra })).toBeNull();
    expect(tokenReceiptsHref({ env: ON, hivra: null })).toBeNull();
    expect(tokenReceiptsHref({ env: ON, hivra })).toBe("/token/receipts");
  });

  it("reads the Safe, the fee split and the founder plan from the migration config, even before that page is published", () => {
    const served = getServedTokenReceiptsBase({ env: ON, hivra, migration, airdrop, ledger: [{ date: "2026-11-05", kind: "founder-sale", txHash: HASH(3), note: null }], now: NOW });
    expect(served).toMatchObject({
      hivraAddress: HIVRA,
      hermesosAddress: HERMESOS_TOKEN.publishedAddress,
      treasurySafe: SAFE,
      fee: { totalPct: 1.58 },
      founder: { wallet: "0x672b58B6d10413Fe69ab0907db5B17712BD45f7A", weeks: 12, saleStart: { iso: "2026-11-04T00:00:00.000Z", dateOnly: true } },
      weeklyCapWei: 500_000_000n * E18,
      receipts: [{ kind: "founder-sale", txHash: HASH(3) }],
    });
  });

  it("logs config problems and leaves the bad entry out", () => {
    const served = getServedTokenReceiptsBase({ env: ON, hivra, migration, airdrop, ledger: [{ date: "2026-11-01", kind: "founder-sale", txHash: HASH(4), note: null }], now: NOW });
    expect(served?.receipts).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith("Token receipts config rejected", expect.objectContaining({ problems: expect.stringContaining("before founder.saleStart") }));
  });

  it("has no weekly cap when the config's cap is invalid", () => {
    const bad = { ...migration, founder: { ...migration.founder!, weeklyCapTokens: "lots" } };
    expect(getServedTokenReceiptsBase({ env: ON, hivra, migration: bad, airdrop, ledger: [], now: NOW })?.weeklyCapWei).toBeNull();
  });
});
