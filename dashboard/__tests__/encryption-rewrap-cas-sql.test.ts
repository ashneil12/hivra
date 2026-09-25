import { execFileSync } from "node:child_process";
import path from "node:path";

it("rewraps encrypted fields only through strict compare-and-set in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-encryption-rewrap-cas.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS encryption rewrap CAS: strict stable surfaces, journal-coupled agent secret, complete body fences, unrelated-field preservation, schema-version preservation, grants");
}, 95_000);
