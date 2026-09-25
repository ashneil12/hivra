import { execFileSync } from "node:child_process";
import path from "node:path";

it("enforces resize readiness freshness, pins, leases and the fixed deadline in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-resize-readiness.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: readiness freshness/pin/lease, fixed deadline, old handler hold and one-use shutdown boundary");
}, 95_000);
