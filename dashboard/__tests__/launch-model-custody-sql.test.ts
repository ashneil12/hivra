import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("reserves launch intent and promotes it atomically without exposing an early active key", () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), "scripts/test-launch-model-custody.cjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS launch custody reservation:");
  expect(output).toContain("PASS launch custody promotion:");
  expect(output).toContain("PASS launch custody cancellation:");
  expect(output).toContain("PASS launch model SQL:");
}, 35_000);
