import { createLaunchDraft } from "@/lib/launch/draft-store";
import { HERMES_LAUNCH_PROFILE, withHermesLane } from "../launch-lane";

describe("which launch profile a new Hermes agent uses", () => {
  it("is the official Hermes computer lane, for every account", () => {
    expect(HERMES_LAUNCH_PROFILE).toBe("hermes-computer");
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
