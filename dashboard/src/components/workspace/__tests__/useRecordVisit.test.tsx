/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";

import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import { listRecents, recordVisit } from "@/lib/workspace/recents";

import { useRecordVisit, VISIT_DEBOUNCE_MS } from "../useRecordVisit";

const MINUTE = 60_000;
let clock: number;
let now: jest.SpyInstance;

beforeEach(() => {
  window.localStorage.clear();
  clock = 1_800_000_000_000;
  now = jest.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  now.mockRestore();
  jest.useRealTimers();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

const order = () => listRecents().map((visit) => [visit.uid, visit.usedAt]);

describe("useRecordVisit", () => {
  // Home's Continue and the switchers' Recent follow what you last used. With
  // two browser tabs, the one you opened last is not always that.
  it("records leaving, so the order is the one you last used", () => {
    const opened = clock;
    const a = renderHook(() => useRecordVisit("x-agent_a", "chat"));
    clock += 5 * MINUTE;
    const b = renderHook(() => useRecordVisit("x-agent_b", "chat"));
    b.unmount();
    clock += 115 * MINUTE;
    a.unmount();

    expect(order()).toEqual([["x-agent_a", opened + 120 * MINUTE], ["x-agent_b", opened + 5 * MINUTE]]);
  });

  it("records when the page is hidden and when it is shown again", () => {
    const start = clock;
    const a = renderHook(() => useRecordVisit("x-agent_a", "files"));
    clock += MINUTE;
    recordVisit("x-agent_b", "chat");
    clock += MINUTE;
    setVisibility("hidden");
    expect(order()[0]).toEqual(["x-agent_a", start + 2 * MINUTE]);

    clock += MINUTE;
    recordVisit("x-agent_b", "chat");
    clock += MINUTE;
    setVisibility("visible");
    expect(order()[0]).toEqual(["x-agent_a", start + 4 * MINUTE]);
    a.unmount();
  });

  it("records the page closing, when no clean-up runs", () => {
    renderHook(() => useRecordVisit("x-agent_a", "chat"));
    clock += MINUTE;
    recordVisit("x-agent_b", "chat");
    clock += MINUTE;
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(order()[0]).toEqual(["x-agent_a", clock]);
  });

  it("writes a surface change after a pause, and on leaving before it", () => {
    jest.useFakeTimers({ doNotFake: ["Date"] });
    const view = renderHook(({ tab }: { tab: AgentSurfaceId }) => useRecordVisit("x-agent_a", tab), {
      initialProps: { tab: "chat" },
    });
    view.rerender({ tab: "files" });
    expect(listRecents()[0].tab).toBe("chat");
    act(() => { jest.advanceTimersByTime(VISIT_DEBOUNCE_MS); });
    expect(listRecents()[0].tab).toBe("files");

    view.rerender({ tab: "box" });
    view.unmount();
    expect(listRecents()[0].tab).toBe("box");
  });

  it("records the resource left when the same view opens another", () => {
    const view = renderHook(({ uid }: { uid: string | null }) => useRecordVisit(uid, uid ? "chat" : null), {
      initialProps: { uid: "x-agent_a" as string | null },
    });
    clock += MINUTE;
    recordVisit("x-agent_c", "chat");
    clock += MINUTE;
    // The next agent is still loading: the one left was in use until now.
    view.rerender({ uid: null });
    expect(order()[0]).toEqual(["x-agent_a", clock]);
    clock += MINUTE;
    view.rerender({ uid: "x-agent_b" });
    expect(order().map(([uid]) => uid)).toEqual(["x-agent_b", "x-agent_a", "x-agent_c"]);
    view.unmount();
  });

  it("records nothing while nothing is open", () => {
    const view = renderHook(() => useRecordVisit(null, null));
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    view.unmount();
    expect(listRecents()).toEqual([]);
  });
});
