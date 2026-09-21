import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("coordinates first-boot mutation ownership with existing cleanup and disconnect in actual SQL", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-first-boot-operations.cjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS first-boot operation SQL:");
  expect(output).toContain("PASS enrolled guest SQL:");
}, 35_000);
