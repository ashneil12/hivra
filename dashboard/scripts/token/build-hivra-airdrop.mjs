#!/usr/bin/env node
/**
 * Build the $HermesOS -> $HIVRA holder claim from a balance snapshot.
 *
 * Eligible holders start the claim themselves on Sablier and pay the claim fee:
 * nothing is pushed to a wallet. The Airdrop wallet creates an instant Sablier
 * airdrop campaign from the file this script writes (--sablier-csv). The
 * Disperse batch files (--batches-dir) are an OPTIONAL manual tool, only for any
 * wallet that cannot claim.
 *
 * READ-ONLY and offline: it reads local files, writes local files, and touches
 * no network, chain, database or service. It signs nothing and sends nothing.
 *
 * Inputs
 *   --snapshot <csv>        the snapshot: a header row with `address` and
 *                           `balance_wei` (other columns are ignored), one row
 *                           per $HermesOS holder at the snapshot block.
 *   --snapshot-block <n>    the Base block the snapshot was taken at.
 *   --exclusions <json>     optional {"0xaddress": "public reason"}: wallets that
 *                           get nothing (pools, launch contracts, the team's own
 *                           wallet). The reason is PUBLISHED, so keep it short and
 *                           never put a person's name, email or user id in it.
 *   --remap <json>          optional, PRIVATE, never committed:
 *                           {"0xaddress": {"send_to": "0x...", "kind": "..."}}.
 *                           A Hivra-managed wallet cannot connect to Sablier, so
 *                           its allocation goes to its owner's own wallet. When
 *                           send_to is the same address (or kind is "keep") it is
 *                           an ordinary holder. Only send_to and kind are read;
 *                           any other field is ignored.
 *   --max-total-wei <n>     optional guard: the Airdrop wallet's $HIVRA allocation,
 *                           in wei. When given, the run refuses (exit 2, no files
 *                           written) if the included total is larger. Always give
 *                           one of the two guards on a --final run.
 *   --max-total-tokens <n>  the same guard in whole $HIVRA ("2500000000" or
 *                           "2500000000.5"); give one of the two, not both.
 *   --final                 mark the public list as the verified final list
 *                           (`final: true`). /token/airdrop shows the eligible
 *                           wallet count, the total allocated and the percentage of
 *                           supply ONLY for a final list; a run without it writes
 *                           `final: false`, and its counts are never shown.
 *   --batch-size <n>        recipients per Disperse batch (default 300), only
 *                           used with --batches-dir.
 *
 * Outputs (give --public-json and at least one of the other two)
 *   --public-json <path>    the public list the /token/airdrop lookup reads
 *                           (dashboard/src/data/token/hivra-airdrop.json): the
 *                           snapshot block, `final`, totals, every included holder
 *                           with the exact amount, excluded wallets with their
 *                           reason, and Hivra-managed wallets flagged WITHOUT
 *                           their destination. No batch, transaction or "sent"
 *                           state: nothing is sent.
 *   --sablier-csv <path>    PRIVATE: the Sablier upload file. Header
 *                           "address,amount", then one line per eligible wallet,
 *                           the amount in whole $HIVRA token units, exact to the
 *                           wei (no float). Managed wallets appear under their
 *                           send_to address, so this file must be outside the
 *                           repository. Each destination gets ONE line: when a
 *                           send_to equals another holder's address (or two managed
 *                           wallets share an owner), their amounts are added
 *                           together exactly.
 *   --batches-dir <dir>     PRIVATE, OPTIONAL: one disperse.app text file per batch,
 *                           lines "address amount" in whole $HIVRA, exact to the
 *                           wei, with the same one-line-per-destination merge. Must
 *                           be outside the repository.
 *
 * Every amount is BigInt arithmetic on wei: there is no float anywhere. The
 * check at the end reads each written file back, and fails unless its sum
 * equals the included total exactly, in wei, with one line per destination.
 *
 * Usage (from dashboard/):
 *   node scripts/token/build-hivra-airdrop.mjs --snapshot ~/airdrop/snapshot.csv \
 *     --snapshot-block 52826055 --exclusions ~/airdrop/exclusions.json \
 *     --remap ~/airdrop/remap.json --max-total-tokens <allocation> [--final] \
 *     --public-json src/data/token/hivra-airdrop.json \
 *     --sablier-csv ~/airdrop/sablier.csv [--batches-dir ~/airdrop/batches]
 *
 * Exit code: 0 when the totals check passes, 1 when it fails, 2 on bad input or usage.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DECIMALS = 18;
export const WEI_PER_TOKEN = 10n ** BigInt(DECIMALS);
/** $HIVRA total supply: 100B tokens, 18 decimals. */
export const HIVRA_TOTAL_SUPPLY_WEI = 100_000_000_000n * WEI_PER_TOKEN;
export const DEFAULT_BATCH_SIZE = 300;
/** Version 2: the Sablier claim list. No batches, no per-holder batch or sent state, plus `final`. */
export const PUBLIC_DATA_VERSION = 2;
/** The Sablier upload file's header row. */
export const SABLIER_CSV_HEADER = "address,amount";
/** The legacy $HermesOS contract (token-registry.ts). */
export const HERMESOS_ADDRESS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BATCH_FILE = /^hivra-airdrop-batch-\d{3,}\.txt$/;
const SABLIER_LINE = /^(0x[0-9a-fA-F]{40}),(\d+(?:\.\d{1,18})?)$/;
/** A published exclusion reason must not look like an email or a Clerk user id. */
const PRIVATE_LOOKING = /@|\buser_[A-Za-z0-9]/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export class InputError extends Error {}

