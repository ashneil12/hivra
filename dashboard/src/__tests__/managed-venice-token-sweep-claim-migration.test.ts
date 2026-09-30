/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the managed-Venice token sweep-claim migration (twice) on the real schema in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-managed-venice-token-sweep-claim.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS managed-venice token sweep claim");
}, 50_000);
