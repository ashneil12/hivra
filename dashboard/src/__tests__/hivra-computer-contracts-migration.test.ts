/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("stores Computer Contract revisions service-only, with a receipt for every delivery, and marks Hivra's setup note", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-computer-contracts.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hivra computer contracts");
}, 50_000);
