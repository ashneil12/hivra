import { CONVERGING_AGENT_POLL_MS, SETTLED_AGENT_POLL_MS, nextAgentStatusPollMs } from "../agent-status-poll";

describe("nextAgentStatusPollMs", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });

  it("reads a settled running agent slowly, and not at all while hidden", () => {
    expect(nextAgentStatusPollMs({ status: "running" }, true)).toBe(SETTLED_AGENT_POLL_MS);
    expect(nextAgentStatusPollMs({ status: "running" }, false)).toBeNull();
  });

  it("reads a provisioning agent at the converging pace", () => {
    expect(nextAgentStatusPollMs({ status: "provisioning" }, true)).toBe(CONVERGING_AGENT_POLL_MS);
  });

  describe("a sleeping agent, with the sleep switch on", () => {
    beforeEach(() => { process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1"; });

    it.each(["napping", "hibernated", "waking", "draining", "hibernating"])("reads %s at the converging pace", (sleep_state) => {
      expect(nextAgentStatusPollMs({ status: "running", sleep_state }, true)).toBe(CONVERGING_AGENT_POLL_MS);
    });

    it("settles after a failed wake, until the owner tries again", () => {
      expect(nextAgentStatusPollMs({ status: "running", sleep_state: "wake_failed" }, true)).toBe(SETTLED_AGENT_POLL_MS);
    });

    it("reads an awake agent slowly", () => {
      expect(nextAgentStatusPollMs({ status: "running", sleep_state: "awake" }, true)).toBe(SETTLED_AGENT_POLL_MS);
    });
  });

  it("ignores sleep entirely with the switch off", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    expect(nextAgentStatusPollMs({ status: "running", sleep_state: "waking" }, true)).toBe(SETTLED_AGENT_POLL_MS);
  });
});
