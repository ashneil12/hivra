// Fixture tests for prepare-hivra-activation.mjs. No network: every source is
// a fake fetch that serves recorded-shape payloads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeFunctionResult, erc20Abi } from "viem";

import {
  BASE_WETH_ADDRESS,
  DEFAULT_ENDPOINTS,
  LAUNCH_FILE,
  MIN_LEAD_MS,
  REGISTRY_FILE,
  choosePool,
  collectObservations,
  evaluateActivation,
  formatReport,
  main,
  medianCloseNative,
  parseArgs,
  readLaunchBlock,
  readMinPriceLiquidityUsd,
  renderLaunchSource,
} from "./prepare-hivra-activation.mjs";

// A made-up address with a valid EIP-55 checksum (nothing is deployed at it in these tests).
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const POOL = `0x${"ab".repeat(32)}`;
const OTHER_POOL = `0x${"cd".repeat(32)}`;
const NOW_MS = Date.parse("2026-10-01T10:00:00Z");
const ACTIVATES_AT = "2026-10-01T16:00:00Z";
const SUPPLY = 100_000_000_000n * 10n ** 18n;

function chainFixture(overrides = {}) {
  const values = { name: "Hivra", symbol: "HIVRA", decimals: 18, totalSupply: SUPPLY, code: "0x6080", ...overrides };
  return {
    handle(body) {
      if (body.method === "eth_getCode") return values.code;
      const selector = body.params[0].data;
      const fn = { "0x06fdde03": "name", "0x95d89b41": "symbol", "0x313ce567": "decimals", "0x18160ddd": "totalSupply" }[selector];
      assert.ok(fn, `unexpected eth_call ${selector}`);
      return encodeFunctionResult({ abi: erc20Abi, functionName: fn, result: values[fn] });
    },
  };
}

function pair(poolId, liquidityUsd, { quote = BASE_WETH_ADDRESS, priceNative = "0.0000000004", chainId = "base", base = ADDRESS } = {}) {
  return {
    chainId,
    dexId: "uniswap",
    labels: ["v4"],
    pairAddress: poolId,
    baseToken: { address: base, symbol: "HIVRA" },
    quoteToken: { address: quote, symbol: quote === BASE_WETH_ADDRESS ? "WETH" : "USDC" },
    priceNative,
    liquidity: { usd: liquidityUsd },
  };
}

function candlesFixture(closesByAgeMinutes, base = ADDRESS.toLowerCase()) {
  const nowSec = Math.floor(NOW_MS / 1000);
  return {
    data: { attributes: { ohlcv_list: closesByAgeMinutes.map(([age, close]) => [nowSec - age * 60, close, close, close, close, 1]) } },
    meta: { base: { address: base } },
  };
}

