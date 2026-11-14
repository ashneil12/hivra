// Fixture tests for prepare-hivra-activation.mjs. No network: every source is
// a fake fetch that serves recorded-shape payloads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeFunctionResult, erc20Abi, toFunctionSelector } from "viem";

import {
  BASE_WETH_ADDRESS,
  DEFAULT_ENDPOINTS,
  DOPPLER_ERC20_V1_IMPLEMENTATIONS,
  DOPPLER_HOOK_INITIALIZER,
  DOPPLER_STATE_ABI,
  LAUNCH_FILE,
  MIN_LEAD_MS,
  NATIVE_ETH_ADDRESS,
  REGISTRY_FILE,
  V4_DYNAMIC_FEE_FLAG,
  choosePool,
  cloneImplementation,
  codeHasFunction,
  collectObservations,
  evaluateActivation,
  formatReport,
  main,
  medianCloseNative,
  parseArgs,
  readLaunchBlock,
  readMinPriceLiquidityUsd,
  readMinQuoteLiquidityUsd,
  renderLaunchSource,
  v4PoolId,
} from "./prepare-hivra-activation.mjs";

// A made-up address with a valid EIP-55 checksum (nothing is deployed at it in these tests).
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const TOKEN = ADDRESS.toLowerCase();
const IMPLEMENTATION = DOPPLER_ERC20_V1_IMPLEMENTATIONS[0];
const NOW_MS = Date.parse("2026-10-01T10:00:00Z");
const ACTIVATES_AT = "2026-10-01T16:00:00Z";
const SUPPLY = 100_000_000_000n * 10n ** 18n;
const ETH_USD = 2_400;

/** The pool key DopplerHookInitializer records for a native-ETH Multicurve launch (fee and tickSpacing as read live on Base). */
function dopplerKey(overrides = {}) {
  return { currency0: NATIVE_ETH_ADDRESS, currency1: TOKEN, fee: V4_DYNAMIC_FEE_FLAG, tickSpacing: 200, hooks: DOPPLER_HOOK_INITIALIZER, ...overrides };
}
const POOL = v4PoolId(dopplerKey());
const OTHER_POOL = v4PoolId(dopplerKey({ tickSpacing: 60 }));

/** Solady LibClone's PUSH0 minimal proxy, exactly as DopplerERC20V1Factory deploys it on Base. */
function cloneCode(implementation = IMPLEMENTATION) {
  return `0x3d3d3d3d363d3d37363d73${implementation.slice(2)}5af43d3d93803e602a57fd5bf3`;
}

/** Runtime code that dispatches these functions (PUSH4 selector, as solc emits). */
function codeWith(signatures) {
  return `0x6080604052${signatures.map((signature) => `63${toFunctionSelector(signature).slice(2)}14`).join("")}00`;
}
const DOPPLER_V1_CODE = codeWith(["name()", "symbol()", "decimals()", "totalSupply()", "burn(uint256)", "release(uint256)", "vestedTotalAmount()"]);

function chainFixture(overrides = {}) {
  const values = {
    name: "Hivra",
    symbol: "HIVRA",
    decimals: 18,
    totalSupply: SUPPLY,
    code: cloneCode(),
    implementationCode: DOPPLER_V1_CODE,
    yearlyMintRate: 0n,
    doppler: { numeraire: NATIVE_ETH_ADDRESS, status: 2, poolKey: dopplerKey() },
    ...overrides,
  };
  const selectors = {
    "0x06fdde03": "name",
    "0x95d89b41": "symbol",
    "0x313ce567": "decimals",
    "0x18160ddd": "totalSupply",
  };
  return {
    handle(body) {
      if (body.method === "eth_getCode") {
        const target = body.params[0].toLowerCase();
        if (target === TOKEN) return values.code;
        return values.implementationCodeAt?.[target] ?? (target === IMPLEMENTATION ? values.implementationCode : "0x");
      }
      const { to, data } = body.params[0];
      if (to.toLowerCase() === DOPPLER_HOOK_INITIALIZER) {
        assert.equal(data.slice(0, 10), toFunctionSelector("getState(address)"));
        const state = values.doppler;
        return encodeFunctionResult({
          abi: DOPPLER_STATE_ABI,
          functionName: "getState",
          result: [state.numeraire, 0n, NATIVE_ETH_ADDRESS, "0x", state.status, state.poolKey, -887000],
        });
      }
      assert.equal(to.toLowerCase(), TOKEN);
      if (data === toFunctionSelector("yearlyMintRate()")) return `0x${values.yearlyMintRate.toString(16).padStart(64, "0")}`;
      const fn = selectors[data];
      assert.ok(fn, `unexpected eth_call ${data}`);
      return encodeFunctionResult({ abi: erc20Abi, functionName: fn, result: values[fn] });
    },
  };
}

