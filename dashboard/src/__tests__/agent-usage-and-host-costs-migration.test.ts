/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("remembers each managed key's agent, records server costs and counts active hours per agent", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-agent-usage-and-host-costs.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS agent usage and host costs");
}, 95_000);
