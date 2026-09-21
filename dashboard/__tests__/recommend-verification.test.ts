const helper = require("../scripts/recommend-verification.cjs") as {
  classifyFiles(files: string[]): "tiny" | "normal" | "high";
  planForRisk(risk: "tiny" | "normal" | "high"): string[];
  strongerRisk(left: "tiny" | "normal" | "high", right: "tiny" | "normal" | "high"): "tiny" | "normal" | "high";
};

describe("recommend-verification", () => {
  it("keeps docs-only changes at tiny risk", () => {
    expect(helper.classifyFiles(["../docs/regression-lockdown.md"])).toBe("tiny");
  });

  it("treats normal source changes as normal risk", () => {
    expect(helper.classifyFiles(["src/app/dashboard/page.tsx"])).toBe("normal");
  });

  it("escalates protected hot paths to high risk", () => {
    expect(helper.classifyFiles(["dashboard/src/app/api/billing/subscribe/route.ts"])).toBe("high");
  });

  it("never lowers a manually selected risk level", () => {
    expect(helper.strongerRisk("high", "tiny")).toBe("high");
    expect(helper.strongerRisk("tiny", "normal")).toBe("normal");
  });

  it("keeps post-deploy checks scoped to high-risk plans by default", () => {
    expect(helper.planForRisk("tiny").join("\n")).toContain("No post-deploy canary check is expected");
    expect(helper.planForRisk("high").join("\n")).toContain("perform a canary check");
  });
});
