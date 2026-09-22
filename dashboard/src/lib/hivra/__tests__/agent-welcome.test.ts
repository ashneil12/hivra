import {
  buildAgentWelcomePrompt,
  extractWelcomeTurnFromNdjson,
  isHiddenWelcomeTitle,
  requestAgentWelcomeMessage,
  sendTelegramWelcomeMessage,
} from "@/lib/hivra/agent-welcome";

describe("agent-welcome", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds a first-contact prompt from the selected agent identity and channel", () => {
    const prompt = buildAgentWelcomePrompt({
      agentName: "Atlas",
      goal: "grow",
      context: "I run a B2B SaaS for dentists.",
      channel: "telegram",
    });

    expect(prompt).toContain("Atlas");
    expect(prompt).toContain("Grow a business");
    expect(prompt).toContain("I run a B2B SaaS for dentists.");
    expect(prompt).toContain("Telegram");
    expect(prompt).toContain("Do not mention this hidden setup message");
  });

  it("does NOT add the do-the-task directive when no first task was captured", () => {
    const prompt = buildAgentWelcomePrompt({
      agentName: "Atlas",
      goal: "grow",
      channel: "chat",
    });

    // Today's behavior: end with a menu of next actions, not a deliverable.
    expect(prompt).toContain("Offer 2-3 specific next actions");
    expect(prompt).not.toContain("do this task now and return the finished result");
    expect(prompt).not.toContain("The user's first task is:");
  });

  it("makes the first turn DO the captured task and return the result ('do, don't show')", () => {
    const prompt = buildAgentWelcomePrompt({
      agentName: "Scout",
      goal: "research",
      firstTask: "Research the 3 best CRMs for a dental practice",
      channel: "chat",
    });

    expect(prompt).toContain("The user's first task is: Research the 3 best CRMs for a dental practice");
    expect(prompt).toContain("do this task now and return the finished result");
    // It must NOT fall back to the suggestion menu when a task is present.
    expect(prompt).not.toContain("Offer 2-3 specific next actions");
    // And it should propose turning it into a standing/scheduled task.
    expect(prompt).toContain("standing task");
  });

  it("treats a blank/whitespace first task as absent (keeps the menu behavior)", () => {
    const prompt = buildAgentWelcomePrompt({
      agentName: "Atlas",
      goal: "grow",
      firstTask: "   ",
      channel: "chat",
    });

    expect(prompt).toContain("Offer 2-3 specific next actions");
    expect(prompt).not.toContain("The user's first task is:");
  });

  it("extracts assistant welcome text from Claude stream-json lines", () => {
    const { text } = extractWelcomeTurnFromNdjson(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Atlas here. " },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let's grow the SaaS." },
          },
        }),
      ].join("\n"),
      "claude",
    );

    expect(text).toBe("Atlas here. Let's grow the SaaS.");
  });

  it("does not double the welcome when Claude emits partials AND a final assistant message", () => {
    // With --include-partial-messages the box streams the text as deltas and then
    // re-sends the SAME text as a complete `assistant` message. The extractor must
    // return the text once, not concatenated twice (the rendered-twice bug).
    const { text } = extractWelcomeTurnFromNdjson(
      [
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hey, I'm Neo. " } },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "What's on your plate?" } },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hey, I'm Neo. What's on your plate?" }] },
        }),
        JSON.stringify({ type: "result", session_id: "s1" }),
      ].join("\n"),
      "claude",
    );

    expect(text).toBe("Hey, I'm Neo. What's on your plate?");
  });

  it("falls back to the assistant message when no streamed partials are present", () => {
    const { text } = extractWelcomeTurnFromNdjson(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Welcome aboard." }] },
        }),
      ].join("\n"),
      "claude",
    );

    expect(text).toBe("Welcome aboard.");
  });

  it("flags the hidden welcome-generation turn so it can be kept out of the chat rail", () => {
    expect(isHiddenWelcomeTitle("This is a hidden Hivra first-contact setup message.")).toBe(true);
    // Box truncates titles to ~70 chars of the first user message — still matched.
    expect(isHiddenWelcomeTitle("This is a hidden Hivra first-contact setup messag")).toBe(true);
    expect(isHiddenWelcomeTitle("Research the best CRM for dentists")).toBe(false);
    expect(isHiddenWelcomeTitle(null)).toBe(false);
    expect(isHiddenWelcomeTitle(undefined)).toBe(false);
  });

  it("extracts assistant welcome text from Codex JSON events in item order", () => {
    const { text } = extractWelcomeTurnFromNdjson(
      [
        JSON.stringify({
          type: "item.completed",
          item: { id: "a", item_type: "agent_message", text: "Forge here." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "b", item_type: "agent_message", text: " What should we ship first?" },
        }),
      ].join("\n"),
      "codex",
    );

    expect(text).toBe("Forge here.\n\nWhat should we ship first?");
  });

  it("requests a personalized welcome from the box chat endpoint", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Scout here, ready to research." },
            },
          }),
          JSON.stringify({ type: "_done", code: 0 }),
        ].join("\n"),
    });

    const turn = await requestAgentWelcomeMessage({
      fetchImpl: fetchMock as typeof fetch,
      boxUrl: "https://box.example.com/",
      token: "box-token",
      agentKind: "claude",
      agentName: "Scout",
      goal: "research",
      firstTask: "Research the best CRM for dentists",
      channel: "chat",
    });

    expect(turn).toEqual({ text: "Scout here, ready to research.", warnings: [], outcome: "complete" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://box.example.com/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer box-token",
        }),
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.sessionId).toBeNull();
    // The captured first task is threaded into the box turn's prompt so the
    // agent performs it on the first turn.
    expect(sentBody.message).toContain("Research the best CRM for dentists");
    expect(sentBody.message).toContain("do this task now and return the finished result");
  });

  it("threads an abort signal into the welcome request so the chat's Stop can cancel it", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ type: "_text", text: "hi" }) });
    const controller = new AbortController();
    await requestAgentWelcomeMessage({
      fetchImpl: fetchMock as typeof fetch,
      boxUrl: "https://box.example.com",
      agentKind: "generic",
      channel: "chat",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("reports a killed or failed first-task turn instead of returning its text as a finished welcome", async () => {
    const body = (...events: unknown[]) => ({ ok: true, text: async () => events.map((e) => JSON.stringify(e)).join("\n") });
    const delta = (t: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    const request = (fetchImpl: jest.Mock) => requestAgentWelcomeMessage({ fetchImpl: fetchImpl as unknown as typeof fetch, boxUrl: "https://box.example.com", agentKind: "claude", channel: "chat", firstTask: "Pull my competitor list" });

    // OOM-killed mid-task: partial text, `_done` null.
    await expect(request(jest.fn().mockResolvedValue(body(delta("Hi, I'm Atlas. Pulling your competitor list now — first I'll"), { type: "_done", code: null }))))
      .resolves.toEqual({ text: "Hi, I'm Atlas. Pulling your competitor list now — first I'll", warnings: [], outcome: "error", failure: "Agent process was killed before it finished" });
    // Logged-out CLI: the error text arrives as the assistant message.
    await expect(request(jest.fn().mockResolvedValue(body(
      { type: "assistant", message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
      { type: "result", is_error: true, result: "Invalid API key · Please run /login" },
      { type: "_done", code: 1 },
    )))).resolves.toMatchObject({ outcome: "error", failure: "Invalid API key · Please run /login" });
    // Stream closed without the box's exit report.
    await expect(request(jest.fn().mockResolvedValue(body(delta("Half"))))).resolves.toMatchObject({ text: "Half", outcome: "unconfirmed" });
  });

  it("rejects when the welcome body cannot be read, and on an HTTP error", async () => {
    const lost = { ok: true, text: async () => { throw new TypeError("network error"); } };
    const args = { boxUrl: "https://box.example.com", agentKind: "claude" as const, channel: "chat" as const };
    await expect(requestAgentWelcomeMessage({ ...args, fetchImpl: jest.fn().mockResolvedValue(lost) as unknown as typeof fetch })).rejects.toThrow("network error");
    await expect(requestAgentWelcomeMessage({ ...args, fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "" }) as unknown as typeof fetch })).rejects.toThrow("Agent welcome generation failed (502)");
  });

  it("sends Telegram welcome text without putting the bot token in thrown errors", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ description: "Unauthorized token 123456:SECRET" }),
    });

    await expect(
      sendTelegramWelcomeMessage({
        fetchImpl: fetchMock as typeof fetch,
        botToken: "123456:SECRET",
        ownerId: "987654",
        text: "Atlas here.",
      }),
    ).rejects.toThrow("Telegram welcome send failed (401)");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:SECRET/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "987654",
          text: "Atlas here.",
          disable_web_page_preview: true,
        }),
      }),
    );
  });
});
