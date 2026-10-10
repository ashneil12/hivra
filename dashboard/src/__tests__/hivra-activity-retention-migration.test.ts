/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the Hivra activity retention migration (twice) and proves its deletion semantics in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-activity-retention.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hivra activity retention");
}, 50_000);
