/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("closes hermes_instances writes to the API roles and keeps the service role in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hermes-instances-api-role-writes.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS hermes_instances API role writes");
}, 50_000);
