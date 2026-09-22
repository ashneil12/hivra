/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("resolves the stale-state reset's yearly tier by rank, not newest payment, in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-reconcile-stale-subscription-yearly-tier.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS reconcile stale subscription yearly tier");
}, 50_000);
