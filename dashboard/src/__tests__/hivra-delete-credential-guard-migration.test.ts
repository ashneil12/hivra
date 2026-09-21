/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("executes the deletion credential guard and existing finalizer in an isolated PostgreSQL database", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/test-hivra-delete-credential-guard.cjs")], {
    encoding: "utf8", timeout: 45_000,
  });
  expect(output).toContain("PASS: delete credential guard");
}, 50_000);
