import {
  IMAGE_INPUT_TOKEN_FLOOR,
  InvalidVeniceChatRequestError,
  MissingVeniceUsageError,
  calculateActualChatCost,
  estimateChatCompletionCost,
  maxAffordableVeniceChatOutputCap,
} from "@/lib/venice/cost-estimator";
import { getVeniceChatModelPrice } from "@/lib/venice/pricing";

describe("Venice chat cost estimator", () => {
  it("holds the larger cap when both cap fields are sent (Venice may honour either)", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100,
      max_tokens: 999,
    });

    expect(estimate.inputTokens).toBe(4);
    expect(estimate.outputTokens).toBe(999);
    expect(estimate.outputCapExplicit).toBe(true);
  });

  it("prices an explicit cap exactly", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100,
    });

    expect(estimate.inputTokens).toBe(4);
    expect(estimate.outputTokens).toBe(100);
    expect(estimate.estimatedCostMicroUsd).toBe(91);
    expect(estimate.reservedCostMicroUsd).toBe(101);
  });

  // Security review 2026-09 (Medium): without a cap Venice runs to the model's
  // default maximum, so that is what the hold has to cover. The old 4,096-token
  // default held 1/31 of it on the 128,000-token Claude Opus models.
  it.each([
    ["claude-opus-4-8", 128_000],
    ["openai-gpt-54", 131_072],
    ["deepseek-v4-pro", 32_768],
    ["venice-uncensored-1-2", 8_192],
  ])("holds %s's full %i-token maximum output when no cap is sent", (model, maxOutput) => {
    const estimate = estimateChatCompletionCost({
      model,
      messages: [{ role: "user", content: "hey" }],
    });

    expect(estimate.outputTokens).toBe(maxOutput);
    expect(estimate.modelMaxOutputTokens).toBe(maxOutput);
    expect(estimate.outputCapExplicit).toBe(false);
    expect(estimate.outputChoices).toBe(1);
    const price = getVeniceChatModelPrice(model);
    expect(estimate.reservedCostMicroUsd).toBeGreaterThanOrEqual(
      Math.ceil((maxOutput * price.outputMicroUsdPerMillion) / 1_000_000)
    );
  });

  it("never holds more output than the model can produce", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hey" }],
      max_tokens: 1_000_000,
    });

    expect(estimate.outputTokens).toBe(8_192);
  });

  it("multiplies output reservation by n choices", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100,
      n: 3,
    });

    expect(estimate.outputChoices).toBe(3);
    expect(estimate.outputTokens).toBe(300);
    expect(estimate.estimatedCostMicroUsd).toBe(271);
  });

  it.each([
    ["max_tokens", { max_tokens: 0 }],
    ["max_tokens", { max_tokens: -5 }],
    ["max_completion_tokens", { max_completion_tokens: 1.5 }],
    ["max_completion_tokens", { max_completion_tokens: "100" }],
    ["n", { n: 0 }],
  ])("refuses a malformed %s with a typed error", (_field, extra) => {
    expect(() =>
      estimateChatCompletionCost({
        model: "venice-uncensored-1-2",
        messages: [{ role: "user", content: "hi" }],
        ...extra,
      })
    ).toThrow(InvalidVeniceChatRequestError);
  });

  it("treats null caps and n as not sent", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: null,
      max_completion_tokens: null,
      n: null,
    });

    expect(estimate.outputTokens).toBe(8_192);
    expect(estimate.outputChoices).toBe(1);
  });

  it("includes tool and function JSON in the input estimate", () => {
    const withoutTools = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 10,
    });
    const withTools = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 10,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_order",
            parameters: {
              type: "object",
              properties: { orderId: { type: "string" } },
            },
          },
        },
      ],
    });

    expect(withTools.inputTokens).toBeGreaterThan(withoutTools.inputTokens);
  });

  it("counts a non-ASCII character as a whole token, not a third of one", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "你好".repeat(150) }],
      max_completion_tokens: 10,
    });

    expect(estimate.inputTokens).toBe(300);
  });

  it("gives an image referenced by a short URL at least the per-image allowance", () => {
    const estimate = estimateChatCompletionCost({
      model: "qwen3-vl-235b-a22b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          ],
        },
      ],
      max_completion_tokens: 10,
    });

    expect(estimate.inputTokens).toBeGreaterThanOrEqual(IMAGE_INPUT_TOKEN_FLOOR);
  });

  // Review of #166 (required fix 2): the estimator only floored image parts,
  // so a video or file part was held at the length of its URL. Probe: 20
  // parallel requests from a $0.05 wallet each held $0.0002 (Opus, file URL)
  // or $0.00009 (Gemini, video URL) while Venice could bill the whole context
  // window. Nothing bounds what such a part stands for from its bytes: a short
  // URL can point at an hour of video, and a few KB of PDF can hold a hundred
  // pages, so these parts are held at the model's whole context window.
  describe("parts whose size the request does not show", () => {
    const opus = getVeniceChatModelPrice("claude-opus-4-8");
    const gemini = getVeniceChatModelPrice("gemini-3-1-pro-preview");
    const withPart = (model: string, part: Record<string, unknown>) =>
      estimateChatCompletionCost({
        model,
        messages: [{ role: "user", content: [{ type: "text", text: "summarise this" }, part] }],
        max_completion_tokens: 1,
      });

    it.each([
      ["a video URL", { type: "video_url", video_url: { url: "https://example.com/v.mp4" } }],
      ["a video data URL", { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }],
      ["a file URL", { type: "file", file: { file_data: "https://example.com/a.pdf", filename: "a.pdf" } }],
      ["a PDF data URL", { type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0xLjQK", filename: "a.pdf" } }],
      ["an uploaded file id", { type: "file", file: { file_id: "file_123" } }],
      ["audio by URL", { type: "input_audio", input_audio: { data: "https://example.com/a.mp3", format: "mp3" } }],
      ["a part type the estimator does not know", { type: "audio_url", audio_url: { url: "https://example.com/a.mp3" } }],
    ])("holds %s at the model's whole context window", (_label, part) => {
      expect(withPart("gemini-3-1-pro-preview", part).inputTokens).toBe(gemini.contextWindow);
      expect(withPart("claude-opus-4-8", part).inputTokens).toBe(opus.contextWindow);
    });

    it("also finds such a part when content is a single part object", () => {
      const estimate = estimateChatCompletionCost({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: { type: "video_url", video_url: { url: "https://e.x/v" } } as never }],
        max_completion_tokens: 1,
      });
      expect(estimate.inputTokens).toBe(opus.contextWindow);
    });

    it("keeps pricing text, images, inline audio and tool calls by their size", () => {
      const estimate = estimateChatCompletionCost({
        model: "claude-opus-4-8",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
              { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "refusal", refusal: "no" }],
            tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", content: [{ type: "text", text: "done" }] },
        ],
        max_completion_tokens: 1,
      });

      expect(estimate.inputTokens).toBeGreaterThanOrEqual(IMAGE_INPUT_TOKEN_FLOOR);
      expect(estimate.inputTokens).toBeLessThan(IMAGE_INPUT_TOKEN_FLOOR + 200);
    });
  });

  it("never holds more input than the model's context window", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "x".repeat(600_000) }],
      max_completion_tokens: 10,
    });

    expect(estimate.inputTokens).toBe(128_000);
  });

  it("does not apply the reservation safety buffer to actual usage cost", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100,
    });
    const actual = calculateActualChatCost({
      model: "venice-uncensored-1-2",
      promptTokens: 4,
      completionTokens: 100,
    });

    expect(estimate.reservedCostMicroUsd).toBe(101);
    expect(actual.actualCostMicroUsd).toBe(91);
  });

  it("throws a typed error when final usage is missing", () => {
    expect(() =>
      calculateActualChatCost({
        model: "venice-uncensored-1-2",
        promptTokens: null,
        completionTokens: 100,
      })
    ).toThrow(MissingVeniceUsageError);
  });
});

