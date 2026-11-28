import "server-only";

import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  CANARY_MEMORY_OVERCOMMIT_PROVISIONER,
  parseCanaryMemoryOvercommit,
  type CanaryMemoryOvercommit,
} from "@/lib/infrastructure/host-capacity-policy";

const PILOT_HOST = "pve11";
const OWNER = /^user_[A-Za-z0-9]+$/;

export async function readCanaryMemoryOvercommit(input: {
  host: string;
  ownerId: string;
  channel: string;
  bundleVersion?: string;
}): Promise<CanaryMemoryOvercommit | null> {
  if (input.host !== PILOT_HOST || input.channel !== "canary"
    || (input.bundleVersion !== undefined && input.bundleVersion !== CANARY_MEMORY_OVERCOMMIT_PROVISIONER)
    || !OWNER.test(input.ownerId) || !isCanonicalGitCanaryDeployment() || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin.rpc("get_hivra_canary_memory_overcommit", {
      p_host_id: input.host,
      p_owner_id: input.ownerId,
    });
    if (!error) return parseCanaryMemoryOvercommit(data);
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
