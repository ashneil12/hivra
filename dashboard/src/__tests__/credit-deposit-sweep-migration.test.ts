/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("sweeps settled USDC top-ups exactly once against the real migrations in an isolated PostgreSQL database", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/test-credit-deposit-sweep.cjs")], {
    encoding: "utf8", timeout: 170_000,
  });
  expect(output).toContain("PASS credit-deposit sweep:");
}, 180_000);
