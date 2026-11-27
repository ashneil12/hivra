import { auth } from "@clerk/nextjs/server";

import { LaunchJourney } from "@/components/launch/LaunchJourney";
import { canCertifyCatalog } from "@/lib/hivra/catalog-certifier-access";
import { managedGvisorLaunchAdmittedForUser } from "@/lib/hivra/managed-gvisor-launch-config";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  const { userId } = await auth();
  return <LaunchJourney
    managedLinuxSandboxEligible={managedGvisorLaunchAdmittedForUser(userId)}
    catalogCertifier={canCertifyCatalog(userId)}
  />;
}
