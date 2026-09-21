import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("runs the server coordinator through actual PostgreSQL custody and guest receipts", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-model-key-coordinator.cjs")],
    { encoding: "utf8", timeout: 40_000 });
  expect(output).toContain("PASS model-key coordinator integration:");
  expect(output).toContain("PASS launch model integration:");
  expect(output).toContain("PASS model-key coordinator teardown:");
}, 45_000);
