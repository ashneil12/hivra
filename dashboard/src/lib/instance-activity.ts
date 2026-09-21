import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const INSTANCE_USER_ACTIVITY_SOURCES = [
  "chat_send",
  "responses_send",
  "terminal_start",
  "terminal_input",
  "instance_lifecycle_action",
  "instance_settings_update",
  "webui_login",
] as const;

type InstanceUserActivitySource =
  (typeof INSTANCE_USER_ACTIVITY_SOURCES)[number];

export type RecordInstanceUserActivityInput = {
  instanceId: string;
  userId: string;
  source: InstanceUserActivitySource;
  now?: Date;
};

export type RecordInstanceUserActivityResult =
  | { ok: true; recordedAt: string }
  | { ok: false; error: string };

export async function recordInstanceUserActivity(
  input: RecordInstanceUserActivityInput
): Promise<RecordInstanceUserActivityResult> {
  const recordedAt = (input.now ?? new Date()).toISOString();

  if (!supabaseAdmin) {
    log.warn("skipped instance user activity record because database is unavailable", {
      source: "instance-activity",
      activitySource: input.source,
      instanceId: input.instanceId,
      userId: input.userId,
      failureType: "instance_activity_database_unavailable",
    });
    return { ok: false, error: "Database not configured" };
  }

  try {
    const { error } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        last_activity_at: recordedAt,
        updated_at: recordedAt,
      })
      .eq("id", input.instanceId)
      .eq("user_id", input.userId);

    if (error) {
      log.warn("failed to record instance user activity", {
        source: "instance-activity",
        activitySource: input.source,
        instanceId: input.instanceId,
        userId: input.userId,
        failureType: "instance_activity_update_failed",
        errorMessage: error.message,
      });
      return { ok: false, error: error.message };
    }

    return { ok: true, recordedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("failed to record instance user activity", {
      source: "instance-activity",
      activitySource: input.source,
      instanceId: input.instanceId,
      userId: input.userId,
      failureType: "instance_activity_update_threw",
      errorMessage: message,
    });
    return { ok: false, error: message };
  }
}
