import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { listLiveInstances, classifyByClerkOwnership } from "@/lib/recovery/orphaned-instances";
import { buildShutdownInstance } from "@/lib/recovery/orphan-instance-shutdown";

// Clerk account removal does not destroy a runtime. Stop legacy instances
// synchronously before acknowledging user.deleted; a failure must be retried.
// Permanent erasure remains with the existing verified teardown workflow.
export async function stopDeletedUserInstances(userId: string): Promise<{ stopped: number }> {
  if (!/^user_[a-zA-Z0-9]+$/.test(userId)) throw new Error("Invalid deleted user identity");
  if (!supabaseAdmin) throw new Error("Database not configured");
  const rows = await listLiveInstances(supabaseAdmin, { userId });
  const clerk = await clerkClient();
  const checks = await classifyByClerkOwnership(rows, clerk.users);
  if (checks.some((check) => check.status !== "orphan")) {
    throw new Error("Deleted owner absence could not be confirmed");
  }
  const shutdown = buildShutdownInstance(supabaseAdmin);
  let stopped = 0;
  let failed = false;
  for (const { row } of checks) {
    // Defense in depth: never let a malformed query response cross tenants.
    if (row.user_id !== userId) throw new Error("Instance owner mismatch");
    try {
      const result = await shutdown(row);
      if (!result.ok) {
        log.warn("Deleted owner runtime shutdown not confirmed", { source: "deleted-user-runtime", instanceId: row.id, failureType: "deleted_owner_shutdown_failed", detail: result.detail });
        failed = true; continue;
      }
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from("hermes_instances").update({
        status: row.status === "scheduled_for_deletion" ? row.status : "stopped",
        lifecycle_state: "suspended",
        last_lifecycle_transition_at: now,
        updated_at: now,
      }).eq("id", row.id).eq("user_id", userId).eq("status", row.status).select("id");
      if (error || !data?.length) { failed = true; continue; }
      stopped += 1;
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Deleted owner's runtime shutdown is incomplete");
  return { stopped };
}