/**
 * A DEXScreener pair in the shape it reports a native-ETH Uniswap v4 pool on
 * Base: quote 0x000...000 "ETH", the pool id as pairAddress, liquidity.quote in ETH.
 */
function pair(poolId, liquidityUsd, { quote = NATIVE_ETH_ADDRESS, priceNative = "0.0000000004", chainId = "base", base = ADDRESS, quoteEth = 10 } = {}) {
  const symbols = { [NATIVE_ETH_ADDRESS]: "ETH", [BASE_WETH_ADDRESS]: "WETH" };
  return {
    chainId,
    dexId: "uniswap",
    labels: ["v4"],
    pairAddress: poolId,
    baseToken: { address: base, symbol: "HIVRA" },
    quoteToken: { address: quote, symbol: symbols[quote] ?? "USDC" },
    priceNative,
    priceUsd: String(Number(priceNative) * ETH_USD),
    liquidity: { usd: liquidityUsd, base: 1_000_000_000, quote: quoteEth },
  };
}

function candlesFixture(closesByAgeMinutes, base = TOKEN, quote = NATIVE_ETH_ADDRESS) {
  const nowSec = Math.floor(NOW_MS / 1000);
  return {
    data: { attributes: { ohlcv_list: closesByAgeMinutes.map(([age, close]) => [nowSec - age * 60, close, close, close, close, 1]) } },
    meta: { base: { address: base }, quote: { address: quote } },
  };
}

/** A fake fetch over the three sources; records every request. */
function fakeFetch({ chain = chainFixture(), pairs = [pair(POOL, 40_000)], candles = candlesFixture([[10, 0.0000000004], [300, 0.0000000004]]), fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", rpcMethod: body?.method ?? null, to: body?.params?.[0]?.to ?? null });
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
    minQuoteLiquidityUsd: inputs.minQuoteLiquidityUsd ?? 12_500,
    observations,
  });
  return {
    result,
    calls,
    failed: result.checks.filter((c) => !c.ok && c.level === "error").map((c) => c.id),
    warned: result.checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.id),
    detail: (id) => result.checks.find((c) => c.id === id)?.detail,
  };
}

