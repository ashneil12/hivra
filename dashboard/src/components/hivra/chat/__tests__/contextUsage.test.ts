import { contextPercent, contextRatio, contextUsageOf, formatTokens, mergeContextUsage } from "../contextUsage";
import { activePromptId, promptMessages } from "../promptOutline";
import { findTranscriptMessages } from "../TranscriptFind";
import type { ChatMessage } from "../types";

const msg = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, text, tools: [], ...extra });

describe("context usage", () => {
  it("has no ratio until the window is known", () => {
    expect(contextRatio({ used: 1000 })).toBeNull();
    expect(contextRatio({ used: 50_000, window: 200_000 })).toBe(0.25);
    expect(contextPercent({ used: 50_000, window: 200_000 })).toBe(25);
  });

  it("keeps the last window when a later reading names none, and takes the newest level", () => {
    expect(mergeContextUsage({ used: 10, window: 100 }, { used: 20 })).toEqual({ used: 20, window: 100 });
    expect(mergeContextUsage({ used: 10 }, { window: 100 })).toEqual({ used: 10, window: 100 });
  });

  it("reads a conversation's context from its replies: the newest level with the window any reply gave", () => {
    const usage = contextUsageOf([{ usage: { used: 10, window: 200 } }, undefined, { usage: { used: 80 } }]);
    expect(usage).toEqual({ used: 80, window: 200 });
    expect(contextUsageOf([undefined, {}])).toBeUndefined();
  });

  it("words token counts shortly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toMatch(/12(\.4)?k/i);
  });
});

describe("the prompt outline", () => {
  const messages = [msg("user", "first question"), msg("assistant", "first answer"), msg("user", "second question"), msg("assistant", "")];

  it("lists the owner's prompts with the first words of the reply, keyed by position", () => {
    const prompts = promptMessages(messages);
    expect(prompts.map((p) => [p.id, p.text, p.reply])).toEqual([["0", "first question", "first answer"], ["2", "second question", ""]]);
  });

  it("is on the last prompt near the end, and on the last one started above the viewport otherwise", () => {
    const anchors = [{ id: "0", top: -400, bottom: -300 }, { id: "2", top: 400, bottom: 500 }];
    expect(activePromptId({ top: 0, bottom: 600 }, anchors, 1000)).toBe("0");
    expect(activePromptId({ top: 0, bottom: 600 }, anchors, 0)).toBe("2");
    expect(activePromptId({ top: 0, bottom: 600 }, [], 0)).toBeNull();
  });
});

describe("find in the conversation", () => {
  it("lists the messages that hold the query, ignoring case and blank queries", () => {
    const messages = [msg("user", "Fix the Parser"), msg("assistant", "The parser is fixed."), msg("user", "thanks")];
    expect(findTranscriptMessages(messages, "parser")).toEqual([0, 1]);
    expect(findTranscriptMessages(messages, "  ")).toEqual([]);
    expect(findTranscriptMessages(messages, "nothing")).toEqual([]);
  });
});
