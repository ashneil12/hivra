import { sidebarStatus } from "../app-sidebar-status";

describe("sidebarStatus", () => {
  it.each([
    ["running", null, "Running", "ok"],
    ["provisioning", null, "Starting", "busy"],
    ["starting", null, "Starting", "busy"],
    ["stopping", null, "Stopping", "busy"],
    ["stopped", null, "Stopped", "off"],
    ["suspended", null, "Stopped", "off"],
    ["paused", null, "Paused", "off"],
    ["error", "error", "Needs attention", "error"],
    ["failed", null, "Needs attention", "error"],
    ["running", "approval", "Needs you", "you"],
    ["running", "clarify", "Needs you", "you"],
    ["some_new_state", null, "Some new state", "busy"],
  ] as const)("says %s (%s) as %s", (status, attention, label, tone) => {
    expect(sidebarStatus({ status, attention })).toEqual({ label, tone });
  });

  it("puts a request for the owner ahead of the status", () => {
    expect(sidebarStatus({ status: "provisioning", attention: "approval" }).label).toBe("Needs you");
  });
});
