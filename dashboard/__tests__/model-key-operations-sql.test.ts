import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("journals and settles model keys with real guest receipts and PostgreSQL lifecycle fences", () => {
  // Two genuine 20-second DB-clock lease expirations; no fake timestamp writes.
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-model-key-operations.cjs")],
    { encoding: "utf8", timeout: 70_000 });
  expect(output).toContain("PASS model key admission:");
  expect(output).toContain("PASS model key settlement:");
  expect(output).toContain("PASS model key history:");
  expect(output).toContain("PASS model key lifecycle:");
  expect(output).toContain("PASS model key SQL:");
}, 75_000);
