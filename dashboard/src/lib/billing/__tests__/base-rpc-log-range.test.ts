/**
 * Base eth_getLogs range limit — regression for USDC top-ups never crediting.
 *
 * https://mainnet.base.org (the fallback when neither HERMES_BASE_RPC_URL nor
 * BASE_RPC_URL is set, which was the case on hermesos and hermesos-canary on
 * 2026-09-22) rejects any eth_getLogs range over 2,000 blocks:
 *
 *   HTTP 413 {"jsonrpc":"2.0","error":{"code":-32614,
 *             "message":"eth_getLogs is limited to a 2,000 range"},"id":1}
 *
 * The USDC top-up reconciler made one 5,000-block call, so every pending
 * top-up failed every /api/cron/reconcile-crypto-topups tick while the cron
 * still returned 200. The fake RPC below enforces the real limit; every Base
 * log scan must stay inside it, and only the shared helper may issue
 * eth_getLogs so the limit cannot drift per caller again.
 */
import fs from "node:fs";
import path from "node:path";

import {
  getLogsInBlockChunks,
  MAX_BASE_RPC_LOG_RANGE_BLOCKS,
} from "@/lib/billing/base-rpc-logs";
import {
  createBaseChainReader,
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
  scanErc20TransfersInWindow,
} from "@/lib/billing/base-transfer-scan";
import { USDC_BASE_TOKEN_ADDRESS } from "@/lib/billing/crypto-topups";
import { reconcileManagedVeniceTokenQuote } from "@/lib/billing/managed-venice-token-reconciliation";
import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import { createManagedVeniceMemoryDb, managedVeniceQuoteRow } from "@/test-utils/managed-venice-memory-db";

const PUBLIC_BASE_RPC_LOG_RANGE_LIMIT = 2_000;
const LATEST_BLOCK = 51_655_528;
const now = new Date("2026-09-22T12:00:00.000Z");
const usdcDepositAddress = "0x000000000000000000000000000000000000dead";
const veniceDepositAddress = "0x000000000000000000000000000000000000ba5e";

type FakeLog = {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  blockHash: string;
};
type LogRange = { fromBlock: number; toBlock: number };

// Base mines a block every 2 s; LATEST_BLOCK was mined at `now`.
function blockTimeSec(block: number) {
  return Math.floor(now.getTime() / 1000) - 2 * (LATEST_BLOCK - block);
}

function blockTimeMs(block: number) {
  return blockTimeSec(block) * 1000;
}

function hex(value: number | bigint) {
  return `0x${value.toString(16)}`;
}

function uint256(value: bigint | number) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function transferLog(params: {
  token: string;
  to: string;
  amount: bigint | number;
  blockNumber: number;
  transactionHash: string;
}): FakeLog {
  return {
    address: params.token,
    topics: [
      ERC20_TRANSFER_TOPIC,
      encodeErc20TransferToTopic("0x0000000000000000000000000000000000000001"),
      encodeErc20TransferToTopic(params.to),
    ],
    data: uint256(params.amount),
    transactionHash: params.transactionHash,
    logIndex: "0x0",
    blockNumber: hex(params.blockNumber),
    blockHash: `0xblock${params.blockNumber}`,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * A Base JSON-RPC endpoint that behaves like mainnet.base.org for the methods
 * the reconcilers use, including the 2,000-block eth_getLogs limit. It records
 * every requested log range. `failGetLogsOnce` returns that HTTP status for the
 * Nth eth_getLogs request (1-based) once, to exercise retry.
 */
function createRangeLimitedBaseRpc(params: {
  logs: FakeLog[];
  latestBlock?: number;
  failGetLogsOnce?: { request: number; status: number };
}) {
  const latestBlock = params.latestBlock ?? LATEST_BLOCK;
  const ranges: LogRange[] = [];
  let getLogsRequests = 0;
  let failureUsed = false;
  const blockTag = (tag: unknown) =>
    tag === "latest" ? latestBlock : Number.parseInt(String(tag), 16);

  const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { method: string; params: unknown[] };
    if (request.method === "eth_blockNumber") {
      return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: hex(latestBlock) });
    }
    if (request.method === "eth_getBlockByNumber") {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          number: request.params[0],
          timestamp: hex(blockTimeSec(Number.parseInt(String(request.params[0]), 16))),
        },
      });
    }
    if (request.method === "eth_getLogs") {
      getLogsRequests += 1;
      const filter = request.params[0] as {
        address: string;
        fromBlock: unknown;
        toBlock: unknown;
        topics: Array<string | null>;
      };
      const range = { fromBlock: blockTag(filter.fromBlock), toBlock: blockTag(filter.toBlock) };
      ranges.push(range);

      if (
        params.failGetLogsOnce &&
        !failureUsed &&
        getLogsRequests === params.failGetLogsOnce.request
      ) {
        failureUsed = true;
        return jsonResponse(params.failGetLogsOnce.status, {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32005, message: "rate limited" },
        });
      }

      if (range.toBlock - range.fromBlock + 1 > PUBLIC_BASE_RPC_LOG_RANGE_LIMIT) {
        return jsonResponse(413, {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" },
        });
      }

      const result = params.logs.filter((log) => {
        const block = Number.parseInt(log.blockNumber, 16);
        return (
          log.address.toLowerCase() === filter.address.toLowerCase() &&
          log.topics[0] === filter.topics[0] &&
          log.topics[2] === filter.topics[2] &&
          block >= range.fromBlock &&
          block <= range.toBlock
        );
      });
      return jsonResponse(200, { jsonrpc: "2.0", id: 1, result });
    }
    throw new Error(`Unexpected RPC method ${request.method}`);
  });

  return { fetchImpl, ranges };
}

