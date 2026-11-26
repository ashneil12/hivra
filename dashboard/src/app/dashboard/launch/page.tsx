import { LaunchJourney } from "@/components/launch/LaunchJourney";
import { managedGvisorLaunchConfigured } from "@/lib/hivra/managed-gvisor-launch-config";

export const dynamic = "force-dynamic";

export default function LaunchPage() {
  return <LaunchJourney managedLinuxSandboxEligible={managedGvisorLaunchConfigured()} />;
}
