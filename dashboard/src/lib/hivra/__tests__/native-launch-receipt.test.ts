/** @jest-environment jsdom */

import {
  NATIVE_LAUNCH_RECEIPT_STORAGE_KEY,
  clearNativeLaunchRequestId,
  nativeLaunchRequestId,
} from "../native-launch-receipt";

describe("native launch receipt", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: jest
        .fn()
        .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
        .mockReturnValue("22222222-2222-4222-8222-222222222222"),
    });
  });

  it("survives a refresh-equivalent second lookup for the same owner and intent", () => {
    expect(nativeLaunchRequestId("owner-one", "codex:2:4")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(nativeLaunchRequestId("owner-one", "codex:2:4")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("creates a new namespace for a different owner or material intent", () => {
    nativeLaunchRequestId("owner-one", "codex:2:4");
    expect(nativeLaunchRequestId("owner-one", "codex:4:8")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(nativeLaunchRequestId("owner-two", "codex:4:8")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("clears only the confirmed owner/request pair", () => {
    const requestId = nativeLaunchRequestId("owner-one", "codex:2:4");
    clearNativeLaunchRequestId("owner-two", requestId);
    expect(window.sessionStorage.getItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY)).not.toBeNull();
    clearNativeLaunchRequestId("owner-one", requestId);
    expect(window.sessionStorage.getItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY)).toBeNull();
  });
});
