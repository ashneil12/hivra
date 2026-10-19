/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("stores agent software observations service-only, with closed values, a 20-hour claim per target and cascade on delete", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-agent-cli-updates.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hivra agent cli updates");
}, 50_000);
