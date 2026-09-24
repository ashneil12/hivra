import { execFileSync } from "node:child_process";
import path from "node:path";

it("releases an orphaned desktop preparation lease only from exact stale quiescence evidence", () => {
  const output = execFileSync(process.execPath, [path.resolve(process.cwd(), "scripts/test-hivra-desktop-prepare-abandon.cjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS desktop prepare abandon");
});
