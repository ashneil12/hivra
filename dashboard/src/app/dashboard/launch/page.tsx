import { LaunchJourney } from "@/components/launch/LaunchJourney";
import { preparedProfilesForDeployment } from "@/lib/hivra/prepared-canary-computers";

export default function LaunchPage() {
  // The prepared desktop computer is offered from the same server configuration
  // the claim route reads, so the tile and the claim cannot disagree.
  return <LaunchJourney preparedProfiles={preparedProfilesForDeployment()} />;
}
