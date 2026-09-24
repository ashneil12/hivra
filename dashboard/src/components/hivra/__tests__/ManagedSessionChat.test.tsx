/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockHistory = jest.fn();
const mockSend = jest.fn();
const mockAnswer = jest.fn();
const mockChange = jest.fn();
const mockGet = jest.fn();

jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children: string }) => <p>{children}</p> }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("@/components/markdown/CodeBlock", () => ({ CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre> }));
jest.mock("@/lib/hivra/managed-session-client", () => {
  const actual = jest.requireActual("@/lib/hivra/managed-session-client");
  return {
    ...actual,
    readManagedSessionHistory: (...args: unknown[]) => mockHistory(...args),
    sendManagedSessionMessage: (...args: unknown[]) => mockSend(...args),
    answerManagedSessionApproval: (...args: unknown[]) => mockAnswer(...args),
    changeManagedSession: (...args: unknown[]) => mockChange(...args),
    getManagedSession: (...args: unknown[]) => mockGet(...args),
  };
});

import { ManagedSessionChat } from "../ManagedSessionChat";
import type { ManagedSessionDto } from "@/lib/hivra/managed-session-contracts";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const session: ManagedSessionDto = {
  agentId: "11111111-1111-4111-8111-111111111111", name: "Builder", harness: "claude-code", size: "mars-2vcpu-4gb",
  status: "ready", providerStatus: "SESSION_STATUS_READY", pauseReason: null, sessionId: "sess_1",
  connectionId: "22222222-2222-4222-8222-222222222222", error: null, createdAt: "2026-09-23T10:00:00Z",
};

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  mockHistory.mockResolvedValue({
    events: [
      { id: "e1", runId: "run_1", type: "run.token_delta", at: null, data: { text: "Looking at the repo.", isReasoning: false } },
      { id: "e2", runId: "run_1", type: "run.human_input_requested", at: null, data: { requestId: "hitl_1", action: "HITL_ACTION_BASH", summary: "Run a command: npm test" } },
    ],
    prompts: [{ runId: "run_1", text: "Run the tests", createdAt: "2026-09-23T10:00:01Z" }],
  });
});

it("rebuilds the conversation from history and resumes the live stream after the last event", async () => {
  render(<ManagedSessionChat initialSession={session} />);
  expect(await screen.findByText("Run the tests")).toBeInTheDocument();
  expect(screen.getByText("Looking at the repo.")).toBeInTheDocument();
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  expect(FakeEventSource.instances[0].url).toBe(`/api/hivra/managed-sessions/${session.agentId}/events?after=e2`);
});

it("sends an approval and shows it as pending until DigitalOcean confirms the decision", async () => {
  mockAnswer.mockResolvedValue(undefined);
  render(<ManagedSessionChat initialSession={session} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(mockAnswer).toHaveBeenCalledWith(session.agentId, "hitl_1", "approve"));
  expect(screen.getByText(/waiting for DigitalOcean to confirm/)).toBeInTheDocument();
  expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  act(() => FakeEventSource.instances[0].emit({ id: "e3", runId: "run_1", type: "run.human_input_received", at: null, data: { requestId: "hitl_1", outcome: "approved" } }));
  expect(await screen.findByText("Approved")).toBeInTheDocument();
});

