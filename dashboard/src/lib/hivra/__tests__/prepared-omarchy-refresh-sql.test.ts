import { spawnSync } from "node:child_process";
import path from "node:path";
jest.setTimeout(90_000);
it("executes reservation, race, readiness, failure and cancellation SQL against PostgreSQL", () => {
  const result = spawnSync(process.execPath, ["--test", path.join(process.cwd(), "scripts/test-prepared-omarchy-refresh-sql.mjs")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 80_000, maxBuffer: 2_000_000 });
  expect({ status: result.status, stderr: result.stderr, output: result.stdout }).toEqual({
    status: 0, stderr: "", output: expect.stringContaining("# pass 8"),
  });
});
