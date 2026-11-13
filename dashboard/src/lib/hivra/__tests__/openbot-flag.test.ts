import { isOpenBotAgentEnabled } from "../openbot-flag";

describe("isOpenBotAgentEnabled", () => {
  it.each(["1", "true", "TRUE", " 1 "])("is on for %j", (value) => {
    expect(isOpenBotAgentEnabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "yes", "on"])("is off for %j", (value) => {
    expect(isOpenBotAgentEnabled(value)).toBe(false);
  });

  it("reads NEXT_PUBLIC_HIVRA_OPENBOT_AGENT by default and is off when unset", () => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT;
    try {
      delete process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT;
      expect(isOpenBotAgentEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT = "1";
      expect(isOpenBotAgentEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT;
      else process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT = previous;
    }
  });
});
