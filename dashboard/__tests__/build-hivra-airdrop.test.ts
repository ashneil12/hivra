/** @jest-environment node */
/**
 * The claim generator (scripts/token/build-hivra-airdrop.mjs) is an ES module
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

  function run(extra: string[]) {
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
    const publicJson = join(dir, "out", "hivra-airdrop.json");
    const sablierCsv = join(dir, "private", "sablier.csv");
    const stdout = execFileSync(process.execPath, [
      SCRIPT,
      "--snapshot", join(dir, "snapshot.csv"),
      "--snapshot-block", "36000000",
      "--exclusions", join(dir, "exclusions.json"),
      "--remap", join(dir, "remap.json"),
      "--public-json", publicJson,
      "--sablier-csv", sablierCsv,
      ...extra,
    ], { encoding: "utf8", timeout: 30_000 });
    return { dir, publicJson, sablierCsv, stdout };
  }

  it("writes a list the /token/airdrop lookup accepts and answers from, plus the Sablier file", () => {
    const { publicJson, sablierCsv, stdout } = run(["--final"]);
    expect(stdout).toMatch(/totals check passed/);
    expect(stdout).toMatch(/public list is FINAL/);
    expect(readFileSync(sablierCsv, "utf8")).toBe([
      "address,amount",
      `${A(2)},250.000000000000000001`,
      `${OWNER},3`,
      `${A(1)},1`,
      `${A(3)},0.000000000000000042`,
      "",
    ].join("\n"));

    const text = readFileSync(publicJson, "utf8");
    expect(text).not.toContain(OWNER.slice(2));
    const parsed = parseHivraAirdropData(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    const airdrop = parsed.airdrop;
    expect(airdrop.data.snapshotBlock).toBe(36000000);
    expect(airdrop.data.final).toBe(true);
    expect(airdrop.data.totals.holders).toBe(4);
    expect(lookupHivraAirdrop(airdrop, A(2).toUpperCase().replace("0X", "0x"))).toEqual({
      kind: "holder", address: A(2), amountWei: "250000000000000000001",
    });
    expect(lookupHivraAirdrop(airdrop, A(1))).toEqual({ kind: "holder", address: A(1), amountWei: "1000000000000000000" });
    expect(lookupHivraAirdrop(airdrop, A(0xa1))).toEqual({ kind: "managed", address: A(0xa1), amountWei: "3000000000000000000" });
    expect(lookupHivraAirdrop(airdrop, A(0xbeef))).toEqual({ kind: "excluded", address: A(0xbeef), label: "Uniswap pool" });
    expect(lookupHivraAirdrop(airdrop, OWNER)).toEqual({ kind: "absent", address: OWNER });
  }, 60_000);

  it("writes a dry-run list (final: false) unless --final is given, and the page parser reads it as not final", () => {
    const { dir, publicJson } = run([]);
    const parsed = parseHivraAirdropData(JSON.parse(readFileSync(publicJson, "utf8")));
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    expect(parsed.airdrop.data.final).toBe(false);
    expect(readdirSync(join(dir, "private"))).toEqual(["sablier.csv"]);
  }, 60_000);
});
