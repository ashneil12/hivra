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

import { HivraChat } from "../HivraChat";
import { listBoxSessions, readBoxSession, stampAgentFirstUsage } from "@/lib/hivra/agent-api";
import { requestAgentWelcomeMessage } from "@/lib/hivra/agent-welcome";

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
}));

jest.mock("@/lib/hivra/agent-welcome", () => ({
  requestAgentWelcomeMessage: jest.fn(),
  isHiddenWelcomeTitle: jest.requireActual("@/lib/hivra/agent-welcome").isHiddenWelcomeTitle,
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

function eventChunk(...events: unknown[]) {
  return { done: false, value: new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n") };
}

describe("HivraChat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    (listBoxSessions as jest.Mock).mockResolvedValue([]);
    (readBoxSession as jest.Mock).mockResolvedValue([]);
    (stampAgentFirstUsage as jest.Mock).mockResolvedValue(undefined);
    (requestAgentWelcomeMessage as jest.Mock).mockResolvedValue("Atlas here, ready to grow the SaaS.");
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
    expect(requestAgentWelcomeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        boxUrl: "https://box.example.com",
        token: "box-token",
        agentKind: "claude",
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
    expect(requestAgentWelcomeMessage).toHaveBeenCalledWith(
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
      expect(requestAgentWelcomeMessage).not.toHaveBeenCalled();
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
          { type: "_done", code: 0 },
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
    const read = jest.fn().mockResolvedValueOnce(eventChunk(partialText, pendingToolEvent, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "action", is_error: true, content: "permission denied" }] } })).mockImplementationOnce(() => pending.promise).mockResolvedValue({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByText("Responding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 action" })).toHaveAttribute("aria-expanded", "false");
    await act(async () => pending.resolve(eventChunk({ type: "_done", code: 0 })));
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
    }, { type: "_done", code: 0 })).mockResolvedValueOnce({ done: true });
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
    }, { type: "_done", code: 0 })).mockResolvedValueOnce({ done: true });
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


  // ── Turn outcome contract: warnings vs terminal failure vs box exit ─────
  const exitEvent = (code: number | null) => ({ type: "_done", code });
  const claudeText = (t: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  const toolResult = (id: string, content: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
  const activityLabels = () => Array.from(document.querySelectorAll(".hivra-chat-activity-label")).map((n) => n.textContent);
  const turnStates = () => Array.from(document.querySelectorAll(".hivra-chat-turn-state")).map((n) => n.textContent);

  it("keeps a turn complete when a non-fatal stderr warning precedes a successful result", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(
      { type: "_stderr", text: "[MCP] server 'docs' connection error, continuing without it" },
      runningToolEvent("t1", "ls"), toolResult("t1", "file.txt"), claudeText("Here are your files."),
      { type: "result", subtype: "success", is_error: false, result: "Here are your files.", session_id: "s1" },
      exitEvent(0),
    )).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="warn-claude" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("list");
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(screen.getByText("Here are your files.")).toBeInTheDocument();
    expect(screen.getByText(/connection error, continuing without it/)).toBeVisible();
    expect(activityLabels()).toEqual(["Completed"]);
    expect(screen.queryByText("Could not complete response")).not.toBeInTheDocument();
    expect(turnStates()).toEqual([]);
  });

  it("keeps a codex retry warning visible after setText and still reads complete", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(
      { type: "thread.started", thread_id: "th1" },
      { type: "error", message: "Reconnecting... 1/5" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "All done, here is the answer." } },
      { type: "turn.completed", usage: {} },
      exitEvent(0),
    )).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="warn-codex" agentName="Atlas" agentKind="codex" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("go");
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(screen.getByText("All done, here is the answer.")).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting\.\.\. 1\/5/)).toBeVisible();
    expect(screen.queryByText("Could not complete response")).not.toBeInTheDocument();
    expect(turnStates()).toEqual([]);
  });

  it("marks the turn failed when the box reports the CLI was killed (exit 137) and keeps partial text", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(
      runningToolEvent("t1", "npm test"), toolResult("t1", "3 passed"), claudeText("Tests pass. Now I will upd"), exitEvent(137),
    )).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="exit-137" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("run tests");
    const failed = await screen.findByRole("status", { name: "Response failed" });
    expect(failed).toHaveTextContent("Could not complete response");
    expect(failed).toHaveTextContent("Agent process exited unexpectedly (code 137)");
    expect(screen.getByText("Tests pass. Now I will upd")).toBeInTheDocument();
    expect(activityLabels()).toEqual(["Response failed"]);
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("marks the turn failed when the box reports a signal kill (exit code null)", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(claudeText("Half an answ"), exitEvent(null))).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="exit-null" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("go");
    const failed = await screen.findByRole("status", { name: "Response failed" });
    expect(failed).toHaveTextContent(/Agent process was killed before it finished/);
    expect(screen.getByText("Half an answ")).toBeInTheDocument();
  });

  it("treats a clean EOF without the box's exit report as unconfirmed, not complete", async () => {
    const read = jest.fn().mockResolvedValueOnce(eventChunk(runningToolEvent("t1", "ls"), toolResult("t1", "ok"), claudeText("Answer"))).mockResolvedValueOnce({ done: true });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="eof-no-done" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("go");
    expect(await screen.findByRole("status", { name: "Response unconfirmed" })).toBeInTheDocument();
    expect(activityLabels()).toEqual(["Completion unconfirmed"]);
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  // ── Turn ownership: every update targets the request's own message ─────
  it("settles the in-flight turn when the box URL changes and never stamps it complete later", async () => {
    const pendingA = deferred<{ done: boolean; value?: Uint8Array }>();
    const readA = jest.fn().mockResolvedValueOnce(eventChunk(runningToolEvent("t1", "sleep 99"))).mockImplementationOnce(() => pendingA.promise);
    const readB = jest.fn().mockResolvedValueOnce(eventChunk(claudeText("second answer"), exitEvent(0))).mockResolvedValueOnce({ done: true });
    const fetchMock = jest.fn().mockResolvedValueOnce(chatResponse(readA)).mockResolvedValueOnce(chatResponse(readB));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { rerender } = render(<HivraChat boxUrl="https://tunnel-1.example.com" storageKey="agent-stable" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("run");
    expect(await screen.findByText("Working")).toBeInTheDocument();
    const signalA = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    rerender(<HivraChat boxUrl="https://tunnel-2.example.com" storageKey="agent-stable" agentName="Atlas" agentKind="claude" />);
    await waitFor(() => expect(signalA.aborted).toBe(true));
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(activityLabels()).toEqual(["Activity interrupted"]);
    expect(turnStates()).toEqual(["Interrupted"]);
    await sendMessage("second");
    await screen.findByText("second answer");
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    await act(async () => pendingA.resolve({ done: true }));
    expect(activityLabels()).toEqual(["Activity interrupted"]);
    expect(turnStates()).toEqual(["Interrupted"]);
  });

  it("keeps an observed agent error when the user presses Stop before the CLI exits", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk({ type: "result", is_error: true, result: "Model unavailable" })).mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="stop-after-error" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("go");
    await screen.findByText(/Model unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(screen.getByRole("status", { name: "Response failed" })).toHaveTextContent("Could not complete response");
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
  });

  function seedSessions(skey: string, sessions: unknown[], activeId: string) {
    const key = "hivra_sessions_" + skey.replace(/[^a-z0-9]/gi, "").slice(-32);
    window.localStorage.setItem(key, JSON.stringify(sessions));
    window.localStorage.setItem(key + "_active", activeId);
  }
  const toolTurn = (q: string, a: string) => [
    { role: "user", text: q, tools: [] },
    { role: "assistant", text: a, tools: [{ id: "x", name: "Bash", detail: "ls", status: "done", result: "out" }], outcome: "complete" },
  ];

  it("does not carry a message's expanded tool history into another session", async () => {
    seedSessions("leak-keys", [
      { id: "a", title: "Chat A", claudeSessionId: null, createdAt: 2, messages: toolTurn("qa", "answer A") },
      { id: "b", title: "Chat B", claudeSessionId: null, createdAt: 1, messages: toolTurn("qb", "answer B") },
    ], "a");
    render(<HivraChat boxUrl="https://box.example.com" storageKey="leak-keys" agentName="Atlas" />);
    await screen.findByText("answer A");
    fireEvent.click(screen.getByRole("button", { name: "1 action" }));
    expect(screen.getByRole("button", { name: "1 action" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    fireEvent.click(screen.getByText("Chat B"));
    await screen.findByText("answer B");
    expect(screen.getByRole("button", { name: "1 action" })).toHaveAttribute("aria-expanded", "false");
  });

  it("never writes a deleted chat's late stream or resume id into the session that becomes active", async () => {
    seedSessions("delete-mid-stream", [
      { id: "a", title: "Chat A", claudeSessionId: "sid-a", createdAt: 2, messages: [{ role: "user", text: "old a", tools: [] }, { role: "assistant", text: "A before", tools: [] }] },
      { id: "b", title: "Chat B", claudeSessionId: "sid-b", createdAt: 1, messages: [{ role: "user", text: "old q", tools: [] }, { role: "assistant", text: "OLD ANSWER", tools: [] }] },
    ], "a");
    const late = deferred<{ done: boolean; value?: Uint8Array }>();
    const readA = jest.fn().mockResolvedValueOnce(eventChunk(claudeText("new partial"))).mockImplementationOnce(() => late.promise).mockResolvedValue({ done: true });
    const readB = jest.fn().mockResolvedValueOnce(eventChunk(claudeText("B reply"), exitEvent(0))).mockResolvedValueOnce({ done: true });
    const fetchMock = jest.fn().mockResolvedValueOnce(chatResponse(readA)).mockResolvedValueOnce(chatResponse(readB));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="delete-mid-stream" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("A before");
    await sendMessage("continue a");
    await screen.findByText("new partial");
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat: Chat A" }));
    await screen.findByText("OLD ANSWER");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => late.resolve(eventChunk(claudeText(" + LATE TEXT"), { type: "result", is_error: false, session_id: "sid-a-new" }, exitEvent(0))));
    expect(screen.getByText("OLD ANSWER")).toBeInTheDocument();
    expect(screen.queryByText(/LATE TEXT/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    await sendMessage("follow up in b");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).sessionId).toBe("sid-b");
  });

  it("makes Stop cancel the auto-welcome / first-task turn", async () => {
    let welcomeSignal: AbortSignal | undefined;
    (requestAgentWelcomeMessage as jest.Mock).mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      welcomeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    render(<HivraChat boxUrl="https://box.example.com" storageKey="welcome-stop" agentName="Atlas" firstTask="Research CRMs" />);
    expect(await screen.findByText("Waiting for response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(welcomeSignal?.aborted).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    expect(screen.queryByText("Waiting for response")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Response stopped" })).toBeInTheDocument();
  });

  // ── Streaming autoscroll: user scroll intent always wins ──────────────
  function controlledStream() {
    const queue: ReturnType<typeof deferred<{ done: boolean; value?: Uint8Array }>>[] = [];
    let cursor = 0;
    const slot = (i: number) => (queue[i] ??= deferred<{ done: boolean; value?: Uint8Array }>());
    const read = jest.fn(() => slot(cursor++).promise);
    let pushed = 0;
    return {
      read,
      push: async (...events: unknown[]) => { await act(async () => { slot(pushed++).resolve(eventChunk(...events)); }); },
      end: async () => { await act(async () => { slot(pushed++).resolve({ done: true }); }); },
    };
  }

  function scrollablePane() {
    const pane = screen.getByRole("region", { name: "Conversation" });
    let top = 0;
    let height = 1500;
    Object.defineProperties(pane, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 500)); } },
    });
    return {
      pane,
      get top() { return top; },
      grow: (px: number) => { height += px; },
      userScrollTo: (v: number) => { pane.scrollTop = v; fireEvent.scroll(pane); },
      bottom: () => height - 500,
    };
  }

  async function withFrames(run: (flush: () => void) => Promise<void>) {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(nextFrame, cb); return nextFrame++; });
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const flush = () => act(() => { const pending = Array.from(frames.values()); frames.clear(); pending.forEach((cb) => cb(0)); });
    try { await run(flush); } finally { request.mockRestore(); cancel.mockRestore(); }
  }

  it("keeps the user's reading position while streaming, for small and large scroll-ups, until they return to the bottom", async () => {
    await withFrames(async (flush) => {
      const stream = controlledStream();
      global.fetch = jest.fn().mockResolvedValue(chatResponse(stream.read)) as unknown as typeof fetch;
      render(<HivraChat boxUrl="https://box.example.com" storageKey="scroll-stream" agentName="Atlas" agentKind="claude" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const view = scrollablePane();
      await sendMessage("write a long answer");
      await stream.push(claudeText("First paragraph. "));
      flush();
      expect(view.top).toBe(view.bottom());

      // A small trackpad / arrow-key scroll-up (well under the 80px threshold).
      view.userScrollTo(view.bottom() - 30);
      const reading = view.top;
      view.grow(100);
      await stream.push(claudeText("More text. "));
      flush();
      expect(view.top).toBe(reading);
      expect(screen.getByRole("button", { name: "Return to latest" })).toBeVisible();

      // A large scroll-up also sticks.
      view.userScrollTo(300);
      view.grow(100);
      await stream.push(claudeText("Even more. "));
      flush();
      expect(view.top).toBe(300);

      // Moving back down without reaching the bottom does not re-stick.
      view.userScrollTo(view.bottom() - 40);
      const almost = view.top;
      view.grow(100);
      await stream.push(claudeText("Still more. "));
      flush();
      expect(view.top).toBe(almost);

      // Returning to the bottom re-engages following.
      view.userScrollTo(view.bottom());
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
      view.grow(100);
      await stream.push(claudeText("Last bit."), exitEvent(0));
      flush();
      expect(view.top).toBe(view.bottom());
      await stream.end();
    });
  });

  it("unsticks on wheel-up and keyboard scroll intent before any scroll event lands", async () => {
    await withFrames(async (flush) => {
      const stream = controlledStream();
      global.fetch = jest.fn().mockResolvedValue(chatResponse(stream.read)) as unknown as typeof fetch;
      render(<HivraChat boxUrl="https://box.example.com" storageKey="scroll-intent" agentName="Atlas" agentKind="claude" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const view = scrollablePane();
      await sendMessage("stream");
      await stream.push(claudeText("a "));
      flush();
      const atBottom = view.top;
      fireEvent.wheel(view.pane, { deltaY: -4 });
      view.grow(100);
      await stream.push(claudeText("b "));
      flush();
      expect(view.top).toBe(atBottom);

      view.userScrollTo(view.bottom());
      flush();
      fireEvent.keyDown(view.pane, { key: "ArrowUp" });
      const beforeToken = view.top;
      view.grow(100);
      await stream.push(claudeText("c "));
      flush();
      expect(view.top).toBe(beforeToken);
      expect(screen.getByRole("button", { name: "Return to latest" })).toBeVisible();
      await stream.end();
    });
  });

  it("moves focus to the composer when 'Return to latest' is activated", async () => {
    await withFrames(async (flush) => {
      render(<HivraChat boxUrl="https://box.example.com" storageKey="latest-focus" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const view = scrollablePane();
      flush();
      view.userScrollTo(100);
      const latest = screen.getByRole("button", { name: "Return to latest" });
      latest.focus();
      fireEvent.click(latest);
      flush();
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Message Atlas" })).toHaveFocus();
      expect(view.top).toBe(view.bottom());
    });
  });

  // ── Accessibility: live regions, session rail, box-history wording ─────
  it("keeps historical turns out of live regions and makes only the current turn live", async () => {
    seedSessions("live-scope", [
      { id: "a", title: "Chat A", claudeSessionId: null, createdAt: 2, messages: [
        ...toolTurn("q1", "answer one"),
        { role: "user", text: "q2", tools: [] },
        { role: "assistant", text: "partial", tools: [{ id: "y", name: "Bash", detail: "make", status: "error" }], outcome: "error", failure: "Model unavailable" },
      ] },
    ], "a");
    const stream = controlledStream();
    global.fetch = jest.fn().mockResolvedValue(chatResponse(stream.read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" storageKey="live-scope" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("answer one");
    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(conversation.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(within(conversation).queryAllByRole("status")).toHaveLength(0);
    expect(within(conversation).getByRole("note", { name: "Response failed" })).toHaveTextContent("Model unavailable");
    await sendMessage("q3");
    await stream.push(runningToolEvent("t9", "ls"));
    const live = conversation.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent("Working");
    await stream.push(exitEvent(137));
    await stream.end();
    expect(conversation.querySelectorAll("[aria-live]")).toHaveLength(1);
    // The settled current turn stays announced: its summary and its failure row.
    const statuses = within(conversation).getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("Response failed");
    expect(statuses[1]).toHaveAccessibleName("Response failed");
    expect(statuses[1]).toHaveTextContent("Agent process exited unexpectedly (code 137)");
  });

  it("renders session rail rows as keyboard-operable buttons with a valid, named delete control", async () => {
    seedSessions("rail-a11y", [
      { id: "a", title: "Chat A", claudeSessionId: null, createdAt: 2, messages: [{ role: "user", text: "qa", tools: [] }, { role: "assistant", text: "answer A", tools: [] }] },
      { id: "b", title: "Chat B", claudeSessionId: null, createdAt: 1, messages: [{ role: "user", text: "qb", tools: [] }, { role: "assistant", text: "answer B", tools: [] }] },
    ], "a");
    render(<HivraChat boxUrl="https://box.example.com" storageKey="rail-a11y" agentName="Atlas" />);
    await screen.findByText("answer A");
    fireEvent.click(screen.getByRole("button", { name: "Show chats" }));
    const rowA = screen.getByRole("button", { name: "Chat A" });
    const rowB = screen.getByRole("button", { name: "Chat B" });
    expect(rowA.tagName).toBe("BUTTON");
    expect(rowA).toHaveAttribute("aria-current", "true");
    expect(rowB).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Delete chat: Chat A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete chat: Chat B" })).toBeInTheDocument();
    expect(document.querySelectorAll("button button")).toHaveLength(0);
    rowB.focus();
    expect(rowB).toHaveFocus();
    fireEvent.click(rowB);
    expect(await screen.findByText("answer B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat B" })).toHaveAttribute("aria-current", "true");
  });

  it("describes resumed box-history tools honestly instead of 'Completion unconfirmed'", async () => {
    (listBoxSessions as jest.Mock).mockResolvedValue([{ id: "remote-1", title: "Past work", updatedAt: Date.now() }]);
    (readBoxSession as jest.Mock).mockResolvedValue([
      { role: "user", text: "fix the build" },
      { role: "assistant", text: "Fixed it.", tools: ["Bash", "Edit"] },
    ]);
    render(<HivraChat boxUrl="https://box.example.com" storageKey="box-history" token="t" agentName="Atlas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByText("Past work"));
    expect(await screen.findByText("Fixed it.")).toBeInTheDocument();
    expect(screen.getByText("2 earlier actions")).toBeInTheDocument();
    expect(screen.getByText("results not stored")).toBeInTheDocument();
    expect(screen.queryByText("Completion unconfirmed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2 actions" }));
    expect(screen.getByRole("button", { name: "Bash — Result not stored" })).toBeInTheDocument();
  });

  // ── Composer: IME commit, width-driven height, touch keyboards ─────────
  it("does not send on the Enter that commits an IME composition (Safari keyCode 229 / composition events)", async () => {
    const fetchMock = mockChatFetchOk();
    render(<HivraChat boxUrl="https://box.example.com" storageKey="ime" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
    fireEvent.change(textarea, { target: { value: "にほん" } });
    // An IME keystroke reported only as keyCode 229 (no composition events seen).
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.compositionEnd(textarea);
    // Safari fires compositionend BEFORE the commit Enter, with isComposing false.
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("refits the composer height when its width changes, not only when the text changes", async () => {
    const observers: { cb: ResizeObserverCallback; el?: Element }[] = [];
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      private entry: { cb: ResizeObserverCallback; el?: Element };
      constructor(cb: ResizeObserverCallback) { this.entry = { cb }; observers.push(this.entry); }
      observe(el: Element) { this.entry.el = el; }
      unobserve() {}
      disconnect() {}
    };
    try {
      render(<HivraChat boxUrl="https://box.example.com" storageKey="composer-width" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
      const observer = observers.find((o) => o.el === textarea);
      expect(observer).toBeDefined();
      const resize = (width: number) => act(() => observer!.cb([{ target: textarea, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
      Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 100 });
      fireEvent.change(textarea, { target: { value: "a long draft that wraps" } });
      expect(textarea).toHaveStyle({ height: "100px", overflowY: "hidden" });
      resize(600);
      // The rail opens: narrower textarea, more wrapped lines.
      Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 200 });
      resize(400);
      expect(textarea).toHaveStyle({ height: "160px", overflowY: "auto" });
      // Wider again: the extra height is released.
      Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 70 });
      resize(700);
      expect(textarea).toHaveStyle({ height: "70px", overflowY: "hidden" });
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  function mockPointer(coarse: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return () => { window.matchMedia = original; };
  }

  it("lets Return insert a newline on touch keyboards and sends only via the Send button", async () => {
    const restore = mockPointer(true);
    try {
      const fetchMock = mockChatFetchOk();
      render(<HivraChat boxUrl="https://box.example.com" storageKey="coarse" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
      expect(textarea).toHaveAttribute("enterkeyhint", "enter");
      fireEvent.change(textarea, { target: { value: "line one" } });
      const enter = fireEvent.keyDown(textarea, { key: "Enter" });
      expect(enter).toBe(true); // default not prevented: the keyboard inserts a newline
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
      expect(screen.getByText(/Return adds a new line · tap Send to send/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it("keeps Enter-to-send and a truthful hint on fine pointers", async () => {
    const restore = mockPointer(false);
    try {
      const fetchMock = mockChatFetchOk();
      render(<HivraChat boxUrl="https://box.example.com" storageKey="fine" agentName="Atlas" />);
      await screen.findByText("Atlas here, ready to grow the SaaS.");
      const textarea = screen.getByRole("textbox", { name: "Message Atlas" });
      expect(textarea).toHaveAttribute("enterkeyhint", "send");
      expect(screen.getByText(/Enter to send, Shift\+Enter for newline/)).toBeInTheDocument();
      fireEvent.change(textarea, { target: { value: "hello" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });
});
