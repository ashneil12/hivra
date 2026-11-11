/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { readPanelPrefs, usePanelPrefs } from "../usePanelPrefs";

const KEY = "hivra.commandPanel.v1:agent-1";

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("usePanelPrefs", () => {
  it("starts from the defaults and lets an action be hidden and shown again", () => {
    const { result } = renderHook(() => usePanelPrefs("agent-1"));
    expect(result.current.isActionShown("update", true)).toBe(true);
    expect(result.current.isActionShown("channels", false)).toBe(false);
    act(() => result.current.setActionShown("update", false));
    expect(result.current.isActionShown("update", true)).toBe(false);
    act(() => result.current.setActionShown("update", true));
    expect(result.current.isActionShown("update", true)).toBe(true);
    act(() => result.current.setActionShown("channels", true));
    expect(result.current.isActionShown("channels", false)).toBe(true);
  });

  it("remembers Not interested for good, per agent", () => {
    const first = renderHook(() => usePanelPrefs("agent-1"));
    expect(first.result.current.isSuggestionShown("channels")).toBe(true);
    act(() => first.result.current.setSuggestionShown("channels", false));
    first.unmount();
    const again = renderHook(() => usePanelPrefs("agent-1"));
    expect(again.result.current.isSuggestionShown("channels")).toBe(false);
    const other = renderHook(() => usePanelPrefs("agent-2"));
    expect(other.result.current.isSuggestionShown("channels")).toBe(true);
    act(() => again.result.current.setSuggestionShown("channels", true));
    expect(readPanelPrefs("agent-1").suggestions.channels).toBe(true);
  });

  it("remembers whether the panel is open and the activity choices", () => {
    const first = renderHook(() => usePanelPrefs("agent-1"));
    expect(first.result.current.prefs.open).toBeNull();
    act(() => { first.result.current.setOpen(false); first.result.current.setActivityOpen(false); first.result.current.setActivityShown(false); });
    first.unmount();
    const again = renderHook(() => usePanelPrefs("agent-1"));
    expect(again.result.current.prefs).toMatchObject({ open: false, activityOpen: false, activity: false });
  });

  it("ignores a saved value it does not understand", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(renderHook(() => usePanelPrefs("agent-1")).result.current.prefs.open).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ open: "yes", actions: { update: "no", files: false }, suggestions: [] }));
    const { prefs } = renderHook(() => usePanelPrefs("agent-1")).result.current;
    expect(prefs.open).toBeNull();
    expect(prefs.actions).toEqual({ files: false });
    expect(prefs.suggestions).toEqual({});
  });

  it("keeps working for this page when storage throws", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => usePanelPrefs("agent-1"));
    expect(result.current.isActionShown("files", true)).toBe(true);
    act(() => result.current.setActionShown("files", false));
    act(() => result.current.setSuggestionShown("channels", false));
    expect(result.current.isActionShown("files", true)).toBe(false);
    expect(result.current.isSuggestionShown("channels")).toBe(false);
  });
});
