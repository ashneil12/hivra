import { AGENT_SURFACE_IDS, type AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";

import { surfaceTab } from "./runtime-selection";
import type { WorkspaceSurface } from "./workspace-contracts";
import {
  clearWorkspaceSelection,
  isWorkspaceAgentUid,
  restoreWorkspaceSelection,
} from "./workspace-persistence";

/**
 * The agents and computers you used in this browser, most recently used first,
 * and the exact surface you were on in each.
 *
 * This replaces two lossy memories. The single "last selection" record kept one
 * resource and folded its tab into the workspace vocabulary, where the
 * computer's own Terminal (`box`) and the agent's command line (`terminal`)
 * are the same word, so resuming someone who was in Computer › Terminal opened
 * the agent's session instead. And a global chat-or-terminal preference was
 * shared by every agent, so using one agent's command line made the next agent
 * you opened start on its command line too. Each entry here stores the page's
 * own tab id, per resource.
 *
 * It is browser-local, like the record it replaces: it follows neither the
 * account to another device nor another browser. Everything read back is
 * validated as strictly as that record, and a stored value that fails is
 * cleared rather than trusted.
 */

export const RECENTS_STORAGE_KEY = "hivra.workspace.recents" as const;
/** How many resources are remembered. Home and the switchers show fewer. */
export const MAX_RECENTS = 12;

const RECENTS_VERSION = 1 as const;
const MAX_STORED_RECENTS_LENGTH = 4096;
const LIST_KEYS = ["version", "visits"] as const;
const VISIT_KEYS = ["tab", "uid", "usedAt"] as const;
const SURFACE_IDS = new Set<string>(AGENT_SURFACE_IDS);
/** The retired global chat/terminal preference, removed once on migration. */
const LEGACY_LAST_VIEW_KEY = "hivra:agent-last-view";

export interface RecentVisit {
  /** Source-qualified uid: `x-<id>` for a Hivra agent or computer, `h-<id>` for
   *  Hermes, `a-<attachment id>` for an agent added to a computer. */
  uid: string;
  /** The surface that was open, in the resource page's own tab vocabulary. */
  tab: AgentSurfaceId;
  /**
   * When it was last on screen, in ms since the epoch: opened, moved between
   * surfaces, left, or its browser tab hidden or shown. 0 when not known.
   */
  usedAt: number;
}

type RecentsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): RecentsStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRecentTab(value: unknown): value is AgentSurfaceId {
  return typeof value === "string" && SURFACE_IDS.has(value);
}

function parseVisit(value: unknown): RecentVisit | null {
  if (!isRecord(value) || !hasExactKeys(value, VISIT_KEYS)) return null;
  const { uid, tab, usedAt } = value;
  if (!isWorkspaceAgentUid(uid) || !isRecentTab(tab)) return null;
  if (typeof usedAt !== "number" || !Number.isSafeInteger(usedAt) || usedAt < 0) return null;
  return { uid, tab, usedAt };
}

function parseList(value: unknown): RecentVisit[] | null {
  if (!isRecord(value) || !hasExactKeys(value, LIST_KEYS)) return null;
  if (value.version !== RECENTS_VERSION || !Array.isArray(value.visits)) return null;
  if (value.visits.length > MAX_RECENTS) return null;
  const visits: RecentVisit[] = [];
  const seen = new Set<string>();
  for (const candidate of value.visits) {
    const visit = parseVisit(candidate);
    // A repeated uid is not something this module writes.
    if (!visit || seen.has(visit.uid)) return null;
    seen.add(visit.uid);
    visits.push(visit);
  }
  return visits;
}

function clear(storage: RecentsStorage): void {
  try {
    storage.removeItem(RECENTS_STORAGE_KEY);
  } catch {
    // Storage can be disabled or quota-restricted. Recents stay optional.
  }
}

