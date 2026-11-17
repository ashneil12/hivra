import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("reserves, power-controls and retires provider computers through the existing lifecycle SQL", () => {
  // Two real-clock dispatch expiry regressions each wait 45 seconds. Keep a bounded
  // allowance for PostgreSQL startup and the rest of the ownership harness.
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-provider-computer-ownership.cjs")],
    { encoding: "utf8", timeout: 120_000 });
  expect(output).toContain("PASS provider preparation SQL:");
  expect(output).toContain("PASS provider native SQL:");
  expect(output).toContain("PASS provider native adapter SQL:");
  expect(output).toContain("PASS provider native deletion SQL:");
  expect(output).toContain("PASS provider power SQL:");
  expect(output).toContain("PASS provider computer ownership SQL:");
}, 125_000);
