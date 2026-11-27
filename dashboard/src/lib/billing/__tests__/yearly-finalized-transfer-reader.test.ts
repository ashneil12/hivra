import { hexToBytes, keccak256, type Hex } from "viem";
import { ERC20_TRANSFER_TOPIC as TRANSFER, type JsonRpcFetch } from "@/lib/billing/base-transfer-scan";
import { createYearlyFinalizedTransferReader, YearlyScanDeferredError, YearlyScanRpcError } from "@/lib/billing/yearly-finalized-transfer-reader";

const PUBLIC = "https://mainnet.base.org";
const PRIMARY = "https://first.invalid/private";
const SECONDARY = "https://second.invalid/private";
const BLOCK = "eth_getBlockByNumber";
const LOGS = "eth_getLogs";
const RECEIPTS = "eth_getBlockReceipts";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const quantity = (n: number) => `0x${n.toString(16)}`;
const timestamp = (height: number) => 1_700_000_000 + 2 * height;
const input = { fromBlock: 10, toBlock: 12, recipient: address(19), tokenAddresses: [address(20), address(21)], priorHash: hash(9) };
const emptyBloom = `0x${"00".repeat(256)}`;

function bloom(values: Array<`0x${string}`>) {
  const bytes = Buffer.alloc(256);
  for (const value of values) {
    const digest = hexToBytes(keccak256(value));
    for (const i of [0, 2, 4]) {
      const bit = ((digest[i] << 8) | digest[i + 1]) & 2047;
      bytes[255 - Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
  }
  return `0x${bytes.toString("hex")}`;
}

const txHash = (height: number, index: number) => hash(height * 100 + index);
function log(height: number, transactionIndex: number, logIndex: number, token = 20, sender = 22, amount = 10_000) {
  return {
    address: address(token), topics: [TRANSFER, hash(sender), hash(19)] as Hex[], data: hash(amount), removed: false,
    blockNumber: quantity(height), blockHash: hash(height), transactionHash: txHash(height, transactionIndex),
    transactionIndex: quantity(transactionIndex), logIndex: quantity(logIndex),
  };
}

const transfers = [log(11, 0, 0), log(11, 1, 1, 21, 22, 12_000)];
const irrelevant = [log(11, 1, 2, 99), log(11, 1, 3, 20, 19), log(11, 1, 4, 20, 22, 0)];
const allLogs = [...transfers, ...irrelevant];
const bloomForLogs = (logs: typeof allLogs) => bloom(logs.flatMap(({ address, topics }) => [address, ...topics]));

function block(height: number) {
  return {
    number: quantity(height), timestamp: quantity(timestamp(height)), hash: hash(height), parentHash: hash(height - 1),
    logsBloom: height === 11 ? bloomForLogs(allLogs) : emptyBloom,
    transactions: height === 11 ? [txHash(height, 0), txHash(height, 1)] : [],
  };
}

function receipts() {
  return [0, 1].map((index) => {
    const logs = allLogs.filter((entry) => entry.transactionIndex === quantity(index));
    return {
      blockNumber: quantity(11), blockHash: hash(11),
      transactionHash: txHash(11, index), transactionIndex: quantity(index), logs, logsBloom: bloomForLogs(logs),
    };
  });
}

type Call = { url: string; method: string; params: unknown[] };
type Reply = { result: unknown } | { status: number; retryAfter?: string } | { error: { code: number; message: string } };

function fixture(
  urls = [PUBLIC],
  override: (call: Call) => Reply | undefined = () => undefined,
  options: Parameters<typeof createYearlyFinalizedTransferReader>[0] = {},
) {
  const calls: Call[] = [];
  const sleepImpl = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
  const fetchImpl: JsonRpcFetch = async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const call = { url, method, params };
    calls.push(call);
    const custom = override(call);
    if (custom && "status" in custom) {
      const { status, retryAfter } = custom;
      return new Response(null, { status, headers: retryAfter ? { "Retry-After": retryAfter } : undefined });
    }
    const result = method === "eth_chainId" ? "0x2105"
      : method === BLOCK ? block(params[0] === "finalized" ? 14 : Number(params[0]))
      : method === RECEIPTS ? receipts().reverse() : undefined;
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id, ...(custom ?? { result }) }),
    };
  };
  return {
    calls, sleepImpl,
    reader: createYearlyFinalizedTransferReader({ urls, fetchImpl, sleepImpl, ...options }),
  };
}

