import { execFileSync } from "node:child_process";
import path from "node:path";

describe("canonical relationship authority PostgreSQL migration", () => {
  it("reconciles owned test-container cleanup even without a launch acknowledgement", () => {
    const output = execFileSync(process.execPath, [
      path.resolve(process.cwd(), "scripts/test-hivra-canonical-authority-cleanup.cjs"),
    ], { encoding: "utf8", timeout: 5_000 });
    expect(output).toContain("PASS owned container cleanup after lost acknowledgement");
  });

  it("transfers metadata atomically and fences legacy projection without granting an installer", () => {
    const output = execFileSync(process.execPath, [
      path.resolve(process.cwd(), "scripts/test-hivra-canonical-authority.cjs"),
    ], { encoding: "utf8", timeout: 15_000 });
    expect(output).toContain("PASS canonical relationship authority transfer");
  });
});
