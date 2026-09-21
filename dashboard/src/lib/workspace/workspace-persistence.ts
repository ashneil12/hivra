import { AGENT_COMPUTER_SURFACES } from "@/lib/agent-computers/contracts";

import type { WorkspaceSurface } from "./workspace-contracts";

export const WORKSPACE_SELECTION_STORAGE_KEY =
  "hivra.workspace.last-selection" as const;

const WORKSPACE_SELECTION_VERSION = 1 as const;
const MAX_BACKING_ID_LENGTH = 128;
const MAX_STORED_SELECTION_LENGTH = 512;
const SOURCE_QUALIFIED_UID = new RegExp(
  `^[hx]-[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_BACKING_ID_LENGTH - 1}}$`,
);
const TOKEN_MARKERS = /(?:^|[-_.:])(bearer|token|api[-_]?key|secret|sk[-_]|pk[-_])/i;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const WORKSPACE_SURFACES = new Set<WorkspaceSurface>([
  "conversation",
  ...AGENT_COMPUTER_SURFACES,
]);
const RECORD_KEYS = ["surface", "uid", "version"] as const;

interface WorkspaceSelectionRecord {
  version: typeof WORKSPACE_SELECTION_VERSION;
  uid: string;
  surface: WorkspaceSurface;
}

export interface WorkspaceSelection {
  uid: string;
  surface: WorkspaceSurface;
}

type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): SelectionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function selectedStorage(storage?: SelectionStorage): SelectionStorage | null {
  return storage ?? browserStorage();
}

function isWorkspaceAgentUid(value: unknown): value is string {
  if (typeof value !== "string" || !SOURCE_QUALIFIED_UID.test(value)) {
    return false;
  }

  const backingId = value.slice(2);
  return !TOKEN_MARKERS.test(backingId) && !JWT_LIKE.test(backingId);
}

function isWorkspaceSurface(value: unknown): value is WorkspaceSurface {
  return (
    typeof value === "string" &&
    WORKSPACE_SURFACES.has(value as WorkspaceSurface)
  );
}

function parseRecord(value: unknown): WorkspaceSelectionRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    !keys.every((key, index) => key === RECORD_KEYS[index])
  ) {
    return null;
  }

  if (
    record.version !== WORKSPACE_SELECTION_VERSION ||
    !isWorkspaceAgentUid(record.uid) ||
    !isWorkspaceSurface(record.surface)
  ) {
    return null;
  }

  return {
    version: WORKSPACE_SELECTION_VERSION,
    uid: record.uid,
    surface: record.surface,
  };
}

export function clearWorkspaceSelection(storage?: SelectionStorage): void {
  const target = selectedStorage(storage);
  if (!target) return;
  try {
    target.removeItem(WORKSPACE_SELECTION_STORAGE_KEY);
  } catch {
    // Storage can be disabled or quota-restricted. Selection remains optional.
  }
}

export function persistWorkspaceSelection(
  selection: WorkspaceSelection,
  storage?: SelectionStorage,
): boolean {
  const target = selectedStorage(storage);
  if (!target) return false;

  const record = parseRecord({
    version: WORKSPACE_SELECTION_VERSION,
    uid: selection.uid,
    surface: selection.surface,
  });
  if (!record) {
    clearWorkspaceSelection(target);
    return false;
  }

  try {
    target.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function restoreWorkspaceSelection(
  storage?: SelectionStorage,
): WorkspaceSelection | null {
  const target = selectedStorage(storage);
  if (!target) return null;

  let raw: string | null;
  try {
    raw = target.getItem(WORKSPACE_SELECTION_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) return null;
  if (raw.length > MAX_STORED_SELECTION_LENGTH) {
    clearWorkspaceSelection(target);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearWorkspaceSelection(target);
    return null;
  }

  const record = parseRecord(parsed);
  if (!record) {
    clearWorkspaceSelection(target);
    return null;
  }

  return { uid: record.uid, surface: record.surface };
}
