/** @jest-environment node */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BASE_CHAIN_ID, HERMESOS_TOKEN } from "@/lib/billing/token-registry";

const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/20260925194500_token_holding_refresh_standing_first.sql"
);

it("re-reads every account with token standing on every run, however many accounts without standing exist, in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-token-holding-refresh-standing-first.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS token holding refresh standing first");
}, 100_000);

it("reads lock-wallet standing from the registry's $HermesOS contract on Base", () => {
  // The candidates function names the token and chain getTokenVerificationWallet
  // reads the lock wallet's balance in; they must stay the registry's.
  const sql = fs.readFileSync(MIGRATION, "utf8");
  expect(sql).toContain(
    `(values (${BASE_CHAIN_ID}, '${HERMESOS_TOKEN.address}')) as hermesos(chain_id, contract)`
  );
  expect(sql).toContain("latest.token_address = hermesos.contract");
  expect(sql).toContain("latest.chain_id = hermesos.chain_id");
  expect(HERMESOS_TOKEN.address).toBe(HERMESOS_TOKEN.address.toLowerCase());
});
