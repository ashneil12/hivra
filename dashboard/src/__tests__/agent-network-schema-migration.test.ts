/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the agent-network identity and policy schema twice and holds its tenancy, attenuation, audit and privilege guarantees", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-agent-network-schema.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS agent network identity and policy schema");
}, 100_000);
