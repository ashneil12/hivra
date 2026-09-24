import { openedAgoLabel, recentSurfaceLabel, type RecentSubject } from "../recent-presentation";

const codex: RecentSubject = { kind: "hivra", resourceKind: "agent", agentType: "codex", surfaceKind: "chat" };
const aeon: RecentSubject = { kind: "hivra", resourceKind: "agent", agentType: "aeon", surfaceKind: "dashboard" };
const ubuntu: RecentSubject = { kind: "hivra", resourceKind: "computer", agentType: "linux-desktop", computerProfile: "ubuntu-desktop", surfaceKind: "computer" };
const sandbox: RecentSubject = { kind: "hivra", resourceKind: "computer", agentType: "linux-terminal", surfaceKind: "computer" };
const hermes: RecentSubject = { kind: "hermes", resourceKind: "agent", agentType: null };

describe("recent presentation", () => {
  it.each([
    [codex, "chat", "Chat"],
    [codex, "terminal", "Codex session"],
    [codex, "box", "Computer › Terminal"],
    [codex, "files", "Computer › Files"],
    [codex, "manage", "Manage"],
    [codex, "telegram", "Manage › Telegram"],
    [aeon, "aeon", "Dashboard"],
    [aeon, "box", "Computer › Terminal"],
    [ubuntu, "desktop", "Desktop"],
    [ubuntu, "box", "Terminal"],
    [hermes, "chat", "Chat"],
  ] as const)("names a remembered surface the way its page does", (subject, tab, label) => {
    expect(recentSurfaceLabel(tab, subject)).toBe(label);
  });

  it.each([
    [codex, "desktop", "Chat"],
    [aeon, "chat", "Dashboard"],
    [ubuntu, "chat", "Desktop"],
    [ubuntu, "terminal", "Desktop"],
    [sandbox, "desktop", "Manage"],
    [hermes, "box", "Chat"],
  ] as const)("names the view a surface the resource lacks falls back to", (subject, tab, label) => {
    expect(recentSurfaceLabel(tab, subject)).toBe(label);
  });

  const MINUTE = 60_000;
  it.each([
    [20_000, "opened just now"],
    [5 * MINUTE, "opened 5 min ago"],
    [59 * MINUTE, "opened 59 min ago"],
    [60 * MINUTE, "opened 1 hour ago"],
    [3 * 60 * MINUTE, "opened 3 hours ago"],
    [24 * 60 * MINUTE, "opened 1 day ago"],
    [47 * 60 * MINUTE, "opened 1 day ago"],
    [48 * 60 * MINUTE, "opened 2 days ago"],
    [40 * 24 * 60 * MINUTE, "opened over a month ago"],
  ])("says when it was opened, %p ms ago", (elapsed, label) => {
    const now = 1_700_000_000_000;
    expect(openedAgoLabel(now - elapsed, now)).toBe(label);
  });

  it("claims no time for a visit whose time was not kept", () => {
    expect(openedAgoLabel(0, 1_700_000_000_000)).toBeNull();
  });

  it("reads a time after now as just now", () => {
    expect(openedAgoLabel(2_000, 1_000)).toBe("opened just now");
  });
});
