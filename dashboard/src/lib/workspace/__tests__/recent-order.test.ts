import { inRecentOrder, switcherGroups } from "../recent-order";
import type { RecentVisit } from "../recents";

type Item = { uid: string; kind: "agent" | "computer" };

const items: Item[] = [
  { uid: "x-alpha", kind: "agent" },
  { uid: "x-beta", kind: "agent" },
  { uid: "h-gamma", kind: "agent" },
  { uid: "x-desk", kind: "computer" },
  { uid: "x-lab", kind: "computer" },
];

function visits(...uids: string[]): RecentVisit[] {
  return uids.map((uid, index) => ({ uid, tab: "chat", usedAt: 100 - index }));
}

const options = (recents: RecentVisit[], currentUid: string | null = null, limit?: number) => ({
  recents,
  currentUid,
  isComputer: (item: Item) => item.kind === "computer",
  limit,
});

describe("recent order", () => {
  it("lists remembered items most recent first and leaves out what is not listed", () => {
    expect(inRecentOrder(items, visits("x-desk", "x-deleted", "x-alpha")).map((entry) => entry.item.uid)).toEqual(["x-desk", "x-alpha"]);
  });

  it("puts Recent first, without the current resource, then Agents and Computers once each", () => {
    const groups = switcherGroups(items, options(visits("x-beta", "x-desk", "h-gamma"), "x-beta"));
    expect(groups.map((group) => [group.key, group.items.map((item) => item.uid)])).toEqual([
      ["recent", ["x-desk", "h-gamma"]],
      ["agent", ["x-alpha", "x-beta"]],
      ["computer", ["x-lab"]],
    ]);
  });

  it("keeps Recent to the limit and the rest in their incoming order", () => {
    const groups = switcherGroups(items, options(visits("x-lab", "x-desk", "h-gamma", "x-beta", "x-alpha"), null, 2));
    expect(groups.map((group) => [group.key, group.items.map((item) => item.uid)])).toEqual([
      ["recent", ["x-lab", "x-desk"]],
      ["agent", ["x-alpha", "x-beta", "h-gamma"]],
    ]);
  });

  it("drops empty groups, Recent included", () => {
    expect(switcherGroups(items.slice(0, 2), options([])).map((group) => group.key)).toEqual(["agent"]);
    expect(switcherGroups([], options(visits("x-alpha")))).toEqual([]);
  });
});
