/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("keeps the computer usage cache service-only with a single-flight claim on the database clock, in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-computer-usage-cache.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hivra computer usage cache");
}, 50_000);