it("walks linked public headers, validates complete receipts, and returns only matching transfers", async () => {
  const { reader, calls, sleepImpl } = fixture();
  await expect(reader.finalized()).resolves.toEqual({ number: 14, timestampMs: timestamp(14) * 1000, hash: hash(14) });
  await expect(reader.block(9)).resolves.toEqual({
    number: 9, timestampMs: timestamp(9) * 1000, hash: hash(9), parentHash: hash(8),
  });
  await expect(reader.scan(input)).resolves.toEqual({
    lastHash: hash(12),
    transfers: transfers.map((entry, index) => ({
      amount: BigInt(entry.data), transactionHash: entry.transactionHash, logIndex: index,
      blockNumber: 11, blockHash: hash(11), timestampMs: timestamp(11) * 1000,
      observedAt: new Date(timestamp(11) * 1000).toISOString(), confirmations: 4, tokenAddress: entry.address,
    })),
  });
  expect(calls.filter((call) => call.method === RECEIPTS).map(({ params }) => params)).toEqual([["0xb"]]);
  expect(calls.some((call) => call.method === LOGS)).toBe(false);
  expect(sleepImpl).toHaveBeenCalledTimes(calls.length - 1);
  expect(sleepImpl.mock.calls.every(([wait]) => wait > 0 && wait <= 1_000)).toBe(true);
});

it("requires configured providers to prove coverage through each canonical header too", async () => {
  const { reader, calls } = fixture([PRIMARY]);
  await expect(reader.scan(input)).resolves.toMatchObject({ lastHash: hash(12), transfers: [{ amount: 10_000n }, { amount: 12_000n }] });
  expect(calls.filter((call) => call.method === LOGS)).toHaveLength(0);
  expect(calls.filter((call) => call.method === BLOCK).map(({ params }) => params[0]))
    .toEqual(["finalized", "0xa", "0xb", "0xc", "0xc", "0xe"]);
  expect(calls.filter((call) => call.method === RECEIPTS)).toHaveLength(1);
});

it("restarts on public after a receipt 429, validating the original pin on the new provider", async () => {
  const { reader, calls } = fixture([PRIMARY, PRIMARY + "/", PUBLIC], ({ url, method, params }) => {
    if (url === PRIMARY && method === RECEIPTS) return { status: 429, retryAfter: "600" };
    if (url === PUBLIC && method === BLOCK && params[0] === "finalized") return { result: block(15) };
  });
  await expect(reader.scan(input)).resolves.toMatchObject({ lastHash: hash(12), transfers: [{ confirmations: 4 }, { confirmations: 4 }] });
  expect(calls.filter((call) => call.method === RECEIPTS).map(({ url }) => url)).toEqual([PRIMARY, PUBLIC]);
  expect(calls.filter((call) => call.url === PUBLIC).slice(0, 4)).toEqual([
    { url: PUBLIC, method: "eth_chainId", params: [] },
    { url: PUBLIC, method: BLOCK, params: ["finalized", false] },
    { url: PUBLIC, method: BLOCK, params: ["0xe", false] },
    { url: PUBLIC, method: BLOCK, params: ["0xa", false] },
  ]);
});

it.each([
  { status: 503 },
  { error: { code: -32601, message: "Method not found" } },
])("fails over to another configured endpoint after a transient or unsupported receipt RPC: %j", async (reply) => {
  const { reader, calls } = fixture([PRIMARY, SECONDARY], ({ method, url }) =>
    method === RECEIPTS && url === PRIMARY ? reply : undefined);
  await expect(reader.scan(input)).resolves.toMatchObject({ lastHash: hash(12) });
  expect(calls.filter((call) => call.method === RECEIPTS).map(({ url }) => url)).toEqual([PRIMARY, SECONDARY]);
});

