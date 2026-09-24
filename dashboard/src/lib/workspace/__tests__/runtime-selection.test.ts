import {
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

  describe("surfaceTab", () => {
    it.each([
      ["conversation", "chat"],
      ["workspace", "aeon"],
      ["desktop", "desktop"],
      ["files", "files"],
      ["git", "git"],
      ["terminal", "terminal"],
      ["browser", "browser"],
    ] as const)("names the agent route tab for the %s surface", (surface, tab) => {
      expect(surfaceTab(surface)).toBe(tab);
    });
  });
});
