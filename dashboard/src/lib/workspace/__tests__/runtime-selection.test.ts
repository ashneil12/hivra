import {
  agentTabSurface,
  hermesRuntimeUid,
  hivraRuntimeUid,
  surfaceTab,
} from "../runtime-selection";

describe("runtime selection", () => {
  describe("uid namespacing", () => {
    // Both fleet surfaces match a stored selection by uid, so these prefixes are
    // a contract with `unified-agent.ts` rather than a formatting choice.
    it("prefixes a Hivra backing id with x-", () => {
      expect(hivraRuntimeUid("abc-123")).toBe("x-abc-123");
    });

    it("prefixes a Hermes backing id with h-", () => {
      expect(hermesRuntimeUid("inst_9")).toBe("h-inst_9");
    });
  });

  describe("agentTabSurface", () => {
    it.each([
      ["chat", "conversation"],
      ["aeon", "workspace"],
      ["desktop", "desktop"],
      ["files", "files"],
      ["git", "git"],
      ["terminal", "terminal"],
      ["browser", "browser"],
      // Both terminal tabs are the same place in the workspace vocabulary.
      ["box", "terminal"],
    ] as const)("maps the %s tab onto the %s surface", (tab, surface) => {
      expect(agentTabSurface(tab)).toBe(surface);
    });

    it("resolves a runtime's own settings tabs to the conversation", () => {
      // skills/telegram/tasks/manage configure the runtime rather than being a
      // place within it. An unstated surface means the conversation here, which
      // is the same answer the route parser gives.
      for (const tab of ["skills", "telegram", "tasks", "manage", "not-a-tab"]) {
        expect(agentTabSurface(tab)).toBe("conversation");
      }
    });
  });

  describe("surfaceTab", () => {
    it("round-trips every surface a tab can produce", () => {
      const surfaces = ["conversation", "workspace", "files", "git", "terminal", "browser", "desktop"] as const;
      for (const surface of surfaces) {
        expect(agentTabSurface(surfaceTab(surface))).toBe(surface);
      }
    });

    it("names the runtime's own primary view for a conversation", () => {
      expect(surfaceTab("conversation")).toBe("chat");
    });
  });
});
