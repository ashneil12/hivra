import { keccak256 } from "viem";
import {
  ERC20_TRANSFER_TOPIC,
  type JsonRpcFetch,
  type ScannedTransfer,
} from "@/lib/billing/base-transfer-scan";
import { sleep } from "@/lib/billing/base-rpc-retry";

const PUBLIC_BASE_RPC = "https://mainnet.base.org";
const MAX_SCAN_BLOCKS = 500;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 2_000;
const BLOCK_METHOD = "eth_getBlockByNumber";
const RECEIPT_METHOD = "eth_getBlockReceipts";
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/i;
const BLOOM = /^0x[0-9a-f]{512}$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;

export class YearlyScanDeferredError extends Error {
  constructor(
    reason: "rate limit" | "request quota" | "deadline",
    readonly rpcMethod: string,
    readonly rpcHttpStatus?: number,
  ) {
    super(`Finalized Base scan deferred: ${reason} (${rpcMethod}${rpcHttpStatus == null ? "" : `, HTTP ${rpcHttpStatus}`})`);
    this.name = "YearlyScanDeferredError";
  }
}

export class YearlyScanRpcError extends Error {
  constructor(
    kind: "request failed" | "method unavailable" | "network failure" | "invalid response",
    readonly rpcMethod: string,
    readonly rpcHttpStatus?: number,
    readonly canFailOver = false,
  ) {
    super(`Finalized Base RPC ${rpcMethod}: ${kind}${rpcHttpStatus == null ? "" : ` (HTTP ${rpcHttpStatus})`}`);
    this.name = "YearlyScanRpcError";
  }
}

interface FinalizedBlock {
  number: number;
  timestampMs: number;
  hash: string;
}

interface Block extends FinalizedBlock {
  parentHash: string;
}

interface ScanInput {
  fromBlock: number;
  toBlock: number;
  recipient: string;
  tokenAddresses: string[];
  priorHash: string;
}

type Transfer = ScannedTransfer & { tokenAddress: string };

export interface YearlyFinalizedTransferReader {
  finalized(): Promise<FinalizedBlock>;
  block(number: number): Promise<Block>;
  scan(input: ScanInput): Promise<{ transfers: Transfer[]; lastHash: string }>;
}

type Hex = `0x${string}`;
type RpcObject = Record<string, unknown>;
type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

const quantity = (n: number) => `0x${n.toString(16)}`;

function invalid(method: string, detail: string, status?: number): never {
  const error = new YearlyScanRpcError("invalid response", method, status);
  error.message += ` (${detail})`;
  throw error;
}

function object(value: unknown, method: string, status?: number): RpcObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(method, "expected an object", status);
  return value as RpcObject;
}

function array(value: unknown, method: string): unknown[] {
  if (!Array.isArray(value)) invalid(method, "expected an array");
  return value;
}

function hex(value: unknown, pattern: RegExp, method: string): Hex {
  if (typeof value !== "string" || !pattern.test(value)) invalid(method, "invalid hexadecimal field");
  return value.toLowerCase() as Hex;
}

function number(value: unknown, method: string) {
  const result = Number(hex(value, /^0x(?:0|[1-9a-f][0-9a-f]*)$/i, method));
  if (!Number.isSafeInteger(result)) invalid(method, "invalid numeric field");
  return result;
}

function getBaseRpcUrls(env: Record<string, string | undefined> = process.env) {
  return [env.HERMES_BASE_RPC_URL, env.BASE_RPC_URL, PUBLIC_BASE_RPC];
}

function isPublicBase(url: string) {
  try {
    return new URL(url).hostname === "mainnet.base.org";
  } catch {
    return false;
  }
}

function retryAfterMs(response: Awaited<ReturnType<JsonRpcFetch>>) {
  const header = (response as { headers?: { get(name: string): string | null } }).headers?.get("retry-after");
  if (!header) return 1_000;
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isNaN(ms) ? 1_000 : Math.max(1_000, ms);
}

async function readBlock(call: RpcCall, tag: number | "finalized") {
  const method = BLOCK_METHOD;
  const raw = object(await call(method, [typeof tag === "number" ? quantity(tag) : tag, false]), method);
  const height = number(raw.number, method);
  const timestampMs = number(raw.timestamp, method) * 1000;
  if ((typeof tag === "number" && height !== tag) || timestampMs > 8.64e15) invalid(method, "wrong height or timestamp");
  const block: Block = {
    number: height,
    timestampMs,
    hash: hex(raw.hash, HASH, method),
    parentHash: hex(raw.parentHash, HASH, method),
  };
  return { block, raw };
}

