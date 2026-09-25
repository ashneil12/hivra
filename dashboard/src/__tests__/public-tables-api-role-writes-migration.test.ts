/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("closes every public-table write path for the API roles and keeps the service role in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-public-tables-api-role-writes.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS public tables API role writes");
}, 50_000);
