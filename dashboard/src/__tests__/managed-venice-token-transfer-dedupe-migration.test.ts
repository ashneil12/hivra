/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the managed Venice transfer-dedupe migration (twice) on the real schema in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-managed-venice-token-transfer-dedupe.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS managed Venice token transfer dedupe");
}, 50_000);
