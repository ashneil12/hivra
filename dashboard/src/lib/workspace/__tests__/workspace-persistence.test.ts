/** @jest-environment jsdom */

import type { WorkspaceSurface } from "../workspace-contracts";
import {
  WORKSPACE_SELECTION_STORAGE_KEY,
  clearWorkspaceSelection,
  persistWorkspaceSelection,
  restoreWorkspaceSelection,
} from "../workspace-persistence";

describe("workspace selection persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores exactly the versioned source-qualified UID and enumerated surface", () => {
    expect(
      persistWorkspaceSelection({ uid: "x-agent-1", surface: "terminal" }),
    ).toBe(true);

    const raw = window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      uid: "x-agent-1",
      surface: "terminal",
    });
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual([
      "surface",
      "uid",
      "version",
    ]);
    expect(restoreWorkspaceSelection()).toEqual({
      uid: "x-agent-1",
      surface: "terminal",
    });
  });

  it.each([
    ["malformed JSON", "not-json"],
    [
      "an expired schema version",
      JSON.stringify({ version: 0, uid: "x-agent-1", surface: "terminal" }),
    ],
    [
      "an unqualified identity",
      JSON.stringify({ version: 1, uid: "agent-1", surface: "terminal" }),
    ],
    [
      "a token-shaped identity",
      JSON.stringify({ version: 1, uid: "x-api-token-secret", surface: "terminal" }),
    ],
    [
      "an unknown surface",
      JSON.stringify({ version: 1, uid: "x-agent-1", surface: "admin" }),
    ],
    [
      "a credential-bearing extra field",
      JSON.stringify({
        version: 1,
        uid: "x-agent-1",
        surface: "terminal",
        token: "DO_NOT_PERSIST_SECRET",
      }),
    ],
  ])("rejects and clears %s", (_label, raw) => {
    window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, raw);

    expect(restoreWorkspaceSelection()).toBeNull();
    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it("rejects unsafe writes instead of retaining an older selection", () => {
    persistWorkspaceSelection({ uid: "h-safe", surface: "conversation" });

    expect(
      persistWorkspaceSelection({
        uid: "x-bearer-secret",
        surface: "terminal" as WorkspaceSurface,
      }),
    ).toBe(false);
    expect(restoreWorkspaceSelection()).toBeNull();
  });

  it("clears the fixed origin-local key without touching other storage", () => {
    window.localStorage.setItem("unrelated", "keep-me");
    persistWorkspaceSelection({ uid: "h-safe", surface: "conversation" });

    clearWorkspaceSelection();

    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep-me");
  });
});
