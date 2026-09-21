// Hivra agent — in-app skill installer (Wave 3). POST { skillIds: string[] }
// installs curated-catalog skills onto a running CLI box. The box has no skills
// write endpoint, so delivery is an on-demand SSH round-trip to the box via the
// orchestrator key (reusing bankr-skills-seed's plumbing). Codex / claude-code
// boxes only — other agent types have no per-CLI skills dir and are rejected.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { installCuratedSkillsOnBox, listInstallableSkillMeta } from "@/lib/hivra/skill-install";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";

// The installable catalog (content-free) for this agent's picker. Auth + flag +
// ownership gated like the POST so the catalog metadata never leaks past the
// dashboard, and the heavy SKILL.md bodies never reach the client bundle.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: agent } = await supabaseAdmin
      .from("hivra_agents")
      .select("type,status")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();
    if (!agent) return apiError("Agent not found", 404);

    const supported = Boolean(bankrSkillsDirForType(agent.type as string | null));
    return apiSuccess({ supported, skills: supported ? listInstallableSkillMeta() : [] });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Each install is a real SSH round-trip to the box — keep it on the modest
    // settings-write budget so the picker can't be used to hammer the host.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_skill_install_post",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { data: agent } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();
    if (!agent) return apiError("Agent not found", 404);

    // Box-type gate: only CLI boxes with a per-CLI skills dir can be seeded.
    if (!bankrSkillsDirForType(agent.type as string | null)) {
      return apiError("This agent type doesn't support installable skills", 400);
    }
    if (agent.status !== "running" || !agent.ip) {
      return apiError("Agent isn't running yet", 409);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = body.skillIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      return apiError("skillIds must be a non-empty array", 400);
    }
    const skillIds = Array.from(
      new Set(raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)),
    );
    if (skillIds.length === 0) return apiError("skillIds must be a non-empty array", 400);
    if (skillIds.length > 50) return apiError("Too many skills in one install", 400);

    let env: Record<string, string | undefined>;
    try {
      env = (await resolveHivraAgentExecutionContext(userId, agent)).env;
    } catch (contextError) {
      const safeError = describeHivraAgentExecutionContextError(contextError);
      if (safeError) return apiError(safeError.message, safeError.status);
      throw contextError;
    }

    const result = await installCuratedSkillsOnBox(
      {
        id: String(agent.id),
        type: (agent.type as string | null) ?? null,
        ip: (agent.ip as string | null) ?? null,
      },
      skillIds,
      env,
    );

    if (!result.ok) {
      return apiError(result.error || "Skill install failed", 502, undefined, {
        installed: result.installed,
        skipped: result.skipped,
      });
    }

    await logHivraAgentEvent({
      userId,
      event: "skills_installed",
      agentId: String(agent.id),
      agentType: agent.type as string,
      detail: { count: result.installed.length, ids: result.installed },
    });

    return apiSuccess({ installed: result.installed, skipped: result.skipped });
  } catch (err) {
    return handleApiError(err);
  }
}
