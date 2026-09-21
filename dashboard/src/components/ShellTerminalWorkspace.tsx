"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";

import { TerminalPanel } from "@/components/TerminalPanel";
import {
  openTerminalWorkspaceTab,
  closeTerminalWorkspaceTab,
  readStoredTerminalWorkspaceState,
  setTerminalWorkspaceActiveTab,
  writeStoredTerminalWorkspaceState,
  type TerminalWorkspaceState,
} from "@/lib/terminal-workspace-state";

interface ShellTerminalWorkspaceProps {
  instanceId: string;
  isActive: boolean;
}

function syncWorkspaceStatuses(state: TerminalWorkspaceState): TerminalWorkspaceState {
  const nextTabs = state.tabs.map((tab) => ({
    ...tab,
    status: tab.id === state.activeTabId ? ("active" as const) : ("idle" as const),
  }));

  const tabsChanged = nextTabs.some((tab, index) => {
    const previousTab = state.tabs[index];
    return previousTab.status !== tab.status;
  });

  if (!tabsChanged) {
    return state;
  }

  return {
    ...state,
    tabs: nextTabs,
  };
}

function mergeRenderedTabIds(
  currentIds: string[],
  workspace: TerminalWorkspaceState
): string[] {
  const validTabIds = new Set(workspace.tabs.map((tab) => tab.id));
  const nextIds = currentIds.filter((tabId) => validTabIds.has(tabId));

  if (!nextIds.includes(workspace.activeTabId)) {
    nextIds.push(workspace.activeTabId);
  }

  if (nextIds.length === currentIds.length && nextIds.every((tabId, index) => tabId === currentIds[index])) {
    return currentIds;
  }

  return nextIds;
}

function loadInitialWorkspace(instanceId: string): TerminalWorkspaceState {
  return syncWorkspaceStatuses(
    typeof window === "undefined"
      ? readStoredTerminalWorkspaceState(instanceId, {
          getItem: () => null,
        })
      : readStoredTerminalWorkspaceState(instanceId)
  );
}

export function ShellTerminalWorkspace({
  instanceId,
  isActive,
}: ShellTerminalWorkspaceProps) {
  const initialWorkspace = useMemo(() => loadInitialWorkspace(instanceId), [instanceId]);
  const [workspace, setWorkspace] = useState<TerminalWorkspaceState>(initialWorkspace);
  const [renderedTabIds, setRenderedTabIds] = useState<string[]>(() => [initialWorkspace.activeTabId]);

  useEffect(() => {
    writeStoredTerminalWorkspaceState(instanceId, workspace);
  }, [instanceId, workspace]);

  const activeTab = useMemo(
    () => workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null,
    [workspace]
  );

  const handleOpenTab = useCallback(() => {
    const nextWorkspace = syncWorkspaceStatuses(openTerminalWorkspaceTab(workspace));
    setWorkspace(nextWorkspace);
    setRenderedTabIds((currentIds) => mergeRenderedTabIds(currentIds, nextWorkspace));
  }, [workspace]);

  const handleActivateTab = useCallback((tabId: string) => {
    const nextWorkspace = syncWorkspaceStatuses(setTerminalWorkspaceActiveTab(workspace, tabId));
    setWorkspace(nextWorkspace);
    setRenderedTabIds((currentIds) => mergeRenderedTabIds(currentIds, nextWorkspace));
  }, [workspace]);

  const handleCloseTab = useCallback((tabId: string) => {
    const nextWorkspace = syncWorkspaceStatuses(closeTerminalWorkspaceTab(workspace, tabId));
    setWorkspace(nextWorkspace);
    setRenderedTabIds((currentIds) => mergeRenderedTabIds(currentIds, nextWorkspace));
  }, [workspace]);

  if (!activeTab) {
    return null;
  }

  return (
    <div
      data-testid="shell-terminal-workspace"
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        minHeight: 0,
        background: "#050711",
        color: "#e5e7eb",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 10px",
          borderBottom: "1px solid rgba(150, 166, 190, 0.12)",
          background: "rgba(9, 12, 22, 0.94)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            flex: 1,
            overflowX: "auto",
            scrollbarWidth: "thin",
          }}
        >
          {workspace.tabs.map((tab) => {
            const isTabActive = tab.id === workspace.activeTabId;

            return (
              <div
                key={tab.id}
                data-testid={`shell-terminal-tab-${tab.id}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                  minWidth: 0,
                  maxWidth: 220,
                  borderRadius: 6,
                  border: isTabActive
                    ? "1px solid rgba(45, 212, 191, 0.28)"
                    : "1px solid rgba(148, 163, 184, 0.12)",
                  background: isTabActive ? "rgba(45, 212, 191, 0.08)" : "rgba(13, 18, 30, 0.74)",
                }}
              >
                <button
                  type="button"
                  onClick={() => handleActivateTab(tab.id)}
                  aria-pressed={isTabActive}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    color: isTabActive ? "#f8fafc" : "rgba(203, 213, 225, 0.76)",
                    cursor: "pointer",
                    padding: "7px 8px",
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    fontWeight: isTabActive ? 700 : 500,
                  }}
                >
                  <TerminalIcon size={13} aria-hidden="true" style={{ color: tab.status === "active" ? "#2dd4bf" : "rgba(148, 163, 184, 0.62)", flexShrink: 0 }} />
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tab.title}
                  </span>
                </button>

                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    border: "none",
                    background: "transparent",
                    color: isTabActive ? "rgba(226, 232, 240, 0.72)" : "rgba(148, 163, 184, 0.58)",
                    cursor: "pointer",
                    flexShrink: 0,
                    borderRadius: 4,
                    marginRight: 2,
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleOpenTab}
          aria-label="Open another terminal tab"
          title="New tab"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 6,
            border: "1px solid rgba(45, 212, 191, 0.22)",
            background: "rgba(45, 212, 191, 0.08)",
            color: "#99f6e4",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Plus size={16} />
        </button>
      </div>

      <div
        data-testid="shell-terminal-workspace-body"
        style={{
          position: "relative",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {renderedTabIds.map((tabId) => {
          const tab = workspace.tabs.find((entry) => entry.id === tabId);
          if (!tab) {
            return null;
          }

          const isTabActive = workspace.activeTabId === tab.id;

          return (
            <div
              key={tab.id}
              data-testid={`shell-terminal-surface-${tab.id}`}
              aria-hidden={!isTabActive}
              style={{
                position: "absolute",
                inset: 0,
                visibility: isTabActive ? "visible" : "hidden",
                opacity: isTabActive ? 1 : 0,
                pointerEvents: isTabActive ? "auto" : "none",
              }}
            >
              <TerminalPanel
                instanceId={instanceId}
                isActive={isActive && isTabActive}
                sessionMode="shell"
                surfaceKey={tab.id}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
