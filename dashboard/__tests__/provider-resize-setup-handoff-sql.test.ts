import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("hands off only verified resize shape publication without releasing first-boot evidence", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-provider-resize-setup-handoff.mjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS provider resize/setup handoff:");
}, 35_000);
