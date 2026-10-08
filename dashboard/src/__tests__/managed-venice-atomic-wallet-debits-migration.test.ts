/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("debits managed-Venice wallets whole or not at all, once per hold, in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-managed-venice-atomic-wallet-debits.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS managed venice atomic wallet debits");
}, 70_000);
