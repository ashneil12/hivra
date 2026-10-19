// Fixture tests for build-hivra-airdrop.mjs. Offline: temp files only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HIVRA_TOTAL_SUPPLY_WEI,
  InputError,
  buildAirdrop,
  checkBatchFiles,
  decimalToWei,
  main,
  parseExclusions,
  parseRemap,
  parseSnapshotCsv,
  percentOfSupplyCeil,
  weiToDecimal,
} from "./build-hivra-airdrop.mjs";

const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const POOL = A(0xbeef);
const MANAGED = A(0xa1);
const KEPT = A(0xa2);
const OWNER = A(0xf00d);
const HASH = `0x${"ab".repeat(32)}`;

const CSV = [
  "address,balance_wei,extra",
  `${A(1)},1000000000000000000,x`, // exactly 1
  `${A(2).toUpperCase().replace("0X", "0x")},123456789012345678901,`, // 123.456789012345678901
  `${A(3)},1,`, // 1 wei
  `${A(4)},0,`, // zero: skipped
  `${POOL},5000000000000000000000,`,
  `${MANAGED},2500000000000000000,`,
  `${KEPT},700000000000000000,`,
].join("\n");

function fixture({ batchSize = 2, sentTxs = {} } = {}) {
  return buildAirdrop({
    rows: parseSnapshotCsv(CSV),
    exclusions: parseExclusions({ [POOL]: "Uniswap pool", [A(99)]: "Not a holder" }),
    remap: parseRemap({
      [MANAGED]: { send_to: OWNER, kind: "remap", user_id: "user_secret", email: "x@y.z" },
      [KEPT]: { send_to: KEPT, kind: "keep" },
    }),
    snapshotBlock: 36_000_000,
    batchSize,
    sentTxs,
  });
}

test("wei converts to exact whole-token decimals and back", () => {
  assert.equal(weiToDecimal(1n), "0.000000000000000001");
  assert.equal(weiToDecimal(10n ** 18n), "1");
  assert.equal(weiToDecimal(123456789012345678901n), "123.456789012345678901");
  assert.equal(weiToDecimal(1500000000000000000n), "1.5");
  // Larger than a double can hold exactly.
  const big = 99_999_999_999_999_999_999_999_999_999n;
  assert.equal(decimalToWei(weiToDecimal(big)), big);
  assert.throws(() => decimalToWei("1.0000000000000000001"), InputError);
  assert.throws(() => decimalToWei("1e18"), InputError);
});

test("share of supply rounds up to 2 decimals", () => {
  assert.equal(percentOfSupplyCeil(HIVRA_TOTAL_SUPPLY_WEI), "100.00");
  assert.equal(percentOfSupplyCeil(0n), "0.00");
  assert.equal(percentOfSupplyCeil(1n), "0.01");
  // Exactly 1.24% stays 1.24; one wei more goes to 1.25.
  const exact = (HIVRA_TOTAL_SUPPLY_WEI * 124n) / 10_000n;
  assert.equal(percentOfSupplyCeil(exact), "1.24");
  assert.equal(percentOfSupplyCeil(exact + 1n), "1.25");
});

