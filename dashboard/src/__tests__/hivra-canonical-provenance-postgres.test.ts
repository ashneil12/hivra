import { execFileSync } from "node:child_process";
import path from "node:path";

describe("canonical binding/provenance PostgreSQL migration", () => {
  it("enforces identity uniqueness and preserves source lineage through actual projection", () => {
    const output = execFileSync(process.execPath, [
      path.resolve(process.cwd(), "scripts/test-hivra-canonical-provenance.cjs"),
    ], { encoding: "utf8", timeout: 15_000 });
    expect(output).toContain("PASS canonical identity uniqueness");
  });
});