/** A fake fetch over the three sources; records every request. */
function fakeFetch({ chain = chainFixture(), pairs = [pair(POOL, 40_000)], candles = candlesFixture([[10, 0.0000000004], [300, 0.0000000004]]), fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", rpcMethod: body?.method ?? null });
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (url === DEFAULT_ENDPOINTS.rpcUrl) {
      if (fail.rpc) return reply(503, {});
      return reply(200, { jsonrpc: "2.0", id: 1, result: chain.handle(body) });
    }
    if (url.startsWith(DEFAULT_ENDPOINTS.dexscreenerUrl)) return fail.dex ? reply(500, {}) : reply(200, { pairs });
    if (url.startsWith(DEFAULT_ENDPOINTS.geckoterminalUrl)) return fail.gecko ? reply(429, {}) : reply(200, candles);
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

async function evaluate(fixture = {}, inputs = {}) {
  const { fetchImpl, calls } = fakeFetch(fixture);
  const address = inputs.address ?? ADDRESS;
  const observations = await collectObservations({ address, poolId: inputs.poolId ?? null, fetchImpl });
  const result = evaluateActivation({
    address,
    activatesAt: inputs.activatesAt ?? ACTIVATES_AT,
    poolId: inputs.poolId ?? null,
    nowMs: inputs.nowMs ?? NOW_MS,
    minLiquidityUsd: inputs.minLiquidityUsd ?? 25_000,
    observations,
  });
  return { result, calls, failed: result.checks.filter((c) => !c.ok && c.level === "error").map((c) => c.id), warned: result.checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.id) };
}

test("a launch that matches everything is READY, with the block to write", async () => {
  const { result, calls, failed, warned } = await evaluate();
  assert.deepEqual(failed, []);
  assert.deepEqual(warned, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { contractAddress: ADDRESS, decimals: 18, poolId: POOL, activatesAt: ACTIVATES_AT });
  // Read-only: only eth_getCode / eth_call on the RPC, and GETs elsewhere.
  for (const call of calls) {
    if (call.url === DEFAULT_ENDPOINTS.rpcUrl) assert.match(call.rpcMethod, /^eth_(getCode|call)$/);
    else assert.equal(call.method, "GET");
  }
  assert.match(formatReport(result, { address: ADDRESS, activatesAt: ACTIVATES_AT }), /READY \(0 warning/);
});

test("writes the EIP-55 form of a lowercase address", async () => {
  const { result } = await evaluate({}, { address: ADDRESS.toLowerCase() });
  assert.equal(result.ok, true);
  assert.equal(result.config.contractAddress, ADDRESS);
});

test("refuses a checksum typo, the zero address and the $HermesOS contract", async () => {
  const typo = ADDRESS.replace("886E0F", "886e0F"); // one letter's case flipped
  assert.notEqual(typo, ADDRESS);
  assert.ok((await evaluate({}, { address: typo })).failed.includes("address.checksum"));
  const zero = await evaluate({}, { address: `0x${"0".repeat(40)}` });
  assert.ok(zero.failed.includes("address.format"));
  const hermesos = await evaluate({}, { address: "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3" });
  assert.ok(hermesos.failed.includes("address.not_hermesos"));
  assert.equal(hermesos.result.config, null);
});

test("checks name, symbol, decimals and a 100 billion supply on Base", async () => {
  assert.deepEqual((await evaluate({ chain: chainFixture({ name: "HIVRA" }) })).failed, ["chain.name"]);
  assert.deepEqual((await evaluate({ chain: chainFixture({ symbol: "HIVRA2" }) })).failed, ["chain.symbol"]);
  const decimals = await evaluate({ chain: chainFixture({ decimals: 9, totalSupply: 100_000_000_000n * 10n ** 9n }) });
  assert.deepEqual(decimals.failed, ["chain.decimals"]);
  assert.deepEqual((await evaluate({ chain: chainFixture({ totalSupply: SUPPLY + 1n }) })).failed, ["chain.total_supply"]);
  assert.deepEqual((await evaluate({ chain: chainFixture({ code: "0x" }) })).failed, ["chain.code"]);
  assert.deepEqual((await evaluate({ fail: { rpc: true } })).failed, ["chain.read"]);
});

test("needs activatesAt to be a real UTC instant in the future, and flags a short lead", async () => {
  assert.ok((await evaluate({}, { activatesAt: "2026-10-01 16:00" })).failed.includes("activatesAt.format"));
  assert.ok((await evaluate({}, { activatesAt: "2026-02-30T16:00:00Z" })).failed.includes("activatesAt.format"));
  assert.ok((await evaluate({}, { activatesAt: "2026-10-01T09:59:59Z" })).failed.includes("activatesAt.future"));
  const soon = await evaluate({}, { activatesAt: new Date(NOW_MS + MIN_LEAD_MS - 60_000).toISOString().replace(".000", "") });
  assert.deepEqual(soon.failed, []);
  assert.deepEqual(soon.warned, ["activatesAt.lead"]);
  assert.equal(soon.result.ok, true);
});

test("picks the deepest HIVRA/WETH pool on Base, and warns when there is more than one", async () => {
  const pairs = [
    pair(OTHER_POOL, 30_000),
    pair(POOL, 90_000),
    pair(`0x${"ef".repeat(32)}`, 500_000, { quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }), // USDC pair: never the pricing pool
    pair(`0x${"12".repeat(32)}`, 900_000, { chainId: "ethereum" }),
  ];
  const { result, warned } = await evaluate({ pairs });
  assert.equal(result.config.poolId, POOL);
  assert.deepEqual(warned, ["pool.single"]);
  // --pool-id pins another listed pool, and refuses one that is not listed.
  const pinned = await evaluate({ pairs }, { poolId: OTHER_POOL.toUpperCase().replace("0X", "0x") });
  assert.equal(pinned.result.config.poolId, OTHER_POOL);
  assert.ok((await evaluate({ pairs }, { poolId: `0x${"99".repeat(32)}` })).failed.includes("pool.found"));
  assert.equal(choosePool([]), null);
});

test("refuses a pool below the registry's liquidity floor, or with an id the registry rejects", async () => {
  const thin = await evaluate({ pairs: [pair(POOL, 24_999)] });
  assert.deepEqual(thin.failed, ["pool.liquidity"]);
  assert.equal(thin.result.config, null);
  const badId = await evaluate({ pairs: [pair("0xabc", 90_000)] });
  assert.ok(badId.failed.includes("pool.id_format"));
  assert.deepEqual((await evaluate({ pairs: [] })).failed, ["pool.found"]);
  assert.deepEqual((await evaluate({ fail: { dex: true } })).failed, ["pool.read"]);
});

test("needs a GeckoTerminal candle for the pool, priced for this token", async () => {
  assert.deepEqual((await evaluate({ candles: candlesFixture([]) })).failed, ["candles.present"]);
  assert.deepEqual((await evaluate({ fail: { gecko: true } })).failed, ["candles.present"]);
  const wrongToken = await evaluate({ candles: candlesFixture([[10, 0.0000000004]], BASE_WETH_ADDRESS) });
  assert.ok(wrongToken.failed.includes("candles.pool_token"));
});

test("warns when the spot sits more than 10% above the median the price feed checks against", async () => {
  const pumped = await evaluate({
    pairs: [pair(POOL, 90_000, { priceNative: "0.0000000005" })],
    candles: candlesFixture([[5, 0.0000000004], [300, 0.0000000004]]),
  });
  assert.deepEqual(pumped.failed, []);
  assert.deepEqual(pumped.warned, ["candles.deviation"]);
  // A quiet pool carries its last close forward, as price-feed.ts does.
  assert.equal(medianCloseNative([{ at: Math.floor(NOW_MS / 1000) - 30 * 3600, close: 2 }], NOW_MS), 2);
  assert.equal(medianCloseNative([], NOW_MS), null);
});

test("warns when the pool has less candle history than the median window", async () => {
  const young = await evaluate({ candles: candlesFixture([[5, 0.0000000004], [60, 0.0000000004]]) });
  assert.deepEqual(young.failed, []);
  assert.deepEqual(young.warned, ["candles.history"]);
  assert.match(young.result.checks.find((c) => c.id === "candles.history").detail, /only 60 minutes of candle history/);
});

test("reads the liquidity floor from token-registry.ts", () => {
  assert.equal(readMinPriceLiquidityUsd("export const HIVRA_MIN_PRICE_LIQUIDITY_USD = 40_000;"), 40_000);
  assert.throws(() => readMinPriceLiquidityUsd("nothing here"), /not found/);
  assert.equal(typeof readMinPriceLiquidityUsd(readFileSync(REGISTRY_FILE, "utf8")), "number");
});

test("rewrites only the four launch fields and keeps the rest of the file", () => {
  const source = readFileSync(LAUNCH_FILE, "utf8");
  const config = { contractAddress: ADDRESS, decimals: 18, poolId: POOL, activatesAt: ACTIVATES_AT };
  const rendered = renderLaunchSource(source, config);
  assert.deepEqual(readLaunchBlock(rendered), config);
  assert.equal(renderLaunchSource(rendered, readLaunchBlock(source)), source);
  assert.throws(() => renderLaunchSource("export const OTHER = 1;", config), /expected HIVRA_TOKEN_LAUNCH block/);
});

test("parses arguments and rejects incomplete ones", () => {
  assert.deepEqual(parseArgs(["--address", ADDRESS, "--activates-at", ACTIVATES_AT, "--write"]), {
    address: ADDRESS,
    activatesAt: ACTIVATES_AT,
    poolId: null,
    write: true,
    json: false,
    help: false,
  });
  assert.throws(() => parseArgs(["--address", ADDRESS]), /required/);
  assert.throws(() => parseArgs(["--address", "--write"]), /needs a value/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("the CLI without --write prints the report and writes nothing", async () => {
  const before = readFileSync(LAUNCH_FILE, "utf8");
  const out = [];
  const { fetchImpl } = fakeFetch();
  const code = await main(["--address", ADDRESS, "--activates-at", ACTIVATES_AT, "--json"], {
    fetchImpl,
    nowMs: NOW_MS,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  });
  assert.equal(code, 0);
  const report = JSON.parse(out[0]);
  assert.equal(report.ok, true);
  assert.equal(typeof report.minLiquidityUsd, "number");
  assert.equal(readFileSync(LAUNCH_FILE, "utf8"), before);
});

test("the CLI refuses --write when a check fails, and exits 2 on bad usage", async () => {
  const before = readFileSync(LAUNCH_FILE, "utf8");
  const out = [];
  const { fetchImpl } = fakeFetch({ pairs: [pair(POOL, 1_000)] });
  const io = { fetchImpl, nowMs: NOW_MS, stdout: (line) => out.push(line), stderr: (line) => out.push(line) };
  assert.equal(await main(["--address", ADDRESS, "--activates-at", ACTIVATES_AT, "--write"], io), 1);
  assert.match(out.join("\n"), /Not written/);
  assert.equal(readFileSync(LAUNCH_FILE, "utf8"), before);
  assert.equal(await main(["--write"], io), 2);
});
