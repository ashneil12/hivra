// The Venice deep link into Launch: /dashboard/launch?agent=hermes&inference=venice&ref=venice
//
// `agent` preselects the agent (same ids as Launch's `profile` param).
// `inference=venice` preselects Hivra credits (managed Venice).
// `inference=venice-key` preselects "use my own key" with Venice as provider.
// `ref` and `code` are attribution (see ./attribution.ts).
// Signed-out visitors: /dashboard/* is protected, so the proxy sends them to
// sign-in with redirect_url set to this same URL and they land back here.

import { launchProfileForAgentType, LAUNCH_ROUTE } from "@/lib/hivra/launch-navigation";
import type { LaunchDraft, LaunchProfileId } from "@/lib/launch/contracts";
import { modelAccessModes } from "@/lib/launch/model-access";

export type VeniceInference = "venice" | "venice-key";

export function parseVeniceInference(value: string | null | undefined): VeniceInference | null {
  return value === "venice" || value === "venice-key" ? value : null;
}

/** The Launch profile an `agent=` value names, or null for anything unknown. */
export function parseAgentParam(value: string | null | undefined): LaunchProfileId | null {
  return launchProfileForAgentType(value);
}

export function buildVeniceLaunchHref(agent: string, inference: VeniceInference = "venice", ref = "venice", code?: string): string {
  const query = new URLSearchParams({ agent, inference, ref });
  if (code) query.set("code", code);
  return `${LAUNCH_ROUTE}?${query.toString()}`;
}

/** Applies the inference choice when the profile supports it. */
export function withVeniceInference(draft: LaunchDraft, inference: VeniceInference | null): LaunchDraft {
  if (!inference || !draft.profileId) return draft;
  const mode = inference === "venice" ? "credits" : "api-key";
  if (!modelAccessModes(draft.profileId).includes(mode)) return draft;
  return { ...draft, modelAccess: { ...draft.modelAccess, mode, provider: "venice", source: "custom" } };
}
