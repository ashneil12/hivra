/** @jest-environment jsdom */
import { TextDecoder, TextEncoder } from "util";

// jsdom doesn't ship TextDecoder/TextEncoder; HivraChat's NDJSON stream reader
// constructs one per turn.
Object.assign(globalThis, {
  TextDecoder: (globalThis as { TextDecoder?: unknown }).TextDecoder ?? TextDecoder,
  TextEncoder: (globalThis as { TextEncoder?: unknown }).TextEncoder ?? TextEncoder,
});

import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import posthog from "posthog-js";

import { CHAT_MARKDOWN_COMPONENTS, HivraChat } from "../HivraChat";
import { listBoxChatRuns, listBoxSessions, readBoxSession, stampAgentFirstUsage, stopBoxChatRun, uploadBoxFile } from "@/lib/hivra/agent-api";
import { startAgentWelcomeRun } from "@/lib/hivra/agent-welcome";
import { clientLog } from "@/lib/client/logger";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("remark-gfm", () => ({
  __esModule: true,
  default: jest.fn(),
}));

// CodeBlock pulls react-syntax-highlighter (ESM) which jest can't parse — and
// its rendering isn't what this suite exercises.
jest.mock("@/components/markdown/CodeBlock", () => ({
  CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  listBoxSessions: jest.fn(),
  readBoxSession: jest.fn(),
  stampAgentFirstUsage: jest.fn(),
  uploadBoxFile: jest.fn(),
  listBoxChatRuns: jest.fn(),
  stopBoxChatRun: jest.fn(),
  boxChatRunEventsUrl: (boxUrl: string, runId: string) => `${boxUrl}/api/chat/runs/${runId}/events`,
}));