function fail(message) {
  throw new InputError(message);
}

function normalizeAddress(raw, what) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!ADDRESS.test(value)) fail(`${what}: "${raw}" is not a 0x-prefixed 20-byte address`);
  return value.toLowerCase();
}

/** Exact decimal text for a wei amount: "1234.5", "0.000000000000000001", "7". */
export function weiToDecimal(wei) {
  if (typeof wei !== "bigint" || wei < 0n) throw new TypeError("weiToDecimal expects a non-negative bigint");
  const whole = wei / WEI_PER_TOKEN;
  const fraction = (wei % WEI_PER_TOKEN).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The inverse of weiToDecimal, exact; rejects more than 18 decimals. */
export function decimalToWei(text) {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!match) throw new InputError(`"${text}" is not a whole-token decimal with at most ${DECIMALS} decimals`);
  return BigInt(match[1]) * WEI_PER_TOKEN + BigInt((match[2] ?? "").padEnd(DECIMALS, "0"));
}

/** Share of the 100B supply, in percent, rounded UP to 2 decimals: "1.24". */
export function percentOfSupplyCeil(wei, supply = HIVRA_TOTAL_SUPPLY_WEI) {
  const scaled = wei * 10_000n; // percent with 2 decimals = wei * 100 * 100 / supply
  const hundredths = scaled / supply + (scaled % supply === 0n ? 0n : 1n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

function splitCsvLine(line) {
  return line.split(",").map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim());
}

/** Rows of {address, balanceWei} from the snapshot CSV; duplicates and bad values are errors. */
export function parseSnapshotCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex < 0) fail("snapshot: the file is empty");
  const header = splitCsvLine(lines[headerIndex]).map((cell) => cell.toLowerCase());
  const addressColumn = header.indexOf("address");
  const balanceColumn = header.indexOf("balance_wei");
  if (addressColumn < 0 || balanceColumn < 0) fail("snapshot: the header must name `address` and `balance_wei` columns");
  const rows = [];
  const seen = new Set();
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    const cells = splitCsvLine(lines[index]);
    const where = `snapshot line ${index + 1}`;
    const address = normalizeAddress(cells[addressColumn], where);
    const balance = cells[balanceColumn] ?? "";
    if (!/^\d+$/.test(balance)) fail(`${where}: balance_wei "${balance}" is not a whole number of wei`);
    if (seen.has(address)) fail(`${where}: ${address} appears twice`);
    seen.add(address);
    rows.push({ address, balanceWei: BigInt(balance) });
  }
  if (rows.length === 0) fail("snapshot: no holder rows");
  return rows;
}

