import { execFileSync } from "node:child_process";
import path from "node:path";

it("guards the resize shutdown marker, receipt and RPC permissions in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-resize-shutdown.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: PostgreSQL shutdown marker, exact receipt, terminal evidence and RPC permission boundary");
}, 95_000);
