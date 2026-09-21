/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("executes the original-resource receipt migration and existing progress gate in PostgreSQL", () => {
  const output = execFileSync(process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hetzner-creation-receipt.cjs")],
    { encoding: "utf8", timeout: 45_000 });
  expect(output).toContain("PASS: Hetzner immutable original receipts");
}, 50_000);
