import { readStoredJson, writeStoredJsonIfChanged } from "@/lib/client-storage";

export type TerminalWorkspaceTabStatus = "active" | "idle";

interface TerminalWorkspaceTab {
  id: string;
  title: string;
  status: TerminalWorkspaceTabStatus;
}

export interface TerminalWorkspaceState {
  panelHeight: number;
  tabs: Array<TerminalWorkspaceTab>;
  activeTabId: string;
  terminalCounter: number;
}

export const DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT = 280;
export const MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT = 100;

const TERMINAL_WORKSPACE_STORAGE_PREFIX = "hermes_terminal_workspace_";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminalWorkspaceTabStatus(value: unknown): value is TerminalWorkspaceTabStatus {
  return value === "active" || value === "idle";
}

function createTerminalWorkspaceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `terminal_${Math.random().toString(36).slice(2, 10)}`;
}

function clampTerminalCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export function clampTerminalWorkspacePanelHeight(
  value: number,
  options?: { maxHeight?: number }
): number {
  const rounded = Number.isFinite(value)
    ? Math.max(MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT, Math.round(value))
    : DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT;

  const maxHeight = options?.maxHeight;
  if (typeof maxHeight !== "number" || !Number.isFinite(maxHeight)) {
    return rounded;
  }

  return Math.min(rounded, Math.max(MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT, Math.round(maxHeight)));
}

export function getTerminalWorkspaceStorageKey(instanceId: string): string {
  return `${TERMINAL_WORKSPACE_STORAGE_PREFIX}${instanceId}`;
}

export function getTerminalWorkspaceTabTitle(counter: number): string {
  return `Terminal ${Math.max(1, Math.floor(counter))}`;
}

function createTerminalWorkspaceTab(
  counter: number,
  options?: {
    id?: string;
    title?: string;
    status?: TerminalWorkspaceTabStatus;
    idFactory?: () => string;
  }
): TerminalWorkspaceTab {
  const trimmedTitle = options?.title?.trim();

  return {
    id: options?.id?.trim() || options?.idFactory?.() || createTerminalWorkspaceId(),
    title: trimmedTitle || getTerminalWorkspaceTabTitle(counter),
    status: options?.status ?? "idle",
  };
}

export function createDefaultTerminalWorkspaceState(options?: {
  terminalCounter?: number;
  panelHeight?: number;
  idFactory?: () => string;
}): TerminalWorkspaceState {
  const terminalCounter = clampTerminalCounter(options?.terminalCounter);
  const initialTab = createTerminalWorkspaceTab(terminalCounter, {
    idFactory: options?.idFactory,
  });

  return {
    panelHeight: clampTerminalWorkspacePanelHeight(
      options?.panelHeight ?? DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT
    ),
    tabs: [initialTab],
    activeTabId: initialTab.id,
    terminalCounter,
  };
}

export function normalizeTerminalWorkspaceState(
  value: unknown,
  options?: { idFactory?: () => string }
): TerminalWorkspaceState {
  if (!isRecord(value)) {
    return createDefaultTerminalWorkspaceState(options);
  }

  const panelHeight = clampTerminalWorkspacePanelHeight(
    typeof value.panelHeight === "number"
      ? value.panelHeight
      : DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT
  );

  let terminalCounter = clampTerminalCounter(value.terminalCounter);
  const parsedTabs = Array.isArray(value.tabs) ? value.tabs : [];

  const tabs = parsedTabs
    .map((entry, index) => {
      if (!isRecord(entry)) {
        return null;
      }

      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id) {
        return null;
      }

      const counter = index + 1;
      const title =
        typeof entry.title === "string" && entry.title.trim().length > 0
          ? entry.title.trim()
          : getTerminalWorkspaceTabTitle(counter);

      terminalCounter = Math.max(terminalCounter, counter);

      return {
        id,
        title,
        status: isTerminalWorkspaceTabStatus(entry.status) ? entry.status : "idle",
      } satisfies TerminalWorkspaceTab;
    })
    .filter((entry): entry is TerminalWorkspaceTab => Boolean(entry));

  if (tabs.length === 0) {
    return createDefaultTerminalWorkspaceState({
      terminalCounter,
      panelHeight,
      idFactory: options?.idFactory,
    });
  }

  const activeTabId =
    typeof value.activeTabId === "string" && tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : tabs[0].id;

  return {
    panelHeight,
    tabs,
    activeTabId,
    terminalCounter,
  };
}

export function readStoredTerminalWorkspaceState(
  instanceId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
  options?: { idFactory?: () => string }
): TerminalWorkspaceState {
  return normalizeTerminalWorkspaceState(
    readStoredJson<TerminalWorkspaceState>(storage, getTerminalWorkspaceStorageKey(instanceId)),
    options
  );
}

export function writeStoredTerminalWorkspaceState(
  instanceId: string,
  state: TerminalWorkspaceState,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): boolean {
  return writeStoredJsonIfChanged(storage, getTerminalWorkspaceStorageKey(instanceId), state);
}

export function openTerminalWorkspaceTab(
  state: TerminalWorkspaceState,
  options?: {
    idFactory?: () => string;
    title?: string;
  }
): TerminalWorkspaceState {
  const nextCounter = clampTerminalCounter(state.terminalCounter) + 1;
  const nextTab = createTerminalWorkspaceTab(nextCounter, {
    idFactory: options?.idFactory,
    title: options?.title,
  });

  return {
    ...state,
    tabs: [...state.tabs, nextTab],
    activeTabId: nextTab.id,
    terminalCounter: nextCounter,
  };
}

export function closeTerminalWorkspaceTab(
  state: TerminalWorkspaceState,
  tabId: string,
  options?: { idFactory?: () => string }
): TerminalWorkspaceState {
  const nextTabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return createDefaultTerminalWorkspaceState({
      terminalCounter: clampTerminalCounter(state.terminalCounter) + 1,
      panelHeight: state.panelHeight,
      idFactory: options?.idFactory,
    });
  }

  return {
    ...state,
    tabs: nextTabs,
    activeTabId: nextTabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : nextTabs[0].id,
  };
}

export function renameTerminalWorkspaceTab(
  state: TerminalWorkspaceState,
  tabId: string,
  title: string
): TerminalWorkspaceState {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return state;
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: trimmedTitle } : tab)),
  };
}

export function setTerminalWorkspaceActiveTab(
  state: TerminalWorkspaceState,
  tabId: string
): TerminalWorkspaceState {
  if (!state.tabs.some((tab) => tab.id === tabId)) {
    return state;
  }

  return {
    ...state,
    activeTabId: tabId,
  };
}

export function setTerminalWorkspacePanelHeight(
  state: TerminalWorkspaceState,
  panelHeight: number,
  options?: { maxHeight?: number }
): TerminalWorkspaceState {
  const nextHeight = clampTerminalWorkspacePanelHeight(panelHeight, options);
  if (nextHeight === state.panelHeight) {
    return state;
  }

  return {
    ...state,
    panelHeight: nextHeight,
  };
}

export function setTerminalWorkspaceTabStatus(
  state: TerminalWorkspaceState,
  tabId: string,
  status: TerminalWorkspaceTabStatus
): TerminalWorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, status } : tab)),
  };
}
