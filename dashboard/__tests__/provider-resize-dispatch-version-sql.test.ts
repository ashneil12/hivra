import { execFileSync } from "node:child_process";
import path from "node:path";

it("keeps an old deployment's resize dispatch inert and the compatible entry one-use", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-resize-dispatch-version.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: old deployment dispatch is inert; compatible entry retains the original one-use body and ACL boundary");
}, 95_000);
