import "server-only";

// Agent templates — save / share / fork a configured agent as a named, reusable
// template (Wave 5.2, STICKINESS_PLAN.md). The only network-effect + creator-
// economy lever in the plan.
//
// A template snapshots the PORTABLE identity of a hivra_agents row:
//   { type, name, goal, context, personality, emoji, llm_config (jsonb, key-free) }
// It NEVER copies the encrypted LLM key (llm_api_key_encrypted) nor any per-agent
// minted proxy-key fields — those are re-minted at launch. Visibility is
// private | link | public; on link/public share the free-text `context` is
// STRIPPED before the template leaves the owner (user-typed, possibly sensitive).
// Private templates keep `context` (owner's own).
//
// SKILLS (Wave 5.2 follow-up): a template also carries the curated-catalog skill
// IDS the source agent had installed, so a fork reproduces them. We snapshot the
// box's live /api/skills at create time, map the reported names to catalog ids,
// and store just the ids (never the bodies — the catalog is the content source).
// Skill ids are non-sensitive, so — unlike `context` — they are CARRIED to
// non-owners on shared templates rather than stripped. See template-skills.ts +
// the migration for the full rationale (curated/non-Bankr/content-bearing only).
//
// Written/read only by the service-role API routes via supabaseAdmin, mirroring
// public.hivra_agents (no RLS; the table has no PostgREST exposure path). Reads
// here never throw — a lookup miss returns null/[] so a UI surface degrades
// gracefully rather than 500ing.

import { randomBytes } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { readStoredLlmConfig, publicLlmConfig } from "@/lib/hivra/agent-llm";
import { coerceSkillIds, snapshotInstalledTemplateSkillIds } from "@/lib/hivra/template-skills";

export type TemplateVisibility = "private" | "link" | "public";

const VISIBILITIES: ReadonlySet<string> = new Set(["private", "link", "public"]);

/** The portable identity fields a template carries (and a launch fills from). */
export interface TemplateIdentity {
  type: string;
  name: string | null;
  goal: string | null;
  /** Stripped to null for non-owners on shared templates. */
  context: string | null;
  personality: string | null;
  emoji: string | null;
  /** Key-free jsonb metadata; never the encrypted key. */
  llm_config: unknown;
  /** Curated-catalog skill ids to reproduce on a fork. Non-sensitive — carried
   *  to non-owners on shared templates (not stripped like `context`). */
  skills: string[];
}

/** A template row as returned to the owner (full, incl. private context). */
export interface OwnerTemplate extends TemplateIdentity {
  id: string;
  slug: string;
  source: string;
  visibility: TemplateVisibility;
  share_token: string | null;
  forked_from: string | null;
  created_at: string;
  updated_at: string;
}

function isVisibility(v: unknown): v is TemplateVisibility {
  return typeof v === "string" && VISIBILITIES.has(v);
}

// Slugify a template name into a URL/lookup-safe base. Falls back to "agent"
// when a name has no usable characters.
function slugifyBase(name: string | null | undefined, type: string): string {
  const raw = (name && name.trim()) || type || "agent";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

// A short random suffix used both for slug uniqueness and as the human-opaque
// part of a share token. crypto.randomBytes (not Math.random) so a share token
// is unguessable.
function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

// Generate a slug that's unique in agent_templates. The base comes from the
// name; on collision we append a random suffix and retry a few times. On the
// rare exhaustion we fall back to a fully random slug (still unique-checked by
// the table's UNIQUE constraint at insert time as the final guard).
async function generateUniqueSlug(name: string | null | undefined, type: string): Promise<string> {
  if (!supabaseAdmin) return `${slugifyBase(name, type)}-${randomSuffix()}`;
  const base = slugifyBase(name, type);
  const candidates = [base, ...Array.from({ length: 5 }, () => `${base}-${randomSuffix()}`)];
  for (const candidate of candidates) {
    const { data, error } = await supabaseAdmin
      .from("agent_templates")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) {
      // Lookup failed — don't block the create; jump straight to a random slug.
      break;
    }
    if (!data) return candidate;
  }
  return `${base}-${randomSuffix(8)}`;
}

function mintShareToken(): string {
  // 24 bytes → 48 hex chars: unguessable, URL-safe, fits the unique column.
  return randomBytes(24).toString("hex");
}

