import type { LaunchAgentProfileId } from "./contracts";

/** A saved template a launch starts from, as far as Launch needs to know it:
 * which template, what it is called, and what it runs. The launch sends only
 * the id; the server applies the template's instructions, personality and
 * skills, checking the owner may use it. */
export type LaunchTemplate = {
  id: string;
  name: string | null;
  profileId: LaunchAgentProfileId;
};

/** A template id or slug, or a share token: letters, digits, "-" and "_". */
const TEMPLATE_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function safeTemplateRef(value: unknown): string | null {
  return typeof value === "string" && TEMPLATE_REF.test(value) ? value : null;
}

/** Templates are saved from Hivra agents; these are the ones Launch can start
 * from one. A plain Hermes agent has no template to fork. */
const TEMPLATE_PROFILES: Readonly<Record<string, LaunchAgentProfileId>> = {
  "claude-code": "claude-code",
  codex: "codex",
  openclaw: "openclaw",
  "agent-zero": "agent-zero",
  aeon: "aeon",
};

export function launchProfileForTemplate(type: unknown): LaunchAgentProfileId | null {
  return typeof type === "string" && Object.hasOwn(TEMPLATE_PROFILES, type) ? TEMPLATE_PROFILES[type] : null;
}

export type LaunchTemplateLookup =
  | { status: "found"; template: LaunchTemplate }
  /** Gone, never shared with this owner, or for an agent Launch can't start. */
  | { status: "unavailable"; message: string }
  /** The lookup itself failed; it says nothing about the template. */
  | { status: "failed"; message: string };

const UNAVAILABLE = "This template is no longer available. Choose what to launch instead.";

function readTemplate(value: unknown): LaunchTemplateLookup {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const id = safeTemplateRef(row?.id);
  if (!row || !id) return { status: "unavailable", message: UNAVAILABLE };
  const profileId = launchProfileForTemplate(row.type);
  if (!profileId) {
    return { status: "unavailable", message: "This template's agent can't be launched from a template yet. Choose what to launch instead." };
  }
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 60) : null;
  return { status: "found", template: { id, name, profileId } };
}

/** Reads a template the owner saved, or one shared with them by link. */
export async function loadLaunchTemplate(
  ref: string,
  shareToken: string | null,
  fetcher: typeof fetch = fetch,
): Promise<LaunchTemplateLookup> {
  try {
    if (shareToken) {
      const response = await fetcher(`/api/hivra/templates/shared/${encodeURIComponent(shareToken)}`, { cache: "no-store" });
      if (response.status === 404) return { status: "unavailable", message: UNAVAILABLE };
      const body = await response.json().catch(() => null) as { success?: boolean; data?: { template?: Record<string, unknown> } } | null;
      if (!response.ok || body?.success !== true) return { status: "failed", message: "Couldn't load that template. Try again, or choose what to launch instead." };
      const template = body.data?.template;
      // The link must be for the template the page was asked to start from.
      if (!template || (template.id !== ref && template.slug !== ref)) return { status: "unavailable", message: UNAVAILABLE };
      return readTemplate(template);
    }
    const response = await fetcher("/api/hivra/templates", { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null) as { success?: boolean; data?: { templates?: unknown } } | null;
    if (!response.ok || body?.success !== true || !Array.isArray(body.data?.templates)) {
      return { status: "failed", message: "Couldn't load that template. Try again, or choose what to launch instead." };
    }
    const template = (body.data.templates as Array<Record<string, unknown>>)
      .find(candidate => candidate?.id === ref || candidate?.slug === ref);
    return template ? readTemplate(template) : { status: "unavailable", message: UNAVAILABLE };
  } catch {
    return { status: "failed", message: "Couldn't load that template. Try again, or choose what to launch instead." };
  }
}