describe("maxAffordableVeniceChatOutputCap", () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Write the word 'again' forever." }],
    ...extra,
  });

  it.each([100_000, 1_000_000, 1_234_567, 3_999_999])(
    "returns the largest cap whose hold fits %i microdollars",
    (available) => {
      const cap = maxAffordableVeniceChatOutputCap(request(), available);

      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThan(128_000);
      const fits = estimateChatCompletionCost(request({ max_completion_tokens: cap }));
      const tooMuch = estimateChatCompletionCost(request({ max_completion_tokens: cap + 1 }));
      expect(fits.reservedCostMicroUsd).toBeLessThanOrEqual(available);
      expect(tooMuch.reservedCostMicroUsd).toBeGreaterThan(available);
    }
  );

  it("ignores the request's own cap fields and stops at the model maximum", () => {
    expect(maxAffordableVeniceChatOutputCap(request({ max_tokens: 10 }), 100_000_000)).toBe(128_000);
  });

  it("divides the budget across n choices", () => {
    const single = maxAffordableVeniceChatOutputCap(request(), 1_000_000);
    const triple = maxAffordableVeniceChatOutputCap(request({ n: 3 }), 1_000_000);

    expect(triple).toBeLessThanOrEqual(Math.ceil(single / 3));
    const fits = estimateChatCompletionCost(request({ n: 3, max_completion_tokens: triple }));
    const tooMuch = estimateChatCompletionCost(request({ n: 3, max_completion_tokens: triple + 1 }));
    expect(fits.reservedCostMicroUsd).toBeLessThanOrEqual(1_000_000);
    expect(tooMuch.reservedCostMicroUsd).toBeGreaterThan(1_000_000);
  });

  it("returns 0 when the input alone does not fit", () => {
    expect(
      maxAffordableVeniceChatOutputCap(
        request({ messages: [{ role: "user", content: "x".repeat(30_000) }] }),
        10
      )
    ).toBe(0);
  });
});
