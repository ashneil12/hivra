import { spawnSync } from "node:child_process";

describe("private provider desktop cleanup SQL", () => {
  it("executes the actual migration and observation functions in isolated PostgreSQL", () => {
    const result = spawnSync(process.execPath, ["scripts/test-provider-desktop-cleanup-sql.cjs"], {
      encoding: "utf8", timeout: 30_000,
      env: {PATH: "/usr/bin:/bin", NODE_ENV: "test"},
    });
    expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
    expect(result.stdout).toContain("PASS desktop cleanup SQL:");
  });
  it("enforces desktop dispatch and cleanup handoff with the real prior lifecycle migrations", () => {
    const result = spawnSync(process.execPath, ["scripts/test-provider-computer-ownership.cjs", "--desktop-only"], {
      encoding: "utf8", timeout: 30_000,
      env: {PATH: "/usr/bin:/bin", NODE_ENV: "test"},
    });
    expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
    expect(result.stdout).toContain("PASS desktop lifecycle SQL:");
  });
});
