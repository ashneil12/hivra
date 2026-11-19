/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("claims and releases sleep and wake leases without touching status", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-agent-sleep-wake.cjs")],
    { encoding: "utf8", timeout: 120_000 }
  );
  expect(output).toContain("PASS agent sleep and wake leases");
}, 125_000);