function write(storage: RecentsStorage, visits: readonly RecentVisit[]): boolean {
  try {
    storage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ version: RECENTS_VERSION, visits }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The tab to resume for a record written before recents existed.
 *
 * Its `terminal` is ambiguous: it was written for the computer's Terminal and
 * for the agent's command line alike. Resuming it as either could be wrong,
 * and guessing the command line is the harmful guess (it can start a session
 * the owner never asked for), so it resumes the resource's primary view.
 */
function legacyTab(surface: WorkspaceSurface): AgentSurfaceId {
  if (surface === "terminal" || surface === "native") return "chat";
  const tab = surfaceTab(surface);
  return isRecentTab(tab) ? tab : "chat";
}

/** Carries the single last-selection record over, once, and retires it. */
function migrate(storage: RecentsStorage): RecentVisit[] {
  const legacy = restoreWorkspaceSelection(storage);
  // Its time was never recorded, so it is not claimed.
  const visits = legacy ? [{ uid: legacy.uid, tab: legacyTab(legacy.surface), usedAt: 0 }] : [];
  if (visits.length > 0 && !write(storage, visits)) return visits;
  clearWorkspaceSelection(storage);
  try {
    storage.removeItem(LEGACY_LAST_VIEW_KEY);
  } catch {
    // Nothing reads it any more; leaving it behind is harmless.
  }
  return visits;
}

function read(storage: RecentsStorage): RecentVisit[] {
  let raw: string | null;
  try {
    raw = storage.getItem(RECENTS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return migrate(storage);
  if (raw.length > MAX_STORED_RECENTS_LENGTH) {
    clear(storage);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clear(storage);
    return [];
  }
  const visits = parseList(parsed);
  if (!visits) {
    clear(storage);
    return [];
  }
  return visits;
}

/** Recently used resources, most recent first. Never throws. */
export function listRecents(storage?: RecentsStorage): RecentVisit[] {
  const target = storage ?? browserStorage();
  return target ? read(target) : [];
}

/**
 * Records that `uid` is in use on `tab` now: it moves to the front, keeping one
 * entry per resource. A value that is not a safe uid or a known tab is ignored,
 * and it never discards the list it failed to add to.
 */
export function recordVisit(
  uid: string,
  tab: AgentSurfaceId,
  options: { now?: number; storage?: RecentsStorage } = {},
): boolean {
  const target = options.storage ?? browserStorage();
  if (!target || !isWorkspaceAgentUid(uid) || !isRecentTab(tab)) return false;
  const usedAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(usedAt) || usedAt < 0) return false;
  const visits = [
    { uid, tab, usedAt },
    ...read(target).filter((visit) => visit.uid !== uid),
  ].slice(0, MAX_RECENTS);
  return write(target, visits);
}

/** The surface `uid` was last open on in this browser, or null. */
export function lastTabFor(uid: string, storage?: RecentsStorage): AgentSurfaceId | null {
  return listRecents(storage).find((visit) => visit.uid === uid)?.tab ?? null;
}

/**
 * Where to send someone back to `uid`: its own page, on the surface they were
 * last on there. A Hermes agent has one surface, so its route takes no tab.
 *
 * `fallback` is the resource's usual link, used unchanged when nothing is
 * remembered or when it already names the remembered surface (so its extra
 * parameters, such as a fast desktop open, are kept). Naming a surface the
 * resource no longer has is safe: the page falls back to its landing view.
 */
export function recentHref(uid: string, fallback?: string, storage?: RecentsStorage): string {
  return visitHref(uid, lastTabFor(uid, storage), fallback);
}

/** {@link recentHref} for a tab already in hand, without reading storage. */
export function visitHref(uid: string, tab: AgentSurfaceId | null, fallback?: string): string {
  if (!isWorkspaceAgentUid(uid)) return fallback ?? "/dashboard?runtimes=1";
  const id = uid.slice(2);
  if (uid.startsWith("h-")) return fallback ?? `/dashboard/instances/${encodeURIComponent(id)}`;
  // An added agent's id is its attachment, never a page: only its own link
  // (the computer's Chat tab) opens it.
  if (uid.startsWith("a-")) return fallback ?? "/dashboard?runtimes=1";
  const base = `/dashboard/agent/${encodeURIComponent(id)}`;
  if (!tab) return fallback ?? base;
  if (fallback) {
    try {
      if (new URL(fallback, "https://hivra.invalid").searchParams.get("tab") === tab) return fallback;
    } catch {
      // A malformed fallback is replaced by the canonical link below.
    }
  }
  return `${base}?tab=${tab}`;
}
