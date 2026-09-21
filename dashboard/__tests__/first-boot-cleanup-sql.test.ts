import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("requires all first-boot resources to be absent before capacity cleanup completes", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-first-boot-cleanup.cjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS first-boot cleanup SQL:");
}, 35_000);