it("forwards a typed message and attaches it to the run DigitalOcean started", async () => {
  mockSend.mockResolvedValue({ runId: "run_2" });
  render(<ManagedSessionChat initialSession={session} />);
  const input = await screen.findByLabelText("Message Builder");
  fireEvent.change(input, { target: { value: "Now fix it" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mockSend).toHaveBeenCalledWith(session.agentId, "Now fix it"));
  expect(await screen.findByText("Now fix it")).toBeInTheDocument();
});

it("asks for confirmation before deleting the session", async () => {
  mockChange.mockResolvedValue({ ...session, status: "deleted" });
  const onDeleted = jest.fn();
  render(<ManagedSessionChat initialSession={session} onDeleted={onDeleted} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
  expect(mockChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Delete session and workspace/ }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(mockChange).toHaveBeenCalledWith(session.agentId, "delete");
});

it("shows Hivra's setup note as a labelled Hivra card, not as a message the owner typed (ATT-13)", async () => {
  const note = [
    "<!-- HIVRA:COMPUTER:START v1 rev=1 -->",
    "## Your computer (from Hivra, revision 1)",
    "",
    "**Who and where.** You are the Claude Code agent \"Builder\".",
    "<!-- HIVRA:COMPUTER:END -->",
    "",
    "This is a setup note from Hivra, not a task. Reply only \"Ready.\" and don't run any tools.",
  ].join("\n");
  mockHistory.mockResolvedValue({
    events: [
      { id: "e1", runId: "run_1", type: "run.token_delta", at: null, data: { text: "Ready.", isReasoning: false } },
      { id: "e2", runId: "run_2", type: "run.token_delta", at: null, data: { text: "Looking at the repo.", isReasoning: false } },
    ],
    prompts: [
      { runId: "run_1", text: note, createdAt: "2026-09-23T10:00:01Z", source: "hivra-setup" },
      { runId: "run_2", text: "Run the tests", createdAt: "2026-09-23T10:00:02Z", source: "user" },
    ],
  });
  const { container } = render(<ManagedSessionChat initialSession={session} />);
  expect(await screen.findByText("Hivra setup")).toBeInTheDocument();
  expect(screen.getByText("Hivra told Builder where it runs and how you see its work.")).toBeInTheDocument();
  // The exact note is one click away, without Hivra's block markers.
  const card = screen.getByText("Hivra setup").closest("details")!;
  expect(card).not.toHaveAttribute("open");
  expect(card).toHaveTextContent("You are the Claude Code agent \"Builder\".");
  expect(card).not.toHaveTextContent("HIVRA:COMPUTER");
  // Only the owner's own message is drawn as an owner bubble.
  const bubbles = Array.from(container.querySelectorAll("div")).filter((element) => element.textContent === "Run the tests" && element.children.length === 0);
  expect(bubbles).toHaveLength(1);
  expect(screen.queryByText(note)).not.toBeInTheDocument();
  expect(screen.getByText("Ready.")).toBeInTheDocument();
});

describe("the launch's first task", () => {
  const setupOnly = {
    events: [{ id: "e1", runId: "run_1", type: "run.token_delta", at: null, data: { text: "Ready.", isReasoning: false } }],
    prompts: [{ runId: "run_1", text: "<!-- HIVRA:COMPUTER:START v1 rev=1 -->\n<!-- HIVRA:COMPUTER:END -->", createdAt: "2026-09-23T10:00:01Z", source: "hivra-setup" }],
  };

  it("goes back in the message box, unsent, when the conversation holds nothing from the owner", async () => {
    mockHistory.mockResolvedValue(setupOnly);
    render(<ManagedSessionChat initialSession={session} firstTask="  Summarize the repo  " />);
    expect(await screen.findByText("Your first task hasn't been sent to Builder yet. It's in the message box. Send it when you're ready.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Builder")).toHaveValue("Summarize the repo");
    expect(mockSend).not.toHaveBeenCalled();
    // Only the owner's Send sends it.
    mockSend.mockResolvedValue({ runId: "run_2" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith(session.agentId, "Summarize the repo"));
    expect(screen.queryByText(/Your first task hasn't been sent/)).not.toBeInTheDocument();
  });

  it("stays out of the way once the owner's first task reached the session", async () => {
    render(<ManagedSessionChat initialSession={session} firstTask="Run the tests" />);
    expect(await screen.findByText("Looking at the repo.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Builder")).toHaveValue("");
    expect(screen.queryByText(/Your first task hasn't been sent/)).not.toBeInTheDocument();
  });
});

it("reloads the stored conversation when asked, without losing what the owner is typing", async () => {
  const { rerender } = render(<ManagedSessionChat initialSession={session} historyVersion={0} />);
  expect(await screen.findByText("Run the tests")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Message Builder"), { target: { value: "half a thought" } });
  expect(mockHistory).toHaveBeenCalledTimes(1);
  mockHistory.mockResolvedValue({
    events: [{ id: "e9", runId: "run_9", type: "run.token_delta", at: null, data: { text: "Ready.", isReasoning: false } }],
    prompts: [{ runId: "run_9", text: "note", createdAt: "2026-09-23T10:05:00Z", source: "hivra-setup" }],
  });
  rerender(<ManagedSessionChat initialSession={session} historyVersion={1} />);
  expect(await screen.findByText("Hivra setup")).toBeInTheDocument();
  expect(mockHistory).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Message Builder")).toHaveValue("half a thought");
});
