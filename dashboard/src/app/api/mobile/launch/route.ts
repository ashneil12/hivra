export const runtime = "nodejs";

// The launch delegates to InstanceService.createInstance, which runs Phase 1
// provisioning synchronously (Proxmox clone + boot) — same budget as the web
// POST /api/instances route (Vercel Pro maximum).
export const maxDuration = 300;

import crypto from "node:crypto";

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { GOALS, type GoalId } from "@/lib/hivra/agent-identity";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { MOBILE_LAUNCH_REQUESTED_LEDGER_KEY } from "@/lib/push/agent-ready-push";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import {
  CreateInstanceSchema,
  InstanceService,
} from "@/lib/services/instance-service";
import { resolveTierSpec } from "@/lib/services/tier-specs";
import { supabaseAdmin } from "@/lib/supabase";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import { PROVIDERS } from "@/lib/models";
import { getWelcomeAgentTypeDefinition } from "@/lib/welcome-agent-catalog";
import { buildWelcomeAgentSettings } from "@/lib/welcome-deploy";
import {
  getWelcomePersonaById,
  type WelcomePersonaDefinition,
} from "@/lib/welcome-persona-catalog";
import {
  buildHermesWelcomeSystemPrompt,
  normalizeWelcomeLaunchCapture,
  type WelcomePersonalizationDraft,
} from "@/lib/welcome-personalization";

/**
 * POST /api/mobile/launch — the jargon-free launch profile (iOS Phase 2).
 *
 * The phone sends persona + names + quiz answers; the server derives every
 * technical decision — size from the caller's plan tier (tier-specs), managed
 * Venice ON (no BYOK), the persona's authored soul as the system-prompt base —
 * and then delegates to the UNMODIFIED InstanceService.createInstance. This
 * route is a thin parameter-mapper over the exact inputs the web welcome flow
 * (WelcomeFlow.tsx) builds for POST /api/instances + its follow-up
 * personalization PATCH; it must never fork provisioning logic.
 *
 * Paid-only: mobile has no free tier. Unentitled callers get 402 with
 * code "subscription_required" (the app routes them to the paywall).
 *
 * firstTask/goal/context are persisted to the dedicated hermes_instances
 * columns AFTER the create returns (the same columns the web flow PATCHes and
 * the lifecycle-email sweep reads) — createInstance does not accept them and
 * stays untouched. The same follow-up write stamps
 * notifications_sent.mobile_launch_requested_at, which the agent-ready push
 * uses to (a) know this box came from the mobile lane and (b) compute the
 * mobile_launch_ready elapsed-ms funnel metric.
 */

const LOG_SOURCE = "mobile-launch";
const ROUTE = "/api/mobile/launch";

/** Poll cadence the app should use against `statusUrl` while provisioning. */
const POLL_RETRY_AFTER_MS = 5_000;

const CustomPersonaSchema = z.object({
  /** The custom specialist's name — mirrors the web's customPersonaName. */
  name: z.string().min(1).max(50),
  emoji: z.string().min(1).max(16).optional(),
  /** One-liner expertise — folded into launch context like the web flow does. */
  expertise: z.string().max(700).optional(),
});

const MobileLaunchSchema = z.object({
  personaId: z.string().max(64).optional(),
  custom: CustomPersonaSchema.optional(),
  agentName: z
    .string()
    .min(1)
    .max(50)
    // Same guard as CreateInstanceSchema.name — names flow into env files and
    // shell heredocs on the agent VM.
    .refine((value) => !/[\n\r\0]/.test(value), {
      message: "Name must not contain newlines or null bytes",
    }),
  goal: z.string().max(64).optional(),
  whoYouAre: z.string().max(200).optional(),
  workingOn: z.string().max(500).optional(),
  firstTask: z.string().max(700).optional(),
});

function isKnownGoalId(value: string | undefined): value is GoalId {
  return Boolean(value && GOALS.some((goal) => goal.id === value));
}

/** The web welcome flow's default model for a provider = its first list entry. */
function defaultVeniceModel(): string {
  const venice = PROVIDERS.find((provider) => provider.id === "venice");
  return venice?.models[0]?.value ?? "";
}

