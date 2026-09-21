import { spawnSync } from "node:child_process";
import path from "node:path";

it("rejects desktops before legacy provider worker ownership or dispatch", () => {
  const result = spawnSync("python3", ["-I", "-B", path.join(process.cwd(), "scripts/test-provider-launch-boundary.py")], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Provider launch boundary regressions failed: ${result.error?.message ?? result.stderr}`);
  }
  expect(result.stderr).toContain("OK");
});
