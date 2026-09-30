/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("swaps a Hetzner token at the same revision without revoking setup, and only when nothing holds the credential", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hetzner-token-replacement.cjs")],
    { encoding: "utf8", timeout: 45_000 },
  );
  expect(output).toContain("PASS hetzner token replacement SQL");
}, 50_000);
