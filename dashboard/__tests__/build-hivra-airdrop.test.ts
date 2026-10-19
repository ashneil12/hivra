/** @jest-environment node */
/**
 * The airdrop generator (scripts/token/build-hivra-airdrop.mjs) is an ES module
 * run by Node, so its fixture tests are node:test; this runs them in the
 * dashboard suite, then feeds a real generator run to the lookup's parser so
 * the two can never drift apart.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lookupHivraAirdrop, parseHivraAirdropData } from "@/lib/claim/hivra-airdrop-lookup";

const SCRIPT = join(process.cwd(), "scripts/token/build-hivra-airdrop.mjs");
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const OWNER = A(0xf00d);
const HASH = `0x${"cd".repeat(32)}`;

describe("build-hivra-airdrop.mjs", () => {
  it("passes its fixture tests (offline)", () => {
    const output = execFileSync(process.execPath, ["--test", "scripts/token/build-hivra-airdrop.test.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output).toMatch(/# fail 0/);
    expect(output).toMatch(/# pass [1-9]\d*/);
  }, 90_000);

  it("writes a list the /token/airdrop lookup accepts and answers from", () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-airdrop-jest-"));
    writeFileSync(join(dir, "snapshot.csv"), [
      "address,balance_wei",
      `${A(1)},1000000000000000000`,
      `${A(2)},250000000000000000001`,
      `${A(3)},42`,
      `${A(0xbeef)},9000000000000000000000`,
      `${A(0xa1)},3000000000000000000`,
    ].join("\n"));
    writeFileSync(join(dir, "exclusions.json"), JSON.stringify({ [A(0xbeef)]: "Uniswap pool" }));
    writeFileSync(join(dir, "remap.json"), JSON.stringify({ [A(0xa1)]: { send_to: OWNER, kind: "remap" } }));
    writeFileSync(join(dir, "sent.json"), JSON.stringify({ 1: HASH }));
    const publicJson = join(dir, "out", "hivra-airdrop.json");
    const batchesDir = join(dir, "batches");
    const stdout = execFileSync(process.execPath, [
      SCRIPT,
      "--snapshot", join(dir, "snapshot.csv"),
      "--snapshot-block", "36000000",
      "--exclusions", join(dir, "exclusions.json"),
      "--remap", join(dir, "remap.json"),
      "--sent-txs", join(dir, "sent.json"),
      "--batch-size", "2",
      "--public-json", publicJson,
      "--batches-dir", batchesDir,
    ], { encoding: "utf8", timeout: 30_000 });
    expect(stdout).toMatch(/totals check passed/);
    expect(readdirSync(batchesDir).sort()).toEqual(["hivra-airdrop-batch-001.txt", "hivra-airdrop-batch-002.txt"]);
    expect(readFileSync(join(batchesDir, "hivra-airdrop-batch-001.txt"), "utf8")).toBe(
      `${A(2)} 250.000000000000000001\n${OWNER} 3\n`,
    );

    const text = readFileSync(publicJson, "utf8");
    expect(text).not.toContain(OWNER.slice(2));
    const parsed = parseHivraAirdropData(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    const airdrop = parsed.airdrop;
    expect(airdrop.data.snapshotBlock).toBe(36000000);
    expect(lookupHivraAirdrop(airdrop, A(2).toUpperCase().replace("0X", "0x"))).toEqual({
      kind: "holder", address: A(2), amountWei: "250000000000000000001", sentTx: HASH,
    });
    expect(lookupHivraAirdrop(airdrop, A(1))).toEqual({ kind: "holder", address: A(1), amountWei: "1000000000000000000", sentTx: null });
    expect(lookupHivraAirdrop(airdrop, A(0xa1))).toEqual({ kind: "managed", address: A(0xa1), amountWei: "3000000000000000000", sent: true });
    expect(lookupHivraAirdrop(airdrop, A(0xbeef))).toEqual({ kind: "excluded", address: A(0xbeef), label: "Uniswap pool" });
    expect(lookupHivraAirdrop(airdrop, OWNER)).toEqual({ kind: "absent", address: OWNER });
  }, 60_000);
});
