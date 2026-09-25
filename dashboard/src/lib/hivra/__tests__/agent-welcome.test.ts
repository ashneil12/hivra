import {
  buildAgentWelcomePrompt,
  isHiddenWelcomeTitle,
  sendTelegramWelcomeMessage,
  startAgentWelcomeRun,
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
  });

  it("never offers to repeat the task on a schedule, which Hivra computers cannot run", () => {
    for (const firstTask of ["Research the 3 best CRMs for a dental practice", undefined]) {
      const prompt = buildAgentWelcomePrompt({ agentName: "Scout", goal: "research", firstTask, channel: "chat" });
      expect(prompt).not.toMatch(/schedul|standing task|every morning/i);
    }
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

  it("flags the hidden welcome-generation turn so it can be kept out of the chat rail", () => {
    expect(isHiddenWelcomeTitle("This is a hidden Hivra first-contact setup message.")).toBe(true);
    // Box truncates titles to ~70 chars of the first user message — still matched.
    expect(isHiddenWelcomeTitle("This is a hidden Hivra first-contact setup messag")).toBe(true);
    expect(isHiddenWelcomeTitle("Research the best CRM for dentists")).toBe(false);
    expect(isHiddenWelcomeTitle(null)).toBe(false);
    expect(isHiddenWelcomeTitle(undefined)).toBe(false);
  });

  it("starts the welcome as a detached run the chat can re-attach to", async () => {
    const response = { ok: true, status: 200 } as Response;
    const fetchMock = jest.fn().mockResolvedValue(response);
    const controller = new AbortController();

    const result = await startAgentWelcomeRun({
      fetchImpl: fetchMock as typeof fetch,
      boxUrl: "https://box.example.com/",
      token: "box-token",
      agentName: "Scout",
      goal: "research",
      firstTask: "Research the best CRM for dentists",
      channel: "chat",
      runId: "00000000-0000-4000-8000-000000000003",
      clientRef: "local-session-1",
      signal: controller.signal,
    });

    // The caller streams the response itself, like any chat turn.
    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://box.example.com/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer box-token",
        }),
        signal: controller.signal,
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    // A new conversation, kept running on the computer when the page goes
    // away, keyed so Stop and re-attach find it.
    expect(sentBody).toMatchObject({
      sessionId: null,
      detach: true,
      runId: "00000000-0000-4000-8000-000000000003",
      clientRef: "local-session-1",
    });
    expect(isHiddenWelcomeTitle(sentBody.message)).toBe(true);
    // The captured first task is threaded into the box turn's prompt so the
    // agent performs it on the first turn.
    expect(sentBody.message).toContain("Research the best CRM for dentists");
    expect(sentBody.message).toContain("do this task now and return the finished result");
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
