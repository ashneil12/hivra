import { spawnSync } from "node:child_process";
import path from "node:path";

it("keeps guest preparation separate from managed activation", () => {
  const result = spawnSync("python3", ["-B", path.join(process.cwd(), "scripts/test-desktop-guest-phases.py")], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Desktop phase regressions failed: ${result.error?.message ?? result.stderr}`);
  }
  expect(result.stderr).toContain("OK");
});
