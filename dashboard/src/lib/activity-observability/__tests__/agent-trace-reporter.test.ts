/** @jest-environment node */
import { spawnSync } from "node:child_process";
import os from "node:os";

// The guest reporter (provisioner/hivra-agent-trace.py) is stdlib Python. Run
// its unit tests in UTC and in a zone behind UTC so a local-time timestamp
// regression cannot hide behind a UTC CI runner.
describe.each(["UTC", "America/New_York"])("guest agent-run reporter (TZ=%s)", (zone) => {
  it("parses real transcript shapes, delivers per contract and never sends content", () => {
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "provisioner/test_hivra_agent_trace.py"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", TZ: zone, TMPDIR: os.tmpdir(), HOME: os.tmpdir(), LANG: "C.UTF-8" },
    });
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: "" });
    expect(result.stderr).toMatch(/\nOK\s*$/);
  }, 150_000);
});
