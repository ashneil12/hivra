import { isProtectedPath } from "@/lib/protected-routes";

describe("isProtectedPath", () => {
  it("treats the homepage as public", () => {
    expect(isProtectedPath("/")).toBe(false);
  });

  it("treats dashboard pages as protected", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/dashboard/instances/abc")).toBe(true);
  });

  it("treats protected instance APIs as protected", () => {
    expect(isProtectedPath("/api/instances")).toBe(true);
    expect(isProtectedPath("/api/instances/abc/health")).toBe(true);
  });

  it("keeps public health and auth routes public", () => {
    expect(isProtectedPath("/api/health")).toBe(false);
    expect(isProtectedPath("/auth/signin")).toBe(false);
    expect(isProtectedPath("/auth/signup")).toBe(false);
  });
});