// Every request is inside the limit, and together the requests tile
// fromBlock..toBlock exactly: no gap a payment could fall into, no overlap.
function expectContiguousWithinLimit(ranges: LogRange[], fromBlock: number, toBlock: number) {
  expect(ranges.length).toBeGreaterThan(0);
  for (const range of ranges) {
    expect(range.toBlock - range.fromBlock + 1).toBeLessThanOrEqual(PUBLIC_BASE_RPC_LOG_RANGE_LIMIT);
  }
  expect(ranges[0].fromBlock).toBe(fromBlock);
  for (let index = 1; index < ranges.length; index += 1) {
    expect(ranges[index].fromBlock).toBe(ranges[index - 1].toBlock + 1);
  }
  expect(ranges[ranges.length - 1].toBlock).toBe(toBlock);
}

// The managed Venice reconciler scans each quote's own anchored range: its
// window plus the 2 h late-payment grace. Quoted 6 h before the head, the whole
// range (~4,200 blocks) is behind the head, so the scan spans several chunks.
const veniceQuotedAt = new Date(now.getTime() - 6 * 3_600_000);
const veniceQuotedAtBlock = LATEST_BLOCK - (6 * 3_600) / 2;
const veniceGraceEndBlock = veniceQuotedAtBlock + ((20 + 120) * 60) / 2;

const veniceQuoteRow = managedVeniceQuoteRow({
  id: "quote_1",
  account_id: "account_1",
  user_id: "user_1",
  token_amount_raw: "1001202000000000000000000",
  snapshot_price_usd: "0.000009988",
  locked_value_micro_usd: 10_000_005,
  deposit_address: veniceDepositAddress,
  quoted_at: veniceQuotedAt.toISOString(),
  expires_at: new Date(veniceQuotedAt.getTime() + 20 * 60_000).toISOString(),
  status: "expired",
  created_at: veniceQuotedAt.toISOString(),
  metadata: {
    managedVeniceTopUp: {
      paidValueMicroUsd: 10_000_000,
      creditValueMicroUsd: 12_000_000,
      bonusValueMicroUsd: 2_000_000,
    },
  },
});