jest.mock("@/lib/hivra/agent-welcome", () => ({
  startAgentWelcomeRun: jest.fn(),
  isHiddenWelcomeTitle: jest.requireActual("@/lib/hivra/agent-welcome").isHiddenWelcomeTitle,
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

const COARSE_POINTER = "(hover: none) and (pointer: coarse)";
const PHONE_WIDTH = "(max-width: 767px)";

// jsdom has no matchMedia; install one that matches the given queries.
function mockMatchMedia(matching: string[]) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function eventChunk(...events: unknown[]) {
  return { done: false, value: new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n") };
}

const WELCOME_TEXT = "Atlas here, ready to grow the SaaS.";
const HIDDEN_WELCOME_TITLE = "This is a hidden Hivra first-contact setup message.";

// The first-contact turn as a computer on the detached-run runtime streams it.
// The text goes out as a Claude text delta and as a plain `_text` line, so one
// fixture reads the same through the claude and the generic parsers.
function welcomeResponse(text = WELCOME_TEXT, events: unknown[] = []) {
  const read = jest.fn()
    .mockResolvedValueOnce(eventChunk(
      { type: "_run", runId: "welcome", detached: true },
      ...events,
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
      { type: "_text", text },
      { type: "_done", code: 0 },
    ))
    .mockResolvedValue({ done: true, value: undefined });
  return { ok: true, status: 200, body: { getReader: () => ({ read }) } };
}

describe("HivraChat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    (listBoxSessions as jest.Mock).mockResolvedValue([]);
    (readBoxSession as jest.Mock).mockResolvedValue([]);
    (stampAgentFirstUsage as jest.Mock).mockResolvedValue(undefined);
    (listBoxChatRuns as jest.Mock).mockResolvedValue(null);
    (stopBoxChatRun as jest.Mock).mockResolvedValue(true);
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => Promise.resolve(welcomeResponse()));
  });

  it("starts an empty regular chat with the personalized assistant first message", async () => {
    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-1"
        token="box-token"
        agentName="Atlas"
        agentKind="claude"
        goal="grow"
        context="I run a B2B SaaS for dentists."
      />,
    );

    expect(await screen.findByText("Atlas here, ready to grow the SaaS.")).toBeInTheDocument();
    expect(screen.getByText(/Runs the official agent CLI on this computer/)).toBeInTheDocument();
    expect(screen.queryByText(/on your own login/)).not.toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeInTheDocument();
    expect(sendButton).toHaveTextContent("Send message");
    expect(screen.queryByText(/hidden Hivra first-contact/i)).not.toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        boxUrl: "https://box.example.com",
        token: "box-token",
        agentName: "Atlas",
        goal: "grow",
        context: "I run a B2B SaaS for dentists.",
        channel: "chat",
      }),
    );
  });

  it("threads the captured first task into the auto-welcome turn ('do, don't show')", async () => {
    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-task-1"
        token="box-token"
        agentName="Scout"
        agentKind="claude"
        goal="research"
        firstTask="Research the 3 best CRMs for a dental practice"
      />,
    );

    await screen.findByText("Atlas here, ready to grow the SaaS.");
    expect(startAgentWelcomeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        firstTask: "Research the 3 best CRMs for a dental practice",
        channel: "chat",
      }),
    );
  });

  it("does not send a duplicate welcome when the box already has chat history", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValueOnce([
      { id: "remote-1", title: "Existing session", updatedAt: Date.now() },
    ]);

    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-2"
        token="box-token"
        agentName="Atlas"
        agentKind="claude"
        goal="grow"
      />,
    );

    await waitFor(() => {
      expect(listBoxSessions).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(startAgentWelcomeRun).not.toHaveBeenCalled();
    });
  });

  // ── agent_first_message_sent — Hivra-lane funnel activation event ────────

  function mockChatFetchOk() {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
        }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  async function sendMessage(text: string) {
    const textarea = await screen.findByPlaceholderText("Message Atlas…");
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByLabelText("Send message"));
  }

  function firstMessageCaptures() {
    return (posthog.capture as jest.Mock).mock.calls.filter(
      ([event]) => event === "agent_first_message_sent"
    );
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function streamChunk(text: string) {
    return new TextEncoder().encode(`${JSON.stringify({ type: "_text", text })}\n`);
  }

  function chatResponse(read: jest.Mock) {
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read }) },
    };
  }

  it("captures agent_first_message_sent once per box on the first successful send", async () => {
    const fetchMock = mockChatFetchOk();

    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-3"
        token="box-token"
        agentName="Atlas"
        agentKind="claude"
      />,
    );

    // Wait for the auto-welcome turn to finish so the input is usable.
    await screen.findByText("Atlas here, ready to grow the SaaS.");

    await sendMessage("hello agent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await waitFor(() => expect(firstMessageCaptures()).toHaveLength(1));
    expect(firstMessageCaptures()[0][1]).toEqual({
      box_id: "agent-3",
      agent_kind: "claude",
      lane: "hivra",
      $insert_id: "agent_first_message_sent_agent-3",
    });
    expect(
      window.localStorage.getItem("hermes:first_message_sent:agent-3")
    ).toBe("1");
    expect(stampAgentFirstUsage).toHaveBeenCalledWith("agent-3");

    // Second send on the same box must NOT re-capture. Wait for the turn to
    // finish (the Stop button reverts to Send message once busy clears).
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    await sendMessage("second message");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstMessageCaptures()).toHaveLength(1);
    expect(stampAgentFirstUsage).toHaveBeenCalledTimes(1);
  });

  it("does not capture when the box POST fails", async () => {
    let resolveResponse!: (response: {
      ok: boolean;
      status: number;
      body: null;
    }) => void;
    const fetchMock = jest.fn(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-4"
        token="box-token"
        agentName="Atlas"
        agentKind="claude"
      />,
    );

    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("hello agent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await act(async () => {
      resolveResponse({
        ok: false,
        status: 502,
        body: null,
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByText(/hit an error \(HTTP 502\)/)).toBeInTheDocument()
    );
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(firstMessageCaptures()).toHaveLength(0);
    expect(stampAgentFirstUsage).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("hermes:first_message_sent:agent-4")
    ).toBeNull();
  });

  it("parses an unterminated final NDJSON event split inside a multibyte character", async () => {
    const finalText = "Final café ☕";
    const encoded = new TextEncoder().encode(
      JSON.stringify({ type: "_text", text: finalText }),
    );
    const multibyteStart = encoded.indexOf(0xe2);
    expect(multibyteStart).toBeGreaterThan(0);
    const splitAt = multibyteStart + 1;
    const read = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoded.slice(0, splitAt),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encoded.slice(splitAt),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest
      .fn()
      .mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;

    render(
      <HivraChat
        boxUrl="https://box.example.com"
        storageKey="agent-final-ndjson"
        agentName="Atlas"
        agentKind="generic"
      />,
    );

    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("show the final event");

    expect(await screen.findByText(finalText)).toBeInTheDocument();
    expect(screen.queryByText(/�/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("aborts agent A exactly once and ignores its late stream before agent B responds", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "existing", title: "Existing session", updatedAt: Date.now() },
    ]);

    const lateAgentARead = deferred<{ done: boolean; value?: Uint8Array }>();
    const readAgentA = jest
      .fn()
      .mockImplementationOnce(() => lateAgentARead.promise)
      .mockResolvedValueOnce({ done: true, value: undefined });
    const readAgentB = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: streamChunk("Agent B response") })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(chatResponse(readAgentA))
      .mockResolvedValueOnce(chatResponse(readAgentB));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <HivraChat
        boxUrl="https://agent-a.example.com"
        storageKey="x-agent-a"
        agentName="Agent A"
        agentKind="generic"
      />,
    );

    const agentAInput = await screen.findByPlaceholderText("Message Agent A…");
    fireEvent.change(agentAInput, { target: { value: "message for A" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(readAgentA).toHaveBeenCalledTimes(1));

    const agentASignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    const onAgentAAbort = jest.fn();
    agentASignal.addEventListener("abort", onAgentAAbort);

    rerender(
      <HivraChat
        boxUrl="https://agent-b.example.com"
        storageKey="x-agent-b"
        agentName="Agent B"
        agentKind="generic"
      />,
    );

    const agentBInput = await screen.findByPlaceholderText("Message Agent B…");
    await waitFor(() => expect(onAgentAAbort).toHaveBeenCalledTimes(1));

    fireEvent.change(agentBInput, { target: { value: "message for B" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      lateAgentARead.resolve({ done: false, value: streamChunk("LATE AGENT A") });
      await Promise.resolve();
    });

    expect(await screen.findByText("Agent B response")).toBeInTheDocument();
    expect(screen.queryByText("LATE AGENT A")).not.toBeInTheDocument();
    expect(onAgentAAbort).toHaveBeenCalledTimes(1);
  });

  it("ignores a late agent A HTTP error after the conversation identity changes", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "existing", title: "Existing session", updatedAt: Date.now() },
    ]);

    const lateAgentAResponse = deferred<Response>();
    const fetchMock = jest.fn().mockImplementationOnce(() => lateAgentAResponse.promise);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <HivraChat
        boxUrl="https://agent-a.example.com"
        storageKey="x-agent-a-error"
        agentName="Agent A"
        agentKind="generic"
      />,
    );

    const agentAInput = await screen.findByPlaceholderText("Message Agent A…");
    fireEvent.change(agentAInput, { target: { value: "message for A" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <HivraChat
        boxUrl="https://agent-b.example.com"
        storageKey="x-agent-b-error"
        agentName="Agent B"
        agentKind="generic"
      />,
    );
    await screen.findByPlaceholderText("Message Agent B…");

    await act(async () => {
      lateAgentAResponse.resolve({ ok: false, status: 503, body: null } as Response);
      await Promise.resolve();
    });

    expect(screen.queryByText(/hit an error \(HTTP 503\)/)).not.toBeInTheDocument();
    expect(screen.queryByText("message for A")).not.toBeInTheDocument();
  });

  it("aborts an active request exactly once when the chat unmounts", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "existing", title: "Existing session", updatedAt: Date.now() },
    ]);

    const pendingRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(jest.fn(() => pendingRead.promise)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = render(
      <HivraChat
        boxUrl="https://agent-a.example.com"
        storageKey="x-agent-a-unmount"
        agentName="Agent A"
        agentKind="generic"
      />,
    );

    const agentAInput = await screen.findByPlaceholderText("Message Agent A…");
    fireEvent.change(agentAInput, { target: { value: "message for A" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    const onAbort = jest.fn();
    signal.addEventListener("abort", onAbort);
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();

    unmount();

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("renders tool activity as a compact accessible history with observed completion", async () => {
    const read = jest.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode([
          { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } } } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file.txt" }] } },
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } } },
        ].map((event) => JSON.stringify(event)).join("\n") + "\n"),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;

    render(<HivraChat boxUrl="https://box.example.com" storageKey="activity-history" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("inspect the files");

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 action" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 action" }));
    const toolButton = await screen.findByRole("button", { name: /Bash.*ls -la/ });
    expect(toolButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toolButton);
    expect(toolButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });

  it("marks a pending tool and response as stopped when the user interrupts", async () => {
    const pendingRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const read = jest.fn().mockResolvedValueOnce({
      done: false,
      value: new TextEncoder().encode(JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "sleep 10" } } },
      }) + "\n"),
    }).mockImplementationOnce(() => pendingRead.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;

    render(<HivraChat boxUrl="https://box.example.com" storageKey="activity-stop" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("run the command");
    expect(await screen.findByText("Working")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(await screen.findByText("Activity stopped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 action" }));
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bash.*Interrupted/ })).toBeDisabled();
    await act(async () => pendingRead.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Late reply" } } }) + "\n") }));
    expect(screen.queryByText("Late reply")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bash.*Interrupted/ })).toBeDisabled();
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal;
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("status", { name: "Response stopped" })).toBeInTheDocument();
  });

  const pendingToolEvent = { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "action", name: "Bash", input: { command: "ls" } } } };
  const partialText = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" } } };

  it("preserves partial text and the stopped state after the stream settles", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk(partialText)).mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    await screen.findByText("Partial answer");
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(screen.getByLabelText("Response stopped")).toHaveTextContent("Stopped");
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    await act(async () => pending.resolve({ done: true }));
    expect(screen.getByLabelText("Response stopped")).toBeInTheDocument();
  });

  it("distinguishes a broken stream from a user stop and preserves partial text", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(pendingToolEvent, partialText)).mockRejectedValueOnce(new Error("connection lost"));
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByLabelText("Response failed")).toHaveTextContent("Could not complete response");
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.queryByLabelText("Response stopped")).not.toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("does not infer tool completion when the stream closes without a tool result", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(pendingToolEvent)).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByText("Completion unconfirmed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 action" }));
    expect(screen.getByRole("button", { name: /Bash.*Unconfirmed/ })).toBeDisabled();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("keeps a past tool failure in history while the agent continues responding", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk(partialText, pendingToolEvent, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "action", is_error: true, content: "permission denied" }] } })).mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByText("Responding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 action" })).toHaveAttribute("aria-expanded", "false");
    await act(async () => pending.resolve({ done: true }));
    expect(screen.getByText("Actions include failures")).toBeInTheDocument();
  });

  it("retains an agent-reported error after a normal stream close", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk({ type: "result", is_error: true, result: "Model unavailable" })).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByLabelText("Response failed")).toBeInTheDocument();
    expect(screen.getByText(/Model unavailable/)).toBeInTheDocument();
  });

  it("labels the composer, grows up to its cap, shrinks, and preserves IME input", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const input = screen.getByRole("textbox", { name: "Message Atlas" });
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 100 });
    fireEvent.change(input, { target: { value: "first\nsecond" } });
    expect(input).toHaveStyle({ height: "100px", overflowY: "hidden" });
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 240 });
    fireEvent.change(input, { target: { value: "many lines" } });
    expect(input).toHaveStyle({ height: "160px", overflowY: "auto" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(global.fetch).not.toHaveBeenCalled();
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 30 });
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveStyle({ height: "44px", overflowY: "hidden" });
  });

  function runningToolEvent(id: string, command: string) {
    return { type: "stream_event", event: { type: "content_block_start", content_block: {
      type: "tool_use", id, name: "Bash", input: { command },
    } } };
  }

  it("summarizes concurrent tools and keeps their details in accessible history", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk(runningToolEvent("one", "ls"), runningToolEvent("two", "pwd")))
      .mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("inspect");
    await screen.findByText(/2 actions running/);
    fireEvent.click(screen.getByRole("button", { name: "2 actions" }));
    expect(screen.getByRole("button", { name: "Bash · ls — Running" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Bash · pwd — Running" })).toBeVisible();
    expect(screen.getByText(/2 actions running/)).toBeInTheDocument();
    expect(screen.queryByText(/previous action/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ done: true }); });
    expect(screen.getByText("Completion unconfirmed")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Unconfirmed/ })).toHaveLength(2);
  });

  it("reports an observed tool error without inventing successful completion at EOF", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(runningToolEvent("one", "bad-command"), {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "one", is_error: true, content: "Command failed" }] },
    })).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("run");
    expect(await screen.findByText("Actions include failures")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 action" }));
    const tool = screen.getByRole("button", { name: /bad-command — Failed/ });
    tool.focus();
    expect(tool).toHaveFocus();
    fireEvent.click(tool);
    expect(document.getElementById(tool.getAttribute("aria-controls")!)).toHaveTextContent("Command failed");
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("preserves partial text and displays a failure when the stream rejects", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk({ type: "stream_event", event: {
      type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" },
    } })).mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("answer");
    await screen.findByText("Partial answer");
    await act(async () => { pending.reject(new Error("connection lost")); });
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Response failed" })).toHaveTextContent("Could not complete response");
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
  });

  it("grows the named composer to its cap and preserves Shift+Enter and IME input", async () => {
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 100 });
    fireEvent.change(textarea, { target: { value: "line one\nline two" } });
    expect(textarea).toHaveStyle({ height: "100px", overflowY: "hidden" });
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 200 });
    fireEvent.change(textarea, { target: { value: "longer draft" } });
    expect(textarea).toHaveStyle({ height: "160px", overflowY: "auto" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 20 });
    fireEvent.change(textarea, { target: { value: "" } });
    expect(textarea).toHaveStyle({ height: "44px", overflowY: "hidden" });
  });

  it("reports waiting and then text streaming without inventing reasoning", async () => {
    const first = deferred<{ done: boolean; value?: Uint8Array }>();
    const last = deferred<{ done: boolean }>();
    const read = jest.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByText("Waiting for response")).toBeVisible();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    await act(async () => first.resolve(eventChunk(partialText)));
    expect(screen.getByText("Responding")).toBeVisible();
    await act(async () => last.resolve({ done: true }));
    expect(screen.queryByText("Responding")).not.toBeInTheDocument();
    expect(screen.getByText("Partial answer")).toBeVisible();
  });

  it("keeps disclosure targets mounted and hidden until opened below the response", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(partialText, pendingToolEvent, {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "action", content: "file.txt" }] },
    })).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("inspect");
    await screen.findByText("Completed");
    const history = screen.getByRole("button", { name: "1 action" });
    const target = document.getElementById(history.getAttribute("aria-controls")!);
    expect(target).not.toBeVisible();
    expect(screen.getByText("Partial answer").compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    history.focus();
    expect(history).toHaveFocus();
    fireEvent.click(history);
    expect(history).toHaveAttribute("aria-expanded", "true");
    expect(target).toBeVisible();
    const tool = screen.getByRole("button", { name: /Bash.*Completed/ });
    const output = document.getElementById(tool.getAttribute("aria-controls")!);
    expect(output).not.toBeVisible();
    fireEvent.click(tool);
    expect(output).toBeVisible();
    fireEvent.click(history);
    expect(target).not.toBeVisible();
  });

  it("coalesces pending scrolls, preserves reading position, and returns to the latest message", async () => {
    const frames: FrameRequestCallback[] = [];
    const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      const { unmount } = render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      // Session hydration cancels its old frame; welcome updates reuse the pending one.
      expect(request.mock.calls.length - cancel.mock.calls.length).toBe(1);
      const pendingFrame = frames.length - 1;
      const pane = screen.getByRole("region", { name: "Conversation" });
      Object.defineProperties(pane, {
        scrollHeight: { configurable: true, value: 1500 },
        clientHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, writable: true, value: 200 },
      });
      fireEvent.scroll(pane);
      expect(screen.getByRole("button", { name: "Return to latest" })).toBeVisible();
      act(() => frames[pendingFrame](0));
      expect(pane.scrollTop).toBe(200);
      fireEvent.click(screen.getByRole("button", { name: "Return to latest" }));
      expect(request).toHaveBeenCalledTimes(pendingFrame + 2);
      act(() => frames[pendingFrame + 1](16));
      expect(pane.scrollTop).toBe(1500);
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
      pane.scrollTop = 200;
      fireEvent.scroll(pane);
      pane.scrollTop = 1000;
      fireEvent.scroll(pane);
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
      unmount();
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("keeps an empty chat at the top instead of pinning its greeting out of view", async () => {
    window.localStorage.setItem("hivra:first-welcome:empty-scroll", "1");
    const frames: FrameRequestCallback[] = [];
    const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      render(<HivraChat boxUrl="https://box.example.com" storageKey="empty-scroll" agentName="Atlas" />);
      await waitFor(() => expect(listBoxSessions).toHaveBeenCalled());
      const pane = screen.getByRole("region", { name: "Conversation" });
      expect(pane).toHaveAttribute("data-empty", "true");
      Object.defineProperties(pane, {
        scrollHeight: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 300 },
        scrollTop: { configurable: true, writable: true, value: 400 },
      });
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      expect(pane.scrollTop).toBe(0);
      fireEvent.scroll(pane);
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("cancels a pending scroll frame when the conversation unmounts", async () => {
    const request = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      const { unmount } = render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      unmount();
      expect(cancel).toHaveBeenCalledWith(42);
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("sends on Enter with a fine pointer and labels the key as send", async () => {
    const fetchMock = mockChatFetchOk();
    render(<HivraChat boxUrl="https://box.example.com" storageKey="fine-composer" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
    expect(textarea).toHaveAttribute("enterkeyhint", "send");
    fireEvent.change(textarea, { target: { value: "ship it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("lets Return insert a newline on touch keyboards and sends only from the Send button", async () => {
    const restore = mockMatchMedia([COARSE_POINTER, PHONE_WIDTH]);
    try {
      const fetchMock = mockChatFetchOk();
      render(<HivraChat boxUrl="https://box.example.com" storageKey="touch-composer" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
      expect(textarea).toHaveAttribute("enterkeyhint", "enter");
      expect(textarea).toHaveAttribute("autocapitalize", "sentences");
      fireEvent.change(textarea, { target: { value: "first line" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it("closes the chats drawer after picking a session on a phone", async () => {
    const restore = mockMatchMedia([PHONE_WIDTH]);
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "remote-1", title: "Deploy notes", updatedAt: Date.now() + 1000 },
    ]);
    try {
      render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-phone" token="box-token" agentName="Atlas" />);
      await waitFor(() => expect(listBoxSessions).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
      expect(screen.getByRole("button", { name: "Hide chats" })).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: /Deploy notes/ }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("button", { name: "Show chats" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Deploy notes/ })).not.toBeInTheDocument();
      await waitFor(() => expect(readBoxSession).toHaveBeenCalledWith("https://box.example.com", "remote-1", "box-token"));

      fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
      fireEvent.click(screen.getByRole("button", { name: "Close chats" }));
      expect(screen.queryByRole("button", { name: /Deploy notes/ })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("treats the phone chats drawer as a modal dialog for focus", async () => {
    const restore = mockMatchMedia([PHONE_WIDTH]);
    try {
      render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-focus" token="box-token" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const toggle = screen.getByRole("button", { name: "Show chats" });
      const column = screen.getByRole("region", { name: "Conversation" }).parentElement!;

      fireEvent.click(toggle);
      const drawer = screen.getByRole("dialog", { name: "Chats" });
      expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(column).toHaveAttribute("inert");
      const newChat = within(drawer).getByRole("button", { name: /New chat/ });
      const close = within(drawer).getByRole("button", { name: "Close chats" });
      expect(newChat).toHaveFocus();

      // Tab wraps inside the drawer instead of reaching the chat behind it.
      fireEvent.keyDown(newChat, { key: "Tab", shiftKey: true });
      expect(within(drawer).getAllByRole("button").at(-1)).toHaveFocus();
      close.focus();
      fireEvent.keyDown(close, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Chats" })).not.toBeInTheDocument();
      expect(column).not.toHaveAttribute("inert");
      expect(toggle).toHaveFocus();

      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("button", { name: "Close chats" }));
      expect(toggle).toHaveFocus();
    } finally {
      restore();
    }
  });

  it("keeps the inline chats column non-modal on wider screens", async () => {
    render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-wide-focus" token="box-token" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const toggle = screen.getByRole("button", { name: "Show chats" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.queryByRole("dialog", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation" }).parentElement).not.toHaveAttribute("inert");
    expect(toggle).toHaveFocus();
  });

  it("keeps the chats column open after picking a session on wider screens", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "remote-1", title: "Deploy notes", updatedAt: Date.now() + 1000 },
    ]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-desktop" token="box-token" agentName="Atlas" />);
    await waitFor(() => expect(listBoxSessions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByRole("button", { name: /Deploy notes/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Hide chats" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deploy notes/ })).toBeInTheDocument();
  });

  it("needs a second tap to delete a chat", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "remote-1", title: "Deploy notes", updatedAt: Date.now() + 1000 },
    ]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-delete" token="box-token" agentName="Atlas" />);
    await waitFor(() => expect(listBoxSessions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    const row = (await screen.findByRole("button", { name: /Deploy notes/ })).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete chat" }));
    expect(screen.getByRole("button", { name: /Deploy notes/ })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Confirm delete chat" }));
    expect(screen.queryByRole("button", { name: /Deploy notes/ })).not.toBeInTheDocument();
  });

  it("explains an oversize attachment instead of dropping it", async () => {
    const { container } = render(<HivraChat boxUrl="https://box.example.com" storageKey="attach-big" token="box-token" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const big = new File(["x"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(big, "size", { value: 11.2 * 1024 * 1024 });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("This file is 11.2 MB — the limit is 8 MB");
    expect(uploadBoxFile).not.toHaveBeenCalled();
  });

  it("reports a failed upload inline", async () => {
    (uploadBoxFile as jest.Mock).mockResolvedValue({ ok: false, error: "HTTP 500" });
    const { container } = render(<HivraChat boxUrl="https://box.example.com" storageKey="attach-fail" token="box-token" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed — try again");
    expect(uploadBoxFile).toHaveBeenCalledWith("https://box.example.com", "notes.txt", expect.any(String), "box-token");
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).not.toBeInTheDocument();
  });

  it("renders every fenced block as a code block, wraps tables, and opens links in a new tab", () => {
    const { pre, table, a } = CHAT_MARKDOWN_COMPONENTS;
    render(
      <div>
        {pre({ children: <code className="language-sh">{"npm test -- --runInBand\n"}</code> })}
        {pre({ children: <code>{"one-line command"}</code> })}
        {table({ children: <tbody><tr><td>cell</td></tr></tbody> })}
        {a({ href: "https://example.com/docs", children: "docs" })}
      </div>,
    );
    expect(screen.getByText("npm test -- --runInBand").tagName).toBe("PRE");
    expect(screen.getByText("one-line command").tagName).toBe("PRE");
    expect(screen.getByRole("table").parentElement).toHaveClass("chat-md-table-wrapper");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("runs several chats at once and routes each stream to the chat that started it", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([
      { id: "existing", title: "Existing session", updatedAt: 1 },
    ]);
    const firstRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const readA = jest.fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce({ done: true, value: undefined });
    const secondRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const readB = jest.fn()
      .mockResolvedValueOnce({ done: false, value: streamChunk("B is working") })
      .mockImplementationOnce(() => secondRead.promise);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(chatResponse(readA))
      .mockResolvedValueOnce(chatResponse(readB));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<HivraChat boxUrl="https://box.example.com" storageKey="parallel" agentName="Atlas" agentKind="generic" />);

    await sendMessage("task A");
    await waitFor(() => expect(readA).toHaveBeenCalledTimes(1));
    const signalA = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    // A new chat is available while A is still working, and sending there
    // starts a second, independent turn instead of being blocked.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("task A")).not.toBeInTheDocument();
    await sendMessage("task B");
    expect(await screen.findByText("B is working")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signalA.aborted).toBe(false);
    expect(screen.getByRole("button", { name: /1 other working/i })).toBeInTheDocument();

    // A's output arrives while B is open: it must land in A, not in B.
    await act(async () => {
      firstRead.resolve({ done: false, value: streamChunk("A finished the job") });
      await Promise.resolve();
    });
    expect(screen.queryByText("A finished the job")).not.toBeInTheDocument();

    // Stopping B leaves A's request alone.
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    const signalB = (fetchMock.mock.calls[1][1] as RequestInit).signal as AbortSignal;
    expect(signalB.aborted).toBe(true);
    expect(signalA.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    fireEvent.click(screen.getByText("task A", { selector: "span" }));
    expect(await screen.findByText("A finished the job")).toBeInTheDocument();
    expect(screen.queryByText("B is working")).not.toBeInTheDocument();
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const replyText = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

  it("asks the box to keep the turn running without this page, keyed by a client run id", async () => {
    const read = jest.fn()
      .mockResolvedValueOnce(eventChunk({ type: "_run", runId: "x", detached: true }, replyText("Done."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(read));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="detach-body" token="box-token" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("long task");
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://box.example.com/api/chat");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ message: "long task", detach: true });
    expect(body.runId).toMatch(UUID);
    expect(typeof body.clientRef).toBe("string");
  });

  it("stops the box run explicitly instead of relying on the dropped connection", async () => {
    const pending = deferred<{ done: boolean; value?: Uint8Array }>();
    const read = jest.fn()
      .mockResolvedValueOnce(eventChunk({ type: "_run", runId: "x", detached: true }, replyText("Working on it")))
      .mockImplementationOnce(() => pending.promise);
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(read));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="detach-stop" token="box-token" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("long task");
    await screen.findByText("Working on it");
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    const runId = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).runId;
    expect(stopBoxChatRun).toHaveBeenCalledWith("https://box.example.com", runId, "box-token");
    expect(screen.getByLabelText("Response stopped")).toHaveTextContent("Stopped");
  });

  it("re-attaches to the run when the stream drops mid-turn and shows the finished reply", async () => {
    const firstRead = jest.fn()
      .mockResolvedValueOnce(eventChunk({ type: "_run", runId: "x", detached: true }, replyText("Half")))
      .mockRejectedValueOnce(new Error("network changed"));
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Half"), replyText(" and the rest."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(chatResponse(firstRead))
      .mockResolvedValueOnce(chatResponse(replay));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="detach-drop" token="box-token" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("long task");
    expect(await screen.findByText("Half and the rest.")).toBeInTheDocument();
    const runId = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).runId;
    expect(fetchMock.mock.calls[1][0]).toBe(`https://box.example.com/api/chat/runs/${runId}/events`);
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
    expect(stopBoxChatRun).not.toHaveBeenCalled();
  });

  it("picks a reply that kept running while the page was closed back up from the box", async () => {
    const runId = "00000000-0000-4000-8000-000000000002";
    window.localStorage.setItem("hivra_sessions_agentresume", JSON.stringify([{
      id: "s1", title: "long task", claudeSessionId: "00000000-0000-4000-8000-000000000001", createdAt: 1,
      messages: [
        { role: "user", text: "long task", tools: [] },
        { role: "assistant", text: "Half", tools: [], streaming: true, runId },
      ],
    }]));
    window.localStorage.setItem("hivra_sessions_agentresume_active", "s1");
    (listBoxSessions as jest.Mock).mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001", title: "long task", updatedAt: 2 }]);
    (listBoxChatRuns as jest.Mock).mockResolvedValue([{ runId, clientRef: "s1", state: "finished", title: "long task", code: 0, stopped: null, interrupted: false, agentSessionId: null, createdAt: "", finishedAt: "" }]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Half"), replyText(" and it finished while you were away."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(replay));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="agent-resume" token="box-token" agentName="Atlas" agentKind="claude" />);
    expect(await screen.findByText("Half and it finished while you were away.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`https://box.example.com/api/chat/runs/${runId}/events`, expect.objectContaining({ headers: { Authorization: "Bearer box-token" } }));
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
  });

  // ── The first-contact welcome is a detached run like any send ─────────────

  const runningRun = (overrides: Record<string, unknown>) => ({
    clientRef: null, state: "running", title: "", code: null, stopped: null, interrupted: false,
    agentSessionId: null, createdAt: "", finishedAt: null, ...overrides,
  });

  it("runs the first-contact welcome as a detached run that Stop ends on the computer", async () => {
    const pending = deferred<{ done: boolean; value?: Uint8Array }>();
    const read = jest.fn()
      .mockResolvedValueOnce(eventChunk({ type: "_run", runId: "x", detached: true }, replyText("Comparing the CRMs")))
      .mockImplementationOnce(() => pending.promise);
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => Promise.resolve(chatResponse(read)));
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-run" token="box-token" agentName="Atlas" agentKind="claude" firstTask="Compare three CRMs" />);

    await screen.findByText("Comparing the CRMs");
    const args = (startAgentWelcomeRun as jest.Mock).mock.calls[0][0];
    expect(args).toMatchObject({ boxUrl: "https://box.example.com", token: "box-token", firstTask: "Compare three CRMs", channel: "chat" });
    expect(args.runId).toMatch(UUID);
    expect(typeof args.clientRef).toBe("string");
    // Only the reply shows: there is no bubble for the hidden prompt.
    expect(screen.queryByText("YOU")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(stopBoxChatRun).toHaveBeenCalledWith("https://box.example.com", args.runId, "box-token");
    expect((args.signal as AbortSignal).aborted).toBe(true);
    expect(screen.getByLabelText("Response stopped")).toHaveTextContent("Stopped");
  });

  it("lets the owner carry on the welcome conversation: the next message resumes the agent's session", async () => {
    const welcomeSession = "00000000-0000-4000-8000-000000000004";
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => Promise.resolve(
      welcomeResponse(WELCOME_TEXT, [{ type: "system", subtype: "init", session_id: welcomeSession }]),
    ));
    const fetchMock = mockChatFetchOk();
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-continue" token="box-token" agentName="Atlas" agentKind="claude" />);

    await screen.findByText(WELCOME_TEXT);
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    await sendMessage("yes, do that");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ message: "yes, do that", sessionId: welcomeSession });
  });

  it("marks the welcome sent before it starts, and a reload mid-welcome re-attaches instead of asking again", async () => {
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => deferred<Response>().promise);
    const first = render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-reload" token="box-token" agentName="Atlas" agentKind="claude" />);
    await waitFor(() => expect(startAgentWelcomeRun).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("hivra:first-welcome:welcomereload")).toBe("1");
    const { runId, clientRef } = (startAgentWelcomeRun as jest.Mock).mock.calls[0][0];

    // Leaving the chat (no pagehide) still saves the reply's run id.
    first.unmount();
    const saved = JSON.parse(window.localStorage.getItem("hivra_sessions_welcomereload") || "[]");
    expect(saved[0].messages).toEqual([expect.objectContaining({ role: "assistant", runId })]);

    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef, title: HIDDEN_WELCOME_TITLE })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Here are the three CRMs."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(replay));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-reload" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByText("Here are the three CRMs.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`https://box.example.com/api/chat/runs/${runId}/events`, expect.anything());
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(1);
  });

  it("falls back to the starter suggestions and tries again next visit when the welcome never starts", async () => {
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => Promise.resolve({ ok: false, status: 502, body: null }));
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-refused" token="box-token" agentName="Atlas" agentKind="claude" goal="grow" />);

    await waitFor(() => expect(clientLog.warn).toHaveBeenCalledWith(
      "agent first message generation failed",
      expect.objectContaining({ reason: "refused", status: 502 }),
    ));
    expect(await screen.findByText("…or just type below.")).toBeInTheDocument();
    expect(window.localStorage.getItem("hivra:first-welcome:welcomerefused")).toBeNull();
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
  });

  it("starts the welcome again after a reload when its request never reached the computer", async () => {
    (startAgentWelcomeRun as jest.Mock).mockImplementationOnce(() => deferred<Response>().promise);
    const first = render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-lost" token="box-token" agentName="Atlas" agentKind="claude" />);
    await waitFor(() => expect(startAgentWelcomeRun).toHaveBeenCalledTimes(1));
    first.unmount();

    // The computer was still starting: it lists no such run and keeps no log of it.
    (listBoxChatRuns as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null }) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-lost" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByText(WELCOME_TEXT)).toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hivra:first-welcome:welcomelost")).toBe("1");
  });

  it("keeps Retry on a retried welcome that never reached the computer, instead of dropping it", async () => {
    const conversation = "00000000-0000-4000-8000-000000000018";
    window.localStorage.setItem("hivra:first-welcome:welcomeretrylost", "1");
    window.localStorage.setItem("hivra_sessions_welcomeretrylost", JSON.stringify([{
      id: "w1", title: "Welcome", claudeSessionId: conversation, createdAt: 1,
      messages: [{ role: "assistant", text: "", tools: [], runId: "00000000-0000-4000-8000-000000000019", welcome: true }],
    }]));
    (listBoxChatRuns as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null }) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-retry-lost" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByLabelText("Response failed")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(WELCOME_TEXT)).toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(1);
    expect((startAgentWelcomeRun as jest.Mock).mock.calls[0][0]).toMatchObject({ resumeSessionId: conversation });
  });

  it("keeps a welcome that failed on the computer visible, with a Retry that carries on its conversation", async () => {
    const conversation = "00000000-0000-4000-8000-000000000011";
    const failed = jest.fn()
      .mockResolvedValueOnce(eventChunk(
        { type: "_run", runId: "x", detached: true },
        { type: "system", subtype: "init", session_id: conversation },
        { type: "result", subtype: "success", is_error: true, result: "Credit balance is too low", session_id: conversation },
        { type: "_done", code: 1 },
      ))
      .mockResolvedValueOnce({ done: true, value: undefined });
    (startAgentWelcomeRun as jest.Mock).mockImplementationOnce(() => Promise.resolve(chatResponse(failed)));
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-error" token="box-token" agentName="Atlas" agentKind="claude" firstTask="Compare three CRMs" />);

    expect(await screen.findByText(/Credit balance is too low/)).toBeInTheDocument();
    expect(screen.getByLabelText("Response failed")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText(WELCOME_TEXT)).toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(2);
    expect((startAgentWelcomeRun as jest.Mock).mock.calls[1][0]).toMatchObject({ firstTask: "Compare three CRMs", resumeSessionId: conversation });
    expect(screen.queryByText(/Credit balance is too low/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
  });

  it("treats a welcome that finished without a word as failed, and keeps its Retry after a reload", async () => {
    const empty = jest.fn()
      .mockResolvedValueOnce(eventChunk({ type: "_run", runId: "x", detached: true }, { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    (startAgentWelcomeRun as jest.Mock).mockImplementationOnce(() => Promise.resolve(chatResponse(empty)));
    const first = render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-empty" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByLabelText("Response failed")).toBeInTheDocument();
    expect(screen.getByText(/finished without replying/)).toBeInTheDocument();
    await screen.findByRole("button", { name: "Retry" });
    first.unmount();

    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-empty" token="box-token" agentName="Atlas" agentKind="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(WELCOME_TEXT)).toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(2);
  });

  it("never starts a second welcome while the computer already runs one, and opens that one in the blank chat", async () => {
    const runId = "00000000-0000-4000-8000-00000000000f";
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: HIDDEN_WELCOME_TITLE })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Atlas here. Your CRM shortlist:"), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(replay)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-elsewhere" token="box-token" agentName="Atlas" agentKind="claude" />);

    // The open chat shows it; the rail is never opened.
    expect(await screen.findByText("Atlas here. Your CRM shortlist:")).toBeInTheDocument();
    // Once that welcome is done and the chat is idle, no other one starts.
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(startAgentWelcomeRun).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("hivra:first-welcome:welcomeelsewhere")).toBe("1");
  });

  it("does not start the welcome when the computer's run list shows it already ran", async () => {
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId: "00000000-0000-4000-8000-000000000012", state: "finished", title: HIDDEN_WELCOME_TITLE })]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-ran" token="box-token" agentName="Atlas" agentKind="claude" goal="grow" />);

    await waitFor(() => expect(window.localStorage.getItem("hivra:first-welcome:welcomeran")).toBe("1"));
    await act(async () => { await Promise.resolve(); });
    expect(startAgentWelcomeRun).not.toHaveBeenCalled();
    expect(screen.getByText("…or just type below.")).toBeInTheDocument();
  });

  it("shares the welcome between the agent page and the workspace view of the same computer", async () => {
    const agentId = "00000000-0000-4000-8000-000000000010";
    const agentPage = render(<HivraChat boxUrl="https://box.example.com" storageKey={agentId} token="box-token" agentName="Atlas" agentKind="claude" />);
    await screen.findByText(WELCOME_TEXT);
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    agentPage.unmount();

    render(<HivraChat boxUrl="https://box.example.com" storageKey={`x-${agentId}`} token="box-token" agentName="Atlas" agentKind="claude" />);
    await waitFor(() => expect(listBoxChatRuns).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByText("…or just type below.")).toBeInTheDocument();
    expect(startAgentWelcomeRun).toHaveBeenCalledTimes(1);
  });

  it("shows an older computer's welcome, which streams without the run preface", async () => {
    const read = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Hello from an older computer.")))
      .mockResolvedValueOnce({ done: true, value: undefined });
    (startAgentWelcomeRun as jest.Mock).mockImplementation(() => Promise.resolve(chatResponse(read)));
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-legacy" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByText("Hello from an older computer.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
  });

  it("saves a just-started reply's run id when the chat unmounts inside the save debounce", async () => {
    window.localStorage.setItem("hivra:first-welcome:unmount-save", "1");
    const pending = deferred<{ done: boolean; value?: Uint8Array }>();
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(jest.fn(() => pending.promise)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { unmount } = render(<HivraChat boxUrl="https://box.example.com" storageKey="unmount-save" token="box-token" agentName="Atlas" agentKind="claude" />);

    await sendMessage("long task");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { runId } = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    unmount();

    const saved = JSON.parse(window.localStorage.getItem("hivra_sessions_unmountsave") || "[]");
    expect(saved[0].messages).toEqual([
      expect.objectContaining({ role: "user", text: "long task" }),
      expect.objectContaining({ role: "assistant", runId }),
    ]);
  });

  // ── Replies started on another device ─────────────────────────────────────

  it("adopts a running reply from another device into the conversation it belongs to", async () => {
    window.localStorage.setItem("hivra:first-welcome:adopt-stub", "1");
    const conversation = "00000000-0000-4000-8000-000000000005";
    const runId = "00000000-0000-4000-8000-000000000006";
    (listBoxSessions as jest.Mock).mockResolvedValue([{ id: conversation, title: "Plan the week", updatedAt: 5 }]);
    (readBoxSession as jest.Mock).mockResolvedValue([
      { role: "user", text: "Earlier question", tools: [] },
      { role: "assistant", text: "Earlier answer", tools: [] },
      { role: "user", text: "Plan the week", tools: [] },
      { role: "assistant", text: "Partial box copy", tools: [] },
    ]);
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: "Plan the week", agentSessionId: conversation })]);
    const pending = deferred<{ done: boolean; value?: Uint8Array }>();
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Monday: gym.")))
      .mockImplementationOnce(() => pending.promise);
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(replay));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-stub" token="box-token" agentName="Atlas" agentKind="claude" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`https://box.example.com/api/chat/runs/${runId}/events`, expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    // One chat for the conversation, marked as working.
    expect(await screen.findAllByText("Plan the week", { selector: "span" })).toHaveLength(1);
    expect(screen.getByLabelText("Working")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Plan the week", { selector: "span" }));
    expect(await screen.findByText("Monday: gym.")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByText("Plan the week", { selector: "div" })).toBeInTheDocument();
    // The live reply replays the turn; the box's partial copy is not doubled.
    expect(screen.queryByText("Partial box copy")).not.toBeInTheDocument();

    // A later wake-up never follows the same run twice.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(listBoxChatRuns).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches a reply from another device to the open chat of that conversation, under its earlier turns", async () => {
    const conversation = "00000000-0000-4000-8000-00000000000c";
    const runId = "00000000-0000-4000-8000-00000000000d";
    window.localStorage.setItem("hivra:first-welcome:adopt-open", "1");
    window.localStorage.setItem("hivra_sessions_adoptopen", JSON.stringify([
      { id: `box-${conversation}`, title: "Plan the week", claudeSessionId: conversation, messages: [], createdAt: 5, loaded: false },
    ]));
    window.localStorage.setItem("hivra_sessions_adoptopen_active", `box-${conversation}`);
    (listBoxSessions as jest.Mock).mockResolvedValue([{ id: conversation, title: "Plan the week", updatedAt: 5 }]);
    (readBoxSession as jest.Mock).mockResolvedValue([
      { role: "user", text: "Earlier question", tools: [] },
      { role: "assistant", text: "Earlier answer", tools: [] },
      { role: "user", text: "Plan the week", tools: [] },
    ]);
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: "Plan the week", agentSessionId: conversation })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Monday: gym."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(replay)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-open" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByText("Monday: gym.")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getAllByText("Plan the week", { selector: "div" })).toHaveLength(1);
    expect(readBoxSession).toHaveBeenCalledWith("https://box.example.com", conversation, "box-token");
  });

  it("adopts a running reply into a conversation opened meanwhile without doubling its prompt or partial output", async () => {
    window.localStorage.setItem("hivra:first-welcome:adopt-opened", "1");
    const conversation = "00000000-0000-4000-8000-000000000014";
    const runId = "00000000-0000-4000-8000-000000000015";
    (listBoxSessions as jest.Mock).mockResolvedValue([{ id: conversation, title: "Plan the week", updatedAt: 5 }]);
    (readBoxSession as jest.Mock).mockResolvedValue([
      { role: "user", text: "Earlier question", tools: [] },
      { role: "assistant", text: "Earlier answer", tools: [] },
      { role: "user", text: "Plan the week", tools: [] },
      { role: "assistant", text: "Partial box copy", tools: [] },
    ]);
    (listBoxChatRuns as jest.Mock).mockResolvedValue([]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-opened" token="box-token" agentName="Atlas" agentKind="claude" />);

    // The owner opens the conversation from its history while the phone's turn runs.
    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByText("Plan the week", { selector: "span" }));
    expect(await screen.findByText("Partial box copy")).toBeInTheDocument();

    // The next wake-up finds that turn running and follows it in the open chat.
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: "Plan the week", agentSessionId: conversation })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Monday: gym."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(replay)) as unknown as typeof fetch;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Monday: gym.")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getAllByText("Plan the week", { selector: "div" })).toHaveLength(1);
    expect(screen.queryByText("Partial box copy")).not.toBeInTheDocument();
  });

  it("opens a running reply from another device as its own chat when this device has no such conversation", async () => {
    window.localStorage.setItem("hivra:first-welcome:adopt-new", "1");
    const runId = "00000000-0000-4000-8000-000000000007";
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: "Draft the launch post" })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Here is the draft."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(replay)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-new" token="box-token" agentName="Atlas" agentKind="claude" />);

    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByText("Draft the launch post", { selector: "span" }));
    expect(await screen.findByText("Here is the draft.")).toBeInTheDocument();
    expect(screen.getByText("Draft the launch post", { selector: "div" })).toBeInTheDocument();
  });

  it("opens another device's running welcome as Welcome, without its hidden prompt", async () => {
    window.localStorage.setItem("hivra:first-welcome:adopt-welcome", "1");
    const runId = "00000000-0000-4000-8000-000000000008";
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "phone-session", title: HIDDEN_WELCOME_TITLE })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Atlas here. Your CRM shortlist:"), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(replay)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-welcome" token="box-token" agentName="Atlas" agentKind="claude" />);

    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByText("Welcome", { selector: "span" }));
    expect(await screen.findByText("Atlas here. Your CRM shortlist:")).toBeInTheDocument();
    expect(screen.queryByText(/hidden Hivra first-contact/i)).not.toBeInTheDocument();
    expect(screen.queryByText("YOU")).not.toBeInTheDocument();
  });

  it("stops a reply still running unseen when its chat is deleted, and never brings it back", async () => {
    const runId = "00000000-0000-4000-8000-00000000000e";
    window.localStorage.setItem("hivra:first-welcome:adopt-deleted", "1");
    window.localStorage.setItem("hivra_sessions_adoptdeleted", JSON.stringify([
      { id: "keep", title: "Other chat", claudeSessionId: null, createdAt: 2, messages: [] },
      { id: "gone", title: "Draft the launch post", claudeSessionId: null, createdAt: 1, messages: [
        { role: "user", text: "Draft the launch post", tools: [] },
        { role: "assistant", text: "Half", tools: [], runId },
      ] },
    ]));
    // The computer was unreachable when the chat opened, so the reply was not re-attached.
    (listBoxChatRuns as jest.Mock).mockResolvedValue(null);
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="adopt-deleted" token="box-token" agentName="Atlas" agentKind="claude" />);

    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    const row = screen.getByText("Draft the launch post", { selector: "span" }).closest("div")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete chat" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm delete chat" }));
    expect(stopBoxChatRun).toHaveBeenCalledWith("https://box.example.com", runId, "box-token");

    // Back online, the computer still lists it as running: it is not adopted.
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId, clientRef: "gone", title: "Draft the launch post" })]);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    await waitFor(() => expect(listBoxChatRuns).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Draft the launch post", { selector: "span" })).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── A reply whose run the computer no longer lists ────────────────────────

  function storeReply(key: string, reply: Record<string, unknown>) {
    window.localStorage.setItem(`hivra:first-welcome:${key}`, "1");
    window.localStorage.setItem(`hivra_sessions_${key.replace(/[^a-z0-9]/gi, "")}`, JSON.stringify([{
      id: "s1", title: "long task", claudeSessionId: "00000000-0000-4000-8000-000000000001", createdAt: 1,
      messages: [{ role: "user", text: "long task", tools: [] }, { role: "assistant", tools: [], ...reply }],
    }]));
  }

  // The computer keeps a run's log after the run leaves its (newest-first) list.
  const logGone = () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null }) as unknown as typeof fetch;
  };

  it("replays a reply the computer's run list no longer shows but whose log it still keeps", async () => {
    const runId = "00000000-0000-4000-8000-000000000016";
    storeReply("beyond-list", { text: "Half", runId });
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId: "00000000-0000-4000-8000-000000000017", state: "finished" })]);
    const replay = jest.fn()
      .mockResolvedValueOnce(eventChunk(replyText("Half"), replyText(" and the rest."), { type: "_done", code: 0 }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockResolvedValue(chatResponse(replay));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="beyond-list" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByText("Half and the rest.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`https://box.example.com/api/chat/runs/${runId}/events`, expect.anything());
    expect(screen.queryByLabelText("Finished while you were away")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
  });

  it("settles a reply whose run aged out as finished while away, not failed, and opens the full reply from history", async () => {
    storeReply("aged-out", { text: "The first half", runId: "00000000-0000-4000-8000-000000000009" });
    (listBoxChatRuns as jest.Mock).mockResolvedValue([runningRun({ runId: "00000000-0000-4000-8000-00000000000a", state: "finished" })]);
    logGone();
    (readBoxSession as jest.Mock).mockResolvedValue([
      { role: "user", text: "long task", tools: [] },
      { role: "assistant", text: "The first half and the second half.", tools: [] },
    ]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="aged-out" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByLabelText("Finished while you were away")).toHaveTextContent("Finished while you were away — open the history to see the full reply");
    expect(screen.getByText("The first half")).toBeInTheDocument();
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open the history" }));
    expect(await screen.findByText("The first half and the second half.")).toBeInTheDocument();
    expect(readBoxSession).toHaveBeenCalledWith("https://box.example.com", "00000000-0000-4000-8000-000000000001", "box-token");
    expect(screen.queryByLabelText("Finished while you were away")).not.toBeInTheDocument();
  });

  it("keeps the failure state for a missing reply with no sign its run ever started", async () => {
    storeReply("never-started", { text: "", runId: "00000000-0000-4000-8000-00000000000b" });
    (listBoxChatRuns as jest.Mock).mockResolvedValue([]);
    logGone();
    render(<HivraChat boxUrl="https://box.example.com" storageKey="never-started" token="box-token" agentName="Atlas" agentKind="claude" />);

    expect(await screen.findByLabelText("Response failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Finished while you were away")).not.toBeInTheDocument();
  });

});
