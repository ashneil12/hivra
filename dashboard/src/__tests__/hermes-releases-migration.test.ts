/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the Hermes release registry migration (twice) in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hermes-releases.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hermes releases");
}, 50_000);
