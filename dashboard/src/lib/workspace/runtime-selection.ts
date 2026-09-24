import type { WorkspaceSurface } from "./workspace-contracts";

/**
 * Identity and surface vocabulary shared by the places that remember which
 * resource the owner last opened.
 *
 * Remembering itself lives in `recents`: the resource routes record each visit
 * with the page's own tab id, and Home and the switchers read it back. This
 * module used to translate those tabs into workspace surfaces for a single
 * stored selection, which folded the computer's Terminal (`box`) into the
 * agent's command line (`terminal`); recents keep the tab exactly, so that
 * translation is gone.
 */

/** The source-qualified uid both fleet surfaces match on (`x-` Hivra, `h-` Hermes). */
export function hivraRuntimeUid(backingId: string): string {
  return `x-${backingId}`;
}

export function hermesRuntimeUid(backingId: string): string {
  return `h-${backingId}`;
}

/**
 * The `?tab=` a workspace surface names on the agent route.
 *
 * Used when carrying a record written in the workspace vocabulary over to the
 * agent route's. It is safe to name a specific tab even for a resource that
 * cannot show it: the canonical route reconciles the requested tab against
 * what the resource actually has (`resolveResourceLanding`), which is what
 * makes `?tab=chat` mean "primary view" rather than literally chat.
 */
export function surfaceTab(surface: WorkspaceSurface): string {
  if (surface === "conversation") return "chat";
  if (surface === "workspace") return "aeon";
  return surface;
}
