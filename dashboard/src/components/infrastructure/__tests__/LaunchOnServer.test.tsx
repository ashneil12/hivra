/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { createLaunchDraft, LAUNCH_DRAFT_STORAGE_KEY, launchDraftStorageKey } from "@/lib/launch/draft-store";

import { usePendingLaunch } from "../LaunchOnServer";

const mockSearchParams = new Map<string, string>();
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => mockSearchParams.get(key) ?? null }),
}));

// The global Clerk mock signs in user_123.
const OWNER = "user_123";

function Probe() {
  return <output>{JSON.stringify(usePendingLaunch())}</output>;
}

function saveDraft(ownerId: string, overrides: Record<string, unknown>) {
  window.localStorage.setItem(launchDraftStorageKey(ownerId), JSON.stringify({ ...createLaunchDraft(), ...overrides }));
}

const sandboxDraft = { stage: "plan", resourceKind: "computer", profileId: "linux-terminal", name: "My sandbox" };

describe("usePendingLaunch", () => {
  beforeEach(() => {
    mockSearchParams.clear();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("reads the signed-in owner's unsent launch draft", () => {
    saveDraft(OWNER, sandboxDraft);
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ source: "journey", profileId: "linux-terminal" }));
  });

  it("never reads another account's draft on a shared browser", () => {
    saveDraft("user_someone_else", sandboxDraft);
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("null");
  });

  it("ignores a launch that was already sent", () => {
    saveDraft(OWNER, { ...sandboxDraft, launchState: "uncertain" });
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("null");
  });

  it("prefers the return link a launch sent the owner here with", () => {
    saveDraft(OWNER, sandboxDraft);
    mockSearchParams.set("launch", "codex");
    mockSearchParams.set("returnTo", "unified-launch");
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ source: "handoff", resourceId: "codex", unified: true }));
  });

  // Review of slice 5: reading the draft during render moved an older per-tab
  // draft into localStorage and deleted it, a side effect of rendering.
  it("reads an older per-tab draft without moving or deleting it", () => {
    const legacy = JSON.stringify({ ...createLaunchDraft(), ...sandboxDraft });
    window.sessionStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, legacy);
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ source: "journey", profileId: "linux-terminal" }));
    expect(window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY)).toBe(legacy);
    expect(window.localStorage.getItem(launchDraftStorageKey(OWNER))).toBeNull();
  });

  it("follows a draft saved in another tab", () => {
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("null");
    act(() => {
      saveDraft(OWNER, sandboxDraft);
      window.dispatchEvent(new StorageEvent("storage", { key: launchDraftStorageKey(OWNER) }));
    });
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ source: "journey", profileId: "linux-terminal" }));
  });
});