test("exclusions, zero balances and remaps shape the public document", () => {
  const { publicDocument, summary, warnings } = fixture();
  assert.deepEqual(summary, { holders: 5, recipients: 5, remapped: 1, excluded: 1, zeroBalance: 1, batches: 3, sentBatches: 0 });
  assert.deepEqual(publicDocument.excluded, [{ address: POOL, label: "Uniswap pool" }]);
  assert.equal(publicDocument.totals.excludedWei, "5000000000000000000000");
  assert.match(warnings.join("\n"), /exclusion 0x0+63 is not in the snapshot/);
  // Largest first; addresses lower-cased.
  assert.deepEqual(publicDocument.holders.map((h) => h.address), [A(2), MANAGED, A(1), KEPT, A(3)]);
  const managed = publicDocument.holders.find((h) => h.address === MANAGED);
  assert.deepEqual(managed, { address: MANAGED, amountWei: "2500000000000000000", remapped: true, sent: false });
  const kept = publicDocument.holders.find((h) => h.address === KEPT);
  assert.deepEqual(kept, { address: KEPT, amountWei: "700000000000000000", batch: 2 });
  const text = JSON.stringify(publicDocument);
  assert.ok(!text.includes(OWNER.slice(2)), "the owner's destination is never published");
  assert.ok(!/user_secret|x@y\.z|remap"|keep"/.test(text), "only send_to and kind are read, and kind is not published");
  const included = 123456789012345678901n + 2500000000000000000n + 10n ** 18n + 700000000000000000n + 1n;
  assert.equal(publicDocument.totals.includedWei, included.toString());
  assert.equal(publicDocument.totals.percentOfSupply, "0.01");
});

test("batches split by size, use send_to for managed wallets, and add up exactly", () => {
  const { batches, includedWei } = fixture();
  assert.deepEqual(batches.map((b) => b.lines), [
    [`${A(2)} 123.456789012345678901`, `${OWNER} 2.5`],
    [`${A(1)} 1`, `${KEPT} 0.7`],
    [`${A(3)} 0.000000000000000001`],
  ]);
  assert.equal(batches.reduce((sum, b) => sum + b.totalWei, 0n), includedWei);
  assert.equal(fixture({ batchSize: 300 }).batches.length, 1);
});

test("sent transactions mark batches and managed wallets as sent", () => {
  const { publicDocument } = fixture({ sentTxs: { 1: HASH.toUpperCase().replace("0X", "0x") } });
  assert.equal(publicDocument.batches[0].tx, HASH);
  assert.equal(publicDocument.batches[1].tx, null);
  assert.equal(publicDocument.holders.find((h) => h.address === MANAGED).sent, true);
  assert.throws(() => fixture({ sentTxs: { 4: HASH } }), /batch number from 1 to 3/);
  assert.throws(() => fixture({ sentTxs: { 1: "0x1234" } }), /tx hash/);
});

test("bad inputs are refused", () => {
  assert.throws(() => parseSnapshotCsv(`address,balance_wei\n${A(1)},1\n${A(1)},2`), /appears twice/);
  assert.throws(() => parseSnapshotCsv(`address,balance_wei\n${A(1)},1.5`), /whole number of wei/);
  assert.throws(() => parseSnapshotCsv(`address,balance_wei\n0x12,1`), /20-byte address/);
  assert.throws(() => parseSnapshotCsv(`wallet,amount\n${A(1)},1`), /header/);
  assert.throws(() => parseExclusions({ [A(1)]: "ash@example.com" }), /labels are public/);
  assert.throws(() => parseExclusions({ [A(1)]: "user_2abc" }), /labels are public/);
  assert.throws(() => parseRemap({ [A(1)]: { send_to: "nope" } }), /send_to/);
  assert.throws(
    () => buildAirdrop({ rows: parseSnapshotCsv(`address,balance_wei\n${A(1)},5`), exclusions: parseExclusions({ [A(1)]: "x" }), remap: parseRemap({ [A(1)]: { send_to: A(2) } }), snapshotBlock: 1 }),
    /both excluded and remapped/,
  );
  assert.throws(
    () => buildAirdrop({ rows: parseSnapshotCsv(`address,balance_wei\n${A(0)},5\n${A(1)},5`), snapshotBlock: 1 }),
    /add it to the exclusions/,
  );
});

