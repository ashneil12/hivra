/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MoveToOfficialCard, type MoveView } from "@/components/instances/MoveToOfficialCard";
import { MovedFromNotice } from "@/components/instances/MovedFromNotice";

const push = jest.fn();
const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

const MOVE_URL = "/api/instances/inst_1/move";
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
const mv = (state: MoveView["state"], extra: Partial<MoveView> = {}): MoveView => ({
  id: "m1", instanceId: "inst_1", agentId: null, state, step: null, message: null,
  startedAt: "2026-11-11T10:00:00Z", finishedAt: null, undoUntil: null, ...extra,
});
const get = (move: MoveView | null, available = true, movedTo: { agentId: string } | null = null) =>
  json({ success: true, data: { offer: { available, reason: null }, move, movedTo } });

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
async function renderCard() {
  const view = render(<MoveToOfficialCard instanceId="inst_1"><p>old cards</p></MoveToOfficialCard>);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("MoveToOfficialCard", () => {
  it("shows the old cards when nothing is offered", async () => {
    mockFetch(() => get(null, false));
    await renderCard();
    expect(screen.getByText("old cards")).toBeInTheDocument();
    expect(screen.queryByTestId("move-card")).toBeNull();
  });

  it("offers the move, confirms inline, then posts", async () => {
    const fetchMock = mockFetch((_u, init) =>
      init?.method === "POST" ? json({ success: true, data: { move: mv("queued") } }, true) : get(null));
    await renderCard();
    expect(screen.queryByText("old cards")).toBeNull();
    expect(screen.getByText("Move to the official Hermes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move my agent" }));
    expect(screen.getByText("Your agent will be offline for about ten minutes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(MOVE_URL, expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByTestId("move-steps")).toBeInTheDocument());
  });

  it("goes back to the offer on Not now", async () => {
    mockFetch(() => get(null));
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Move my agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("button", { name: "Move my agent" })).toBeInTheDocument();
  });

  it("ticks steps as the real state advances and shows the message", async () => {
    jest.useFakeTimers();
    const states: MoveView[] = [mv("launching"), mv("packing"), mv("uploading", { message: "Almost half" }), mv("finishing")];
    let i = 0;
    mockFetch(() => get(states[Math.min(i++, states.length - 1)]));
    render(<MoveToOfficialCard instanceId="inst_1" />);
    await act(async () => {});
    const counts = () => {
      const steps = screen.getByTestId("move-steps");
      return [
        steps.querySelectorAll('[data-step-state="done"]').length,
        steps.querySelector('[data-step-state="active"]')?.textContent,
      ];
    };
    expect(counts()).toEqual([0, "Setting up the new computer"]);
    for (const expected of [[1, "Packing your data"], [2, "Copying it"], [3, "Unpacking and checking it"]] as const) {
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(counts()).toEqual([...expected]);
    }
    expect(screen.queryByTestId("move-message")).toBeNull();
  });

  it("shows the message while a step runs", async () => {
    mockFetch(() => get(mv("uploading", { message: "Almost half" })));
    await renderCard();
    expect(screen.getByTestId("move-message")).toHaveTextContent("Almost half");
  });

  it("navigates to the new agent when done", async () => {
    mockFetch(() => get(mv("done", { agentId: "a_9" })));
    await renderCard();
    expect(screen.getByText("Your agent has moved.")).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/dashboard/agent/a_9");
  });

  it("says nothing was lost on failure and retries", async () => {
    const fetchMock = mockFetch((_u, init) =>
      init?.method === "POST" ? json({ success: true, data: { move: mv("queued") } }) : get(mv("failed", { message: "Checks did not match" })));
    await renderCard();
    expect(screen.getByText("Not moved, and nothing was lost.")).toBeInTheDocument();
    expect(screen.getByText("Checks did not match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(MOVE_URL, expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByTestId("move-steps")).toBeInTheDocument());
  });

  it("tells the owner when it needs attention", async () => {
    mockFetch(() => get(mv("needs_attention")));
    await renderCard();
    expect(screen.getByText("The move needs our attention.")).toBeInTheDocument();
    expect(screen.getByText(/Your data is safe/)).toBeInTheDocument();
  });

  it("shows the offer again after an undo", async () => {
    mockFetch(() => get(mv("undone")));
    await renderCard();
    expect(screen.getByRole("button", { name: "Move my agent" })).toBeInTheDocument();
  });

  it("redirects at once when the agent already moved", async () => {
    mockFetch(() => get(null, false, { agentId: "a_7" }));
    await renderCard();
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/a_7");
    expect(screen.queryByTestId("move-card")).toBeNull();
  });

  it("stays on the old agent while the move is being undone", async () => {
    mockFetch(() => get(mv("undoing", { agentId: "a_7", message: "Starting your old computer again." }), false, { agentId: "a_7" }));
    await renderCard();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Moving your agent back")).toBeInTheDocument();
    expect(screen.getByTestId("move-message")).toHaveTextContent("Starting your old computer again.");
    expect(screen.queryByTestId("move-steps")).toBeNull();
  });
});

describe("MovedFromNotice", () => {
  const future = new Date(Date.now() + 5 * 864e5).toISOString();
  const data = (extra: Record<string, unknown> = {}) =>
    json({ success: true, data: { movedFrom: { instanceId: "inst_1", name: "Ada", at: "2026-11-11T10:00:00Z", undoUntil: future }, move: null, canUndo: true, ...extra } });

  it("does not fetch for other agents", async () => {
    const fetchMock = mockFetch(() => data());
    render(<MovedFromNotice agentId="a_1" enabled={false} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the notice and undoes after an inline question", async () => {
    const fetchMock = mockFetch((_u, init) =>
      init?.method === "POST" ? json({ success: true, data: { move: mv("undone"), instanceId: "inst_1" } }) : data());
    render(<MovedFromNotice agentId="a_1" enabled />);
    await screen.findByText(/Moved from Ada on/);
    expect(screen.getByText(/The old computer is kept until/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo move" }));
    expect(screen.getByText(/Anything done here since the move will be lost/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents/a_1/move/undo", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/instances/inst_1"));
  });

  it("hides once the undo window has passed, and without canUndo has no button", async () => {
    mockFetch(() => data({ movedFrom: { instanceId: "i", name: "Ada", at: "2026-11-01T00:00:00Z", undoUntil: "2026-11-08T00:00:00Z" } }));
    const { container } = render(<MovedFromNotice agentId="a_1" enabled />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    mockFetch(() => data({ canUndo: false }));
    render(<MovedFromNotice agentId="a_2" enabled />);
    await screen.findByText(/Moved from Ada/);
    expect(screen.queryByRole("button", { name: "Undo move" })).toBeNull();
  });
});
