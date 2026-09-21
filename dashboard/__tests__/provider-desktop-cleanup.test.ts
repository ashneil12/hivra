import { spawnSync } from "node:child_process";
import path from "node:path";

it("verifies retained desktop recovery without guest mutation", () => {
  const result = spawnSync("python3", ["-B", path.join(process.cwd(), "scripts/test-provider-desktop-cleanup.py")], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Desktop cleanup regressions failed: ${result.error?.message ?? result.stderr}`);
  }
  expect(result.stderr).toContain("OK");
});
