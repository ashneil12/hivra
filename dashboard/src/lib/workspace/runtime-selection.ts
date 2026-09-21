import type { WorkspaceSurface } from "./workspace-contracts";

/**
 * Remembers which runtime the owner last opened.
 *
 * `workspace-persistence` has always been able to store a selection, and the
 * fleet pane has always been able to read one — it renders a "Continue <name>"
 * link from it. What went missing is the middle: the only writer was
 * `UnifiedWorkspace`, and when the workspace route became a door into the
 * canonical agent route, nothing imported that component any more. The reader
 * shipped, the writer did not survive the merge, so the resume link could never
 * appear no matter how many runtimes you opened.
 *
 * This is that writer's replacement, driven from the runtime detail route —
 * which is the only place that actually knows both the runtime you are in and
 * the surface you are looking at.
 *
 * It records; it never navigates. Restoring a selection by redirecting is the
 * behaviour the fleet pane deliberately removed (arriving somewhere is not a
 * surprise), so a stored selection is only ever offered, never followed.
 */

/**
 * The Hivra per-agent tab vocabulary, mapped onto workspace surfaces.
 *
 * The two vocabularies were built for different shells and only partly overlap,
 * so this translation is explicit rather than a pass-through — the same reason
 * `workspace-redirect` spells its own mapping out. Tabs with no surface
 * equivalent (skills, telegram, tasks, manage) are settings for the runtime
 * rather than a place within it, and they resolve to the conversation: that is
 * this codebase's existing answer for an unstated surface, not a new invention.
 */
const AGENT_TAB_SURFACES: Record<string, WorkspaceSurface> = {
  chat: "conversation",
  aeon: "workspace",
  desktop: "desktop",
  files: "files",
  git: "git",
  terminal: "terminal",
  box: "terminal",
  browser: "browser",
};

export function agentTabSurface(tab: string): WorkspaceSurface {
  return AGENT_TAB_SURFACES[tab] ?? "conversation";
}

/** The source-qualified uid both fleet surfaces match on (`x-` Hivra, `h-` Hermes). */
export function hivraRuntimeUid(backingId: string): string {
  return `x-${backingId}`;
}

export function hermesRuntimeUid(backingId: string): string {
  return `h-${backingId}`;
}

/**
 * The `?tab=` a surface resumes on.
 *
 * The inverse of {@link agentTabSurface}, used when offering a stored selection
 * back. It is safe to name a specific tab even for a resource that cannot show
 * it: the canonical route reconciles the requested tab against what the
 * resource actually has (`resolveResourceLanding`), which is what makes
 * `?tab=chat` mean "primary view" rather than literally chat.
 */
export function surfaceTab(surface: WorkspaceSurface): string {
  if (surface === "conversation") return "chat";
  if (surface === "workspace") return "aeon";
  return surface;
}