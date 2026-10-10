import { execFileSync } from "node:child_process";
import path from "node:path";

it("dispatches desktop preparation at most once under the shared lease in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-hivra-desktop-prepare.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: desktop prepare exact owner/identity/channel CAS, shared lease and Delete intent, at-most-once dispatch, nonterminal retention, strict terminal evidence/ACLs, replay and unrelated data preservation");
}, 95_000);
