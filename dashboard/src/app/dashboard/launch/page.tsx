import { LaunchJourney } from "@/components/launch/LaunchJourney";
import { preparedProfilesForDeployment } from "@/lib/hivra/prepared-canary-computers";

export default function LaunchPage() {
  // The prepared desktop computer is offered from the same server configuration
  // the claim route reads, so the tile and the claim cannot disagree. Hermes as
  // a Hivra computer is on for Canary only; the agents route reads the same
  // flag, so the tile and the launch cannot disagree either.
  return <LaunchJourney preparedProfiles={preparedProfilesForDeployment()} />;
}
