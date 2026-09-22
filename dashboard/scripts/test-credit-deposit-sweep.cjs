// Credit-deposit USDC treasury sweep, end to end, fully in memory.
//
// Applies the real crypto_deposit_receipts / Bankr wallet migrations to
// PostgreSQL/WASM and runs the real src/lib/billing/credit-deposit-sweep.ts
// (and the real Bankr / gas helpers it calls) against it. Only the network is
// faked: a Base JSON-RPC that keeps USDC balances, mines transfers and rejects
// eth_getLogs ranges over 2,000 blocks (as the public Base RPC does), and a
// Bankr partner API that mints recipient-scoped keys and executes transfers on
// that chain. No credentials, live database or chain are touched.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createPgliteSupabase } = require("./lib/pglite-postgrest.cjs");

process.env.NODE_ENV = "test";
require("./register-server-only-noop.cjs");
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node" },
});
require("tsconfig-paths/register");

const supabaseModule = require("../src/lib/supabase.ts");
const opsEventsModule = require("../src/lib/ops-events.ts");
const { log } = require("../src/lib/logger.ts");
const { sweepPendingCreditDepositReceipts } = require("../src/lib/billing/credit-deposit-sweep.ts");

const MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425120000_credit_billing_foundation.sql",
  "20260425140000_crypto_deposit_receipts.sql",
  "20260426183000_bankr_deposit_wallets.sql",
  "20260430062000_bankr_deposit_credentials_purpose.sql",
  "20260501100000_bankr_deposit_credentials_yearly_subscription_purpose.sql",
];
const SWEEP_MIGRATION = "20260922185029_credit_deposit_sweep_state.sql";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TREASURY = "0x7ea5000000000000000000000000000000000001";
const RPC_URL = "https://base-rpc.test";
const BANKR_URL = "https://bankr.test";
const ENV = {
  HERMES_TREASURY_ADDRESS: TREASURY,
  HERMES_BASE_RPC_URL: RPC_URL,
  BANKR_PARTNER_KEY: "partner-test-key",
  BANKR_API_BASE_URL: BANKR_URL,
};
const T0 = new Date("2026-09-22T12:00:00.000Z");
const minutes = (count) => new Date(T0.getTime() + count * 60_000);

