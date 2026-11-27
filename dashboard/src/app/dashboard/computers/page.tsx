import { auth } from "@clerk/nextjs/server";

import { ComputerCatalogPage } from "@/components/computers/ComputerCatalogPage";
import { managedGvisorLaunchAdmittedForUser } from "@/lib/hivra/managed-gvisor-launch-config";

export const dynamic = "force-dynamic";

export default async function ComputersPage() {
  const { userId } = await auth();
  return <ComputerCatalogPage managedLinuxSandboxEligible={managedGvisorLaunchAdmittedForUser(userId)} />;
}
