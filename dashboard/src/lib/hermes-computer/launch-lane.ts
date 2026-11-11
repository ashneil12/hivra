import { PROFILE_DETAILS, type LaunchDraft, type LaunchProfileId } from "@/lib/launch/contracts";
import { freshModelAccess } from "@/lib/launch/model-access";

/**
 * Which launch profile a new Hermes agent uses.
 *
 * "hermes-computer" is Hermes as a Hivra computer (the official Hermes, its own
 * web UI); "hermes" is the Hermes instances lane every Hermes agent used
 * before. Where the computer lane is on for this deployment
 * (isHermesComputerEnabled) every new Hermes agent uses it. Running it needs a
 * plan, the same as every Hivra-run computer, and the launch says so the same
 * way it does for any other agent.
 */
export function hermesLaunchProfile(enabled: boolean): Extract<LaunchProfileId, "hermes" | "hermes-computer"> {
  return enabled ? "hermes-computer" : "hermes";
}

/**
 * The draft moved to the Hermes lane that applies, when it is a Hermes draft
 * that has not been sent. Resources and model access go back to that lane's
 * own recommendation (the owner has made no choice that carries over: the two
 * lanes offer different sizes and model choices); the name and everything
 * else stay. Any other draft, and a Hermes launch already sent, is returned as
 * it was.
 */
export function withHermesLane(
  draft: LaunchDraft,
  profileId: Extract<LaunchProfileId, "hermes" | "hermes-computer">,
): LaunchDraft {
  if (draft.profileId !== "hermes" && draft.profileId !== "hermes-computer") return draft;
  if (draft.profileId === profileId) return draft;
  if (draft.launchState !== "idle" || draft.submittedDeployment || draft.stage === "launch") return draft;
  return {
    ...draft,
    profileId,
    capacity: { mode: "hivra-managed", targetId: null },
    browser: false,
    browserSource: "recommended",
    browserRaisedFrom: null,
    resources: { ...PROFILE_DETAILS[profileId].recommended },
    modelAccess: freshModelAccess(),
    sendMemoryKey: false,
  };
}
