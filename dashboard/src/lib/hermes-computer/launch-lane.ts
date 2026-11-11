import type { PlanInfo } from "@/lib/hivra/agent-api";
import { isPaidPlan } from "@/lib/launch/launch-plan";
import { PROFILE_DETAILS, type LaunchDraft, type LaunchProfileId } from "@/lib/launch/contracts";
import { freshModelAccess } from "@/lib/launch/model-access";

/**
 * Which launch profile a new Hermes agent uses.
 *
 * "hermes-computer" is Hermes as a Hivra computer (the official Hermes, its own
 * web UI); "hermes" is the Hermes instances lane every Hermes agent used
 * before. The computer lane is used only where it is on for this deployment
 * (isHermesComputerEnabled) and the owner's plan holds a Hivra Cloud computer:
 * Hivra Cloud computers need a paid plan, so an account without one keeps the
 * instances lane it has always launched Hermes on. A plan that could not be
 * read keeps the computer lane; the launch itself re-checks the plan.
 */
export function hermesLaunchProfile(
  { enabled, plan, planChecked }: { enabled: boolean; plan: PlanInfo | null; planChecked: boolean },
): Extract<LaunchProfileId, "hermes" | "hermes-computer"> {
  if (!enabled) return "hermes";
  if (planChecked && plan !== null && !isPaidPlan(plan)) return "hermes";
  return "hermes-computer";
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
