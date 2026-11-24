/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("preserves token holder access and billing records when a member switches in PostgreSQL", () => {
  const output = execFileSync(process.execPath, [
    path.resolve(__dirname, "../../scripts/test-optional-holder-switch.cjs"),
  ], { encoding: "utf8", timeout: 60_000 });
  expect(output).toContain("PASS optional holder switch");
}, 70_000);