it("rotates after a sanitized network rejection", async () => {
  const { reader, calls } = fixture([PRIMARY, SECONDARY], ({ url }) => {
    if (url === PRIMARY) throw new TypeError("fetch failed, sensitive URL");
    return undefined;
  });
  await expect(reader.finalized()).resolves.toMatchObject({ hash: hash(14) });
  expect(calls.map(({ url }) => url)).toEqual([PRIMARY, SECONDARY, SECONDARY]);
});

it("uses the two configured environment endpoints before the public default", async () => {
  const oldPrimary = process.env.HERMES_BASE_RPC_URL;
  const oldSecondary = process.env.BASE_RPC_URL;
  process.env.HERMES_BASE_RPC_URL = ` ${PRIMARY}/ `;
  process.env.BASE_RPC_URL = SECONDARY;
  try {
    const { reader, calls } = fixture(undefined, ({ url }) => url === PUBLIC ? undefined : { status: 503 }, { urls: undefined });
    await expect(reader.finalized()).resolves.toMatchObject({ hash: hash(14) });
    expect(calls.map(({ url }) => url)).toEqual([PRIMARY, SECONDARY, PUBLIC, PUBLIC]);
  } finally {
    if (oldPrimary === undefined) delete process.env.HERMES_BASE_RPC_URL;
    else process.env.HERMES_BASE_RPC_URL = oldPrimary;
    if (oldSecondary === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = oldSecondary;
  }
});

it("fails honestly on a non-retryable upstream response without exposing its endpoint", async () => {
  const { reader, calls } = fixture([PRIMARY, SECONDARY], () => ({ status: 403 }));
  const error = await reader.finalized().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ rpcHttpStatus: 403, rpcMethod: "eth_chainId" });
  expect((error as Error).message).not.toContain(PRIMARY);
  expect(calls.map(({ url }) => url)).toEqual([PRIMARY]);
});