/** {address: label} with lower-cased keys; labels are published, so they are checked. */
export function parseExclusions(raw) {
  if (raw === undefined || raw === null) return new Map();
  if (typeof raw !== "object" || Array.isArray(raw)) fail("exclusions: expected a JSON object {address: label}");
  const exclusions = new Map();
  for (const [key, label] of Object.entries(raw)) {
    const address = normalizeAddress(key, "exclusions");
    if (typeof label !== "string" || !label.trim()) fail(`exclusions: ${address} needs a non-empty label`);
    const text = label.trim();
    if (text.length > 120) fail(`exclusions: the label for ${address} is longer than 120 characters`);
    if (PRIVATE_LOOKING.test(text)) fail(`exclusions: the label for ${address} looks like an email or user id; labels are public`);
    if (exclusions.has(address)) fail(`exclusions: ${address} is listed twice`);
    exclusions.set(address, text);
  }
  return exclusions;
}

/** {address: {sendTo, kind}} with lower-cased keys. Only send_to and kind are read. */
export function parseRemap(raw) {
  if (raw === undefined || raw === null) return new Map();
  if (typeof raw !== "object" || Array.isArray(raw)) fail("remap: expected a JSON object {address: {send_to, kind}}");
  const remap = new Map();
  for (const [key, entry] of Object.entries(raw)) {
    const address = normalizeAddress(key, "remap");
    if (!entry || typeof entry !== "object") fail(`remap: ${address} needs {send_to, kind}`);
    const sendTo = normalizeAddress(entry.send_to, `remap ${address} send_to`);
    if (sendTo === ZERO_ADDRESS || sendTo === HERMESOS_ADDRESS) fail(`remap: ${address} send_to is not a wallet`);
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    if (remap.has(address)) fail(`remap: ${address} is listed twice`);
    remap.set(address, { sendTo, kind });
  }
  return remap;
}

/**
 * The whole claim list from parsed inputs. Pure: returns the public document,
 * the Sablier upload file and the optional Disperse batches (with the real
 * recipients) and warnings; writes nothing.
 */
