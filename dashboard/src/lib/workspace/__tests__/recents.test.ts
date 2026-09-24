/** @jest-environment jsdom */

import {
  MAX_RECENTS,
  RECENTS_STORAGE_KEY,
  lastTabFor,
  listRecents,
  recentHref,
  recordVisit,
  visitHref,
} from "../recents";
import { WORKSPACE_SELECTION_STORAGE_KEY } from "../workspace-persistence";

function stored(visits: unknown, version: unknown = 1) {
  window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ version, visits }));
}

describe("recents", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it("keeps the most recent first, one entry per resource", () => {
    recordVisit("x-one", "chat", { now: 1_000 });
    recordVisit("h-two", "chat", { now: 2_000 });
    recordVisit("x-one", "files", { now: 3_000 });

    expect(listRecents()).toEqual([
      { uid: "x-one", tab: "files", usedAt: 3_000 },
      { uid: "h-two", tab: "chat", usedAt: 2_000 },
    ]);
    expect(Object.keys(JSON.parse(window.localStorage.getItem(RECENTS_STORAGE_KEY)!)).sort()).toEqual(["version", "visits"]);
  });

  it(`remembers at most ${MAX_RECENTS}, dropping the oldest`, () => {
    for (let index = 0; index < MAX_RECENTS + 3; index += 1) {
      recordVisit(`x-agent-${index}`, "chat", { now: 1_000 + index });
    }
    const visits = listRecents();
    expect(visits).toHaveLength(MAX_RECENTS);
    expect(visits[0].uid).toBe(`x-agent-${MAX_RECENTS + 2}`);
    expect(visits.map((visit) => visit.uid)).not.toContain("x-agent-2");
  });

  // Computer › Terminal is `box`; the agent's own command line is `terminal`.
  // They were once stored as one word, so resuming the shell opened the agent.
  it("keeps Computer › Terminal apart from the agent's session", () => {
    recordVisit("x-codex", "box");
    expect(lastTabFor("x-codex")).toBe("box");
    expect(recentHref("x-codex")).toBe("/dashboard/agent/codex?tab=box");

    recordVisit("x-codex", "terminal");
    expect(recentHref("x-codex")).toBe("/dashboard/agent/codex?tab=terminal");
  });

  it("remembers each agent's own surface, never another's", () => {
    recordVisit("x-first", "terminal");
    recordVisit("x-second", "chat");
    expect(lastTabFor("x-first")).toBe("terminal");
    expect(lastTabFor("x-second")).toBe("chat");
    expect(lastTabFor("x-never-opened")).toBeNull();
  });

  it.each([
    ["a token-shaped identity", "x-api-token-secret"],
    ["a JWT-shaped identity", "x-eyJabc.def.ghi"],
    ["an unqualified identity", "agent-1"],
    ["an identity that is too long", `x-${"a".repeat(200)}`],
  ])("refuses to store %s and keeps the list it had", (_label, uid) => {
    recordVisit("x-safe", "chat", { now: 5 });
    expect(recordVisit(uid, "chat")).toBe(false);
    expect(listRecents()).toEqual([{ uid: "x-safe", tab: "chat", usedAt: 5 }]);
  });

  it("refuses a surface the pages do not have", () => {
    expect(recordVisit("x-safe", "admin" as never)).toBe(false);
    expect(window.localStorage.getItem(RECENTS_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["malformed JSON", () => window.localStorage.setItem(RECENTS_STORAGE_KEY, "not-json")],
    ["another version", () => stored([], 2)],
    ["an extra top-level field", () => window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ version: 1, visits: [], token: "DO_NOT_KEEP" }))],
    ["an extra visit field", () => stored([{ uid: "x-one", tab: "chat", usedAt: 1, token: "DO_NOT_KEEP" }])],
    ["a token-shaped identity", () => stored([{ uid: "x-bearer-secret", tab: "chat", usedAt: 1 }])],
    ["an unknown surface", () => stored([{ uid: "x-one", tab: "admin", usedAt: 1 }])],
    ["a negative time", () => stored([{ uid: "x-one", tab: "chat", usedAt: -1 }])],
    ["a fractional time", () => stored([{ uid: "x-one", tab: "chat", usedAt: 1.5 }])],
    ["a repeated resource", () => stored([{ uid: "x-one", tab: "chat", usedAt: 2 }, { uid: "x-one", tab: "box", usedAt: 1 }])],
    ["too many entries", () => stored(Array.from({ length: MAX_RECENTS + 1 }, (_, index) => ({ uid: `x-${index}`, tab: "chat", usedAt: index })))],
    ["an oversized value", () => window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ version: 1, visits: [], pad: "x".repeat(5000) }))],
  ])("clears a stored list with %s", (_label, write) => {
    write();
    expect(listRecents()).toEqual([]);
    expect(window.localStorage.getItem(RECENTS_STORAGE_KEY)).toBeNull();
  });

  it("carries the single last-selection record over once, without claiming when it was opened", () => {
    window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify({ version: 1, uid: "x-ubuntu", surface: "desktop" }));
    window.localStorage.setItem("hivra:agent-last-view", "terminal");

    expect(listRecents()).toEqual([{ uid: "x-ubuntu", tab: "desktop", usedAt: 0 }]);
    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
    // The shared chat/terminal preference is retired with it.
    expect(window.localStorage.getItem("hivra:agent-last-view")).toBeNull();

    recordVisit("x-codex", "chat", { now: 10 });
    expect(listRecents().map((visit) => visit.uid)).toEqual(["x-codex", "x-ubuntu"]);
  });

  it.each([
    ["conversation", "chat"],
    ["workspace", "aeon"],
    ["files", "files"],
    // It was written for both terminals, so neither is guessed.
    ["terminal", "chat"],
  ])("carries a %s selection over as %s", (surface, tab) => {
    window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify({ version: 1, uid: "x-agent", surface }));
    expect(lastTabFor("x-agent")).toBe(tab);
  });

  it("drops a tampered last-selection record instead of carrying it over", () => {
    window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify({ version: 1, uid: "x-api-token-secret", surface: "desktop" }));
    expect(listRecents()).toEqual([]);
    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Blocked"); });

    expect(listRecents()).toEqual([]);
    expect(recordVisit("x-one", "chat")).toBe(false);
    expect(lastTabFor("x-one")).toBeNull();
    expect(recentHref("x-one", "/dashboard/agent/one?tab=chat")).toBe("/dashboard/agent/one?tab=chat");
  });

  it("never throws when storage itself cannot be reached", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    try {
      expect(listRecents()).toEqual([]);
      expect(recordVisit("x-one", "chat")).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  it("does not lose the list when a write fails", () => {
    recordVisit("x-one", "chat", { now: 1 });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
    expect(recordVisit("x-two", "chat", { now: 2 })).toBe(false);
    jest.restoreAllMocks();
    expect(listRecents()).toEqual([{ uid: "x-one", tab: "chat", usedAt: 1 }]);
  });

  describe("recentHref", () => {
    it("uses the resource's own link when nothing is remembered", () => {
      expect(recentHref("x-desk", "/dashboard/agent/desk?tab=desktop&open=fast")).toBe("/dashboard/agent/desk?tab=desktop&open=fast");
      expect(recentHref("x-desk")).toBe("/dashboard/agent/desk");
    });

    it("keeps the resource's own link when it already names the remembered surface", () => {
      recordVisit("x-desk", "desktop");
      expect(recentHref("x-desk", "/dashboard/agent/desk?tab=desktop&open=fast")).toBe("/dashboard/agent/desk?tab=desktop&open=fast");
    });

    it("names the remembered surface otherwise", () => {
      recordVisit("x-desk", "files");
      expect(recentHref("x-desk", "/dashboard/agent/desk?tab=desktop&open=fast")).toBe("/dashboard/agent/desk?tab=files");
    });

    it("sends a Hermes agent to its own page, which has one surface", () => {
      recordVisit("h-inst_1", "chat");
      expect(recentHref("h-inst_1")).toBe("/dashboard/instances/inst_1");
    });

    it("encodes the id and ignores a uid it did not write", () => {
      expect(visitHref("x-a:b", "chat")).toBe("/dashboard/agent/a%3Ab?tab=chat");
      expect(visitHref("not-a-uid", "chat")).toBe("/dashboard?runtimes=1");
    });
  });
});
