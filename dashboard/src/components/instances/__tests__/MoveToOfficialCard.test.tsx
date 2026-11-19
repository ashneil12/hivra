/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MoveToOfficialCard, type MoveView } from "@/components/instances/MoveToOfficialCard";
import { MovedFromNotice } from "@/components/instances/MovedFromNotice";

const push = jest.fn();
const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
const mv = (state: MoveView["state"], extra: Partial<MoveView> = {}): MoveView => ({
  id: "m1", instanceId: "inst_1", agentId: null, state, step: null, message: null,
  startedAt: "2026-11-11T10:00:00Z", finishedAt: null, undoUntil: null, ...extra,
});
const get = (move: MoveView | null, available = true, movedTo: { agentId: string } | null = null, scheduledFor: string | null = null) =>
  json({ success: true, data: { offer: { available, reason: null }, scheduledFor, move, movedTo } });

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

  it("says when the move is planned, with no button", async () => {
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const when = new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const fetchMock = mockFetch(() => get(null, true, null, at));
    await renderCard();
    expect(screen.queryByText("old cards")).toBeNull();
    expect(screen.getByText(`Moving to the official Hermes on ${when}`)).toBeInTheDocument();
    expect(screen.getByTestId("move-card")).toHaveAttribute("data-state", "scheduled");
    expect(screen.getByText(/offline for about 15 minutes/)).toBeInTheDocument();
    expect(screen.queryByText(/email you the day before/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes back to soon, without promising another email, once the planned time has passed", async () => {
    mockFetch(() => get(null, true, null, new Date(Date.now() - 60 * 60 * 1000).toISOString()));
    await renderCard();
    expect(screen.getByText("Moving to the official Hermes soon")).toBeInTheDocument();
    expect(screen.getByTestId("move-card")).toHaveAttribute("data-state", "soon");
    expect(screen.queryByText(/email you the day before/)).toBeNull();
  });

  it("says it is coming soon and promises an email when not scheduled yet", async () => {
    mockFetch(() => get(null));
    await renderCard();
    expect(screen.getByText("Moving to the official Hermes soon")).toBeInTheDocument();
    expect(screen.getByTestId("move-card")).toHaveAttribute("data-state", "soon");
    expect(screen.getByText(/We'll email you the day before\./)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
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

  it("says nothing was lost on failure, with no button", async () => {
    mockFetch(() => get(mv("failed", { message: "Checks did not match" })));
    await renderCard();
    expect(screen.getByText("Not moved, and nothing was lost.")).toBeInTheDocument();
    expect(screen.getByText("Checks did not match")).toBeInTheDocument();
    expect(screen.getByText("We'll try again once we've checked what went wrong.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells the owner when it needs attention", async () => {
    mockFetch(() => get(mv("needs_attention")));
    await renderCard();
    expect(screen.getByText("The move needs our attention.")).toBeInTheDocument();
    expect(screen.getByText(/Your data is safe/)).toBeInTheDocument();
  });

  it("shows the planned move again after an undo", async () => {
    mockFetch(() => get(mv("undone")));
    await renderCard();
    expect(screen.getByText("Moving to the official Hermes soon")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
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
