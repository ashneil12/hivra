import { notFound } from "next/navigation";

import { MakerPage } from "@/components/launch/MakerPage";
import { isLaunchProfileId } from "@/lib/launch/contracts";
import { catalogSourceRepo, isMakerClaimsEnabled } from "@/lib/launch/launch-catalog";

// A maker's page for one catalog entry: prove the claim, then read the
// numbers. Only for an agent whose maker publishes a repository Hivra can read
// the proof from, and only while maker claims are turned on.
export default async function MakerPageRoute({ params }: { params: Promise<{ profile: string }> }) {
  const { profile } = await params;
  if (!isMakerClaimsEnabled() || !isLaunchProfileId(profile) || !catalogSourceRepo(profile)) notFound();
  return <MakerPage profileId={profile} />;
}
