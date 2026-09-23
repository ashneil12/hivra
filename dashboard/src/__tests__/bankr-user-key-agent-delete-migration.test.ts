/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("drops user-connected Bankr keys, and only those, when an agent in either lane is deleted", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-bankr-user-key-agent-delete.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS bankr user key dropped on agent delete");
}, 50_000);