export function buildAirdrop({ rows, exclusions = new Map(), remap = new Map(), snapshotBlock, batchSize = DEFAULT_BATCH_SIZE, maxTotalWei, final = false }) {
  if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock <= 0) fail("snapshot block must be a positive whole number");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) fail("batch size must be a positive whole number");
  if (maxTotalWei !== undefined && (typeof maxTotalWei !== "bigint" || maxTotalWei <= 0n)) fail("max total must be a positive whole number of wei");
  if (typeof final !== "boolean") fail("final must be true or false");
  const warnings = [];
  const inSnapshot = new Set(rows.map((row) => row.address));
  for (const address of exclusions.keys()) {
    if (!inSnapshot.has(address)) warnings.push(`exclusion ${address} is not in the snapshot; it is left out of the public list`);
  }
  for (const address of remap.keys()) {
    if (exclusions.has(address)) fail(`${address} is both excluded and remapped; pick one`);
    if (!inSnapshot.has(address)) warnings.push(`remap ${address} is not in the snapshot; it is ignored`);
  }

  const included = [];
  const excluded = [];
  let includedWei = 0n;
  let excludedWei = 0n;
  let zeroBalance = 0;
  for (const row of rows) {
    if (exclusions.has(row.address)) {
      if (row.balanceWei > 0n) {
        excluded.push({ address: row.address, label: exclusions.get(row.address) });
        excludedWei += row.balanceWei;
      }
      continue;
    }
    if (row.balanceWei === 0n) {
      zeroBalance += 1;
      continue;
    }
    if (row.address === ZERO_ADDRESS || row.address === HERMESOS_ADDRESS) {
      fail(`${row.address} holds $HermesOS in the snapshot but is not a wallet; add it to the exclusions`);
    }
    const entry = remap.get(row.address);
    const remapped = Boolean(entry && entry.sendTo !== row.address && entry.kind.toLowerCase() !== "keep");
    included.push({ address: row.address, amountWei: row.balanceWei, sendTo: remapped ? entry.sendTo : row.address, remapped });
    includedWei += row.balanceWei;
  }
  if (included.length === 0) fail("no holder is left after the exclusions");
  if (maxTotalWei !== undefined && includedWei > maxTotalWei) {
    fail(
      `the included total ${weiToDecimal(includedWei)} HIVRA (${includedWei} wei) is more than the airdrop wallet's ` +
        `allocation ${weiToDecimal(maxTotalWei)} HIVRA (${maxTotalWei} wei); check the snapshot and exclusions`,
    );
  }

  // Largest first, then by address/destination: the same inputs always give the same files.
  const byAmountThen = (key) => (a, b) => (a.amountWei === b.amountWei ? (a[key] < b[key] ? -1 : 1) : a.amountWei > b.amountWei ? -1 : 1);
  included.sort(byAmountThen("address"));
  excluded.sort((a, b) => (a.address < b.address ? -1 : 1));

  // One line per destination: a managed wallet whose send_to is another holder
  // (or shares an owner with another managed wallet) is added to that line.
  const recipientsByDestination = new Map();
  for (const member of included) {
    const recipient = recipientsByDestination.get(member.sendTo) ?? { sendTo: member.sendTo, amountWei: 0n, members: [] };
    recipient.amountWei += member.amountWei;
    recipient.members.push(member);
    recipientsByDestination.set(member.sendTo, recipient);
  }
  const recipients = [...recipientsByDestination.values()].sort(byAmountThen("sendTo"));

  // The Sablier upload file: the primary output.
  const sablierLines = recipients.map((recipient) => `${recipient.sendTo},${weiToDecimal(recipient.amountWei)}`);
  const sablierCsv = `${[SABLIER_CSV_HEADER, ...sablierLines].join("\n")}\n`;

  // The optional Disperse batches, for any wallet that cannot claim.
  const batches = [];
  for (let start = 0; start < recipients.length; start += batchSize) {
    const slice = recipients.slice(start, start + batchSize);
    batches.push({
      index: batches.length + 1,
      lines: slice.map((recipient) => `${recipient.sendTo} ${weiToDecimal(recipient.amountWei)}`),
      totalWei: slice.reduce((sum, recipient) => sum + recipient.amountWei, 0n),
    });
  }

  const publicDocument = {
    version: PUBLIC_DATA_VERSION,
    final,
    snapshotBlock,
    decimals: DECIMALS,
    ratio: "1:1",
    totals: {
      holders: included.length,
      includedWei: includedWei.toString(),
      excludedWallets: excluded.length,
      excludedWei: excludedWei.toString(),
      percentOfSupply: percentOfSupplyCeil(includedWei),
    },
    // A managed wallet is flagged and carries no destination: the owner's wallet is private.
    holders: included.map((member) =>
      member.remapped
        ? { address: member.address, amountWei: member.amountWei.toString(), remapped: true }
        : { address: member.address, amountWei: member.amountWei.toString() },
    ),
    excluded,
  };
  return {
    publicDocument,
    sablierCsv,
    sablierLines: sablierLines.length,
    batches,
    includedWei,
    summary: {
      holders: included.length,
      recipients: recipients.length,
      remapped: included.filter((member) => member.remapped).length,
      excluded: excluded.length,
      zeroBalance,
      batches: batches.length,
    },
    warnings,
  };
}

/**
 * Reads the written Sablier file back and checks it against the included total,
 * in wei, the expected number of lines, the exact header, and one line per
 * destination.
 */
