/**
 * Best-effort write-through of WebUI-runtime profile state into the
 * `profiles` Supabase table.
 *
 * Why this exists: profile creates/updates/deletes for WebUI-backend
 * instances live in WebUI's runtime state. The /profiles GET handler
 * tries WebUI first and silently falls back to Supabase whenever WebUI
 * is unreachable (502, timeout, redeploy). Without write-through the
 * fallback never sees user-created profiles, so a transient runtime
 * hiccup makes a real profile "disappear" from the dashboard until
 * WebUI comes back.
 *
 * The two functions below are best-effort: a Supabase failure is
 * logged but never fails the user-visible operation. The WebUI runtime
 * stays the source of truth — Supabase is a hot-cache mirror so the
 * fallback path can answer correctly while the runtime is unhealthy.
 *
 * `default` profiles are intentionally skipped — `loadStoredProfiles`
 * synthesizes one at read time, and a real row would shadow that
 * synthesis (instance.config carries the default's model/provider/etc).
 */

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

const LOG_SOURCE = "webui-profile-persistence";

interface PersistInput {
  instanceId: string;
  userId: string;
  name: string;
  displayName?: string | null;
  model?: string | null;
  provider?: string | null;
  avatarUrl?: string | null;
  systemPrompt?: string | null;
  status?: string | null;
}

export async function persistWebUIProfileToSupabase(input: PersistInput): Promise<void> {
  if (!supabaseAdmin) return;
  if (input.name === "default") return;

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    instance_id: input.instanceId,
    user_id: input.userId,
    name: input.name,
    display_name: input.displayName ?? input.name,
    model: input.model ?? null,
    provider: input.provider ?? null,
    avatar_url: input.avatarUrl ?? null,
    status: input.status ?? "running",
    updated_at: now,
  };
  // `undefined` means "don't touch system_prompt" — omitting the key leaves it
  // out of the upsert's INSERT columns and its ON CONFLICT SET list, so an
  // existing row keeps its prompt. `null` still explicitly clears it. Callers
  // pass `undefined` when a SOUL write was skipped to preserve an authored
  // identity, so the mirror never advertises a prompt the box never took.
  if (input.systemPrompt !== undefined) {
    row.system_prompt = input.systemPrompt ?? null;
  }

  try {
    const result = await supabaseAdmin
      .from("profiles")
      .upsert(
        { ...row, created_at: now },
        { onConflict: "instance_id,name", ignoreDuplicates: false }
      );
    const error = (result as { error?: unknown } | null | undefined)?.error;
    if (error) {
      log.warn(
        "webui profile supabase write-through failed; fallback path may not see this profile",
        {
          source: LOG_SOURCE,
          failureType: "webui_profile_persist_failed",
          instanceId: input.instanceId,
          userId: input.userId,
          profileName: input.name,
        },
        error,
      );
    }
  } catch (err) {
    log.warn(
      "webui profile supabase write-through threw; fallback path may not see this profile",
      {
        source: LOG_SOURCE,
        failureType: "webui_profile_persist_threw",
        instanceId: input.instanceId,
        userId: input.userId,
        profileName: input.name,
      },
      err,
    );
  }
}

export async function removeWebUIProfileFromSupabase(input: {
  instanceId: string;
  userId: string;
  name: string;
}): Promise<void> {
  if (!supabaseAdmin) return;
  if (input.name === "default") return;

  try {
    const result = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("instance_id", input.instanceId)
      .eq("user_id", input.userId)
      .eq("name", input.name);
    const error = (result as { error?: unknown } | null | undefined)?.error;
    if (error) {
      log.warn(
        "webui profile supabase delete write-through failed; fallback path may show a ghost row",
        {
          source: LOG_SOURCE,
          failureType: "webui_profile_delete_failed",
          instanceId: input.instanceId,
          userId: input.userId,
          profileName: input.name,
        },
        error,
      );
    }
  } catch (err) {
    log.warn(
      "webui profile supabase delete write-through threw; fallback path may show a ghost row",
      {
        source: LOG_SOURCE,
        failureType: "webui_profile_delete_threw",
        instanceId: input.instanceId,
        userId: input.userId,
        profileName: input.name,
      },
      err,
    );
  }
}
