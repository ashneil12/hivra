/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("lets the agent software table hold the Aeon dashboard, OpenClaw and Agent Zero in their own version forms, and nothing else", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hivra-agent-app-updates.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hivra agent app updates");
}, 50_000);
