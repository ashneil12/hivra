import { cardTrialText } from "../OverviewTab";

describe("cardTrialText", () => {
  it("names the trial end, what the trial has, what full Pro adds and when the card is charged", () => {
    const text = cardTrialText("2026-11-26T12:00:00Z");
    expect(text).toContain("Free trial until 26 November");
    expect(text).toContain("1 agent with 1 vCPU and 2 GB");
    expect(text).toContain("3 agents, 2 vCPU, 4 GB and Keep awake");
    expect(text).toContain("charged when the trial ends unless you cancel");
  });
});
