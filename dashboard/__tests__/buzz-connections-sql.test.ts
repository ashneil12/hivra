import { execFileSync } from "node:child_process";
import path from "node:path";

it("enforces the Buzz connection journal's ownership, lease and privilege checks in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-buzz-connections.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS Buzz connection journal: 171 ownership, identity, lease, receipt, snapshot, deletion and privilege checks");
}, 95_000);
