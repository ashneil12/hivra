/** @jest-environment node */
import { spawnSync } from "node:child_process";
import os from "node:os";

// The guest surface watchdog (provisioner/hivra-surface-watchdog.py) is stdlib
// Python. Its unit tests reproduce the wedged-surface incident class with
// scripted HTTP/systemctl fixtures — no real gateway or systemd is touched.
describe("guest surface watchdog", () => {
  it("probes the real path, bounds restarts, honours the update hold and reports unit failures", () => {
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "provisioner/test_hivra_surface_watchdog.py"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", TZ: "UTC", TMPDIR: os.tmpdir(), HOME: os.tmpdir(), LANG: "C.UTF-8" },
    });
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: "" });
    expect(result.stderr).toMatch(/\nOK\s*$/);
  }, 150_000);
});