export function checkSablierCsv(file, expectedWei, expectedLines) {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[0] !== SABLIER_CSV_HEADER) throw new InputError(`${path.basename(file)}: the header must be exactly "${SABLIER_CSV_HEADER}"`);
  let total = 0n;
  let count = 0;
  const destinations = new Set();
  let duplicates = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const match = SABLIER_LINE.exec(line);
    if (!match) throw new InputError(`${path.basename(file)}: malformed line "${line}"`);
    total += decimalToWei(match[2]);
    count += 1;
    const destination = match[1].toLowerCase();
    if (destinations.has(destination)) duplicates += 1;
    destinations.add(destination);
  }
  return { ok: total === expectedWei && count === expectedLines && duplicates === 0, totalWei: total, lines: count, duplicates };
}

/**
 * Reads the written Disperse batch files back and checks them against the
 * included total, in wei, the expected number of lines, and one line per
 * destination.
 */
export function checkBatchFiles(batchesDir, expectedWei, expectedLines) {
  let total = 0n;
  let lines = 0;
  const destinations = new Set();
  let duplicates = 0;
  const files = readdirSync(batchesDir).filter((name) => BATCH_FILE.test(name)).sort();
  for (const name of files) {
    for (const line of readFileSync(path.join(batchesDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [address, amount, extra] = line.trim().split(/\s+/);
      if (extra !== undefined || !ADDRESS.test(address ?? "")) throw new InputError(`${name}: malformed line "${line}"`);
      total += decimalToWei(amount ?? "");
      lines += 1;
      const destination = address.toLowerCase();
      if (destinations.has(destination)) duplicates += 1;
      destinations.add(destination);
    }
  }
  return { ok: total === expectedWei && lines === expectedLines && duplicates === 0, totalWei: total, lines, duplicates, files: files.length };
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path, resolving symlinks through the nearest existing ancestor when the target does not exist yet. */
function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realOrResolved(parent), path.basename(resolved));
  }
}

