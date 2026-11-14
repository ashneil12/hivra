/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("sums usage per person and agent type and keeps the type of deleted agents", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-usage-by-user-and-type.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS usage by user and type");
}, 95_000);
