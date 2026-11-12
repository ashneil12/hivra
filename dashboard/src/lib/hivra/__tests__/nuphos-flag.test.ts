import { isNuphosAgentEnabled } from "../nuphos-flag";

describe("isNuphosAgentEnabled", () => {
  it.each(["1", "true", "TRUE", " 1 "])("is on for %j", (value) => {
    expect(isNuphosAgentEnabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "yes", "on"])("is off for %j", (value) => {
    expect(isNuphosAgentEnabled(value)).toBe(false);
  });

  it("reads NEXT_PUBLIC_HIVRA_NUPHOS_AGENT by default and is off when unset", () => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_NUPHOS_AGENT;
    try {
      delete process.env.NEXT_PUBLIC_HIVRA_NUPHOS_AGENT;
      expect(isNuphosAgentEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_HIVRA_NUPHOS_AGENT = "1";
      expect(isNuphosAgentEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_NUPHOS_AGENT;
      else process.env.NEXT_PUBLIC_HIVRA_NUPHOS_AGENT = previous;
    }
  });
});
