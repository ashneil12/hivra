/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the yearly payment-attribution migration (twice) and settles payments in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-yearly-token-payment-settlement.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS yearly token payment settlement");
}, 50_000);
