import { execFileSync } from "node:child_process";
import path from "node:path";

it("keeps absent-server resize evidence and hands explicit deletion to normal cleanup in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-resize-absence.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: real resize guards retain absent-server evidence and hand explicit deletion to normal cleanup");
}, 95_000);
