import "server-only";

import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  CANARY_MEMORY_OVERCOMMIT_PROVISIONER_VERSIONS,
  CANARY_MEMORY_HOST_ID,
  parseCanaryMemoryOvercommit,
  type CanaryMemoryOvercommit,
} from "@/lib/infrastructure/host-capacity-policy";

const OWNER = /^user_[A-Za-z0-9]+$/;

export async function readCanaryMemoryOvercommit(input: {
  host: string | null;
  ownerId: string;
  channel: string;
  bundleVersion?: string;
}): Promise<CanaryMemoryOvercommit | null> {
  if ((input.host !== null && !CANARY_MEMORY_HOST_ID.test(input.host)) || input.channel !== "canary"
    || (input.bundleVersion !== undefined && !CANARY_MEMORY_OVERCOMMIT_PROVISIONER_VERSIONS.includes(input.bundleVersion))
    || !OWNER.test(input.ownerId) || !isCanonicalGitCanaryDeployment() || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin.rpc("get_hivra_canary_memory_overcommit", {
      p_host_id: input.host,
      p_owner_id: input.ownerId,
    });
    if (!error) return parseCanaryMemoryOvercommit(data, input.host);
  } catch {
    // A read failure cannot authorize relaxed host admission.
  }
  log.warn("Could not read Canary memory overcommit grant", {
    source: "hivra-canary-memory-overcommit",
    failureType: "hivra_canary_memory_overcommit_grant_unavailable",
    proxmoxHost: input.host,
  });
  return null;
}