test("main writes the files, passes the totals check, and refuses private files in the repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-airdrop-"));
  const snapshot = path.join(dir, "snapshot.csv");
  const exclusions = path.join(dir, "exclusions.json");
  const remap = path.join(dir, "remap.json");
  writeFileSync(snapshot, CSV);
  writeFileSync(exclusions, JSON.stringify({ [POOL]: "Uniswap pool" }));
  writeFileSync(remap, JSON.stringify({ [MANAGED]: { send_to: OWNER, kind: "remap" } }));
  const publicJson = path.join(dir, "public", "hivra-airdrop.json");
  const batchesDir = path.join(dir, "batches");
  const logs = [];
  const io = { log: (line) => logs.push(line), error: (line) => logs.push(line) };
  const base = ["--snapshot", snapshot, "--snapshot-block", "36000000", "--exclusions", exclusions, "--remap", remap, "--public-json", publicJson];

  // A first run with small batches, then a re-run with one batch: stale files go.
  assert.equal(main([...base, "--batches-dir", batchesDir, "--batch-size", "2"], io, path.join(dir, "repo")), 0);
  assert.equal(readdirSync(batchesDir).length, 3);
  assert.equal(main([...base, "--batches-dir", batchesDir], io, path.join(dir, "repo")), 0);
  assert.deepEqual(readdirSync(batchesDir), ["hivra-airdrop-batch-001.txt"]);
  assert.match(logs.join("\n"), /totals check passed/);
  assert.match(logs.join("\n"), /share of the 100B supply: 0\.01% \(rounded up\)/);
  const written = JSON.parse(readFileSync(publicJson, "utf8"));
  assert.equal(written.snapshotBlock, 36000000);
  assert.ok(!readFileSync(publicJson, "utf8").includes(OWNER.slice(2)));

  // A tampered batch file fails the check.
  const check = checkBatchFiles(batchesDir, BigInt(written.totals.includedWei) + 1n, written.totals.holders);
  assert.equal(check.ok, false);

  // Private files inside the repository are refused.
  const errors = [];
  const quiet = { log: () => {}, error: (line) => errors.push(line) };
  assert.equal(main([...base, "--batches-dir", path.join(dir, "batches")], quiet, dir), 2);
  assert.match(errors.join("\n"), /--remap must be outside the repository/);
  assert.equal(main(["--snapshot", snapshot, "--snapshot-block", "1", "--public-json", publicJson, "--batches-dir", path.join(dir, "b")], quiet, dir), 2);
  assert.match(errors.join("\n"), /--batches-dir must be outside the repository/);
  assert.equal(main(["--snapshot", snapshot], quiet, dir), 2);
});

test("a destination shared by several holders gets one Disperse line with the exact sum", () => {
  const SECOND = A(0xa3);
  const rows = parseSnapshotCsv(
    [
      "address,balance_wei",
      `${A(1)},1000000000000000001`, // 1.000000000000000001, also a managed wallet's owner
      `${MANAGED},2500000000000000000`, // send_to A(1)
      `${SECOND},3`, // send_to OWNER
      `${KEPT},4`, // send_to OWNER too
    ].join("\n"),
  );
  const result = buildAirdrop({
    rows,
    remap: parseRemap({
      [MANAGED]: { send_to: A(1), kind: "remap" },
      [SECOND]: { send_to: OWNER, kind: "remap" },
      [KEPT]: { send_to: OWNER.toUpperCase().replace("0X", "0x"), kind: "remap" },
    }),
    snapshotBlock: 1,
    batchSize: 1,
  });
  assert.equal(result.summary.holders, 4);
  assert.equal(result.summary.recipients, 2);
  assert.deepEqual(result.batches.map((b) => b.lines), [[`${A(1)} 3.500000000000000001`], [`${OWNER} 0.000000000000000007`]]);
  assert.equal(result.batches.reduce((sum, b) => sum + b.totalWei, 0n), result.includedWei);
  assert.equal(result.includedWei, 3500000000000000008n);
  // Every holder still has its own exact public amount, and points at the merged line's batch.
  const holders = Object.fromEntries(result.publicDocument.holders.map((h) => [h.address, h]));
  assert.deepEqual(holders[A(1)], { address: A(1), amountWei: "1000000000000000001", batch: 1 });
  assert.equal(holders[MANAGED].remapped, true);
  assert.deepEqual(result.publicDocument.batches.map((b) => [b.recipients, b.totalWei]), [[1, "3500000000000000001"], [1, "7"]]);
  const sent = buildAirdrop({ rows, remap: parseRemap({ [MANAGED]: { send_to: A(1) } }), snapshotBlock: 1, batchSize: 1, sentTxs: { 1: HASH } });
  assert.equal(sent.publicDocument.holders.find((h) => h.address === MANAGED).sent, true);
});

