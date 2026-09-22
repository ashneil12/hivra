/**
 * Base JSON-RPC fake for $HermesOS payment tests.
 *
 * Models the parts of Base the billing code reads: per-block timestamps
 * (2 s blocks by default), eth_getLogs honouring fromBlock/toBlock/address/
 * topics and the public endpoint's 2,000-block range limit (HTTP 413 +
 * JSON-RPC error body), and ERC-20 balanceOf via eth_call, derived from the
 * same transfer list so balances and logs never disagree.
 */

import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";

export const FAKE_ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF_SELECTOR = "0x70a08231";

export function addressTopic(address: string) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

export interface FakeTransfer {
  txHash: string;
  amountRaw: bigint | string;
  block: number;
  logIndex?: number;
  to: string;
  from?: string;
  tokenAddress?: string;
}

interface JsonRpcRequestBody {
  method: string;
  params: unknown[];
}

export interface FakeRpcFailure {
  method: string;
  status?: number;
  body?: unknown;
  times?: number;
}

export const FAKE_SENDER = "0x1111111111111111111111111111111111111111";

export function createBaseRpcFake(options: {
  latestBlock: number;
  /** Timestamp of `latestBlock`; other blocks are spaced `blockTimeSec` apart. */
  latestTimestamp: string;
  blockTimeSec?: number;
  transfers?: FakeTransfer[];
  maxLogRangeBlocks?: number;
}) {
  const blockTimeSec = options.blockTimeSec ?? 2;
  const anchorBlock = options.latestBlock;
  const anchorSec = Math.floor(Date.parse(options.latestTimestamp) / 1000);
  const maxLogRange = options.maxLogRangeBlocks ?? 2_000;
  let latestBlock = options.latestBlock;
  const transfers: FakeTransfer[] = [...(options.transfers ?? [])];
  const failures: Array<FakeRpcFailure & { remaining: number }> = [];
  const requests: JsonRpcRequestBody[] = [];

  function blockTimestampSec(block: number) {
    return anchorSec + (block - anchorBlock) * blockTimeSec;
  }

  function tokenOf(transfer: FakeTransfer) {
    return (transfer.tokenAddress ?? HERMESOS_TOKEN_ADDRESS).toLowerCase();
  }

  function toLog(transfer: FakeTransfer) {
    return {
      address: tokenOf(transfer),
      topics: [
        FAKE_ERC20_TRANSFER_TOPIC,
        addressTopic(transfer.from ?? FAKE_SENDER),
        addressTopic(transfer.to),
      ],
      data: `0x${BigInt(transfer.amountRaw).toString(16)}`,
      transactionHash: transfer.txHash,
      logIndex: `0x${(transfer.logIndex ?? 0).toString(16)}`,
      blockNumber: `0x${transfer.block.toString(16)}`,
      blockHash: `0xblock${transfer.block}`,
    };
  }

  function balanceOf(token: string, owner: string) {
    const holder = owner.toLowerCase();
    let balance = 0n;
    for (const transfer of transfers) {
      if (transfer.block > latestBlock || tokenOf(transfer) !== token.toLowerCase()) continue;
      if (transfer.to.toLowerCase() === holder) balance += BigInt(transfer.amountRaw);
      if ((transfer.from ?? FAKE_SENDER).toLowerCase() === holder) balance -= BigInt(transfer.amountRaw);
    }
    return balance;
  }

  const ok = (result: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });

  const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JsonRpcRequestBody;
    requests.push(request);

    const failureIndex = failures.findIndex((failure) => failure.method === request.method);
    if (failureIndex >= 0) {
      const failure = failures[failureIndex];
      failure.remaining -= 1;
      if (failure.remaining <= 0) failures.splice(failureIndex, 1);
      return {
        ok: false,
        status: failure.status ?? 500,
        json: async () => failure.body ?? {},
        text: async () => JSON.stringify(failure.body ?? {}),
      };
    }

    if (request.method === "eth_blockNumber") return ok(`0x${latestBlock.toString(16)}`);

    if (request.method === "eth_getBlockByNumber") {
      const tag = request.params[0];
      const block = tag === "latest" ? latestBlock : Number.parseInt(String(tag), 16);
      if (!Number.isSafeInteger(block) || block < 0 || block > latestBlock) return ok(null);
      return ok({
        number: `0x${block.toString(16)}`,
        timestamp: `0x${blockTimestampSec(block).toString(16)}`,
      });
    }

    if (request.method === "eth_call") {
      const call = request.params[0] as { to: string; data: string };
      if (!call.data.startsWith(BALANCE_OF_SELECTOR)) throw new Error(`Unexpected eth_call ${call.data}`);
      const owner = `0x${call.data.slice(-40)}`;
      return ok(`0x${balanceOf(call.to, owner).toString(16).padStart(64, "0")}`);
    }

    if (request.method === "eth_getLogs") {
      const filter = request.params[0] as {
        address?: string;
        fromBlock: string;
        toBlock: string;
        topics?: Array<string | null>;
      };
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      if (toBlock - fromBlock + 1 > maxLogRange) {
        return {
          ok: false,
          status: 413,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" },
          }),
          text: async () => "eth_getLogs is limited to a 2,000 range",
        };
      }
      const logs = transfers
        .filter((transfer) => transfer.block >= fromBlock && transfer.block <= toBlock && transfer.block <= latestBlock)
        .map(toLog)
        .filter((log) => !filter.address || log.address === filter.address.toLowerCase())
        .filter((log) =>
          (filter.topics ?? []).every((topic, index) => topic == null || log.topics[index] === topic.toLowerCase())
        )
        .sort(
          (a, b) =>
            Number.parseInt(a.blockNumber, 16) - Number.parseInt(b.blockNumber, 16) ||
            Number.parseInt(a.logIndex, 16) - Number.parseInt(b.logIndex, 16)
        );
      return ok(logs);
    }

    throw new Error(`Unexpected RPC method ${request.method}`);
  });

  return {
    fetchImpl,
    requests,
    /** Advance (or rewind) the chain head; timestamps keep the same spacing. */
    setLatestBlock(block: number) {
      latestBlock = block;
    },
    latestBlock() {
      return latestBlock;
    },
    addTransfer(transfer: FakeTransfer) {
      transfers.push(transfer);
    },
    transfers,
    balanceOf(owner: string, token: string = HERMESOS_TOKEN_ADDRESS) {
      return balanceOf(token, owner);
    },
    failNext(failure: FakeRpcFailure) {
      failures.push({ ...failure, remaining: failure.times ?? 1 });
    },
    blockTimestamp(block: number) {
      return new Date(blockTimestampSec(block) * 1000).toISOString();
    },
    /** The last block whose timestamp is <= `iso`. */
    blockAt(iso: string | number) {
      const ms = typeof iso === "number" ? iso : Date.parse(iso);
      return anchorBlock + Math.floor((Math.floor(ms / 1000) - anchorSec) / blockTimeSec);
    },
    methodCount(method: string) {
      return requests.filter((request) => request.method === method).length;
    },
  };
}

export type BaseRpcFake = ReturnType<typeof createBaseRpcFake>;
