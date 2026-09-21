import { MEMORY_PAUSE_TITLE, memoryPauseMessage } from "@/lib/memory-pause-message";

describe("memory pause explanation", () => {
  it.each([[1024, "1 GB"], [2048, "2 GB"], [512, "512 MB"], [1536, "1.5 GB"]])(
    "uses the recorded %i MB allocation", (cap, expected) => {
      expect(memoryPauseMessage(cap)).toContain(`${expected} memory allocation`);
    },
  );

  it.each([undefined, null, 0, -1, NaN, Infinity])("does not invent a missing/invalid cap (%s)", cap => {
    expect(memoryPauseMessage(cap)).not.toMatch(/\d+ (?:GB|MB)/);
  });

  it("distinguishes a monitoring pause from time limits and an OOM crash", () => {
    expect(MEMORY_PAUSE_TITLE).toBe("Paused for high memory use");
    expect(memoryPauseMessage(2048)).toContain("not a usage-time limit or confirmation of an out-of-memory crash");
    expect(memoryPauseMessage(2048)).toContain("may pause again");
    expect(memoryPauseMessage(2048)).not.toMatch(/Free agents|4×|nothing.*lost/i);
  });
});
