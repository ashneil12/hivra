/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("closes the public schema to the API roles by default, pins the trigger search paths and limits hermes-attachments in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-lock-down-api-role-grants.cjs")],
    { encoding: "utf8", timeout: 150_000 }
  );
  expect(output).toContain("PASS lock down API role grants");
}, 160_000);