function bloomMask(value: Hex) {
  const hash = keccak256(value);
  let mask = 0n;
  for (let i = 2; i < 14; i += 4) mask |= 1n << BigInt(Number.parseInt(hash.slice(i, i + 4), 16) & 2047);
  return mask;
}

function parseLog(raw: unknown, method: string) {
  const log = object(raw, method);
  const topics = array(log.topics, method).map((topic) => hex(topic, HASH, method));
  if (topics.length > 4 || (log.removed !== undefined && log.removed !== false)) invalid(method, "invalid log");
  return {
    address: hex(log.address, ADDRESS, method),
    topics,
    data: hex(log.data, DATA, method),
    transactionHash: hex(log.transactionHash, HASH, method),
    transactionIndex: number(log.transactionIndex, method),
    logIndex: number(log.logIndex, method),
    blockNumber: number(log.blockNumber, method),
    blockHash: hex(log.blockHash, HASH, method),
  };
}

type Log = ReturnType<typeof parseLog>;

function logMatches(log: Log, tokens: Set<string>, recipient: Hex) {
  return tokens.has(log.address) && log.topics[0] === ERC20_TRANSFER_TOPIC && log.topics[2] === recipient;
}

function toTransfer(log: Log, block: Block, pin: FinalizedBlock): Transfer | null {
  if (log.topics.length !== 3) invalid(RECEIPT_METHOD, "invalid ERC-20 topic count");
  const sender = hex(log.topics[1], ADDRESS_TOPIC, RECEIPT_METHOD);
  const amount = BigInt(hex(log.data, HASH, RECEIPT_METHOD));
  if (amount === 0n || sender === log.topics[2]) return null;
  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: block.number,
    blockHash: block.hash,
    amount,
    confirmations: pin.number - block.number + 1,
    timestampMs: block.timestampMs,
    observedAt: new Date(block.timestampMs).toISOString(),
    tokenAddress: log.address,
  };
}

async function readReceiptLogs(call: RpcCall, header: Awaited<ReturnType<typeof readBlock>>) {
  const method = RECEIPT_METHOD;
  const { block, raw } = header;
  const canonicalBloom = BigInt(hex(raw.logsBloom, BLOOM, BLOCK_METHOD));
  const txHashes = array(raw.transactions, BLOCK_METHOD).map((tx) => hex(tx, HASH, BLOCK_METHOD));
  if (new Set(txHashes).size !== txHashes.length) invalid(BLOCK_METHOD, "duplicate transactions");
  const receipts = array(await call(method, [quantity(block.number)]), method);
  if (receipts.length !== txHashes.length) invalid(method, "incomplete receipts");
  const indexedReceipts = new Map<number, RpcObject>();
  for (const entry of receipts) {
    const receipt = object(entry, method);
    const i = number(receipt.transactionIndex, method);
    if (indexedReceipts.has(i) || number(receipt.blockNumber, method) !== block.number ||
        hex(receipt.blockHash, HASH, method) !== block.hash || hex(receipt.transactionHash, HASH, method) !== txHashes[i]) {
      invalid(method, "receipt does not match canonical transaction");
    }
    indexedReceipts.set(i, receipt);
  }

  const masks = new Map<Hex, bigint>();
  const maskFor = (value: Hex) => {
    const cached = masks.get(value);
    if (cached !== undefined) return cached;
    const mask = bloomMask(value);
    masks.set(value, mask);
    return mask;
  };
  const logs: Log[] = [];
  let blockBloom = 0n;
  for (let i = 0; i < txHashes.length; i += 1) {
    const receipt = indexedReceipts.get(i)!;
    let receiptBloom = 0n;
    for (const entry of array(receipt.logs, method)) {
      const log = parseLog(entry, method);
      if (log.blockNumber !== block.number || log.blockHash !== block.hash ||
          log.transactionHash !== txHashes[i] || log.transactionIndex !== i || log.logIndex !== logs.length) {
        invalid(method, "log does not match canonical transaction or log order");
      }
      receiptBloom |= maskFor(log.address);
      for (const topic of log.topics) receiptBloom |= maskFor(topic);
      logs.push(log);
    }
    if (receiptBloom !== BigInt(hex(receipt.logsBloom, BLOOM, method))) invalid(method, "receipt bloom mismatch");
    blockBloom |= receiptBloom;
  }
  if (blockBloom !== canonicalBloom) invalid(method, "header bloom mismatch");
  return logs;
}

