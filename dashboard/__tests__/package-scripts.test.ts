import pkg from "../package.json";

const scripts = pkg.scripts as Record<string, string | undefined>;

describe("package ops scripts", () => {
  it("runs fleet persistence with the server-only noop shim", () => {
    expect(scripts["ops:fleet-persistence"]).toContain(
      "-r ./scripts/register-server-only-noop.cjs"
    );
  });

  it("runs production builds through stale Next dev lock recovery", () => {
    expect(scripts.build).toBe("node scripts/next-build-with-stale-lock-recovery.cjs");
  });

  it("does not reinstall local pre-push verification hooks during install", () => {
    expect(scripts.postinstall).toBeUndefined();
    expect(scripts["setup:guardrails"]).toBeUndefined();
  });

  it("exposes the risk-based verification planner", () => {
    expect(scripts["verify:plan"]).toBe("node scripts/recommend-verification.cjs");
  });
});
