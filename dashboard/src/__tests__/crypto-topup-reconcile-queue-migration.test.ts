/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the crypto top-up reconcile-queue migration (twice) on the real schema in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-crypto-topup-reconcile-queue.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS crypto top-up reconcile queue");
}, 50_000);
