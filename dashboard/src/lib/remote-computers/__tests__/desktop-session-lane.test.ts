/** @jest-environment jsdom */

import {
  DESKTOP_ISSUE_LANE_WAIT_MS,
  desktopProofSuccesses,
  refreshDesktopCapability,
  resetDesktopSessionLaneForTests,
  runDesktopIssue,
} from "../desktop-session-lane";

const COMPUTER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("desktop session lane", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    resetDesktopSessionLaneForTests();
    fetchMock.mockReset();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  });

  it("joins a proof already running for the computer and never starts a second one", async () => {
    let land!: () => void;
    fetchMock.mockReturnValue(new Promise<Response>(resolve => {
      land = () => resolve(answer(200, { success: true, data: { prepared: true } }));
    }));
    const first = refreshDesktopCapability(COMPUTER);
    const second = refreshDesktopCapability(COMPUTER);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/hivra/agents/${COMPUTER}/remote-desktop`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "refresh" }),
    }));
    land();
    await expect(second).resolves.toEqual({ ok: true, status: 200, payload: { success: true, data: { prepared: true } } });
    expect(desktopProofSuccesses(COMPUTER)).toBe(1);
    // Settled: the next caller proves again.
    fetchMock.mockResolvedValue(answer(200, { success: true, data: { prepared: true } }));
    await refreshDesktopCapability(COMPUTER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps computers apart", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    void refreshDesktopCapability(COMPUTER);
    void refreshDesktopCapability(OTHER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses only a success that landed after the caller looked, and never a failure", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { success: true, data: { prepared: true } }));
    const before = desktopProofSuccesses(COMPUTER);
    await refreshDesktopCapability(COMPUTER);
    expect(await refreshDesktopCapability(COMPUTER, { reuseSuccessAfter: before })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Looked after that success: it proves again.
    fetchMock.mockResolvedValueOnce(answer(409, { success: false, code: "capability_refresh_failed" }));
    const after = desktopProofSuccesses(COMPUTER);
    expect(await refreshDesktopCapability(COMPUTER, { reuseSuccessAfter: after })).toMatchObject({ ok: false, status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A failed proof is not counted or reused.
    expect(desktopProofSuccesses(COMPUTER)).toBe(after);
    fetchMock.mockResolvedValueOnce(answer(200, { success: true, data: { prepared: true } }));
    await refreshDesktopCapability(COMPUTER, { reuseSuccessAfter: after });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not count a 200 that did not prove the runtime ready", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { success: true, data: { prepared: false } }));
    await refreshDesktopCapability(COMPUTER);
    expect(desktopProofSuccesses(COMPUTER)).toBe(0);
  });

  it("lets the next caller prove again after a request that failed outright", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(refreshDesktopCapability(COMPUTER)).rejects.toThrow("Failed to fetch");
    fetchMock.mockResolvedValueOnce(answer(200, { success: true, data: { prepared: true } }));
    await expect(refreshDesktopCapability(COMPUTER)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("runs one computer's session requests one at a time, in order, and other computers freely", async () => {
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = runDesktopIssue(COMPUTER, async () => {
      order.push("first:start");
      await new Promise<void>(resolve => { finishFirst = resolve; });
      order.push("first:end");
      return 1;
    });
    const second = runDesktopIssue(COMPUTER, async () => { order.push("second"); return 2; });
    const other = runDesktopIssue(OTHER, async () => { order.push("other"); return 3; });
    await expect(other).resolves.toBe(3);
    expect(order).toEqual(["first:start", "other"]);
    finishFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("does not let a failed request block the next one", async () => {
    const failed = runDesktopIssue(COMPUTER, async () => { throw new Error("replaced_open"); });
    const next = runDesktopIssue(COMPUTER, async () => "asked");
    await expect(failed).rejects.toThrow("replaced_open");
    await expect(next).resolves.toBe("asked");
  });

  it("waits on a hung request only for a bounded time", async () => {
    jest.useFakeTimers();
    try {
      void runDesktopIssue(COMPUTER, () => new Promise(() => undefined));
      let ran = false;
      const next = runDesktopIssue(COMPUTER, async () => { ran = true; });
      await jest.advanceTimersByTimeAsync(DESKTOP_ISSUE_LANE_WAIT_MS - 1);
      expect(ran).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await next;
      expect(ran).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
