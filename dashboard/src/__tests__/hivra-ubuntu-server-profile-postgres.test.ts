import { execFileSync } from "node:child_process";
import path from "node:path";

describe("ubuntu-server computer profile PostgreSQL migration", () => {
  it("allows the profile, binds it, gives it files and terminal only, and refuses a missing or duplicated anchor", () => {
    const output = execFileSync(process.execPath, [
      path.resolve(process.cwd(), "scripts/test-hivra-ubuntu-server-profile.cjs"),
    ], { encoding: "utf8", timeout: 15_000 });
    expect(output).toContain("PASS hivra ubuntu server profile");
  });
});
