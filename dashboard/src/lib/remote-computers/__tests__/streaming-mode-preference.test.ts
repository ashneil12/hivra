/** @jest-environment jsdom */

import {
  readStreamModePreference,
  streamModeStorageKey,
  writeStreamModePreference,
} from "../streaming-mode-preference";

describe("desktop streaming mode preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults every computer to HQ and keeps choices isolated per computer", () => {
    const first = "00000000-0000-4000-8000-000000001041";
    const second = "00000000-0000-4000-8000-000000002099";

    expect(readStreamModePreference(first)).toBe("hq");
    expect(readStreamModePreference(second)).toBe("hq");

    writeStreamModePreference(first, "performance");

    expect(readStreamModePreference(first)).toBe("performance");
    expect(readStreamModePreference(second)).toBe("hq");
    expect(window.localStorage.getItem(streamModeStorageKey(first))).toBe("performance");
  });

  it("normalizes the computer identity used by the storage key", () => {
    const upper = "00000000-0000-4000-8000-00000000ABCD";
    const lower = upper.toLowerCase();

    writeStreamModePreference(upper, "performance");

    expect(streamModeStorageKey(upper)).toBe(streamModeStorageKey(lower));
    expect(readStreamModePreference(lower)).toBe("performance");
  });

  it("persists QHD and explicit 4K without changing the HQ default", () => {
    const computer = "00000000-0000-4000-8000-000000001041";
    writeStreamModePreference(computer, "qhd");
    expect(readStreamModePreference(computer)).toBe("qhd");
    writeStreamModePreference(computer, "uhd");
    expect(readStreamModePreference(computer)).toBe("uhd");

    window.localStorage.setItem(streamModeStorageKey(computer), "invalid");
    expect(readStreamModePreference(computer)).toBe("hq");
  });
});