test("a Doppler launch in a native-ETH pool that matches everything is READY, with the block to write", async () => {
  const { result, calls, failed, warned, detail } = await evaluate();
  assert.deepEqual(failed, []);
  assert.deepEqual(warned, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { contractAddress: ADDRESS, decimals: 18, poolId: POOL, activatesAt: ACTIVATES_AT });
  for (const id of ["chain.implementation", "chain.no_mint", "chain.inflation", "doppler.state", "doppler.numeraire", "pool.doppler_key", "pool.eth_liquidity", "candles.quote"]) {
    assert.ok(result.checks.some((c) => c.id === id && c.ok), `${id} passes`);
  }
  assert.match(detail("pool.doppler_key"), /currency0 native ETH, .*fee dynamic \(set by the Doppler hook\), tickSpacing 200/);
  assert.match(detail("candles.quote"), /in ETH \(native\)/);
  // Read-only: only eth_getCode / eth_call on the RPC, and GETs elsewhere.
  for (const call of calls) {
    if (call.url === DEFAULT_ENDPOINTS.rpcUrl) assert.match(call.rpcMethod, /^eth_(getCode|call)$/);
    else assert.equal(call.method, "GET");
  }
  // It read the implementation's code and Doppler's record of the pool.
  assert.ok(calls.some((c) => c.rpcMethod === "eth_call" && c.to?.toLowerCase() === DOPPLER_HOOK_INITIALIZER));
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
  assert.deepEqual((await evaluate({ chain: chainFixture({ totalSupply: SUPPLY - 1n }) })).failed, ["chain.total_supply"]);
  const noCode = await evaluate({ chain: chainFixture({ code: "0x" }) });
  assert.deepEqual(noCode.failed, ["chain.code"]);
  assert.equal(noCode.result.config, null);
  const rpcDown = await evaluate({ fail: { rpc: true } });
  assert.deepEqual(rpcDown.failed, ["chain.read"]);
  assert.equal(rpcDown.result.config, null);
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

test("refuses a token whose supply could grow: not the DopplerERC20V1 clone, a mint function, or inflation", async () => {
  // Plain bytecode (not a clone): could hold anything, including a mint or an upgrade path.
  const plain = await evaluate({ chain: chainFixture({ code: DOPPLER_V1_CODE }) });
  assert.deepEqual(plain.failed, ["chain.implementation"]);
  assert.match(plain.detail("chain.implementation"), /not a minimal-proxy clone/);
  // A clone of some other implementation.
  const other = `0x${"77".repeat(20)}`;
  const otherClone = await evaluate({ chain: chainFixture({ code: cloneCode(other), implementationCodeAt: { [other]: DOPPLER_V1_CODE } }) });
  assert.deepEqual(otherClone.failed, ["chain.implementation"]);
  // Code with an owner mint.
  const minter = await evaluate({ chain: chainFixture({ implementationCode: codeWith(["totalSupply()", "mint(address,uint256)"]) }) });
  assert.deepEqual(minter.failed, ["chain.no_mint"]);
  assert.match(minter.detail("chain.no_mint"), /mint\(address,uint256\)/);
  // The older Doppler DERC20: yearly inflation minted through mintInflation().
  const derc20 = codeWith(["totalSupply()", "mintInflation()", "yearlyMintRate()"]);
  const inflating = await evaluate({ chain: chainFixture({ implementationCode: derc20, yearlyMintRate: 2n * 10n ** 16n }) });
  assert.deepEqual(inflating.failed, ["chain.no_mint", "chain.inflation"]);
  assert.match(inflating.detail("chain.inflation"), /20000000000000000 \(WAD per year\)/);
  assert.equal(inflating.result.config, null);
  // An inflation getter that reads 0, with no mint entry point, is not inflation.
  const zeroRate = await evaluate({ chain: chainFixture({ implementationCode: codeWith(["totalSupply()", "yearlyMintRate()"]), yearlyMintRate: 0n }) });
  assert.deepEqual(zeroRate.failed, []);
  assert.match(zeroRate.detail("chain.inflation"), /yearlyMintRate\(\) is 0/);
});

test("accepts the $HIVRA launch: a clone of the current DopplerERC20V1 0xedf3…50f8, and still the earlier 0xdb7b…be87", async () => {
  const current = "0xedf3f3981e98077591c1b909bccff0e572bd50f8";
  assert.deepEqual([...DOPPLER_ERC20_V1_IMPLEMENTATIONS], ["0xdb7b520bb5c3a2c5d4871198081911359f93be87", current]);
  // Runtime code of $HIVRA (0xe3a1F26440A9FDf5d17b6B3F12F5ebB290080871), recorded live on Base on 2026-10-27.
  const hivraClone = "0x3d3d3d3d363d3d37363d73edf3f3981e98077591c1b909bccff0e572bd50f85af43d3d93803e602a57fd5bf3";
  assert.equal(cloneImplementation(hivraClone), current);
  // The current implementation's dispatcher: the ERC-20 and votes reads, burn, and the vesting functions; no mint.
  const currentCode = codeWith([
    "name()", "symbol()", "decimals()", "totalSupply()", "burn(uint256)", "release(uint256)", "release(uint256,uint256)",
    "releaseFor(address,uint256)", "vestingStart()", "vestingOf(address,uint256)", "getPastTotalSupply(uint256)",
  ]);
  const launched = await evaluate({ chain: chainFixture({ code: hivraClone, implementationCodeAt: { [current]: currentCode } }) });
  assert.deepEqual(launched.failed, []);
  assert.match(launched.detail("chain.implementation"), new RegExp(`clone of DopplerERC20V1 ${current}`));
  assert.ok(launched.result.checks.some((c) => c.id === "chain.no_mint" && c.ok));
  // A clone of the accepted address that has no code there is still refused.
  const empty = await evaluate({ chain: chainFixture({ code: hivraClone, implementationCodeAt: { [current]: "0x" } }) });
  assert.deepEqual(empty.failed, ["chain.implementation"]);
  // The same implementation with a mint entry point would still fail chain.no_mint.
  const minting = await evaluate({
    chain: chainFixture({ code: hivraClone, implementationCodeAt: { [current]: codeWith(["totalSupply()", "mint(address,uint256)"]) } }),
  });
  assert.deepEqual(minting.failed, ["chain.no_mint"]);
});

test("reads clones and selectors the way they appear on Base", () => {
  // Runtime code of a DopplerERC20V1 clone, recorded live on Base (token 0x72092daf...0eba3).
  const recorded = "0x3d3d3d3d363d3d37363d73db7b520bb5c3a2c5d4871198081911359f93be875af43d3d93803e602a57fd5bf3";
  assert.equal(cloneImplementation(recorded), IMPLEMENTATION);
  assert.equal(cloneImplementation(`0x363d3d373d3d3d363d73${"12".repeat(20)}5af43d82803e903d91602b57fd5bf3`), `0x${"12".repeat(20)}`);
  assert.equal(cloneImplementation("0x6080604052"), null);
  assert.equal(cloneImplementation(null), null);
  assert.equal(codeHasFunction(codeWith(["mint(address,uint256)"]), "mint(address,uint256)"), true);
  assert.equal(codeHasFunction(DOPPLER_V1_CODE, "mint(address,uint256)"), false);
});

test("computes the Uniswap v4 pool id from a pool key, matching a live Doppler pool on Base", () => {
  // DopplerHookInitializer.getState(0x72092daf...0eba3) and the pool DEXScreener lists for it, read live.
  const live = {
    currency0: BASE_WETH_ADDRESS,
    currency1: "0x72092dafa940b8a2b814d75940cf4163f1f0eba3",
    fee: V4_DYNAMIC_FEE_FLAG,
    tickSpacing: 200,
    hooks: DOPPLER_HOOK_INITIALIZER,
  };
  assert.equal(v4PoolId(live), "0x9ee3a8dab6f9a4ffa3d47921e399cc8c2d3bf4e6ad842164454e7cc0b7d0c4bb");
});

test("needs the pool Doppler recorded for the token, live and quoted in ETH", async () => {
  const uninitialized = await evaluate({ chain: chainFixture({ doppler: { numeraire: NATIVE_ETH_ADDRESS, status: 0, poolKey: dopplerKey() } }) });
  assert.ok(uninitialized.failed.includes("doppler.state"));
  assert.match(uninitialized.detail("doppler.state"), /not a Doppler Multicurve launch/);
  assert.equal(uninitialized.result.config, null);
  const exited = await evaluate({ chain: chainFixture({ doppler: { numeraire: NATIVE_ETH_ADDRESS, status: 4, poolKey: dopplerKey() } }) });
  assert.ok(exited.failed.includes("doppler.state"));
  assert.match(exited.detail("doppler.state"), /liquidity has left the pool/);
  // A pool Doppler created with WETH as the numeraire is accepted, with a warning (the plan is native ETH).
  const wethKey = dopplerKey({ currency0: BASE_WETH_ADDRESS });
  const wethPool = v4PoolId(wethKey);
  const weth = await evaluate({
    chain: chainFixture({ doppler: { numeraire: BASE_WETH_ADDRESS, status: 2, poolKey: wethKey } }),
    pairs: [pair(wethPool, 40_000, { quote: BASE_WETH_ADDRESS })],
    candles: candlesFixture([[10, 0.0000000004], [300, 0.0000000004]], TOKEN, BASE_WETH_ADDRESS),
  });
  assert.deepEqual(weth.failed, []);
  assert.deepEqual(weth.warned, ["doppler.numeraire"]);
  assert.equal(weth.result.config.poolId, wethPool);
  // Any other numeraire is refused: the price feed prices $HIVRA only against ETH.
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const usdcNumeraire = await evaluate({ chain: chainFixture({ doppler: { numeraire: usdc, status: 2, poolKey: dopplerKey({ currency0: usdc }) } }) });
  assert.ok(usdcNumeraire.failed.includes("doppler.numeraire"));
});

test("picks the Doppler pool over a deeper ETH pool, warns about the others, and never a USDC pair", async () => {
  const pairs = [
    pair(OTHER_POOL, 300_000, { quoteEth: 50 }),
    pair(POOL, 90_000),
    pair(`0x${"ef".repeat(32)}`, 5_000_000, { quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", quoteEth: 1_000 }), // USDC pair: never the pricing pool
    pair(`0x${"12".repeat(32)}`, 900_000, { chainId: "ethereum" }),
  ];
  const { result, warned } = await evaluate({ pairs });
  assert.equal(result.config.poolId, POOL);
  assert.deepEqual(warned, ["pool.single"]);
  // --pool-id can pin another listed ETH pool, but not one that is not Doppler's.
  const pinned = await evaluate({ pairs }, { poolId: OTHER_POOL.toUpperCase().replace("0X", "0x") });
  assert.deepEqual(pinned.failed, ["pool.doppler_key"]);
  assert.match(pinned.detail("pool.doppler_key"), new RegExp(`--pool-id ${POOL}`));
  assert.equal(pinned.result.config, null);
  assert.ok((await evaluate({ pairs }, { poolId: `0x${"99".repeat(32)}` })).failed.includes("pool.found"));
  // Without a Doppler record, the deepest ETH side wins (not the token-heavy total).
  const observed = [
    { poolId: POOL, quoteAddress: NATIVE_ETH_ADDRESS, liquidityUsd: 1_000_000, quoteLiquidityUsd: 2_400 },
    { poolId: OTHER_POOL, quoteAddress: BASE_WETH_ADDRESS, liquidityUsd: 50_000, quoteLiquidityUsd: 24_000 },
  ];
  assert.equal(choosePool(observed).poolId, OTHER_POOL);
  assert.equal(choosePool(observed, null, POOL).poolId, POOL);
  assert.equal(choosePool([]), null);
});

test("refuses a pool below either liquidity floor, or with an id the registry rejects", async () => {
  const thin = await evaluate({ pairs: [pair(POOL, 24_999)] });
  assert.deepEqual(thin.failed, ["pool.liquidity"]);
  assert.equal(thin.result.config, null);
  // A fresh Doppler pool: a large total that is nearly all $HIVRA, with $12,000 of ETH.
  const tokenHeavy = await evaluate({ pairs: [pair(POOL, 2_000_000, { quoteEth: 5 })] });
  assert.deepEqual(tokenHeavy.failed, ["pool.eth_liquidity"]);
  assert.match(tokenHeavy.detail("pool.eth_liquidity"), /\$12,000 of ETH in the pool; the ETH-side floor is \$12,500/);
  assert.equal(tokenHeavy.result.config, null);
  const noQuoteSide = { ...pair(POOL, 2_000_000), liquidity: { usd: 2_000_000 } };
  assert.deepEqual((await evaluate({ pairs: [noQuoteSide] })).failed, ["pool.eth_liquidity"]);
  const badId = await evaluate({ pairs: [pair("0xabc", 90_000)] });
  assert.ok(badId.failed.includes("pool.id_format"));
  assert.ok(badId.failed.includes("pool.doppler_key"));
  assert.deepEqual((await evaluate({ pairs: [] })).failed, ["pool.found"]);
  assert.deepEqual((await evaluate({ fail: { dex: true } })).failed, ["pool.read"]);
});

test("needs a GeckoTerminal candle for the pool, priced for this token in ETH", async () => {
  assert.deepEqual((await evaluate({ candles: candlesFixture([]) })).failed, ["candles.present"]);
  assert.deepEqual((await evaluate({ fail: { gecko: true } })).failed, ["candles.present"]);
  const wrongToken = await evaluate({ candles: candlesFixture([[10, 0.0000000004]], BASE_WETH_ADDRESS) });
  assert.ok(wrongToken.failed.includes("candles.pool_token"));
  const usdcCandles = await evaluate({ candles: candlesFixture([[10, 0.0000000004], [300, 0.0000000004]], TOKEN, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") });
  assert.deepEqual(usdcCandles.failed, ["candles.quote"]);
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
  assert.match(young.detail("candles.history"), /only 60 minutes of candle history/);
});

test("reads both liquidity floors from token-registry.ts", () => {
  assert.equal(readMinPriceLiquidityUsd("export const HIVRA_MIN_PRICE_LIQUIDITY_USD = 40_000;"), 40_000);
  assert.throws(() => readMinPriceLiquidityUsd("nothing here"), /not found/);
  assert.equal(typeof readMinPriceLiquidityUsd(readFileSync(REGISTRY_FILE, "utf8")), "number");
  assert.equal(readMinQuoteLiquidityUsd("export const HIVRA_MIN_QUOTE_LIQUIDITY_USD = 20_000;"), 20_000);
  assert.throws(() => readMinQuoteLiquidityUsd("nothing here"), /not found/);
  assert.equal(readMinQuoteLiquidityUsd(readFileSync(REGISTRY_FILE, "utf8")), 12_500);
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
  assert.equal(typeof report.minQuoteLiquidityUsd, "number");
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
  // A token that can mint is never written either.
  const minting = fakeFetch({ chain: chainFixture({ implementationCode: codeWith(["mint(address,uint256)"]) }) });
  assert.equal(await main(["--address", ADDRESS, "--activates-at", ACTIVATES_AT, "--write"], { ...io, fetchImpl: minting.fetchImpl }), 1);
  assert.equal(readFileSync(LAUNCH_FILE, "utf8"), before);
  assert.equal(await main(["--write"], io), 2);
});
