import { execFileSync } from "node:child_process";
import path from "node:path";

it("fences folder recovery by owner, identity, consent and lifecycle in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-hivra-folder-recovery.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: folder recovery owner/identity/consent, lifecycle fence, durable receipt privileges, exact completion, old controller revocation + guest release + fresh source controller, unrelated resource preservation");
}, 95_000);