export function createYearlyFinalizedTransferReader(options: {
  urls?: string[];
  fetchImpl?: JsonRpcFetch;
  maxRequests?: number;
  paceMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  deadlineMs?: number;
} = {}): YearlyFinalizedTransferReader {
  const urls = [...new Set((options.urls ?? getBaseRpcUrls())
    .map((value) => value?.trim().replace(/\/$/, ""))
    .filter((value): value is string => Boolean(value)))];
  const endpoints = urls.map((url) => ({ url, public: isPublicBase(url), lastRequestAt: -Infinity, verified: false }));
  if (!endpoints.length) throw new Error("No Base RPC endpoints configured");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const deadline = options.deadlineMs ?? Date.now() + 45_000;
  const maxRequests = options.maxRequests ?? 100;
  let requests = 0;
  let active = 0;
  let pin: FinalizedBlock | undefined;
  let lastPublicRequestAt = -Infinity;

  function checkDeadline(method: string) {
    if (Date.now() >= deadline) throw new YearlyScanDeferredError("deadline", method);
  }

  function checkBudget(method: string) {
    checkDeadline(method);
    if (requests >= maxRequests) throw new YearlyScanDeferredError("request quota", method);
  }

  function caller(endpoint: typeof endpoints[number]): RpcCall {
    return async (method, params) => {
      let delay = 0;
      for (let attempt = 0; ; attempt += 1) {
        checkBudget(method);
        const pace = Math.max(endpoint.public ? 1_000 : 0, options.paceMs ?? 0);
        const lastRequestAt = endpoint.public ? lastPublicRequestAt : endpoint.lastRequestAt;
        const wait = Math.max(delay, lastRequestAt + pace - Date.now());
        if (wait >= deadline - Date.now()) throw new YearlyScanDeferredError("deadline", method);
        if (wait > 0) await sleepImpl(wait);
        checkBudget(method);
        endpoint.lastRequestAt = Date.now();
        if (endpoint.public) lastPublicRequestAt = endpoint.lastRequestAt;
        const id = ++requests;
        const remaining = deadline - Date.now();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(remaining <= REQUEST_TIMEOUT_MS
                ? new YearlyScanDeferredError("deadline", method)
                : new YearlyScanRpcError("network failure", method, undefined, true));
              controller.abort();
            }, Math.min(remaining, REQUEST_TIMEOUT_MS));
          });
          const response = await Promise.race([Promise.resolve().then(() => fetchImpl(endpoint.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: controller.signal,
          })).catch(() => {
            throw new YearlyScanRpcError("network failure", method, undefined, true);
          }), timeout]);
          const rateLimit = (allowRetry: boolean) => {
            delay = retryAfterMs(response);
            if (endpoint.public && allowRetry && attempt === 0 &&
                delay <= MAX_RATE_LIMIT_WAIT_MS && delay < deadline - Date.now() && requests < maxRequests) return;
            throw new YearlyScanDeferredError("rate limit", method, response.status);
          };
          if (!response.ok) {
            if (response.status === 429 || response.status === 402) {
              rateLimit(response.status === 429);
              continue;
            }
            const unavailable = response.status === 501;
            throw new YearlyScanRpcError(unavailable ? "method unavailable" : "request failed", method, response.status,
              unavailable || (response.status >= 500 && response.status <= 599));
          }
          const payload = object(await Promise.race([Promise.resolve().then(() => response.json()).catch((error: unknown) => {
            if (error instanceof TypeError) throw new YearlyScanRpcError("network failure", method, response.status, true);
            invalid(method, "invalid JSON", response.status);
          }), timeout]), method, response.status);
          const hasResult = Object.hasOwn(payload, "result");
          const hasError = Object.hasOwn(payload, "error");
          if (payload.jsonrpc !== "2.0" || payload.id !== id || hasResult === hasError) {
            invalid(method, "invalid JSON-RPC envelope", response.status);
          }
          if (hasError) {
            const error = object(payload.error, method, response.status);
            if (typeof error.code !== "number" || typeof error.message !== "string") {
              invalid(method, "invalid JSON-RPC error", response.status);
            }
            if (error.code === 429 || error.code === -32005 ||
                /\b(rate.limit|too many requests|quota exceeded|capacity exceeded)\b/i.test(error.message)) {
              rateLimit(true);
              continue;
            }
            const unavailable = error.code === -32601 || error.code === -32004 ||
              /\bmethod (?:is )?(?:not supported|not available|disabled)\b/i.test(error.message);
            throw new YearlyScanRpcError(unavailable ? "method unavailable" : "request failed", method, response.status, unavailable);
          }
          return payload.result;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    };
  }

  async function assertPin(call: RpcCall, anchor: FinalizedBlock, block?: Block) {
    const actual = block ?? (await readBlock(call, anchor.number)).block;
    if (actual.hash !== anchor.hash || actual.timestampMs !== anchor.timestampMs) {
      invalid(BLOCK_METHOD, "pinned finalized block changed");
    }
  }

  async function onEndpoint<T>(work: (call: RpcCall, anchor: FinalizedBlock) => Promise<T>) {
    let failure: Error | undefined;
    let rateLimit: YearlyScanDeferredError | undefined;
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      const i = (active + offset) % endpoints.length;
      const endpoint = endpoints[i];
      const call = caller(endpoint);
      try {
        if (!endpoint.verified || i !== active) {
          const method = "eth_chainId";
          if (number(await call(method, []), method) !== 8453) invalid(method, "wrong chain");
          const { block } = await readBlock(call, "finalized");
          if (pin) {
            if (block.number < pin.number) invalid(BLOCK_METHOD, "endpoint behind pinned finality");
            await assertPin(call, pin, block.number === pin.number ? block : undefined);
          } else {
            const { number, timestampMs, hash } = block;
            pin = { number, timestampMs, hash };
          }
          endpoint.verified = true;
        }
        const result = await work(call, pin!);
        active = i;
        return result;
      } catch (error) {
        if (error instanceof YearlyScanDeferredError && error.rpcHttpStatus !== undefined) {
          rateLimit = error;
        } else if (!(error instanceof YearlyScanRpcError && error.canFailOver)) {
          throw error;
        }
        failure = error;
      }
    }
    throw rateLimit ?? failure;
  }

  let pending: Promise<unknown> = Promise.resolve();
  function sequential<T>(work: () => Promise<T>) {
    const result = pending.then(work);
    pending = result.catch(() => undefined);
    return result;
  }

  return {
    finalized: () => sequential(() => onEndpoint(async (_call, anchor) => ({ ...anchor }))),
    block: (height) => sequential(() => onEndpoint(async (call, anchor) => {
      if (!Number.isSafeInteger(height) || height < 0 || height > anchor.number) {
        throw new Error("Requested block is outside pinned Base finality");
      }
      const { block } = await readBlock(call, height);
      if (height === anchor.number) await assertPin(call, anchor, block);
      return block;
    })),
    scan: (input) => sequential(() => onEndpoint(async (call, anchor) => {
      const { fromBlock, toBlock } = input;
      if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) ||
          fromBlock < 0 || toBlock < fromBlock || toBlock > anchor.number ||
          toBlock - fromBlock >= MAX_SCAN_BLOCKS) {
        throw new Error("Invalid finalized Base scan range");
      }
      const priorHash = hex(input.priorHash, HASH, BLOCK_METHOD);
      const recipient = `0x${hex(input.recipient, ADDRESS, RECEIPT_METHOD).slice(2).padStart(64, "0")}` as Hex;
      const tokens = new Set(input.tokenAddresses.map((address) => hex(address, ADDRESS, RECEIPT_METHOD)));
      if (tokens.size === 0) throw new Error("Finalized Base scan requires token addresses");
      const first = await readBlock(call, fromBlock);
      if (first.block.parentHash !== priorHash) invalid(BLOCK_METHOD, "checkpoint parent changed");
      const transfers: Transfer[] = [];
      let last = first;
      const filter = bloomMask(ERC20_TRANSFER_TOPIC) | bloomMask(recipient);
      for (let height = fromBlock; height <= toBlock; height += 1) {
        const header = height === fromBlock ? first : await readBlock(call, height);
        if (height !== fromBlock && (header.block.parentHash !== last.block.hash ||
            header.block.timestampMs <= last.block.timestampMs)) {
          invalid(BLOCK_METHOD, "scan parent continuity broken");
        }
        last = header;
        const bloom = BigInt(hex(header.raw.logsBloom, BLOOM, BLOCK_METHOD));
        if ((bloom & filter) !== filter) continue;
        for (const log of await readReceiptLogs(call, header)) {
          if (!logMatches(log, tokens, recipient)) continue;
          const transfer = toTransfer(log, header.block, anchor);
          if (transfer) transfers.push(transfer);
        }
      }

      const rechecked = (await readBlock(call, toBlock)).block;
      if (rechecked.hash !== last.block.hash || rechecked.timestampMs !== last.block.timestampMs ||
          rechecked.parentHash !== last.block.parentHash) invalid(BLOCK_METHOD, "scan end block changed");
      await assertPin(call, anchor, toBlock === anchor.number ? rechecked : undefined);
      checkDeadline(BLOCK_METHOD);
      return { transfers, lastHash: last.block.hash };
    })),
  };
}
