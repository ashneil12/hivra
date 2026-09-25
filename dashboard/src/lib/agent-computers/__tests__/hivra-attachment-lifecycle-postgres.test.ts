/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("runs the attach lifecycle on every real migration: intent v2, plan limit, complete, fail, access, remove, delete and grants (T3, T20, T25, T30, T35)", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../../../scripts/test-hivra-attachment-lifecycle.cjs")],
    { encoding: "utf8", timeout: 170_000 },
  );
  expect(output).toContain("PASS hivra attachment lifecycle");
}, 180_000);
