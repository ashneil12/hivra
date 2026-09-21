import { readFileSync } from "fs";
import { join } from "path";

const dashboardRoot = join(__dirname, "..", "..");

describe("instrumentation runtime boundary", () => {
  it("keeps Node-only process listeners out of the shared instrumentation hook", () => {
    const sharedHook = readFileSync(
      join(dashboardRoot, "instrumentation.ts"),
      "utf8"
    );
    const nodeHook = readFileSync(
      join(dashboardRoot, "instrumentation.node.ts"),
      "utf8"
    );

    expect(sharedHook).not.toContain("process.on(");
    expect(sharedHook).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(sharedHook).toContain('import("./instrumentation.node")');
    expect(nodeHook).toContain("process.on(");
  });
});
