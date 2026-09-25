import { createManagedVeniceOutputMeter } from "../stream-output-meter";

const sse = (value: unknown) => `data: ${JSON.stringify(value)}`;

describe("createManagedVeniceOutputMeter", () => {
  it("counts one token per frame that carried text when Venice streams token by token", () => {
    const meter = createManagedVeniceOutputMeter();
    for (const text of ["Once", " upon", " a", " time"]) {
      expect(meter.observeChatSseFrame(sse({ choices: [{ delta: { content: text } }] }))).toBeNull();
    }
    // Role-only, empty and finish frames carry no output.
    meter.observeChatSseFrame(sse({ choices: [{ delta: { role: "assistant" } }] }));
    meter.observeChatSseFrame(sse({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }));
    meter.observeChatSseFrame("data: [DONE]");
    meter.observeChatSseFrame(": keep-alive");
    expect(meter.outputTokens()).toBe(4);
  });

  it("falls back to UTF-8 size / 4 when frames batch several tokens", () => {
    const meter = createManagedVeniceOutputMeter();
    meter.observeChatSseFrame(sse({ choices: [{ delta: { content: "x".repeat(400) } }] }));
    expect(meter.outputTokens()).toBe(100);
  });

  it("counts reasoning, refusals, tool-call arguments and every choice", () => {
    const meter = createManagedVeniceOutputMeter();
    meter.observeChatChunk({
      choices: [
        { index: 0, delta: { reasoning_content: "abcd" } },
        { index: 1, delta: { tool_calls: [{ index: 0, function: { name: "", arguments: "abcdabcd" } }] } },
      ],
    });
    meter.observeChatChunk({ choices: [{ delta: { refusal: "abcd" } }] });
    expect(meter.outputTokens()).toBe(4);
  });

  it("returns the usage block a frame carried", () => {
    const meter = createManagedVeniceOutputMeter();
    const usage = { prompt_tokens: 1, completion_tokens: 2 };
    expect(meter.observeChatSseFrame(sse({ choices: [], usage }))).toEqual(usage);
  });

  it("counts a whole chat completion, Responses deltas and Responses bodies", () => {
    const chat = createManagedVeniceOutputMeter();
    chat.observeChatChunk({ choices: [{ message: { content: "x".repeat(40) } }] });
    expect(chat.outputTokens()).toBe(10);

    const stream = createManagedVeniceOutputMeter();
    stream.observeResponsesEvent({ type: "response.output_text.delta", delta: "ab" });
    stream.observeResponsesEvent({ type: "response.function_call_arguments.delta", delta: "{}" });
    stream.observeResponsesEvent({ type: "response.created", response: { id: "r" } });
    expect(stream.outputTokens()).toBe(2);

    const body = createManagedVeniceOutputMeter();
    body.observeResponsesBody({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "x".repeat(8) }] },
        { type: "message", content: [{ type: "output_text", text: "x".repeat(32) }] },
        { type: "function_call", name: "f", arguments: "x".repeat(8) },
      ],
    });
    expect(body.outputTokens()).toBe(12);
  });

  it("counts multi-byte text by its UTF-8 size", () => {
    const meter = createManagedVeniceOutputMeter();
    meter.observeUnparsedText("日本語の文章です"); // 8 characters, 24 bytes
    expect(meter.outputTokens()).toBe(6);
  });
});
