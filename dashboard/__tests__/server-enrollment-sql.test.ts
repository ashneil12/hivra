import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("enforces server enrollment issue, report, Yes, Replace, receipts and retention in actual SQL", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-server-enrollment.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS server enrollment actual SQL: 13 groups");
}, 95_000);