function toOwnerTemplate(row: Record<string, unknown>): OwnerTemplate {
  const visibility = isVisibility(row.visibility) ? row.visibility : "private";
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    source: typeof row.source === "string" ? row.source : "community",
    type: typeof row.type === "string" ? row.type : "",
    name: typeof row.name === "string" ? row.name : null,
    goal: typeof row.goal === "string" ? row.goal : null,
    context: typeof row.context === "string" ? row.context : null,
    personality: typeof row.personality === "string" ? row.personality : null,
    emoji: typeof row.emoji === "string" ? row.emoji : null,
    llm_config: publicLlmConfig(readStoredLlmConfig(row.llm_config)),
    skills: coerceSkillIds(row.skills),
    visibility,
    share_token: typeof row.share_token === "string" ? row.share_token : null,
    forked_from: typeof row.forked_from === "string" ? row.forked_from : null,
    created_at: typeof row.created_at === "string" ? row.created_at : new Date(0).toISOString(),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
  };
}

// Snapshot a user's OWN agent into a new private template. Loads the owned
// hivra_agents row, copies ONLY the portable identity (never the encrypted key
// nor minted proxy-key fields), generates a unique slug from the name, and
// inserts a private template. Returns null on any failure (no owned row, db
// error) — the caller maps that to a 404/500.
export async function createTemplateFromAgent(
  userId: string,
  agentId: string,
): Promise<OwnerTemplate | null> {
  if (!supabaseAdmin) return null;
  // Owner check is the eq(user_id) — a user can only template their own agent.
  // chat_url + api_token + status drive the best-effort skills snapshot below.
  const { data: agent, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, type, name, goal, context, personality, emoji, llm_config, status, chat_url, api_token")
    .eq("id", agentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !agent) return null;

  const row = agent as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : "";
  if (!type) return null;
  const name = typeof row.name === "string" ? row.name : null;
  const slug = await generateUniqueSlug(name, type);

  // Snapshot the curated skills the agent has installed by reading its live
  // /api/skills (best-effort: a down/unreachable box yields [] and the template
  // still saves, just without skills). Only a running box can report skills.
  const skills =
    row.status === "running" && typeof row.chat_url === "string"
      ? await snapshotInstalledTemplateSkillIds(
          row.chat_url,
          typeof row.api_token === "string" ? row.api_token : null,
        )
      : [];

  // The stored jsonb is already key-free (the encrypted key lives in a separate
  // column we never select here). Persist exactly what hivra_agents holds so a
  // launch from this template reproduces the identity, minus the secret.
  const { data: created, error: insErr } = await supabaseAdmin
    .from("agent_templates")
    .insert({
      owner_user_id: userId,
      slug,
      source: "community",
      type,
      name,
      goal: typeof row.goal === "string" ? row.goal : null,
      context: typeof row.context === "string" ? row.context : null,
      personality: typeof row.personality === "string" ? row.personality : null,
      emoji: typeof row.emoji === "string" ? row.emoji : null,
      llm_config: row.llm_config ?? null,
      skills,
      visibility: "private",
    })
    .select()
    .single();
  if (insErr || !created) {
    log.warn("agent template create failed", {
      source: "hivra/templates",
      failureType: "agent_template_create_failed",
      userId,
      agentId,
      errorMessage: insErr ? String(insErr.message ?? insErr) : "no row returned",
    });
    return null;
  }
  return toOwnerTemplate(created as Record<string, unknown>);
}

// List the templates a user owns (newest first). Never throws — returns [] on
// any failure.
export async function listUserTemplates(userId: string): Promise<OwnerTemplate[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("agent_templates")
    .select("*")
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    log.warn("agent template list failed", {
      source: "hivra/templates",
      failureType: "agent_template_list_failed",
      userId,
      errorMessage: String(error.message ?? error),
    });
    return [];
  }
  return (Array.isArray(data) ? data : []).map((r) => toOwnerTemplate(r as Record<string, unknown>));
}

