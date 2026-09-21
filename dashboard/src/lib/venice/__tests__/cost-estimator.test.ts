import {
  MissingVeniceUsageError,
  RESERVATION_OUTPUT_TOKEN_DEFAULT,
  calculateActualChatCost,
  estimateChatCompletionCost,
} from "@/lib/venice/cost-estimator";

describe("Venice chat cost estimator", () => {
  it("uses max_completion_tokens over deprecated max_tokens", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100,
      max_tokens: 999,
    });

    expect(estimate.inputTokens).toBe(4);
    expect(estimate.outputTokens).toBe(100);
    expect(estimate.outputCapExplicit).toBe(true);
    expect(estimate.estimatedCostMicroUsd).toBe(91);
    expect(estimate.reservedCostMicroUsd).toBe(101);
  });

  it("falls back to the defensive reservation default when no output cap is supplied", () => {
    const estimate = estimateChatCompletionCost({
      model: "venice-uncensored-1-2",
      messages: [{ role: "user", content: "hey" }],
    });

    expect(estimate.outputTokens).toBe(RESERVATION_OUTPUT_TOKEN_DEFAULT);
    expect(estimate.outputCapExplicit).toBe(false);
    expect(estimate.outputChoices).toBe(1);
    expect(estimate.reservedCostMicroUsd).toBeGreaterThan(estimate.estimatedCostMicroUsd);
  });

  it("respects model max when it is smaller than the defensive default", () => {
    const estimate = estimateChatCompletionCost({
      model: "openai-gpt-52",
      messages: [{ role: "user", content: "hey" }],
    });

    // GPT-5.2 caps output at 16,384 but our defensive default is 4,096.
    expect(estimate.outputTokens).toBe(RESERVATION_OUTPUT_TOKEN_DEFAULT);
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