/** Mirrors WelcomeFlow's aiPeer derivation for the Honcho block. */
function toAiPeer(agentName: string): string {
  return agentName.trim().replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success: withinLimit } = enforceRateLimit(`mobile_launch_${ip}`, {
      limit: 10,
      windowMs: 60 * 1000,
    });
    if (!withinLimit) return apiError("Too Many Requests", 429);

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const requestedAtIso = new Date().toISOString();

    const json = await request.json().catch(() => null);
    const parsed = MobileLaunchSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400, undefined, undefined, {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "mobile_launch_invalid_payload",
        userId,
      });
    }
    const body = parsed.data;

    // ── Persona resolution ──────────────────────────────────────────────────
    // Exactly one lane: an authored persona (soul-backed) or a custom build.
    let persona: WelcomePersonaDefinition | null = null;
    if (!body.custom) {
      persona = getWelcomePersonaById(body.personaId);
      if (!persona || persona.isCustom) {
        return apiError(
          persona?.isCustom
            ? "Send the `custom` object to build your own specialist."
            : "Pick a specialist (personaId) or build your own (custom).",
          400,
          undefined,
          undefined,
          {
            source: LOG_SOURCE,
            route: ROUTE,
            failureType: "mobile_launch_unknown_persona",
            userId,
          }
        );
      }
    }
    // The custom card's presentation defaults (personality/emoji fallbacks)
    // come from the catalog's "custom" entry, exactly like the web flow.
    const customCard = getWelcomePersonaById("custom");

    // ── Entitlement (paid-only lane) ────────────────────────────────────────
    // resolveEffectiveSubscription is the same resolver createInstance runs;
    // rejecting here gives the app a clean 402 paywall signal instead of the
    // web lane's 403 copy. The stripe-trialing rejection mirrors
    // createInstance's own rule (trialing budgets are often $0).
    const sub = await resolveEffectiveSubscription(userId);
    const entitled =
      !!sub &&
      sub.plan !== "free" &&
      sub.instance_limit > 0 &&
      !(sub.source === "stripe" && sub.status === "trialing");
    if (!entitled) {
      return apiError(
        "A subscription is required to launch your agent.",
        402,
        undefined,
        { code: "subscription_required" },
        {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "mobile_launch_subscription_required",
          userId,
          logLevel: "info",
        }
      );
    }

    // ── Server-picked technical profile ────────────────────────────────────
    // Size comes from the plan tier — the phone never sees vCPU/RAM numbers.
    const spec = resolveTierSpec(sub.plan);
    const agentName = body.agentName.trim();

    // Personalization draft — field-for-field what WelcomeFlow seeds from a
    // persona click (handleSelectPersona/handleContinueFromPersona).
    const draft: WelcomePersonalizationDraft = persona
      ? {
          goal: isKnownGoalId(body.goal) ? body.goal : persona.goal,
          context: "",
          firstTask: body.firstTask ?? "",
          personality: persona.personality,
          emoji: persona.emoji,
          agentName,
          who: body.whoYouAre ?? null,
          business: body.workingOn ?? null,
          soulPromptId: persona.soulPromptId ?? null,
        }
      : {
          goal: isKnownGoalId(body.goal) ? body.goal : customCard?.goal ?? "assist",
          // Web parity: the custom expertise line folds into launch context.
          context: body.custom?.expertise?.trim() ?? "",
          firstTask: body.firstTask ?? "",
          personality: customCard?.personality ?? "friendly and adaptable",
          emoji: body.custom?.emoji?.trim() || customCard?.emoji || "🤖",
          agentName,
          who: body.whoYouAre ?? null,
          business: body.workingOn ?? null,
          soulPromptId: null,
        };

    // Soul-seeded system prompt — same builder + same basePrompt source
    // (the "general" agent type) as the web flow.
    const systemPrompt = buildHermesWelcomeSystemPrompt({
      agentName,
      basePrompt: getWelcomeAgentTypeDefinition("general")?.systemPrompt,
      draft,
    });

    // Managed-Venice deploy profile — byte-for-byte the web welcome flow's
    // managed path: provider venice, first-listed model, empty apiKey (the
    // server mints the proxy key), managed proxy base URL, managed runtime.
    const agentSettings = buildWelcomeAgentSettings({
      providerId: "venice",
      model: defaultVeniceModel(),
      customBaseUrl: getManagedVeniceProxyBaseUrl(),
      systemPrompt,
      runtimeMode: "managed",
      // Match web launches: privileged VM/Docker control is enabled later by
      // the owner from Advanced Cloud Access, never silently at provision time.
      enableRootAccess: false,
      webUseGateway: false,
      imageGenUseGateway: false,
      ttsUseGateway: false,
      browserUseGateway: false,
    });

    const createPayload = CreateInstanceSchema.safeParse({
      name: agentName,
      provider: "venice",
      model: defaultVeniceModel(),
      apiKey: "",
      managedVenice: { enabled: true, walletType: "hermesos" },
      honcho: {
        enabled: true,
        peerName: "user",
        aiPeer: toAiPeer(agentName),
        memoryMode: "hybrid",
        recallMode: "hybrid",
      },
      agentSettings,
      cpuLimit: spec.cpuLimit,
      ramLimit: spec.ramLimitMb,
    });
    if (!createPayload.success) {
      return apiError(
        createPayload.error.issues[0].message,
        400,
        undefined,
        undefined,
        {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "mobile_launch_payload_rejected",
          userId,
          logLevel: "error",
        }
      );
    }

    // ── Funnel event (attempt-scoped, fired before the long provision) ─────
    // Flushed immediately so a Vercel timeout mid-provision can't lose it.
    try {
      posthogClient.capture({
        distinctId: userId,
        event: "mobile_launch_requested",
        properties: {
          persona: persona?.id ?? "custom",
          plan: sub.plan,
          goal: draft.goal,
          has_first_task: Boolean(body.firstTask?.trim()),
          $insert_id: `mobile_launch_requested_${crypto.randomUUID()}`,
          $set_once: { hermes_user_id: userId },
        },
      });
      await posthogClient.flush();
    } catch (captureErr) {
      log.warn("failed to capture mobile_launch_requested", {
        source: LOG_SOURCE,
        route: ROUTE,
        userId,
        errorMessage:
          captureErr instanceof Error ? captureErr.message : String(captureErr),
      });
    }

    // ── Delegate to the existing provisioning path, UNMODIFIED ─────────────
    const result = await InstanceService.createInstance(userId, createPayload.data);

    if (!result.success) {
      const failureType =
        result.failureType ??
        (result.status >= 500
          ? "instance_create_failed"
          : `deploy_rejected_${result.status}`);
      return apiError(result.message, result.status, result.error, { failureType }, {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType,
        userId,
        logLevel: "error",
      });
    }

    const instance = result.data as { id: string; name?: string };

    // ── Follow-up row write (the web flow's personalization PATCH, server-side)
    // goal/first_task/context are the columns the lifecycle-email sweep reads;
    // the ledger stamp marks the box as mobile-launched for the agent-ready
    // push + mobile_launch_ready metric. The row is seconds old and only this
    // request knows its id, so a direct notifications_sent write (over the
    // '{}' default) cannot clobber anyone. Best-effort: the box is already
    // provisioning — a metadata write failure must not fail the launch.
    const capture = normalizeWelcomeLaunchCapture({
      goal: draft.goal,
      firstTask: draft.firstTask,
      context: draft.context,
    });
    const { error: followUpError } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        goal: capture.goal,
        first_task: capture.firstTask,
        context: capture.context,
        notifications_sent: {
          [MOBILE_LAUNCH_REQUESTED_LEDGER_KEY]: requestedAtIso,
        },
      })
      .eq("id", instance.id);
    if (followUpError) {
      log.warn("mobile launch follow-up write failed (launch still succeeded)", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "mobile_launch_capture_write_failed",
        userId,
        instanceId: instance.id,
        errorMessage: followUpError.message,
      });
    }

    // The polling contract: summary mode still reconciles provisioning rows
    // (and fires the agent-ready hook) without the heavy full-mode probes.
    return apiSuccess({
      instance: result.data,
      agent: {
        name: agentName,
        emoji: draft.emoji ?? null,
        personaId: persona?.id ?? "custom",
        goal: draft.goal,
      },
      polling: {
        statusUrl: "/api/instances?summary=true",
        retryAfterMs: POLL_RETRY_AFTER_MS,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
