import {
  buildAgentLaunchHref,
  buildLaunchHref,
  buildLaunchSetupHref,
  launchProfileForAgentType,
} from "../launch-navigation";

describe("launch navigation", () => {
  it("builds every Launch link in one shape, with the kind a profile implies", () => {
    expect(buildLaunchHref()).toBe("/dashboard/launch");
    expect(buildLaunchHref({ kind: "agent", start: true })).toBe("/dashboard/launch?kind=agent&start=1");
    expect(buildLaunchHref({ start: true, profile: "ubuntu-desktop" })).toBe("/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
    expect(buildLaunchHref({ start: true, template: "t-1", templateToken: "tok" })).toBe("/dashboard/launch?start=1&template=t-1&templateToken=tok");
    expect(buildLaunchHref({ profile: "codex", targetIds: ["a", "b"] })).toBe("/dashboard/launch?kind=agent&profile=codex&targetId=a&targetId=b");
  });

  it("maps the agents older first-run links named onto Launch profiles", () => {
    expect(launchProfileForAgentType("general")).toBe("hermes");
    expect(launchProfileForAgentType("claude-code")).toBe("claude-code");
    expect(launchProfileForAgentType("operatoros")).toBeNull();
    expect(launchProfileForAgentType("__proto__")).toBeNull();
    expect(launchProfileForAgentType(null)).toBeNull();
  });

  it("opens a new launch of the agent a link named, or the agent choice", () => {
    expect(buildAgentLaunchHref("general")).toBe("/dashboard/launch?kind=agent&start=1&profile=hermes");
    expect(buildAgentLaunchHref("nope")).toBe("/dashboard/launch?kind=agent&start=1");
    expect(buildAgentLaunchHref()).toBe("/dashboard/launch?kind=agent&start=1");
  });

  it("sends ready capacity to Launch for every runtime, never to the retired welcome forms", () => {
    const target = "33333333-3333-4333-8333-333333333333";
    for (const resource of ["claude-code", "codex", "aeon", "openclaw", "agent-zero", "linux-desktop", "linux-terminal", "windows"] as const) {
      expect(buildLaunchSetupHref(resource, target)).toMatch(/^\/dashboard\/launch\?/);
    }
    // A new launch from Capacity; the launch Capacity was opened from continues.
    expect(buildLaunchSetupHref("aeon", target)).toBe(`/dashboard/launch?kind=agent&start=1&profile=aeon&targetId=${target}`);
    expect(buildLaunchSetupHref("linux-desktop", target, { unified: true })).toBe(`/dashboard/launch?kind=computer&profile=ubuntu-desktop&targetId=${target}`);
    expect(buildLaunchSetupHref("windows", null)).toBe("/dashboard/launch?kind=computer&start=1&profile=windows");
  });
});
