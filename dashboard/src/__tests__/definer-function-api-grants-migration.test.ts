/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("closes the balance guards and service-role RPCs to the API roles in isolated PostgreSQL", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-definer-function-api-grants.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS definer function API grants");
}, 50_000);