it("exposes safe status and method for malformed transport without retrying", async () => {
  const fetchImpl = jest.fn<ReturnType<JsonRpcFetch>, Parameters<JsonRpcFetch>>().mockResolvedValue({
    ok: true, status: 200, json: async () => { throw new SyntaxError("sensitive response body"); },
  });
  const reader = createYearlyFinalizedTransferReader({ urls: [PRIMARY, SECONDARY], fetchImpl });
  const error = await reader.finalized().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(YearlyScanRpcError);
  expect(error).toMatchObject({ rpcHttpStatus: 200, rpcMethod: "eth_chainId" });
  expect((error as Error).message).not.toContain("sensitive response body");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([
  ["wrong chain", "eth_chainId", [], { result: "0x1" }],
  ["endpoint behind pinned finality", BLOCK, ["finalized", false], { result: block(13) }],
  ["pinned finalized block changed", BLOCK, ["finalized", false], { result: { ...block(14), hash: hash(99) } }],
] as const)("rejects fallback providing a %s", async (error, targetMethod, targetParams, reply) => {
  const { reader, calls } = fixture([PRIMARY, PUBLIC], ({ url, method, params }) => {
    if (url === PRIMARY && method === RECEIPTS) return { status: 429 };
    if (url === PUBLIC && method === targetMethod && JSON.stringify(params) === JSON.stringify(targetParams)) return reply;
  });
  await expect(reader.scan(input)).rejects.toThrow(error);
  expect(calls.some((call) => call.url === PUBLIC && call.method === RECEIPTS)).toBe(false);
});

it.each([
  ["incomplete receipts", () => receipts().slice(1)],
  ["receipt does not match canonical transaction", () => [{ ...receipts()[0], blockHash: hash(99) }, receipts()[1]]],
  ["log does not match canonical transaction or log order", () => [
    { ...receipts()[0], logs: [{ ...transfers[0], logIndex: "0x1" }] }, receipts()[1],
  ]],
  ["receipt bloom mismatch", () => [{ ...receipts()[0], logsBloom: emptyBloom }, receipts()[1]]],
  ["invalid hexadecimal field", () => [
    { ...receipts()[0], logs: [{ ...transfers[0], data: "0x00" }] }, receipts()[1],
  ]],
] as const)("does not advance past public receipt corruption: %s", async (error, malformed) => {
  const { reader, calls } = fixture([PUBLIC, SECONDARY], ({ method }) =>
    method === RECEIPTS ? { result: malformed() } : undefined);
  await expect(reader.scan(input)).rejects.toThrow(error);
  expect(calls.some((call) => call.url === SECONDARY)).toBe(false);
});

it("rejects malformed configured blooms instead of treating the middle block as empty", async () => {
  const { reader, calls } = fixture([PRIMARY, SECONDARY], ({ method, params }) =>
    method === BLOCK && params[0] === "0xb" ? { result: { ...block(11), logsBloom: "0x0" } } : undefined);
  await expect(reader.scan(input)).rejects.toThrow("invalid hexadecimal field");
  expect(calls.every(({ url }) => url === PRIMARY)).toBe(true);
});

it("rejects a broken checkpoint parent and broken intermediate public continuity", async () => {
  const { reader } = fixture([PUBLIC], ({ method, params }) =>
    method === BLOCK && params[0] === "0xb" ? { result: { ...block(11), parentHash: hash(99) } } : undefined);
  await expect(reader.scan({ ...input, priorHash: hash(99) })).rejects.toThrow("checkpoint parent changed");
  await expect(reader.scan(input)).rejects.toThrow("scan parent continuity broken");
});

it.each([
  ["0xc", "scan end block changed"],
  ["0xe", "pinned finalized block changed"],
])("rechecks the scan end and pinned boundary before returning: %s", async (height, error) => {
  let readCount = 0;
  const { reader } = fixture([PUBLIC], ({ method, params }) => {
    if (method === BLOCK && params[0] === height && (height === "0xe" || ++readCount === 2)) {
      return { result: { ...block(Number(height)), hash: hash(99) } };
    }
  });
  await expect(reader.scan(input)).rejects.toThrow(error);
});

it("will not read outside pinned finality or over the chunk limit", async () => {
  const { reader, calls } = fixture([PRIMARY], ({ method, params }) =>
    method === BLOCK && params[0] === "finalized" ? { result: block(510) } : undefined);
  await expect(reader.block(511)).rejects.toThrow("outside pinned Base finality");
  await expect(reader.scan({ ...input, toBlock: 510 })).rejects.toThrow("Invalid finalized Base scan range");
  expect(calls).toHaveLength(2);
});

it("defers when the shared quota is exhausted partway through a chunk", async () => {
  const { reader, calls } = fixture([PUBLIC], () => undefined, { maxRequests: 5 });
  await reader.finalized();
  await expect(reader.scan(input)).rejects.toMatchObject({
    name: "YearlyScanDeferredError", rpcMethod: BLOCK, message: expect.stringContaining("request quota"),
  });
  expect(calls).toHaveLength(5);
});

it("honors a short Retry-After once, then exposes a safe 429 deferral", async () => {
  const { reader, calls, sleepImpl } = fixture([PUBLIC], () => ({ status: 429, retryAfter: "2" }));
  const error = await reader.finalized().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(YearlyScanDeferredError);
  expect(error).toMatchObject({ rpcHttpStatus: 429, rpcMethod: "eth_chainId" });
  expect(calls).toHaveLength(2);
  expect(sleepImpl).toHaveBeenCalledWith(2_000);
  expect((error as Error).message).not.toContain(PUBLIC);
});

it("does not spend the deadline waiting out a long Retry-After", async () => {
  const { reader, calls, sleepImpl } = fixture([PUBLIC], () => ({ status: 429, retryAfter: "90" }));
  await expect(reader.finalized()).rejects.toMatchObject({ rpcHttpStatus: 429 });
  expect(calls).toHaveLength(1);
  expect(sleepImpl).not.toHaveBeenCalled();
});

it("times out a stalled response body and defers without exceeding the deadline", async () => {
  const fetchImpl: JsonRpcFetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const reader = createYearlyFinalizedTransferReader({ urls: [PRIMARY], fetchImpl, deadlineMs: Date.now() + 30 });
  await expect(reader.finalized()).rejects.toMatchObject({
    name: "YearlyScanDeferredError", rpcMethod: "eth_chainId", message: expect.stringContaining("deadline"),
  });
});
