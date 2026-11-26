/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("reconciles catalog metadata without removing rows or repurposed indexes", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-reconcile-legacy-catalog-metadata.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS legacy catalog metadata reconciliation");
}, 65_000);
