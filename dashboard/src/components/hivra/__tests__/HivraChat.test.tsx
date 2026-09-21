/** @jest-environment jsdom */
import { TextDecoder, TextEncoder } from "util";

// jsdom doesn't ship TextDecoder/TextEncoder; HivraChat's NDJSON stream reader
// constructs one per turn.
Object.assign(globalThis, {
  TextDecoder: (globalThis as { TextDecoder?: unknown }).TextDecoder ?? TextDecoder,
  TextEncoder: (globalThis as { TextEncoder?: unknown }).TextEncoder ?? TextEncoder,
});

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        ].map((event) => JSON.stringify(event)).join("\n") + "\n"),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;

    render(<HivraChat boxUrl="https://box.example.com" storageKey="activity-history" agentName="Atlas" agentKind="claude" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("inspect the files");

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("1 action", { selector: "summary" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("1 action", { selector: "summary" }));
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
    fireEvent.click(screen.getByText("1 action", { selector: "summary" }));
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
    fireEvent.click(screen.getByText("1 action", { selector: "summary" }));
    expect(screen.getByRole("button", { name: /Bash.*Unconfirmed/ })).toBeDisabled();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("keeps a past tool failure in history while the agent continues responding", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk(pendingToolEvent, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "action", is_error: true, content: "permission denied" }] } })).mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("begin");
    expect(await screen.findByText("Responding")).toBeInTheDocument();
    expect(screen.getByText("1 action", { selector: "summary" }).closest("details")).not.toHaveAttribute("open");
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

  it("keeps all concurrently running tools visible and out of previous history", async () => {
    const pending = deferred<{ done: boolean }>();
    const read = jest.fn().mockResolvedValueOnce(eventChunk(runningToolEvent("one", "ls"), runningToolEvent("two", "pwd")))
      .mockImplementationOnce(() => pending.promise);
    global.fetch = jest.fn().mockResolvedValue(chatResponse(read)) as unknown as typeof fetch;
    render(<HivraChat boxUrl="https://box.example.com" agentName="Atlas" />);
    await screen.findByText("Atlas here, ready to grow the SaaS.");
    await sendMessage("inspect");
    expect(await screen.findByRole("button", { name: "Bash · ls — Running" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Bash · pwd — Running" })).toBeVisible();
    expect(screen.getByText(/2 actions running/)).toBeInTheDocument();
    expect(screen.queryByText(/previous action/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ done: true }); });
    expect(screen.getByText("Completion unconfirmed")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("2 actions", { selector: "summary" }));
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
    fireEvent.click(screen.getByText("1 action", { selector: "summary" }));
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

});
