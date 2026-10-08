import { execFileSync } from "node:child_process";
import path from "node:path";

it("enforces the desktop resize floor on quote, claim and first dispatch in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-desktop-resize-floor.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS desktop resize floor: quote/claim/first-dispatch enforcement, historical cancellation, explicit profile and agent compatibility");
}, 95_000);