const OPTION_NAMES = {
  "--snapshot": "snapshot",
  "--snapshot-block": "snapshotBlock",
  "--exclusions": "exclusions",
  "--remap": "remap",
  "--batch-size": "batchSize",
  "--public-json": "publicJson",
  "--sablier-csv": "sablierCsv",
  "--batches-dir": "batchesDir",
  "--max-total-wei": "maxTotalWei",
  "--max-total-tokens": "maxTotalTokens",
};
/** Options that take no value. */
const FLAG_NAMES = { "--final": "final" };

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function parseArgs(argv) {
  const args = { batchSize: DEFAULT_BATCH_SIZE, final: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = FLAG_NAMES[argv[index]];
    if (flag) {
      args[flag] = true;
      continue;
    }
    const key = OPTION_NAMES[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) fail(`unknown or incomplete option "${argv[index]}"`);
    args[key] = value;
    index += 1;
  }
  for (const required of ["snapshot", "snapshotBlock", "publicJson"]) {
    if (!args[required]) fail(`--${kebab(required)} is required`);
  }
  if (!args.sablierCsv && !args.batchesDir) fail("give --sablier-csv (the Sablier upload file) or --batches-dir (the optional Disperse batches)");
  for (const numeric of ["snapshotBlock", "batchSize"]) {
    const value = String(args[numeric]);
    if (!/^\d+$/.test(value)) fail(`--${kebab(numeric)} must be a positive whole number`);
    args[numeric] = Number(value);
  }
  if (args.maxTotalWei !== undefined && args.maxTotalTokens !== undefined) fail("give --max-total-wei or --max-total-tokens, not both");
  if (args.maxTotalWei !== undefined) {
    if (!/^\d+$/.test(args.maxTotalWei)) fail("--max-total-wei must be a whole number of wei");
    args.maxTotalWei = BigInt(args.maxTotalWei);
  } else if (args.maxTotalTokens !== undefined) {
    args.maxTotalWei = decimalToWei(args.maxTotalTokens);
  }
  delete args.maxTotalTokens;
  if (args.maxTotalWei !== undefined && args.maxTotalWei <= 0n) fail("the max total must be more than zero");
  return args;
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${what}: cannot read ${file} (${error.message})`);
  }
}

export function main(argv, io = { log: console.log, error: console.error }, repoRoot = REPO_ROOT) {
  try {
    const args = parseArgs(argv);
    const root = realOrResolved(repoRoot);
    // The remap names owners' own wallets and the claim and batch files carry them: none may sit in the repository.
    if (args.remap && isInside(realOrResolved(args.remap), root)) fail("--remap must be outside the repository: it is private");
    if (args.sablierCsv && isInside(realOrResolved(args.sablierCsv), root)) fail("--sablier-csv must be outside the repository: it lists private destinations");
    if (args.batchesDir && isInside(realOrResolved(args.batchesDir), root)) fail("--batches-dir must be outside the repository: the batches list private destinations");

    const result = buildAirdrop({
      rows: parseSnapshotCsv(readFileSync(args.snapshot, "utf8")),
      exclusions: parseExclusions(args.exclusions ? readJson(args.exclusions, "exclusions") : null),
      remap: parseRemap(args.remap ? readJson(args.remap, "remap") : null),
      snapshotBlock: args.snapshotBlock,
      batchSize: args.batchSize,
      maxTotalWei: args.maxTotalWei,
      final: args.final,
    });

    if (args.sablierCsv) {
      mkdirSync(path.dirname(path.resolve(args.sablierCsv)), { recursive: true });
      writeFileSync(args.sablierCsv, result.sablierCsv);
    }
    if (args.batchesDir) {
      mkdirSync(args.batchesDir, { recursive: true });
      // A re-run with a different batch size must not leave stale batch files behind.
      for (const name of readdirSync(args.batchesDir)) if (BATCH_FILE.test(name)) unlinkSync(path.join(args.batchesDir, name));
      for (const batch of result.batches) {
        const name = `hivra-airdrop-batch-${String(batch.index).padStart(3, "0")}.txt`;
        writeFileSync(path.join(args.batchesDir, name), `${batch.lines.join("\n")}\n`);
      }
    }
    mkdirSync(path.dirname(path.resolve(args.publicJson)), { recursive: true });
    writeFileSync(args.publicJson, `${JSON.stringify(result.publicDocument, null, 2)}\n`);

    for (const warning of result.warnings) io.error(`warning: ${warning}`);
    const s = result.summary;
    io.log(`snapshot block ${args.snapshotBlock}`);
    io.log(`holders ${s.holders} (Hivra-managed ${s.remapped}), excluded ${s.excluded}, zero balance skipped ${s.zeroBalance}`);
    io.log(`claim lines ${s.recipients} (${s.holders - s.recipients} merged into a shared destination)`);
    io.log(`included ${weiToDecimal(result.includedWei)} HIVRA (${result.includedWei} wei)`);
    io.log(`share of the 100B supply: ${result.publicDocument.totals.percentOfSupply}% (rounded up)`);
    io.log(args.final
      ? "public list is FINAL: /token/airdrop will show the counts"
      : "public list is a dry run (final: false): /token/airdrop will not show the counts");
    if (args.maxTotalWei !== undefined) io.log(`within the airdrop wallet's allocation of ${weiToDecimal(args.maxTotalWei)} HIVRA`);

    let ok = true;
    if (args.sablierCsv) {
      const check = checkSablierCsv(args.sablierCsv, result.includedWei, result.summary.recipients);
      io.log(`sablier  ${weiToDecimal(check.totalWei)} HIVRA (${check.totalWei} wei) in ${check.lines} lines`);
      ok = ok && check.ok;
    }
    if (args.batchesDir) {
      const check = checkBatchFiles(args.batchesDir, result.includedWei, result.summary.recipients);
      io.log(`optional Disperse batches ${s.batches} of up to ${args.batchSize}: ${weiToDecimal(check.totalWei)} HIVRA (${check.totalWei} wei) in ${check.lines} lines`);
      ok = ok && check.ok;
    }
    if (!ok) {
      io.error("TOTALS CHECK FAILED: the written files do not add up to the included total");
      return 1;
    }
    io.log("totals check passed: sum(files) == sum(included) exactly");
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      io.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realOrResolved(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
