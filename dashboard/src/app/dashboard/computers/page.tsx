import { ComputerCatalogPage } from "@/components/computers/ComputerCatalogPage";
import { preparedProfilesForDeployment } from "@/lib/hivra/prepared-canary-computers";

export default function ComputersPage() {
  // The prepared desktop computer is offered from the same server configuration
  // the claim route reads, so the card and the claim cannot disagree.
  return <ComputerCatalogPage preparedProfiles={preparedProfilesForDeployment()} />;
}
