/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";
it("executes the cleanup migration and lease/state guards in PostgreSQL", () => {
  const output = execFileSync(process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hetzner-cleanup.cjs")],
    { encoding: "utf8", timeout: 45_000 });
  expect(output).toContain("PASS: Hetzner cleanup lease");
}, 50_000);
