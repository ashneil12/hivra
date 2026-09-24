/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("enforces the plan's agent limit in the database for launches, reservations and attachments (T35)", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-agent-slot-limit.cjs")],
    { encoding: "utf8", timeout: 110_000 }
  );
  expect(output).toContain("PASS hivra agent slot limit");
}, 120_000);
