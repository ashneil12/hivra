import { execFileSync } from "node:child_process";
import path from "node:path";

it("keeps the nested desktop clickable and reports changed/timeout outcomes in Chromium", () => {
  const output = execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts/test-remote-desktop-handoff-browser.cjs"),
  ], { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS remote desktop browser handoff");
}, 35_000);