describe("getLogsInBlockChunks", () => {
  const filter = { address: USDC_BASE_TOKEN_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, null, "0xto"] };

  function recordingCall(resultForRange: (range: LogRange) => unknown[] = () => []) {
    const ranges: LogRange[] = [];
    const call = jest.fn(async (method: string, args: unknown[]) => {
      expect(method).toBe("eth_getLogs");
      const request = args[0] as { fromBlock: string; toBlock: string };
      const range = {
        fromBlock: Number.parseInt(request.fromBlock, 16),
        toBlock: Number.parseInt(request.toBlock, 16),
      };
      ranges.push(range);
      return resultForRange(range);
    });
    return { call: call as unknown as Parameters<typeof getLogsInBlockChunks>[0]["call"], ranges };
  }

  it("pins the chunk size at the public Base RPC limit", () => {
    expect(MAX_BASE_RPC_LOG_RANGE_BLOCKS).toBeLessThanOrEqual(PUBLIC_BASE_RPC_LOG_RANGE_LIMIT);
  });

  it("tiles a 5,000-block range into requests of at most 2,000 blocks and keeps log order", async () => {
    const { call, ranges } = recordingCall((range) => [`logs ${range.fromBlock}-${range.toBlock}`]);

    const logs = await getLogsInBlockChunks<string>({ call, filter, fromBlock: 1_000, toBlock: 5_999 });

    expect(ranges).toEqual([
      { fromBlock: 1_000, toBlock: 2_999 },
      { fromBlock: 3_000, toBlock: 4_999 },
      { fromBlock: 5_000, toBlock: 5_999 },
    ]);
    expect(logs).toEqual(["logs 1000-2999", "logs 3000-4999", "logs 5000-5999"]);
  });

  it("uses one request for exactly 2,000 blocks and two for 2,001", async () => {
    const exact = recordingCall();
    await getLogsInBlockChunks({ call: exact.call, filter, fromBlock: 10, toBlock: 2_009 });
    expect(exact.ranges).toEqual([{ fromBlock: 10, toBlock: 2_009 }]);

    const overByOne = recordingCall();
    await getLogsInBlockChunks({ call: overByOne.call, filter, fromBlock: 10, toBlock: 2_010 });
    expect(overByOne.ranges).toEqual([
      { fromBlock: 10, toBlock: 2_009 },
      { fromBlock: 2_010, toBlock: 2_010 },
    ]);
  });

  it("refuses an inverted or non-integer range without calling the RPC", async () => {
    const { call, ranges } = recordingCall();

    await expect(getLogsInBlockChunks({ call, filter, fromBlock: 5, toBlock: 4 })).rejects.toThrow(
      "Invalid Base log scan range"
    );
    await expect(getLogsInBlockChunks({ call, filter, fromBlock: -1, toBlock: 4 })).rejects.toThrow(
      "Invalid Base log scan fromBlock"
    );
    await expect(getLogsInBlockChunks({ call, filter, fromBlock: 0, toBlock: 1.5 })).rejects.toThrow(
      "Invalid Base log scan toBlock"
    );
    expect(ranges).toEqual([]);
  });

  it("fails the whole scan when one chunk fails, instead of returning a partial scan", async () => {
    let requests = 0;
    const call = (async () => {
      requests += 1;
      if (requests === 2) throw new Error("Base RPC request failed with status 413");
      return [];
    }) as unknown as Parameters<typeof getLogsInBlockChunks>[0]["call"];

    await expect(getLogsInBlockChunks({ call, filter, fromBlock: 0, toBlock: 4_999 })).rejects.toThrow(
      "status 413"
    );
  });
});

