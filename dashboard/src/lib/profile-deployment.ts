import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProfileDeploymentRoute {
  name: string;
  port: number;
}

interface ProfileDeploymentRow {
  name: string;
  gateway_port: number | null;
  status: string | null;
}

type HydratedProfileDeploymentRow = ProfileDeploymentRow & {
  name: string;
  gateway_port: number;
};

function toProfileDeploymentRoute(
  profile: HydratedProfileDeploymentRow
): ProfileDeploymentRoute {
  return {
    name: profile.name,
    port: profile.gateway_port,
  };
}

export async function getProfileDeploymentState(
  supabase: SupabaseClient,
  instanceId: string,
  userId: string
): Promise<{
  profileRoutes: ProfileDeploymentRoute[];
  profilesToRestore: ProfileDeploymentRoute[];
}> {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("name, gateway_port, status")
    .eq("instance_id", instanceId)
    .eq("user_id", userId)
    .not("gateway_port", "is", null);

  if (error) {
    throw new Error(`Failed to load profile deployment state: ${error.message}`);
  }

  const profileRows: HydratedProfileDeploymentRow[] = (profiles || []).filter(
    (profile): profile is HydratedProfileDeploymentRow =>
      typeof profile.name === "string" && typeof profile.gateway_port === "number"
  );

  const profileRoutes: ProfileDeploymentRoute[] = profileRows.map(
    toProfileDeploymentRoute
  );

  const profilesToRestore: ProfileDeploymentRoute[] = profileRows
    .filter((profile) => profile.status === "running")
    .map(toProfileDeploymentRoute);

  return { profileRoutes, profilesToRestore };
}
