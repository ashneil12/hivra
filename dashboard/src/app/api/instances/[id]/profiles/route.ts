import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ProfileService } from "@/lib/services/profile-service";
import { z } from "zod";
import { inferProviderFromModel, normalizeModelValue } from "@/lib/models";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { WebUIError } from "@/lib/webui/client";
import { resolveWebUIInstanceClient } from "@/lib/webui/instance";
import { isWebfreeBackend } from "@/lib/types/instance";
import { mapWebUIProfileToDashboard } from "@/lib/webui/profiles";
import { log } from "@/lib/logger";
import { persistWebUIProfileToSupabase } from "@/lib/webui/profile-persistence";

const ProfileOrderSchema = z.object({
  order: z.array(
    z.string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^(default|[a-z0-9][a-z0-9_-]*)$/, "Invalid profile name in order")
  ).max(128, "Profile order cannot include more than 128 profiles"),
});

interface InstanceConfig {
  model?: string;
  provider?: string;
  avatarUrl?: string;
  profileOrder?: unknown;
  agentSettings?: {
    systemPrompt?: string;
  };
  [key: string]: unknown;
}

function readInstanceConfig(config: unknown): InstanceConfig {
  return config && typeof config === "object" && !Array.isArray(config)
    ? config as InstanceConfig
    : {};
}

function sanitizeProfileOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const order: string[] = [];
  value.forEach((entry) => {
    if (typeof entry !== "string") return;
    const name = entry.trim();
    if (!name || seen.has(name)) return;
    if (!/^(default|[a-z0-9][a-z0-9_-]*)$/.test(name)) return;
    seen.add(name);
    order.push(name);
  });
  return order;
}

function applyProfileOrder<T extends { name: string }>(profiles: T[], order: string[]): T[] {
  if (order.length === 0) return profiles;

  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const orderedProfiles = order
    .map((name) => byName.get(name))
    .filter((profile): profile is T => Boolean(profile));
  const orderedNames = new Set(orderedProfiles.map((profile) => profile.name));
  const remainingProfiles = profiles.filter((profile) => !orderedNames.has(profile.name));
  return [...orderedProfiles, ...remainingProfiles];
}

function isSummaryProfilesRequest(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get("summary") === "true";
}

function toProfileSummary(profile: {
  id: string;
  name: string;
  display_name: string | null;
  avatar_url: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  gateway_port: number | null;
  created_at: string;
}) {
  return {
    id: profile.id,
    name: profile.name,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    model: profile.model,
    provider: profile.provider,
    status: profile.status,
    gateway_port: profile.gateway_port,
    created_at: profile.created_at,
  };
}

