/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("pages the holdings crons through every account with token standing and repairs deposit-wallet primaries in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-token-holding-refresh-cursor.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS token holding refresh cursor");
}, 70_000);
