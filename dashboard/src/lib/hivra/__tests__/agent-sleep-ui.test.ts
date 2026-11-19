import { agentSleepUiEnabled, agentSleepView, sleepGenerationOf } from "../agent-sleep-ui";

describe("agent sleep on screen", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });

  describe("with the switch off", () => {
    beforeEach(() => { delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP; });

    it("reads every agent as awake", () => {
      expect(agentSleepUiEnabled()).toBe(false);
      for (const sleep_state of ["napping", "hibernated", "waking", "wake_failed", "draining"]) {
        expect(agentSleepView({ status: "running", sleep_state })).toBe("awake");
      }
    });

    it("needs the value 1, nothing else", () => {
      process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "true";
      expect(agentSleepUiEnabled()).toBe(false);
    });
  });

  describe("with the switch on", () => {
    beforeEach(() => { process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1"; });

    it("reads a missing or awake sleep state as awake", () => {
      expect(agentSleepView({ status: "running" })).toBe("awake");
      expect(agentSleepView({ status: "running", sleep_state: null })).toBe("awake");
      expect(agentSleepView({ status: "running", sleep_state: "awake" })).toBe("awake");
      expect(agentSleepView(null)).toBe("awake");
      expect(agentSleepView(undefined)).toBe("awake");
    });

    it("reads waking as waking", () => {
      expect(agentSleepView({ status: "running", sleep_state: "waking" })).toBe("waking");
    });

    it("reads every other state, known or not, as asleep", () => {
      for (const sleep_state of ["draining", "napping", "hibernating", "hibernated", "wake_failed", "sleeping", "something new"]) {
        expect(agentSleepView({ status: "running", sleep_state })).toBe("asleep");
      }
    });

    it("never calls a computer that is not running asleep", () => {
      for (const status of ["stopped", "provisioning", "error", null, undefined]) {
        expect(agentSleepView({ status, sleep_state: "napping" })).toBe("awake");
      }
    });
  });

  it("reads a sleep generation sent as a number or a string", () => {
    expect(sleepGenerationOf({ sleep_generation: 7 })).toBe(7);
    expect(sleepGenerationOf({ sleep_generation: "12" })).toBe(12);
    expect(sleepGenerationOf({ sleep_generation: "nope" })).toBe(0);
    expect(sleepGenerationOf({ sleep_generation: -1 })).toBe(0);
    expect(sleepGenerationOf(null)).toBe(0);
    expect(sleepGenerationOf({})).toBe(0);
  });
});
