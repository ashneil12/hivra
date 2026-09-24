import { MAX_RETURN_PATH_LENGTH, planReturnParams, safeReturnPath, withReturnParams } from "../safe-return-path";

describe("safeReturnPath", () => {
  it("accepts same-origin relative dashboard paths and returns them canonically", () => {
    expect(safeReturnPath("/dashboard/launch?draft=33333333-3333-4333-8333-333333333333"))
      .toBe("/dashboard/launch?draft=33333333-3333-4333-8333-333333333333");
    expect(safeReturnPath("/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("/dashboard/billing?tab=plans")).toBe("/dashboard/billing?tab=plans");
  });

  it.each([
    ["an absolute URL", "https://evil.example/dashboard/launch"],
    ["a protocol-relative URL", "//evil.example/dashboard"],
    ["a scheme", "javascript:alert(1)"],
    ["a backslash host", "/\\evil.example/dashboard"],
    ["a backslash in the path", "/dashboard\\..\\admin"],
    ["a relative path", "dashboard/launch"],
    ["a path outside the dashboard", "/sign-out"],
    ["a lookalike prefix", "/dashboardx/launch"],
    ["a dot segment", "/dashboard/../api/billing/subscribe"],
    ["an encoded dot segment", "/dashboard/%2e%2e/api"],
    ["an encoded slash", "/dashboard%2F..%2Fapi"],
    ["a fragment", "/dashboard/launch#frag"],
    ["whitespace", "/dashboard/launch ?x=1"],
    ["a tab", "/dashboard/\tlaunch"],
    ["a control character", "/dashboard/launch\u0000"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it("rejects paths longer than the limit", () => {
    expect(safeReturnPath(`/dashboard/${"a".repeat(MAX_RETURN_PATH_LENGTH)}`)).toBeNull();
  });

  it("sets query params on a safe path without changing where it points", () => {
    expect(withReturnParams("/dashboard/launch?draft=abc", { upgraded: "1" })).toBe("/dashboard/launch?draft=abc&upgraded=1");
    expect(withReturnParams("/dashboard/launch?upgraded=0", { upgraded: "1" })).toBe("/dashboard/launch?upgraded=1");
  });
});

describe("planReturnParams", () => {
  it("names the plan a change moved to, or 1 when it isn't known", () => {
    expect(planReturnParams("fleet")).toEqual({ upgraded: "fleet" });
    expect(planReturnParams(null)).toEqual({ upgraded: "1" });
    expect(planReturnParams("../x")).toEqual({ upgraded: "1" });
  });
});
