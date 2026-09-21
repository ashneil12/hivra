import {
  DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT,
  MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT,
  clampTerminalWorkspacePanelHeight,
  closeTerminalWorkspaceTab,
  createDefaultTerminalWorkspaceState,
  getTerminalWorkspaceStorageKey,
  getTerminalWorkspaceTabTitle,
  normalizeTerminalWorkspaceState,
  openTerminalWorkspaceTab,
  readStoredTerminalWorkspaceState,
  renameTerminalWorkspaceTab,
  setTerminalWorkspaceActiveTab,
  setTerminalWorkspacePanelHeight,
  setTerminalWorkspaceTabStatus,
  writeStoredTerminalWorkspaceState,
} from "@/lib/terminal-workspace-state";

describe("terminal workspace state helpers", () => {
  it("builds deterministic storage keys and tab titles", () => {
    expect(getTerminalWorkspaceStorageKey("inst_123")).toBe("hermes_terminal_workspace_inst_123");
    expect(getTerminalWorkspaceTabTitle(3)).toBe("Terminal 3");
  });

  it("creates a default state with one idle tab", () => {
    const state = createDefaultTerminalWorkspaceState({
      idFactory: () => "tab-1",
    });

    expect(state).toEqual({
      panelHeight: DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT,
      tabs: [{ id: "tab-1", title: "Terminal 1", status: "idle" }],
      activeTabId: "tab-1",
      terminalCounter: 1,
    });
  });

  it("normalizes invalid persisted state back to a safe default", () => {
    const state = normalizeTerminalWorkspaceState(
      {
        panelHeight: 20,
        activeTabId: "missing",
        terminalCounter: 0,
        tabs: [{ id: "", title: "  ", status: "broken" }],
      },
      { idFactory: () => "fallback-tab" }
    );

    expect(state).toEqual({
      panelHeight: MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT,
      tabs: [{ id: "fallback-tab", title: "Terminal 1", status: "idle" }],
      activeTabId: "fallback-tab",
      terminalCounter: 1,
    });
  });

  it("opens, renames, activates, and marks tabs without mutating the rest of the state", () => {
    const initialState = createDefaultTerminalWorkspaceState({
      idFactory: () => "tab-1",
    });
    const withSecondTab = openTerminalWorkspaceTab(initialState, {
      idFactory: () => "tab-2",
    });
    const renamedState = renameTerminalWorkspaceTab(withSecondTab, "tab-2", "Deploy Shell");
    const activatedState = setTerminalWorkspaceActiveTab(renamedState, "tab-1");
    const statusState = setTerminalWorkspaceTabStatus(activatedState, "tab-2", "active");

    expect(withSecondTab.terminalCounter).toBe(2);
    expect(withSecondTab.activeTabId).toBe("tab-2");
    expect(renamedState.tabs[1]).toEqual({
      id: "tab-2",
      title: "Deploy Shell",
      status: "idle",
    });
    expect(activatedState.activeTabId).toBe("tab-1");
    expect(statusState.tabs[1]?.status).toBe("active");
  });

  it("creates a fallback tab when the last tab is closed", () => {
    const initialState = createDefaultTerminalWorkspaceState({
      idFactory: () => "tab-1",
    });
    const nextState = closeTerminalWorkspaceTab(initialState, "tab-1", {
      idFactory: () => "tab-2",
    });

    expect(nextState).toEqual({
      panelHeight: DEFAULT_TERMINAL_WORKSPACE_PANEL_HEIGHT,
      tabs: [{ id: "tab-2", title: "Terminal 2", status: "idle" }],
      activeTabId: "tab-2",
      terminalCounter: 2,
    });
  });

  it("clamps persisted panel height and round-trips through storage", () => {
    const getItem = jest.fn<string | null, [string]>().mockReturnValue(null);
    const setItem = jest.fn<void, [string, string]>();
    const storage = { getItem, setItem };
    const state = setTerminalWorkspacePanelHeight(
      createDefaultTerminalWorkspaceState({ idFactory: () => "tab-1" }),
      999,
      { maxHeight: 420 }
    );

    expect(clampTerminalWorkspacePanelHeight(40)).toBe(MIN_TERMINAL_WORKSPACE_PANEL_HEIGHT);
    expect(state.panelHeight).toBe(420);

    expect(writeStoredTerminalWorkspaceState("inst_123", state, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      "hermes_terminal_workspace_inst_123",
      JSON.stringify(state)
    );

    getItem.mockReturnValueOnce(JSON.stringify(state));

    expect(readStoredTerminalWorkspaceState("inst_123", storage)).toEqual(state);
  });
});