// Load a template's identity for LAUNCH (fork). Resolves by id OR slug.
//   - Owner: full identity, including private `context`.
//   - Non-owner: only if visibility is public|link, and `context` is STRIPPED.
//   - Private + not owner: returns null (treated as a 404 by the caller).
// Never throws — returns null on any miss/error.
export async function getTemplateForLaunch(
  idOrSlug: string,
  requestingUserId: string | null,
): Promise<TemplateIdentity | null> {
  if (!supabaseAdmin) return null;
  const key = (idOrSlug || "").trim();
  if (!key) return null;

  // A uuid matches the id column; anything else can only be a slug. (Querying a
  // non-uuid against a uuid column errors in Postgres, so branch on shape.)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const column = isUuid ? "id" : "slug";
  const { data, error } = await supabaseAdmin
    .from("agent_templates")
    .select("owner_user_id, type, name, goal, context, personality, emoji, llm_config, skills, visibility")
    .eq(column, key)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  const owner = typeof row.owner_user_id === "string" ? row.owner_user_id : null;
  const visibility = isVisibility(row.visibility) ? row.visibility : "private";
  const isOwner = Boolean(requestingUserId) && owner === requestingUserId;

  // Private templates are launchable only by their owner.
  if (!isOwner && visibility === "private") return null;

  return {
    type: typeof row.type === "string" ? row.type : "",
    name: typeof row.name === "string" ? row.name : null,
    goal: typeof row.goal === "string" ? row.goal : null,
    // STRIP context for non-owners — it's free-text and possibly sensitive.
    context: isOwner && typeof row.context === "string" ? row.context : null,
    personality: typeof row.personality === "string" ? row.personality : null,
    emoji: typeof row.emoji === "string" ? row.emoji : null,
    // jsonb metadata is already key-free.
    llm_config: row.llm_config ?? null,
    // Skill ids are non-sensitive — carried for owner AND non-owner so a fork
    // from a shared template reproduces the skills (the network-effect lever).
    skills: coerceSkillIds(row.skills),
  };
}

// Change a template's visibility (owner only). Minting/keeping a share_token on
// link|public so the shared view has a stable URL; clearing it back to null on
// private so a re-private'd template is no longer reachable by an old link.
// Returns the updated owner view, or null on a not-owned/invalid request.
export async function setTemplateVisibility(
  userId: string,
  id: string,
  visibility: string,
): Promise<OwnerTemplate | null> {
  if (!supabaseAdmin) return null;
  if (!isVisibility(visibility)) return null;

  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("agent_templates")
    .select("id, share_token")
    .eq("id", id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (loadErr || !existing) return null;

  const existingToken =
    typeof (existing as Record<string, unknown>).share_token === "string"
      ? ((existing as Record<string, unknown>).share_token as string)
      : null;

  let shareToken: string | null;
  if (visibility === "private") {
    shareToken = null; // revoke the link
  } else {
    shareToken = existingToken || mintShareToken(); // mint once, then reuse
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from("agent_templates")
    .update({ visibility, share_token: shareToken, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_user_id", userId)
    .select()
    .single();
  if (updErr || !updated) {
    log.warn("agent template visibility update failed", {
      source: "hivra/templates",
      failureType: "agent_template_visibility_update_failed",
      userId,
      templateId: id,
      visibility,
      errorMessage: updErr ? String(updErr.message ?? updErr) : "no row returned",
    });
    return null;
  }
  return toOwnerTemplate(updated as Record<string, unknown>);
}

// Public read for a shared template by its share_token. Returns the identity
// with `context` ALWAYS stripped (the viewer is, by definition, not the owner
// here). Only link|public templates have a token, so a revoked/private template
// is automatically unreachable. Never throws.
export async function getPublicTemplateByShareToken(
  token: string,
): Promise<(TemplateIdentity & { id: string; slug: string; visibility: TemplateVisibility }) | null> {
  if (!supabaseAdmin) return null;
  const key = (token || "").trim();
  if (!key) return null;
  const { data, error } = await supabaseAdmin
    .from("agent_templates")
    .select("id, slug, type, name, goal, personality, emoji, llm_config, skills, visibility, share_token")
    .eq("share_token", key)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const visibility = isVisibility(row.visibility) ? row.visibility : "private";
  if (visibility === "private") return null; // defense in depth
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    type: typeof row.type === "string" ? row.type : "",
    name: typeof row.name === "string" ? row.name : null,
    goal: typeof row.goal === "string" ? row.goal : null,
    context: null, // never expose the owner's free-text context on a shared view
    personality: typeof row.personality === "string" ? row.personality : null,
    emoji: typeof row.emoji === "string" ? row.emoji : null,
    llm_config: publicLlmConfig(readStoredLlmConfig(row.llm_config)),
    skills: coerceSkillIds(row.skills), // ids are non-sensitive — safe on a shared view
    visibility,
  };
}

// Delete a template the user owns. Returns true on a successful delete of an
// owned row, false otherwise (not owned / db error). Never throws.
export async function deleteTemplate(userId: string, id: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from("agent_templates")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", userId)
    .select("id");
  if (error) {
    log.warn("agent template delete failed", {
      source: "hivra/templates",
      failureType: "agent_template_delete_failed",
      userId,
      templateId: id,
      errorMessage: String(error.message ?? error),
    });
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