test("the max total guard refuses an airdrop larger than the wallet's allocation", () => {
  const rows = parseSnapshotCsv(`address,balance_wei\n${A(1)},600\n${A(2)},400`);
  assert.equal(buildAirdrop({ rows, snapshotBlock: 1, maxTotalWei: 1000n }).includedWei, 1000n);
  assert.throws(() => buildAirdrop({ rows, snapshotBlock: 1, maxTotalWei: 999n }), (error) => error instanceof InputError && /more than the airdrop wallet's allocation/.test(error.message));
  assert.throws(() => buildAirdrop({ rows, snapshotBlock: 1, maxTotalWei: 0n }), /positive/);
  // Excluded wallets do not count against the allocation.
  assert.equal(buildAirdrop({ rows, exclusions: parseExclusions({ [A(1)]: "Pool" }), snapshotBlock: 1, maxTotalWei: 400n }).includedWei, 400n);
});

test("main enforces --max-total-wei and --max-total-tokens before writing anything", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-airdrop-max-"));
  const snapshot = path.join(dir, "snapshot.csv");
  writeFileSync(snapshot, `address,balance_wei\n${A(1)},1500000000000000000\n${A(2)},1`);
  const publicJson = path.join(dir, "public.json");
  const batchesDir = path.join(dir, "batches");
  const base = ["--snapshot", snapshot, "--snapshot-block", "1", "--public-json", publicJson, "--batches-dir", batchesDir];
  const errors = [];
  const logs = [];
  const io = { log: (line) => logs.push(line), error: (line) => errors.push(line) };
  const repo = path.join(dir, "repo");

  assert.equal(main([...base, "--max-total-tokens", "1.5"], io, repo), 2);
  assert.match(errors.join("\n"), /more than the airdrop wallet's allocation 1\.5 HIVRA/);
  assert.throws(() => readdirSync(batchesDir), /ENOENT/, "nothing is written when the guard refuses");
  assert.equal(main([...base, "--max-total-wei", "1500000000000000000"], io, repo), 2);

  assert.equal(main([...base, "--max-total-wei", "1500000000000000001"], io, repo), 0);
  assert.equal(main([...base, "--max-total-tokens", "1.500000000000000001"], io, repo), 0);
  assert.match(logs.join("\n"), /within the airdrop wallet's allocation of 1\.500000000000000001 HIVRA/);

  errors.length = 0;
  assert.equal(main([...base, "--max-total-wei", "1", "--max-total-tokens", "1"], io, repo), 2);
  assert.match(errors.join("\n"), /not both/);
  assert.equal(main([...base, "--max-total-wei", "1.5"], io, repo), 2);
  assert.equal(main([...base, "--max-total-tokens", "0"], io, repo), 2);
  assert.equal(main([...base, "--max-total-tokens", "1e9"], io, repo), 2);
});

test("the batch check fails when a destination appears on two lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-airdrop-dup-"));
  writeFileSync(path.join(dir, "hivra-airdrop-batch-001.txt"), `${A(1)} 1\n`);
  writeFileSync(path.join(dir, "hivra-airdrop-batch-002.txt"), `${A(1).toUpperCase().replace("0X", "0x")} 1\n`);
  const check = checkBatchFiles(dir, 2n * 10n ** 18n, 2);
  assert.equal(check.duplicates, 1);
  assert.equal(check.ok, false);
});
