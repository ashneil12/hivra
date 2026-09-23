/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("adds the $HermesOS/$HIVRA token dimension, cohort and token-scoped settlement in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-dual-platform-token-foundation.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS dual platform token foundation");
}, 70_000);
