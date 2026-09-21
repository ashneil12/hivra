import {
  anthropicRequestToOpenAi,
  openAiResponseToAnthropic,
  openAiFinishReasonToAnthropic,
  AnthropicStreamTranslator,
} from "@/lib/venice/anthropic-openai-translate";

describe("anthropicRequestToOpenAi", () => {
  it("prepends the system prompt and carries core params", () => {
    const out = anthropicRequestToOpenAi({
      model: "deepseek-v4-pro",
      system: "You are helpful.",
      max_tokens: 1024,
      temperature: 0.7,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 1024, temperature: 0.7, stream: true });
  });

  it("flattens a system block array to text", () => {
    const out = anthropicRequestToOpenAi({
      model: "m",
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      max_tokens: 10,
      messages: [],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "AB" });
  });

  it("maps an assistant tool_use block to OpenAI tool_calls", () => {
    const out = anthropicRequestToOpenAi({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
    });
    const asst = out.messages[0];
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Let me check.");
    expect(asst.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) } },
    ]);
  });

  it("maps a user tool_result block to an OpenAI tool message", () => {
    const out = anthropicRequestToOpenAi({
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72F" }] },
      ],
    });
    expect(out.messages).toEqual([{ role: "tool", tool_call_id: "toolu_1", content: "72F" }]);
  });

  it("translates tools and tool_choice", () => {
    const out = anthropicRequestToOpenAi({
      model: "m",
      max_tokens: 10,
      messages: [],
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "get_weather" },
    });
    expect(out.tools[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("maps tool_choice any→required and auto→auto", () => {
    expect(anthropicRequestToOpenAi({ model: "m", max_tokens: 1, messages: [], tool_choice: { type: "any" } }).tool_choice).toBe("required");
    expect(anthropicRequestToOpenAi({ model: "m", max_tokens: 1, messages: [], tool_choice: { type: "auto" } }).tool_choice).toBe("auto");
  });

  it("maps a base64 image block to an OpenAI image_url part", () => {
    const out = anthropicRequestToOpenAi({
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ] },
      ],
    });
    const userMsg = out.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("carries stop_sequences as stop", () => {
    const out = anthropicRequestToOpenAi({ model: "m", max_tokens: 1, stop_sequences: ["\n\n"], messages: [] });
    expect(out.stop).toEqual(["\n\n"]);
  });
});

describe("openAiFinishReasonToAnthropic", () => {
  it("maps the known finish reasons", () => {
    expect(openAiFinishReasonToAnthropic("stop")).toBe("end_turn");
    expect(openAiFinishReasonToAnthropic("length")).toBe("max_tokens");
    expect(openAiFinishReasonToAnthropic("tool_calls")).toBe("tool_use");
    expect(openAiFinishReasonToAnthropic(null)).toBeNull();
  });
});

describe("openAiResponseToAnthropic", () => {
  it("translates a text completion", () => {
    const out = openAiResponseToAnthropic(
      { id: "cmpl_1", model: "deepseek-v4-pro", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      "fallback"
    );
    expect(out).toMatchObject({
      id: "cmpl_1",
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  });

  it("translates a tool_call completion into a tool_use block with parsed input", () => {
    const out = openAiResponseToAnthropic(
      { id: "c", choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] }, finish_reason: "tool_calls" }] },
      "fallback"
    );
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("falls back to the request model and zero usage when absent", () => {
    const out = openAiResponseToAnthropic({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }, "fallback-model");
    expect(out.model).toBe("fallback-model");
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("AnthropicStreamTranslator", () => {
  function parseEvents(s: string) {
    return s
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "))!;
        return JSON.parse(dataLine.slice(6));
      });
  }

  it("streams a text completion as message_start → block → delta → stop → message_stop", () => {
    const t = new AnthropicStreamTranslator("deepseek-v4-pro", "msg_1");
    let buf = t.start();
    buf += t.chunk({ choices: [{ delta: { content: "Hel" } }] });
    buf += t.chunk({ choices: [{ delta: { content: "lo" } }] });
    buf += t.chunk({ choices: [{ delta: {}, finish_reason: "stop" }] });
    buf += t.chunk({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
    buf += t.finish();
    const types = parseEvents(buf).map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const events = parseEvents(buf);
    expect(events[2].delta).toEqual({ type: "text_delta", text: "Hel" });
    expect(events.find((e) => e.type === "message_delta").delta.stop_reason).toBe("end_turn");
    expect(events.find((e) => e.type === "message_delta").usage.output_tokens).toBe(2);
  });

  it("streams a tool call as tool_use block + input_json_delta fragments", () => {
    const t = new AnthropicStreamTranslator("m", "msg_2");
    let buf = t.start();
    buf += t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] } }] });
    buf += t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] });
    buf += t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] } }] });
    buf += t.chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    buf += t.finish();
    const events = parseEvents(buf);
    const start = events.find((e) => e.type === "content_block_start");
    expect(start.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather" });
    const jsonDeltas = events.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json);
    expect(jsonDeltas.join("")).toBe('{"city":"SF"}');
    expect(events.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });

  it("emits nothing from chunk() before start()", () => {
    const t = new AnthropicStreamTranslator("m", "msg_3");
    expect(t.chunk({ choices: [{ delta: { content: "x" } }] })).toBe("");
  });
});