async function loadStoredProfiles(input: {
  instanceId: string;
  userId: string;
  instanceName?: string | null;
  config: InstanceConfig;
  profileOrder: string[];
  summaryOnly: boolean;
}) {
  const defaultDisplayName = input.instanceName || "Default Agent";
  const profileSelect = input.summaryOnly
    ? "id, instance_id, user_id, name, display_name, avatar_url, model, provider, status, gateway_port, created_at, updated_at"
    : "*";

  const { data: profiles, error } = await supabaseAdmin!
     .from("profiles")
     .select(profileSelect as "*")
     .eq("instance_id", input.instanceId)
     .eq("user_id", input.userId)
     .order("created_at", { ascending: true });

  if (error) {
    return {
      ok: false as const,
      response: apiError("Failed to fetch profiles", 500, {
        failureType: "instance_profiles_fetch_failed",
      }),
    };
  }

  const result = profiles || [];
  if (!result.some((p: { name: string }) => p.name === 'default')) {
    result.unshift({
      id: `default-${input.instanceId}`,
      instance_id: input.instanceId,
      user_id: input.userId,
      name: 'default',
      display_name: defaultDisplayName,
      model: typeof input.config.model === "string"
        ? normalizeModelValue(input.config.model, typeof input.config.provider === "string" ? input.config.provider : inferProviderFromModel(input.config.model))
        : null,
      provider: input.config.provider || null,
      ...(input.summaryOnly ? {} : { system_prompt: input.config.agentSettings?.systemPrompt || null }),
      avatar_url: input.config.avatarUrl || null,
      gateway_port: null,
      status: 'running',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  return {
    ok: true as const,
    profiles: applyProfileOrder(result, input.profileOrder),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id: instanceId } = await params;

    const { data: instanceRow, error: instanceError } = await supabaseAdmin!
       .from("hermes_instances")
       .select("name, config, backend")
       .eq("id", instanceId)
       .eq("user_id", userId)
       .single();

    if (instanceError || !instanceRow) {
      return apiError("Instance not found", 404);
    }

    const config = readInstanceConfig(instanceRow.config);
    const profileOrder = sanitizeProfileOrder(config.profileOrder);

    if (isWebfreeBackend(instanceRow.backend)) {
      const summaryOnly = isSummaryProfilesRequest(request);
      const resolved = await resolveWebUIInstanceClient({
        instanceId,
        userId,
        requireRunning: true,
      });
      if (!resolved.ok) {
        return apiError(resolved.error, resolved.status);
      }

      try {
        const payload = await resolved.client.profiles();
        const now = new Date().toISOString();
        // Per-profile runtime model/provider enrichment (a per-profile
        // /api/settings fetch) has been RETIRED — that endpoint 404s on the
        // fleet agent image, and no consumer reads the enriched model/provider
        // fields (the three GET callers read only name/display_name). The
        // profile's own model/provider from /api/profiles is authoritative, so
        // this is now a plain map with no per-profile round-trips.
        const profiles: Array<Awaited<ReturnType<typeof mapWebUIProfileToDashboard>>> = [];
        for (const profile of payload.profiles ?? []) {
          profiles.push(
            mapWebUIProfileToDashboard({
              profile,
              instanceId,
              userId,
              instanceName: instanceRow.name,
              now,
            }),
          );
        }
        const orderedProfiles = applyProfileOrder(profiles, profileOrder);

        // Lazy backfill: quietly mirror the WebUI runtime's profile list
        // into Supabase so the fallback path in this same handler stays
        // truthful when WebUI later hiccups. POST/PATCH/DELETE already
        // write through; this catches profiles that pre-date the
        // write-through change. No-op for the synthesized `default`.
        //
        // F092: this used to be N serial awaited DB writes INSIDE the read
        // request — slowing every profiles GET and (when one threw) tipping
        // the whole handler into the stored-rows fallback. It's a best-effort
        // mirror, so fire it batched (parallel) and DO NOT await it before
        // returning: the read response no longer waits on the backfill, and a
        // failed write is logged instead of derailing the response.
        const backfillTargets = orderedProfiles.filter((p) => p.name !== "default");
        if (backfillTargets.length > 0) {
          void Promise.allSettled(
            backfillTargets.map((profile) =>
              persistWebUIProfileToSupabase({
                instanceId,
                userId,
                name: profile.name,
                displayName: profile.display_name ?? profile.name,
                model: profile.model ?? null,
                provider: profile.provider ?? null,
                avatarUrl: profile.avatar_url ?? null,
                systemPrompt: profile.system_prompt ?? null,
                status: profile.status ?? "running",
              }),
            ),
          ).then((results) => {
            const failures = results.filter((r) => r.status === "rejected").length;
            if (failures > 0) {
              log.warn("lazy WebUI profile backfill had failures", {
                source: "profiles",
                route: "/api/instances/[id]/profiles",
                method: "GET",
                instanceId,
                userId,
                failureType: "webui_profile_backfill_failed",
                failedCount: failures,
                totalCount: backfillTargets.length,
              });
            }
          });
        }

        return apiSuccess(summaryOnly ? orderedProfiles.map(toProfileSummary) : orderedProfiles);
      } catch (err) {
        log.warn("WebUI profile request failed; falling back to stored rows", {
          source: "profiles",
          route: "/api/instances/[id]/profiles",
          method: "GET",
          instanceId,
          userId,
          failureType: "webui_profiles_request_failed",
          redactedError: redactSensitiveCommandOutput(
            err instanceof Error ? err.message : String(err),
            600
          ),
          upstreamStatus: err instanceof WebUIError ? err.status : null,
        }, err);
        const fallback = await loadStoredProfiles({
          instanceId,
          userId,
          instanceName: instanceRow.name,
          config,
          profileOrder,
          summaryOnly,
        });
        if (!fallback.ok) return fallback.response;
        return apiSuccess(summaryOnly ? fallback.profiles.map(toProfileSummary) : fallback.profiles);
      }
    }

    const { searchParams } = new URL(request.url);
    if (searchParams.get("sync") === "true") {
      try {
        await ProfileService.syncProfiles(instanceId, userId);
      } catch (error) {
        log.warn("live profile sync failed; falling back to stored rows", {
          source: "profiles",
          route: "/api/instances/[id]/profiles",
          method: "GET",
          instanceId,
          userId,
          failureType: "live_profile_sync_failed",
          redactedError: redactSensitiveCommandOutput(
            error instanceof Error ? error.message : String(error),
            600
          ),
        }, error);
      }
    }
    
    const summaryOnly = isSummaryProfilesRequest(request);
    const stored = await loadStoredProfiles({
      instanceId,
      userId,
      instanceName: instanceRow.name,
      config,
      profileOrder,
      summaryOnly,
    });
    if (!stored.ok) return stored.response;
    return apiSuccess(summaryOnly ? stored.profiles.map(toProfileSummary) : stored.profiles);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id: instanceId } = await params;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return apiError("Invalid JSON body", 400, {
        failureType: "profile_order_invalid_json",
      });
    }

    const parsed = ProfileOrderSchema.safeParse(json);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const profileOrder = sanitizeProfileOrder(parsed.data.order);
    const { data: instanceRow, error: instanceError } = await supabaseAdmin!
      .from("hermes_instances")
      .select("config")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .single();

    if (instanceError || !instanceRow) {
      return apiError("Instance not found", 404);
    }

    const nextConfig = {
      ...readInstanceConfig(instanceRow.config),
      profileOrder,
    };

    const { error: updateError } = await supabaseAdmin!
      .from("hermes_instances")
      .update({ config: nextConfig })
      .eq("id", instanceId)
      .eq("user_id", userId);

    if (updateError) {
      return apiError("Failed to save profile order", 500, {
        failureType: "profile_order_update_failed",
      });
    }

    return apiSuccess({ profileOrder });
  } catch (err) {
    return handleApiError(err);
  }
}
