import type { PlanInfo } from "@/lib/hivra/agent-api";
import { createLaunchDraft } from "@/lib/launch/draft-store";
import { hermesLaunchProfile, withHermesLane } from "../launch-lane";

const plan = (key: string, subscribed = true): PlanInfo => ({
  subscribed, name: key, key, maxAgents: 3, maxCpuPerAgent: 2, maxRamPerAgent: 4, poolCpu: 2, poolRam: 4,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
});

describe("which launch profile a new Hermes agent uses", () => {
  it("stays on the instances lane where the computer lane is off", () => {
    expect(hermesLaunchProfile({ enabled: false, plan: plan("operator"), planChecked: true })).toBe("hermes");
  });

  it("uses the computer lane for a paid plan, and while the plan is still being read", () => {
    expect(hermesLaunchProfile({ enabled: true, plan: plan("operator"), planChecked: true })).toBe("hermes-computer");
    expect(hermesLaunchProfile({ enabled: true, plan: null, planChecked: false })).toBe("hermes-computer");
  });

  it("keeps the instances lane for an account without a paid plan, which holds no Hivra Cloud computer", () => {
    expect(hermesLaunchProfile({ enabled: true, plan: plan("free"), planChecked: true })).toBe("hermes");
    expect(hermesLaunchProfile({ enabled: true, plan: plan("free", false), planChecked: true })).toBe("hermes");
  });

  it("keeps the computer lane when the plan could not be read, leaving the launch to re-check it", () => {
    expect(hermesLaunchProfile({ enabled: true, plan: null, planChecked: true })).toBe("hermes-computer");
  });
});

describe("moving an unsent Hermes draft to the lane that applies", () => {
  const hermesDraft = (profileId: "hermes" | "hermes-computer") => ({
    ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId, name: "Hermes 1",
  });

  it("moves the draft and gives it the other lane's own recommended size and model choices, keeping its name", () => {
    const moved = withHermesLane(hermesDraft("hermes-computer"), "hermes");
    expect(moved).toMatchObject({ profileId: "hermes", name: "Hermes 1", resources: { source: "recommended" }, modelAccess: { source: "recommended" } });
    const back = withHermesLane(hermesDraft("hermes"), "hermes-computer");
    expect(back).toMatchObject({ profileId: "hermes-computer", name: "Hermes 1", resources: { cpu: 2, ram: 4 }, capacity: { mode: "hivra-managed" } });
  });

  it("returns the same draft when it is already on that lane", () => {
    const draft = hermesDraft("hermes");
    expect(withHermesLane(draft, "hermes")).toBe(draft);
  });

  it("never moves another agent's draft or a launch already sent", () => {
    const other = { ...hermesDraft("hermes"), profileId: "codex" as const };
    expect(withHermesLane(other, "hermes-computer")).toBe(other);
    for (const sent of [
      { ...hermesDraft("hermes"), launchState: "uncertain" as const },
      { ...hermesDraft("hermes"), launchState: "submitting" as const },
      { ...hermesDraft("hermes"), stage: "launch" as const },
    ]) {
      expect(withHermesLane(sent, "hermes-computer")).toBe(sent);
    }
  });
});
