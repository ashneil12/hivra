/** @jest-environment jsdom */
import {
  STANDING_TASKS_NUDGE_DISMISSED_KEY,
  dismissStandingTasksNudge,
  readStandingTasksNudgeDismissed,
} from "../standing-tasks-dismissal";

describe("standing-tasks nudge dismissal persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to not-dismissed when nothing is stored", () => {
    expect(readStandingTasksNudgeDismissed()).toBe(false);
  });

  it("dismiss persists, so a subsequent read (i.e. a page reload) stays dismissed", () => {
    expect(readStandingTasksNudgeDismissed()).toBe(false);
    dismissStandingTasksNudge();
    // Simulates the next mount reading localStorage during state init.
    expect(readStandingTasksNudgeDismissed()).toBe(true);
    expect(window.localStorage.getItem(STANDING_TASKS_NUDGE_DISMISSED_KEY)).toBe("1");
  });

  it("ignores any non-'1' stored value (only an explicit dismissal counts)", () => {
    window.localStorage.setItem(STANDING_TASKS_NUDGE_DISMISSED_KEY, "true");
    expect(readStandingTasksNudgeDismissed()).toBe(false);
  });

  it("never throws when localStorage is unavailable", () => {
    const original = window.localStorage.getItem;
    // Force a throw on access (private mode / blocked storage).
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new Error("blocked");
      },
    });
    expect(() => readStandingTasksNudgeDismissed()).not.toThrow();
    expect(readStandingTasksNudgeDismissed()).toBe(false);
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: original,
    });
  });
});
