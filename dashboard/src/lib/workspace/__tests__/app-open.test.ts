/** @jest-environment jsdom */
import { HOME_OPENED_STORAGE_KEY, isAppOpenAtHome, markHomeOpened } from "../app-open";

// jsdom has no navigation timing; each case says how the document opened.
function navigationEntries(entries: PerformanceEntry[]) {
  Object.defineProperty(performance, "getEntriesByType", {
    configurable: true,
    value: (kind: string) => (kind === "navigation" ? entries : []),
  });
}

function openedAt(url: string, type: NavigationTimingType = "navigate") {
  navigationEntries([{ name: url, type } as unknown as PerformanceEntry]);
}

describe("app open at Home", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    delete (performance as unknown as Record<string, unknown>).getEntriesByType;
  });

  it("is the app opened at Home: a fresh load of /dashboard not shown yet in this tab", () => {
    openedAt(`${window.location.origin}/dashboard`);
    expect(isAppOpenAtHome()).toBe(true);
  });

  it("is only once per tab: Home shown already, the Home link and the logo show the list", () => {
    openedAt(`${window.location.origin}/dashboard`);
    markHomeOpened();
    expect(window.sessionStorage.getItem(HOME_OPENED_STORAGE_KEY)).toBe("1");
    expect(isAppOpenAtHome()).toBe(false);
  });

  it("is not when the app opened somewhere else and Home was reached from inside it", () => {
    openedAt(`${window.location.origin}/dashboard/agent/codex-1?tab=chat`);
    expect(isAppOpenAtHome()).toBe(false);
  });

  it("is not on a reload or a back/forward to Home", () => {
    openedAt(`${window.location.origin}/dashboard`, "reload");
    expect(isAppOpenAtHome()).toBe(false);
    openedAt(`${window.location.origin}/dashboard`, "back_forward");
    expect(isAppOpenAtHome()).toBe(false);
  });

  it("is not without navigation timing or session storage to tell the two apart", () => {
    navigationEntries([]);
    expect(isAppOpenAtHome()).toBe(false);

    openedAt(`${window.location.origin}/dashboard`);
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(isAppOpenAtHome()).toBe(false);
  });
});
