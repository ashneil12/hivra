/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("stores agent activity readings and counts in-use hours once", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-agent-activity-samples.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS agent activity samples");
}, 95_000);
