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
});
