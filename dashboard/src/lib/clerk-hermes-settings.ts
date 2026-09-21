import "server-only";

import { clerkClient } from "@clerk/nextjs/server";

import {
  extractGlobalHermesSettings,
  type GlobalHermesSettings,
} from "@/lib/instance-settings";
import { log } from "@/lib/logger";

const LOG_SOURCE = "clerk-hermes-settings";

/**
 * Resolve the Clerk user's `hermesSettings` (used as `globalSettings` for
 * `applyLiveUpdate` and the initial provision script). Falls back to an
 * empty settings object if Clerk returns Not Found, the network errors,
 * or the lookup otherwise fails.
 *
 * Why the fallback exists: a Hermes instance row can outlive its Clerk
 * owner (account self-deletion, abuse purge, manual cleanup) while the
 * VM is still up and consuming Hetzner / Proxmox capacity. Without a
 * fallback, the first updater that batches over running instances
 * throws on the orphaned row and the rest of the fleet gets quietly
 * skipped — exactly the 2026-05-01 incident that left one tenant
 * pinned to vanilla-hermes-agent while the other 38 moved to
 * hermes-webui:stable.
 */
export async function loadGlobalHermesSettingsForUser(
  userId: string,
  ctx?: { instanceId?: string | null },
): Promise<GlobalHermesSettings> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    return extractGlobalHermesSettings(user.publicMetadata);
  } catch (err) {
    log.warn(
      "clerk user lookup failed; falling back to default global hermes settings",
      {
        source: LOG_SOURCE,
        failureType: "clerk_user_lookup_failed",
        userId,
        instanceId: ctx?.instanceId ?? null,
      },
      err,
    );
    return extractGlobalHermesSettings(null);
  }
}
