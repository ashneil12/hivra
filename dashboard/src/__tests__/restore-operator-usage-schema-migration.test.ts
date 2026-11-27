/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("restores service-only operator usage without replacing existing stats routines", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-restore-operator-usage-schema.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS operator usage schema restoration");
}, 65_000);
