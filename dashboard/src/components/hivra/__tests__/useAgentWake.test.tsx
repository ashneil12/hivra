/** @jest-environment jsdom */
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { holdAutoWake, releaseAutoWake, useAgentWake } from "../useAgentWake";
import type { AgentSleepView } from "@/lib/hivra/agent-sleep-ui";

const mockWakeAgent = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({ wakeAgent: (...args: unknown[]) => mockWakeAgent(...args) }));

type Props = { agentId?: string; view: AgentSleepView; state?: string | null; loaded?: boolean };
const mount = (initial: Props) =>
  renderHook(
    ({ agentId = "agent-1", view, state = null, loaded = true }: Props) => useAgentWake(agentId, view, state, jest.fn(), loaded),
    { initialProps: initial },
  );

beforeEach(() => {
  jest.clearAllMocks();
  releaseAutoWake("agent-1");
  mockWakeAgent.mockResolvedValue({ state: "waking" });
});

describe("useAgentWake: opening the page", () => {
  it("wakes an agent that is already asleep when the page opens, once", async () => {
    const { result, rerender } = mount({ view: "asleep", state: "napping" });
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
    expect(mockWakeAgent).toHaveBeenCalledWith("agent-1");
    expect(result.current.resting).toBeNull();
    rerender({ view: "waking", state: "waking" });
    expect(mockWakeAgent).toHaveBeenCalledTimes(1);
  });

  it("wakes at once an agent whose first read is asleep, even though it read as awake before the read", async () => {
    const { result, rerender } = mount({ view: "awake", loaded: false });
    rerender({ view: "asleep", state: "napping", loaded: true });
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
    expect(result.current.resting).toBeNull();
  });

  it("never wakes an agent that is awake", () => {
    mount({ view: "awake" });
    expect(mockWakeAgent).not.toHaveBeenCalled();
  });
});

describe("useAgentWake: a sleep the owner asked for from this page", () => {
  it("does not wake the agent again at once, so Nap now stays asleep", async () => {
    const { result, rerender } = mount({ view: "awake" });
    // The settings screen reports a successful Nap now, then the page reads the napping row.
    act(() => holdAutoWake("agent-1"));
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("manual"));
    expect(mockWakeAgent).not.toHaveBeenCalled();
    // Pressing a key or touching the page does not end a test sleep.
    fireEvent.pointerDown(window);
    fireEvent.keyDown(window, { key: "a" });
    expect(result.current.resting).toBe("manual");
    expect(mockWakeAgent).not.toHaveBeenCalled();
  });

  it("wakes it when the owner asks, and holds nothing once it is awake", async () => {
    const { result, rerender } = mount({ view: "awake" });
    act(() => holdAutoWake("agent-1"));
    rerender({ view: "asleep", state: "hibernated" });
    await waitFor(() => expect(result.current.resting).toBe("manual"));
    act(() => result.current.retry());
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
    expect(result.current.resting).toBeNull();
    rerender({ view: "awake" });
    // A later sleep that nobody asked for is the idle kind, not the manual one.
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
  });
});

describe("useAgentWake: an agent that naps while the page sits open", () => {
  it("leaves it asleep instead of waking it every nap window", async () => {
    const { result, rerender } = mount({ view: "awake" });
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
    expect(mockWakeAgent).not.toHaveBeenCalled();
    // The page's polls keep reading the same napping row.
    rerender({ view: "asleep", state: "napping" });
    expect(mockWakeAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["a press", () => fireEvent.pointerDown(window)],
    ["a key", () => fireEvent.keyDown(window, { key: "a" })],
    ["a touch", () => fireEvent.touchStart(window)],
  ])("wakes it when the owner comes back with %s", async (_name, act_) => {
    const { result, rerender } = mount({ view: "awake" });
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
    act(() => act_());
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
    expect(result.current.resting).toBeNull();
  });

  it("wakes it when the tab becomes visible again", async () => {
    const { result, rerender } = mount({ view: "awake" });
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
  });

  it("wakes it when the owner clicks into the agent's own frame", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    try {
      const { result, rerender } = mount({ view: "awake" });
      rerender({ view: "asleep", state: "napping" });
      await waitFor(() => expect(result.current.resting).toBe("idle"));
      act(() => {
        frame.focus();
        window.dispatchEvent(new Event("blur"));
      });
      await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
    } finally {
      frame.remove();
    }
  });

  it("stays asleep when the window loses focus to another app", async () => {
    const { result, rerender } = mount({ view: "awake" });
    rerender({ view: "asleep", state: "napping" });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
    act(() => { window.dispatchEvent(new Event("blur")); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWakeAgent).not.toHaveBeenCalled();
    expect(result.current.resting).toBe("idle");
  });
});

describe("useAgentWake: a hold from an earlier visit", () => {
  it("is cleared when the page is opened afresh, so opening wakes the agent", async () => {
    holdAutoWake("agent-1");
    mount({ view: "asleep", state: "napping" });
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(1));
  });
});

describe("useAgentWake: the early wake switch", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE;
  const previousSleep = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  beforeEach(() => { process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1"; });
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE;
    else process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE = previous;
    if (previousSleep === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previousSleep;
  });

  it("is off by default: nothing is sent before the first read", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE;
    mount({ view: "awake", loaded: false });
    expect(mockWakeAgent).not.toHaveBeenCalled();
  });

  it("sends nothing early while the sleep screens are off, even with the switch on", () => {
    process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE = "early_wake";
    delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    mount({ view: "awake", loaded: false });
    expect(mockWakeAgent).not.toHaveBeenCalled();
  });

  it("sends the wake beside the first read, and uses that one answer when the read finds it asleep", async () => {
    process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE = "early_wake";
    mockWakeAgent.mockResolvedValue({ state: "awake", wakeMs: 1200 });
    const onWoke = jest.fn();
    const { rerender } = renderHook(
      ({ view, loaded }: { view: AgentSleepView; loaded: boolean }) => useAgentWake("agent-1", view, "napping", onWoke, loaded),
      { initialProps: { view: "awake" as AgentSleepView, loaded: false } },
    );
    expect(mockWakeAgent).toHaveBeenCalledTimes(1);
    rerender({ view: "asleep", loaded: true });
    await waitFor(() => expect(onWoke).toHaveBeenCalledTimes(1));
    // The answer already sent is used: no second request.
    expect(mockWakeAgent).toHaveBeenCalledTimes(1);
  });

  it("drops the early answer when the first read finds the agent awake, so a later nap is not woken by it", async () => {
    process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE = "early_wake";
    mockWakeAgent.mockResolvedValue({ state: "awake", wakeMs: null });
    const { result, rerender } = mount({ view: "awake", loaded: false });
    expect(mockWakeAgent).toHaveBeenCalledTimes(1);
    rerender({ view: "awake", loaded: true });
    rerender({ view: "asleep", state: "napping", loaded: true });
    await waitFor(() => expect(result.current.resting).toBe("idle"));
    mockWakeAgent.mockResolvedValue({ state: "waking" });
    act(() => { fireEvent.pointerDown(window); });
    // Coming back sends a fresh request rather than reusing the old answer.
    await waitFor(() => expect(mockWakeAgent).toHaveBeenCalledTimes(2));
  });
});
