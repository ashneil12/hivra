import { welcomeRedirect } from "../welcome-redirect";

const go = (query: string) => welcomeRedirect(new URLSearchParams(query));

describe("welcomeRedirect", () => {
  it("opens Launch for a plain visit", () => {
    expect(go("")).toBe("/dashboard/launch");
  });

  it("opens the agent choice for the old agent-type and deploy steps", () => {
    expect(go("step=agent-type")).toBe("/dashboard/launch?kind=agent&start=1");
    expect(go("step=deploy")).toBe("/dashboard/launch?kind=agent&start=1");
  });

  it("opens the named agent's own plan, with Hermes under its old key", () => {
    expect(go("step=deploy&agentType=general")).toBe("/dashboard/launch?kind=agent&start=1&profile=hermes");
    expect(go("agentType=claude-code")).toBe("/dashboard/launch?kind=agent&start=1&profile=claude-code");
    expect(go("step=agent-type&agentType=agent-zero")).toBe("/dashboard/launch?kind=agent&start=1&profile=agent-zero");
    // An agent Launch doesn't know is not guessed at.
    expect(go("agentType=operatoros")).toBe("/dashboard/launch");
  });

  it("carries a ready server handed over from Capacity, and only a well-formed one", () => {
    expect(go("step=deploy&agentType=codex&targetId=22222222-2222-4222-8222-222222222222&targetId=javascript:alert(1)"))
      .toBe("/dashboard/launch?kind=agent&start=1&profile=codex&targetId=22222222-2222-4222-8222-222222222222");
  });

  it("starts a launch from a saved or shared template", () => {
    expect(go("step=agent-type&templateId=11111111-1111-4111-8111-111111111111"))
      .toBe("/dashboard/launch?start=1&template=11111111-1111-4111-8111-111111111111");
    expect(go("step=agent-type&templateId=11111111-1111-4111-8111-111111111111&templateToken=share_Token-9"))
      .toBe("/dashboard/launch?start=1&template=11111111-1111-4111-8111-111111111111&templateToken=share_Token-9");
    // A malformed reference is dropped rather than passed along.
    expect(go("templateId=../../etc&agentType=codex")).toBe("/dashboard/launch?kind=agent&start=1&profile=codex");
  });

  it("lands a checkout return in Launch, which says whether the plan shows yet", () => {
    expect(go("subscription=success&step=agent-type")).toBe("/dashboard/launch?upgraded=1");
    expect(go("subscription=success&plan=fleet")).toBe("/dashboard/launch?upgraded=fleet");
  });

  it("chooses a paid plan in Billing, which comes back to Launch", () => {
    expect(go("plan=operator")).toBe("/dashboard/billing?returnTo=%2Fdashboard%2Flaunch");
    // Free needs no checkout: a new account turns it on in Launch.
    expect(go("plan=free")).toBe("/dashboard/launch");
  });
});
