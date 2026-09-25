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

  it("falls back to four ASCII characters a token when frames batch several tokens", () => {
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

  // #167 second review: UTF-8 size / 4 counted batched CJK at 0.75 of a
  // token per character.
  it("counts every non-ASCII character as a token, and ASCII at four characters a token", () => {
    const meter = createManagedVeniceOutputMeter();
    meter.observeUnparsedText("日本語の文章です"); // 8 characters, 24 bytes
    expect(meter.outputTokens()).toBe(8);

    const batched = createManagedVeniceOutputMeter();
    for (let frame = 0; frame < 100; frame += 1) {
      batched.observeChatSseFrame(sse({ choices: [{ delta: { content: "これは長い日本語の文章" } }] }));
    }
    expect(batched.outputTokens()).toBe(1_100);

    const mixed = createManagedVeniceOutputMeter();
    mixed.observeUnparsedText(`${"abcd".repeat(10)}é😀`);
    expect(mixed.outputTokens()).toBe(12);
  });

  // #167 second review: 40 KB of function-call arguments sent only in the
  // done event (about 10k tokens) were charged 30 µUSD.
  it("counts Responses output that arrives only in done events, once", () => {
    const meter = createManagedVeniceOutputMeter();
    const args = "x".repeat(40_000);
    meter.observeResponsesEvent({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{" });
    meter.observeResponsesEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: args });
    meter.observeResponsesEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", name: "f", arguments: args },
    });
    // The arguments once: the delta, then the rest from the done event; the
    // item event repeats them and adds nothing.
    expect(meter.outputTokens()).toBe(10_000);

    const deltas = createManagedVeniceOutputMeter();
    for (let index = 0; index < 10; index += 1) {
      deltas.observeResponsesEvent({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "abcd" });
    }
    deltas.observeResponsesEvent({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "abcd".repeat(10) });
    deltas.observeResponsesEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "abcd".repeat(10) }] },
    });
    // Ten deltas, and the done events repeat them: nothing is counted twice.
    expect(deltas.outputTokens()).toBe(10);

    const itemOnly = createManagedVeniceOutputMeter();
    itemOnly.observeResponsesEvent({
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "ct_1", type: "custom_tool_call", name: "apply_patch", input: "y".repeat(400) },
    });
    expect(itemOnly.outputTokens()).toBe(100);
  });
});