const read = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const topicFor = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const addressFor = (seed) => `0x${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
const usdc = (display) => BigInt(Math.round(Number(display) * 1_000_000));

// ── Fake Base chain ─────────────────────────────────────────────────────────

class FakeBase {
  constructor() {
    this.head = 30_000_000;
    this.balances = new Map();
    this.receipts = new Map();
    this.logs = [];
    this.nonce = 0;
  }

  balanceOf(address) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  fund(address, raw) {
    this.balances.set(address.toLowerCase(), this.balanceOf(address) + BigInt(raw));
  }

  mine(blocks = 1) {
    this.head += blocks;
  }

  // Mines a USDC transfer in the next block. Reverts (status 0, no log) when
  // asked to or when the sender cannot cover it.
  transfer(from, to, raw, { revert = false } = {}) {
    this.mine();
    this.nonce += 1;
    const hash = `0x${createHash("sha256").update(`tx:${this.nonce}`).digest("hex")}`;
    const ok = !revert && this.balanceOf(from) >= raw;
    const logs = [];
    if (ok) {
      this.balances.set(from.toLowerCase(), this.balanceOf(from) - raw);
      this.fund(to, raw);
      const entry = {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicFor(from), topicFor(to)],
        data: `0x${raw.toString(16).padStart(64, "0")}`,
        blockNumber: hex(this.head),
        transactionHash: hash,
        logIndex: "0x0",
        removed: false,
      };
      logs.push(entry);
      this.logs.push(entry);
    }
    this.receipts.set(hash, {
      transactionHash: hash,
      blockNumber: hex(this.head),
      status: ok ? "0x1" : "0x0",
      logs,
    });
    return hash;
  }

  transfersTo(address) {
    return this.logs
      .filter((entry) => entry.topics[2] === topicFor(address))
      .map((entry) => ({ hash: entry.transactionHash, from: `0x${entry.topics[1].slice(26)}`, raw: BigInt(entry.data) }));
  }

  rpc(method, params) {
    if (method === "eth_blockNumber") return { result: hex(this.head) };
    if (method === "eth_call") {
      const [{ to, data }] = params;
      assert.equal(to.toLowerCase(), USDC, "eth_call only models USDC balanceOf");
      assert.ok(data.startsWith("0x70a08231"), "eth_call only models balanceOf");
      const owner = `0x${data.slice(-40)}`;
      return { result: `0x${this.balanceOf(owner).toString(16).padStart(64, "0")}` };
    }
    if (method === "eth_getTransactionReceipt") {
      return { result: this.receipts.get(String(params[0]).toLowerCase()) ?? null };
    }
    if (method === "eth_getLogs") {
      const [{ address, fromBlock, toBlock, topics = [] }] = params;
      const from = Number(BigInt(fromBlock));
      const to = toBlock === "latest" ? this.head : Number(BigInt(toBlock));
      if (to - from + 1 > 2000) {
        return { httpStatus: 413, error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" } };
      }
      const result = this.logs.filter((entry) => {
        const block = Number(BigInt(entry.blockNumber));
        if (block < from || block > to) return false;
        if (address && entry.address !== String(address).toLowerCase()) return false;
        return topics.every((topic, index) => topic == null || entry.topics[index] === String(topic).toLowerCase());
      });
      return { result };
    }
    throw new Error(`fake Base RPC does not model ${method}`);
  }
}

// ── Fake Bankr partner API ──────────────────────────────────────────────────

// Modes for the next /wallet/transfer calls (FIFO; default "ok"):
//   ok                 transfer mined, 200 { txHash }
//   ok_without_hash    transfer mined, 200 {}
//   broadcast_then_502 transfer mined, then a 502
//   drop_then_502      nothing sent, 502
//   network_error      fetch rejects before any response
//   reject             nothing sent, 400
//   revert             tx mined but reverted, 200 { txHash }
class FakeBankr {
  constructor(chain) {
    this.chain = chain;
    this.walletsById = new Map();
    this.keys = new Map();
    this.modes = [];
    this.transferRequests = [];
  }

  registerWallet(bankrWalletId, address) {
    this.walletsById.set(bankrWalletId, address.toLowerCase());
  }

  queue(...modes) {
    this.modes.push(...modes);
  }

  mintKey(bankrWalletId, headers, body) {
    if (headers["X-Partner-Key"] !== ENV.BANKR_PARTNER_KEY) return { status: 401, body: { error: "bad partner key" } };
    const wallet = this.walletsById.get(bankrWalletId);
    if (!wallet) return { status: 404, body: { error: "unknown wallet" } };
    const key = `bk_${this.keys.size + 1}`;
    this.keys.set(key, { wallet, recipients: body.allowedRecipients.evm.map((value) => value.toLowerCase()) });
    return { status: 200, body: { apiKey: key } };
  }

  transfer(headers, body) {
    const key = this.keys.get(headers["X-API-Key"]);
    if (!key) return { status: 401, body: { error: "bad api key" } };
    const recipient = body.recipientAddress.toLowerCase();
    if (!key.recipients.includes(recipient)) return { status: 403, body: { error: "recipient not allowed" } };
    assert.equal(body.tokenAddress.toLowerCase(), USDC);
    const raw = usdc(body.amount);
    this.transferRequests.push({ from: key.wallet, to: recipient, raw });
    const mode = this.modes.shift() ?? "ok";
    if (mode === "network_error") throw new TypeError("fetch failed");
    if (mode === "reject") return { status: 400, body: { error: "insufficient_funds_for_gas" } };
    if (mode === "drop_then_502") return { status: 502, body: { error: "bad gateway" } };
    const hash = this.chain.transfer(key.wallet, recipient, raw, { revert: mode === "revert" });
    if (mode === "broadcast_then_502") return { status: 502, body: { error: "bad gateway" } };
    if (mode === "ok_without_hash") return { status: 200, body: {} };
    return { status: 200, body: { txHash: hash } };
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function fakeFetch(chain, bankr) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const headers = init.headers || {};
    if (url === RPC_URL) {
      const answer = chain.rpc(body.method, body.params || []);
      if (answer.httpStatus) return response(answer.httpStatus, { jsonrpc: "2.0", id: body.id, error: answer.error });
      return response(200, { jsonrpc: "2.0", id: body.id, ...answer });
    }
    const keyMint = url.match(/^https:\/\/bankr\.test\/partner\/wallets\/([^/]+)\/api-keys$/);
    if (keyMint) {
      const answer = bankr.mintKey(decodeURIComponent(keyMint[1]), headers, body);
      return response(answer.status, answer.body);
    }
    if (url === `${BANKR_URL}/wallet/transfer`) {
      const answer = bankr.transfer(headers, body);
      return response(answer.status, answer.body);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

const opsEvents = [];
const errorLogs = [];
opsEventsModule.reportOpsEvent = async (input) => {
  opsEvents.push(input);
  return null;
};
log.error = (message, error, context) => errorLogs.push({ message, error, context });
log.warn = () => {};
log.info = () => {};

// PGlite starts slowly, so scenarios share one instance and each one rebuilds
// the schema from the migrations.
async function resetDatabase(db, { sweepMigration }) {
  await db.exec(`
    drop schema if exists public cascade; create schema public;
    drop schema if exists auth cascade; create schema auth;
    create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function public.update_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
    create table public.hermes_instances (id uuid primary key default gen_random_uuid());
    create table public.user_wallets (id uuid primary key default gen_random_uuid());
  `);
  for (const name of PREREQUISITES) await db.exec(read(name));
  if (sweepMigration) await db.exec(read(SWEEP_MIGRATION));
}

async function createHarness(db, { sweepMigration = true } = {}) {
  await resetDatabase(db, { sweepMigration });

  const rest = createPgliteSupabase(db);
  supabaseModule.supabaseAdmin = rest.client;
  const chain = new FakeBase();
  const bankr = new FakeBankr(chain);
  globalThis.fetch = fakeFetch(chain, bankr);
  opsEvents.length = 0;
  errorLogs.length = 0;
  let receiptCount = 0;

  const h = {
    db,
    rest,
    chain,
    bankr,
    opsEvents,
    errorLogs,

    async wallet(userId, purpose = "credit_deposit") {
      const address = addressFor(`${userId}:${purpose}`);
      const bankrWalletId = `bankr-${userId}-${purpose}`;
      await db.query(
        `insert into public.bankr_deposit_wallet_credentials
          (user_id, purpose, bankr_wallet_id, evm_address, normalized_evm_address, api_key_status)
         values ($1, $2, $3, $4, $4, 'active')`,
        [userId, purpose, bankrWalletId, address]
      );
      bankr.registerWallet(bankrWalletId, address);
      return address;
    },

    // A top-up receipt as the reconciler writes it once credits are granted.
    async settledReceipt({ userId, wallet, amount, depositMode = "checkout", token = USDC, status = "settled" }) {
      receiptCount += 1;
      const { rows } = await db.query(
        `insert into public.crypto_deposit_receipts
          (user_id, provider, reference_id, chain_id, token_address, token_symbol, token_decimals,
           deposit_address, normalized_deposit_address, amount_minor, tx_hash, log_index, block_number,
           confirmations, status, deposit_mode, detected_at, confirmed_at, settled_at)
         values ($1, 'bankr', $2, 8453, $3, 'USDC', 6, $4, $4, $5, $6, $7, 29000000, 3, $8, $9,
           $10, $10, case when $8 = 'settled' then $10::timestamptz end)
         returning id`,
        [
          userId,
          `bankr_crypto_topup:${receiptCount}`,
          token,
          wallet,
          String(amount),
          `0xdeposit${receiptCount}`,
          receiptCount,
          status,
          depositMode,
          minutes(-60 + receiptCount).toISOString(),
        ]
      );
      return rows[0].id;
    },

    async sweepStatus(id) {
      const { rows } = await db.query("select sweep_status from public.crypto_deposit_receipts where id = $1", [id]);
      return rows[0].sweep_status;
    },

    async receipt(id) {
      const { rows } = await db.query(
        `select sweep_status, sweep_tx_hash, sweep_attempts, sweep_error, sweep_attempted_at,
                sweep_transfer_requested_at, sweep_confirmed_at, sweep_destination_address
           from public.crypto_deposit_receipts where id = $1`,
        [id]
      );
      return rows[0];
    },

    sweep(now = T0, options = {}) {
      return sweepPendingCreditDepositReceipts({ env: { ...ENV, ...options.env }, now, limit: 50 });
    },

    treasuryReceived() {
      return chain.transfersTo(TREASURY).reduce((sum, transfer) => sum + transfer.raw, 0n);
    },

  };
  return h;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const scenarios = [];
const scenario = (name, run, options) => scenarios.push({ name, run, options });

scenario("a settled USDC top-up is swept to the treasury once and confirmed on chain", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(50));
  const receipt = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });

  await h.sweep(minutes(0));
  assert.equal(h.bankr.transferRequests.length, 1, "exactly one transfer requested");
  assert.deepEqual(h.chain.transfersTo(TREASURY).map((t) => [t.from, t.raw]), [[wallet, usdc(50)]]);
  const submitted = await h.receipt(receipt);
  assert.equal(submitted.sweep_status, "submitted");
  assert.equal(submitted.sweep_tx_hash, h.chain.transfersTo(TREASURY)[0].hash);
  assert.equal(submitted.sweep_attempts, 1);
  assert.equal(submitted.sweep_destination_address, TREASURY);

  h.chain.mine(3);
  await h.sweep(minutes(10));
  const confirmed = await h.receipt(receipt);
  assert.equal(confirmed.sweep_status, "confirmed");
  assert.ok(confirmed.sweep_confirmed_at, "confirmation time recorded");

  await h.sweep(minutes(20));
  assert.equal(h.bankr.transferRequests.length, 1, "a confirmed receipt is never swept again");
  assert.equal(h.chain.balanceOf(wallet), 0n);
});

scenario("a lost sweep hash never re-sweeps funds that belong to a later receipt", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(50) + usdc(25));
  const first = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });
  const second = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(25) });
  // The transfer for the first receipt succeeds, but recording its hash fails.
  h.rest.failNextWrite((q) => q.table === "crypto_deposit_receipts" && q.operation === "update" && Boolean(q.values.sweep_tx_hash));
  await h.sweep(minutes(0));
  assert.equal(h.bankr.transferRequests.length, 2);

  // The user buys the same package again; the wallet now holds exactly the
  // new receipt's funds, which a retry of the first receipt would take.
  h.chain.fund(wallet, usdc(50));
  const third = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });
  h.chain.mine(3);
  await h.sweep(minutes(10));
  h.chain.mine(3);
  await h.sweep(minutes(20));

  const hashes = h.chain.transfersTo(TREASURY).map((transfer) => transfer.hash);
  for (const [id, hash] of [[first, hashes[0]], [second, hashes[1]], [third, hashes[2]]]) {
    const row = await h.receipt(id);
    assert.deepEqual([row.sweep_status, row.sweep_tx_hash], ["confirmed", hash], `receipt ${id} carries its own sweep tx`);
  }
  assert.deepEqual(h.bankr.transferRequests.map((request) => request.raw), [usdc(50), usdc(25), usdc(50)]);
  assert.equal(h.treasuryReceived(), usdc(125));
  assert.equal(h.chain.balanceOf(wallet), 0n);
  assert.ok(
    h.errorLogs.some((entry) => entry.context?.receiptId === first && entry.context?.sweepTxHash === hashes[0]),
    "the unrecorded sweep is logged with its tx hash"
  );
  assert.ok(h.opsEvents.some((event) => event.metadata?.receiptId === first), "the unrecorded sweep reaches the ops feed");
});

scenario("concurrent sweep runs claim a receipt before transferring it", async (h) => {
  const wallet = await h.wallet("user_a");
  // The wallet also holds 50 USDC that no settled receipt accounts for (for
  // example an overpayment awaiting review); it must stay where it is.
  h.chain.fund(wallet, usdc(50) + usdc(50));
  const receipt = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });

  await Promise.all([h.sweep(minutes(0)), h.sweep(minutes(0)), h.sweep(minutes(0))]);
  assert.equal(h.bankr.transferRequests.length, 1, "one transfer across concurrent runs");
  assert.equal(h.chain.balanceOf(wallet), usdc(50), "funds no receipt accounts for are not swept");
  assert.equal((await h.receipt(receipt)).sweep_attempts, 1);
});

scenario("a Bankr refusal is retried, an ambiguous failure is never re-sent", async (h) => {
  const walletA = await h.wallet("user_a");
  const walletB = await h.wallet("user_b");
  const walletC = await h.wallet("user_c");
  h.chain.fund(walletA, usdc(50));
  h.chain.fund(walletB, usdc(20));
  h.chain.fund(walletC, usdc(5));
  const refused = await h.settledReceipt({ userId: "user_a", wallet: walletA, amount: usdc(50) });
  const dropped = await h.settledReceipt({ userId: "user_b", wallet: walletB, amount: usdc(20) });
  const unreachable = await h.settledReceipt({ userId: "user_c", wallet: walletC, amount: usdc(5) });
  h.bankr.queue("reject", "drop_then_502", "network_error");

  await h.sweep(minutes(0));
  const refusedRow = await h.receipt(refused);
  assert.equal(refusedRow.sweep_status, "failed");
  assert.match(refusedRow.sweep_error, /status=400/);
  for (const id of [dropped, unreachable]) {
    const row = await h.receipt(id);
    assert.equal(row.sweep_status, "submitted", "an ambiguous failure stays claimed");
    assert.equal(row.sweep_tx_hash, null);
    assert.ok(row.sweep_error, "the ambiguous failure is recorded");
    assert.ok(h.opsEvents.some((event) => event.metadata?.receiptId === id), "an ambiguous failure reaches the ops feed");
  }

  await h.sweep(minutes(10));
  assert.equal(h.bankr.transferRequests.length, 4, "only the refused transfer is sent again");
  h.chain.mine(3);
  await h.sweep(minutes(20));
  assert.equal((await h.receipt(refused)).sweep_status, "confirmed");

  // Long after the scan window, nothing on chain: still unresolved, still not re-sent.
  h.chain.mine(5_000);
  await h.sweep(minutes(600));
  assert.equal(h.bankr.transferRequests.length, 4);
  assert.equal((await h.receipt(dropped)).sweep_status, "submitted");
  assert.equal((await h.receipt(unreachable)).sweep_status, "submitted");
  assert.equal(h.treasuryReceived(), usdc(50));
  for (const id of [dropped, unreachable]) {
    assert.ok(
      h.opsEvents.some((event) => event.metadata?.receiptId === id && event.metadata?.failureType === "credit_deposit_sweep_unresolved"),
      "an unresolved sweep asks for a manual decision"
    );
  }
});

scenario("a transfer Bankr made without returning its hash is confirmed from chain evidence", async (h) => {
  const walletA = await h.wallet("user_a");
  const walletB = await h.wallet("user_b");
  h.chain.fund(walletA, usdc(50));
  h.chain.fund(walletB, usdc(20));
  const lostResponse = await h.settledReceipt({ userId: "user_a", wallet: walletA, amount: usdc(50) });
  const noHash = await h.settledReceipt({ userId: "user_b", wallet: walletB, amount: usdc(20) });
  h.bankr.queue("broadcast_then_502", "ok_without_hash");

  await h.sweep(minutes(0));
  assert.equal((await h.receipt(lostResponse)).sweep_tx_hash, null);
  assert.equal((await h.receipt(noHash)).sweep_tx_hash, null);
  h.chain.mine(3);
  await h.sweep(minutes(10));

  const [first, second] = h.chain.transfersTo(TREASURY);
  assert.deepEqual(
    [await h.receipt(lostResponse), await h.receipt(noHash)].map((row) => [row.sweep_status, row.sweep_tx_hash]),
    [["confirmed", first.hash], ["confirmed", second.hash]]
  );
  assert.equal(h.bankr.transferRequests.length, 2, "evidence, not a retry, resolves the doubt");
});

scenario("a reverted sweep moved nothing and is retried", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(50));
  const receipt = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });
  h.bankr.queue("revert");

  await h.sweep(minutes(0));
  assert.equal(h.treasuryReceived(), 0n);
  h.chain.mine(3);
  await h.sweep(minutes(10));
  assert.equal(h.bankr.transferRequests.length, 2, "retried after the revert");
  h.chain.mine(3);
  await h.sweep(minutes(20));
  const row = await h.receipt(receipt);
  assert.equal(row.sweep_status, "confirmed");
  assert.equal(row.sweep_attempts, 2);
  assert.equal(h.treasuryReceived(), usdc(50));
});

scenario("a claim abandoned before any transfer request is released after its lease", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(50));
  const receipt = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });
  // A previous run claimed the receipt and died during its preflight.
  await h.db.query(
    `update public.crypto_deposit_receipts
        set sweep_status = 'submitted', sweep_attempts = 1, sweep_attempted_at = $2,
            sweep_claim_block = $3, sweep_destination_address = $4
      where id = $1`,
    [receipt, minutes(0).toISOString(), h.chain.head, TREASURY]
  );

  await h.sweep(minutes(5));
  assert.equal(h.bankr.transferRequests.length, 0, "a live claim is left alone");
  await h.sweep(minutes(20));
  assert.equal(h.bankr.transferRequests.length, 1, "an expired claim is released and swept");
  const row = await h.receipt(receipt);
  assert.equal(row.sweep_status, "submitted");
  assert.equal(row.sweep_attempts, 2);
});

scenario("never sweeps another user's wallet, a lock wallet, or funds that are missing", async (h) => {
  const walletA = await h.wallet("user_a");
  const walletB = await h.wallet("user_b");
  const lockWallet = await h.wallet("user_c", "hermesos_lock");
  const walletD = await h.wallet("user_d");
  h.chain.fund(walletB, usdc(40));
  h.chain.fund(lockWallet, usdc(40));
  h.chain.fund(walletD, usdc(10));
  h.chain.fund(walletA, usdc(40));
  const foreign = await h.settledReceipt({ userId: "user_a", wallet: walletB, amount: usdc(40) });
  const lock = await h.settledReceipt({ userId: "user_c", wallet: lockWallet, amount: usdc(40) });
  const short = await h.settledReceipt({ userId: "user_d", wallet: walletD, amount: usdc(50) });

  await h.sweep(minutes(0));
  await h.sweep(minutes(10));
  assert.equal(h.bankr.transferRequests.length, 0);
  for (const id of [foreign, lock, short]) {
    const row = await h.receipt(id);
    assert.equal(row.sweep_status, "skipped", `receipt ${id} held for review`);
    assert.ok(row.sweep_error);
    assert.ok(h.opsEvents.some((event) => event.metadata?.receiptId === id), `receipt ${id} reaches the ops feed`);
  }
});

scenario("sweep failures are recorded on the receipt and a failed write is surfaced", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(50));
  const receipt = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });

  await h.sweep(minutes(0), { env: { HERMES_TREASURY_ADDRESS: "" } });
  const unconfigured = await h.receipt(receipt);
  assert.equal(unconfigured.sweep_status, "failed");
  assert.match(unconfigured.sweep_error, /HERMES_TREASURY_ADDRESS/);
  assert.ok(unconfigured.sweep_attempted_at);

  // The claim write fails: nothing may be transferred, and the failure is visible.
  h.rest.failNextWrite((q) => q.table === "crypto_deposit_receipts" && q.values.sweep_status === "submitted");
  const run = await h.sweep(minutes(10));
  assert.equal(h.bankr.transferRequests.length, 0);
  assert.ok(run.results.some((result) => result.receiptId === receipt && result.outcome === "error"));
  assert.ok(h.errorLogs.some((entry) => entry.context?.receiptId === receipt));

  await h.sweep(minutes(20));
  assert.equal(h.bankr.transferRequests.length, 1);
});

scenario("only settled checkout/open-credit Base USDC receipts are owed a sweep", async (h) => {
  const wallet = await h.wallet("user_a");
  h.chain.fund(wallet, usdc(1_000));
  const owed = [
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(1) }),
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(2), depositMode: "open_credit" }),
  ];
  const notOwed = [
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(3), depositMode: "token_lock" }),
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(4), token: addressFor("some-other-erc20") }),
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(5), status: "confirmed" }),
    await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(6), status: "failed" }),
  ];
  for (const id of owed) assert.equal((await h.receipt(id)).sweep_status, "pending");
  for (const id of notOwed) assert.equal((await h.receipt(id)).sweep_status, "not_required");

  // Claim-first settlement: receipt claimed as 'confirmed', then settled.
  await h.db.query("update public.crypto_deposit_receipts set status = 'settled', settled_at = now() where id = $1", [notOwed[2]]);
  assert.equal((await h.receipt(notOwed[2])).sweep_status, "pending");
  owed.push(notOwed.splice(2, 1)[0]);

  // Upsert settlement (insert ... on conflict do update) of an existing claim.
  await h.db.query(
    `insert into public.crypto_deposit_receipts
      (user_id, provider, reference_id, chain_id, token_address, token_symbol, token_decimals, deposit_address,
       normalized_deposit_address, amount_minor, tx_hash, log_index, block_number, status)
     select user_id, provider, reference_id, chain_id, token_address, token_symbol, token_decimals, deposit_address,
       normalized_deposit_address, amount_minor, tx_hash, log_index, block_number, 'settled'
       from public.crypto_deposit_receipts where id = $1
     on conflict (provider, reference_id) do update set status = excluded.status, settled_at = now()`,
    [notOwed[2]]
  );
  assert.equal((await h.receipt(notOwed[2])).sweep_status, "pending");
  owed.push(notOwed.splice(2, 1)[0]);

  await h.sweep(minutes(0));
  assert.deepEqual(
    h.bankr.transferRequests.map((request) => request.raw).sort((a, b) => Number(a - b)),
    [usdc(1), usdc(2), usdc(5), usdc(6)]
  );
  for (const id of notOwed) assert.equal((await h.receipt(id)).sweep_status, "not_required");
});

scenario("the migration backfills settled receipts, is rerun-safe and guards sweep state", async (h) => {
  const wallet = await h.wallet("user_a");
  const settled = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(50) });
  const lock = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(9), depositMode: "token_lock" });
  assert.equal(await h.sweepStatus(settled), "not_required", "prod state before the migration");

  await h.db.exec(read(SWEEP_MIGRATION));
  await h.db.exec(read(SWEEP_MIGRATION));
  assert.equal(await h.sweepStatus(settled), "pending");
  assert.equal(await h.sweepStatus(lock), "not_required");

  const other = await h.settledReceipt({ userId: "user_a", wallet, amount: usdc(7) });
  const rejects = async (code, sql, params) =>
    assert.rejects(h.db.query(sql, params), (error) => error.code === code, `${sql} -> ${code}`);
  await rejects("23514", "update public.crypto_deposit_receipts set sweep_status = 'swept' where id = $1", [settled]);
  await rejects("23514", "update public.crypto_deposit_receipts set sweep_status = 'confirmed' where id = $1", [settled]);
  await rejects("23514", "update public.crypto_deposit_receipts set sweep_status = 'submitted' where id = $1", [settled]);
  await h.db.query(
    "update public.crypto_deposit_receipts set sweep_status = 'confirmed', sweep_tx_hash = '0xabc' where id = $1",
    [settled]
  );
  await rejects("23505", "update public.crypto_deposit_receipts set sweep_tx_hash = '0xABC' where id = $1", [other]);
  // A finished or held sweep is never re-queued by later writes.
  await h.db.query("update public.crypto_deposit_receipts set status = 'settled' where id = $1", [settled]);
  assert.equal(await h.sweepStatus(settled), "confirmed");
}, { sweepMigration: false });

async function main() {
  const only = process.argv[2];
  const selected = scenarios.filter((entry) => !only || entry.name.includes(only));
  const failures = [];
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    for (const entry of selected) {
      const h = await createHarness(db, entry.options);
      try {
        await entry.run(h);
        console.log(`PASS ${entry.name}`);
      } catch (error) {
        failures.push(entry.name);
        console.log(`FAIL ${entry.name}\n    ${String(error && error.message).split("\n").join("\n    ")}`);
      }
    }
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.log(`FAIL credit-deposit sweep: ${failures.length} of ${selected.length} scenarios failed`);
    process.exit(1);
  }
  console.log(`PASS credit-deposit sweep: ${selected.length} scenarios`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
