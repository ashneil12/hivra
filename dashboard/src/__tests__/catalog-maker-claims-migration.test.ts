/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("keeps maker claims in shape and counts use per agent type", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-catalog-maker-claims.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS catalog maker claims");
}, 95_000);
