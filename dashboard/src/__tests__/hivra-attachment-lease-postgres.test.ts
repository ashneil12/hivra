import { execFileSync } from "node:child_process";
import path from "node:path";

it("reserves the actual legacy lifecycle slot for a private attachment command", () => {
  const output = execFileSync(process.execPath, [path.resolve(process.cwd(), "scripts/test-hivra-attachment-lease.cjs")],
    { encoding: "utf8", timeout: 15_000 });
  expect(output).toContain("PASS attachment admission shares legacy lease");
});
