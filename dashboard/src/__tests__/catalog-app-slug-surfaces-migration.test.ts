/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("gives every catalog-shaped slug the catalog surfaces and delete action while aeon, computer types, bogus types and hermes rows stay unchanged", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-catalog-app-slug-surfaces.cjs")],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(output).toContain("PASS catalog app slug surfaces");
}, 65_000);