describe("USDC top-up transfer scan within Base's 2,000-block eth_getLogs limit", () => {
  // The USDC reconciler scans each intent's window (creation to session end
  // plus late-payment grace) through scanErc20TransfersInWindow.
  const windowStartMs = blockTimeMs(LATEST_BLOCK - 5_000);
  const windowEndMs = blockTimeMs(LATEST_BLOCK - 800);

  function chainFor(fetchImpl: ReturnType<typeof createRangeLimitedBaseRpc>["fetchImpl"], sleepImpl?: () => Promise<void>) {
    return createBaseChainReader({
      rpcUrl: "https://base.test",
      fetchImpl,
      rpcOptions: sleepImpl ? { sleepImpl, random: () => 0 } : undefined,
    });
  }

  it("finds a payment in the first block of a 4,200-block intent window", async () => {
    const paidBlock = LATEST_BLOCK - 5_000;
    const { fetchImpl, ranges } = createRangeLimitedBaseRpc({
      logs: [
        transferLog({
          token: USDC_BASE_TOKEN_ADDRESS,
          to: usdcDepositAddress,
          amount: 50_000_000,
          blockNumber: paidBlock,
          transactionHash: "0xpaid",
        }),
      ],
    });

    const scan = await scanErc20TransfersInWindow({
      chain: chainFor(fetchImpl),
      tokenAddress: USDC_BASE_TOKEN_ADDRESS,
      toAddress: usdcDepositAddress,
      fromMs: windowStartMs,
      toMs: windowEndMs,
      minConfirmations: 3,
    });

    expect(scan.transfers).toEqual([
      expect.objectContaining({ transactionHash: "0xpaid", blockNumber: paidBlock, amount: 50_000_000n }),
    ]);
    expectContiguousWithinLimit(ranges, ranges[0].fromBlock, ranges[ranges.length - 1].toBlock);
    expect(ranges[0].fromBlock).toBeLessThanOrEqual(paidBlock);
    expect(ranges[ranges.length - 1].toBlock).toBeGreaterThanOrEqual(LATEST_BLOCK - 800);
    expect(ranges.length).toBeGreaterThan(1);
  });

  it("stays within the limit across the largest window the scanner accepts", async () => {
    const { fetchImpl, ranges } = createRangeLimitedBaseRpc({ logs: [] });

    await scanErc20TransfersInWindow({
      chain: chainFor(fetchImpl),
      tokenAddress: USDC_BASE_TOKEN_ADDRESS,
      toAddress: usdcDepositAddress,
      fromMs: blockTimeMs(LATEST_BLOCK - 49_000),
      toMs: blockTimeMs(LATEST_BLOCK),
      minConfirmations: 3,
    });

    expect(ranges.length).toBeGreaterThanOrEqual(25);
    expectContiguousWithinLimit(ranges, ranges[0].fromBlock, LATEST_BLOCK);
  });

  it("retries a rate-limited (429) log chunk instead of failing the scan", async () => {
    const paidBlock = LATEST_BLOCK - 2_500;
    const { fetchImpl, ranges } = createRangeLimitedBaseRpc({
      logs: [
        transferLog({
          token: USDC_BASE_TOKEN_ADDRESS,
          to: usdcDepositAddress,
          amount: 50_000_000,
          blockNumber: paidBlock,
          transactionHash: "0xpaid",
        }),
      ],
      failGetLogsOnce: { request: 2, status: 429 },
    });
    const sleepImpl = jest.fn(async () => undefined);

    const scan = await scanErc20TransfersInWindow({
      chain: chainFor(fetchImpl, sleepImpl),
      tokenAddress: USDC_BASE_TOKEN_ADDRESS,
      toAddress: usdcDepositAddress,
      fromMs: windowStartMs,
      toMs: windowEndMs,
      minConfirmations: 3,
    });

    expect(scan.transfers.map((transfer) => transfer.transactionHash)).toEqual(["0xpaid"]);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    // The rate-limited chunk is re-requested, so its range appears twice.
    expect(ranges[2]).toEqual(ranges[1]);
    expectContiguousWithinLimit([ranges[0], ...ranges.slice(2)], ranges[0].fromBlock, ranges[ranges.length - 1].toBlock);
  });
});

describe("managed Venice token reconciliation within Base's 2,000-block eth_getLogs limit", () => {
  it("finds a transfer in the first block of the quote's window + grace scan", async () => {
    const { fetchImpl, ranges } = createRangeLimitedBaseRpc({
      logs: [
        transferLog({
          token: HERMESOS_TOKEN_ADDRESS,
          to: veniceDepositAddress,
          amount: BigInt(veniceQuoteRow.token_amount_raw as string),
          blockNumber: veniceQuotedAtBlock,
          transactionHash: "0xhermes",
        }),
      ],
    });
    const settleQuote = jest.fn(async () => ({ status: "settled" as const, quoteId: "quote_1" }));

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: "quote_1",
      userId: "user_1",
      db: createManagedVeniceMemoryDb({ managed_venice_token_quotes: [veniceQuoteRow] }).db,
      rpcUrl: "https://base.test",
      fetchImpl,
      settleQuote,
      now,
    });

    expect(result.status).toBe("settled");
    expect(settleQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_1", transactionHash: "0xhermes" }),
      expect.anything()
    );
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    expectContiguousWithinLimit(ranges, ranges[0].fromBlock, ranges[ranges.length - 1].toBlock);
    expect(ranges[0].fromBlock).toBeLessThanOrEqual(veniceQuotedAtBlock);
    expect(ranges[ranges.length - 1].toBlock).toBeGreaterThanOrEqual(veniceGraceEndBlock);
  });
});

describe("eth_getLogs call sites", () => {
  // Every Base log scan must go through getLogsInBlockChunks. A second call
  // site is how the USDC reconciler kept a 5,000-block request after the
  // managed-Venice reconciler was fixed.
  it("are confined to the shared chunked helper", () => {
    const srcRoot = path.resolve(__dirname, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // test-utils holds fake RPC servers that answer eth_getLogs.
          if (!["__tests__", "test-utils", "node_modules"].includes(entry.name)) walk(full);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
          if (/["'`]eth_getLogs["'`]/.test(fs.readFileSync(full, "utf8"))) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([path.join("lib", "billing", "base-rpc-logs.ts")]);
  });
});
