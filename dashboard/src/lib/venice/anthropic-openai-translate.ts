// Anthropic Messages ↔ OpenAI chat-completions translation.
//
// Claude Code speaks the Anthropic Messages API; Venice is OpenAI-compatible.
// This module translates in both directions so a Claude Code box can run
// inference through the managed-Venice gateway (or BYO Venice key via the same
// shim base URL). Pure + synchronous so it's fully unit-testable; the route
// wires it to auth, billing, and the upstream fetch.
//
// SPEC-GROUNDED, LIVE-VALIDATION PENDING: built against the published Anthropic
// Messages + OpenAI chat shapes. Must be validated against a real Claude Code
// session (managed-Venice translation acceptance) before claude-code is un-gated in the
// catalog. Covers the paths Claude Code actually uses: system prompt, text,
// tool_use/tool_result, images, streaming with tool calls.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Request: Anthropic Messages → OpenAI chat/completions
// ---------------------------------------------------------------------------

function anthropicContentToOpenAiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as Json).type === "text")
    .map((b) => String((b as Json).text ?? ""))
    .join("");
}

// A user/assistant content array can mix text, tool_use (assistant),
// tool_result (user), and image blocks. OpenAI splits these across message
// roles, so one Anthropic message may expand into several OpenAI messages.
function translateAnthropicMessage(msg: Json): Json[] {
  const role = msg.role;
  const content = msg.content;
  if (typeof content === "string") {
    return [{ role, content }];
  }
  if (!Array.isArray(content)) return [];

  const out: Json[] = [];
  const textParts: Json[] = [];
  const toolCalls: Json[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Json;
    switch (b.type) {
      case "text":
        textParts.push({ type: "text", text: String(b.text ?? "") });
        break;
      case "image": {
        // Anthropic image block → OpenAI image_url part (base64 data URL).
        const src = b.source || {};
        if (src.type === "base64" && src.media_type && src.data) {
          textParts.push({
            type: "image_url",
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        } else if (src.type === "url" && src.url) {
          textParts.push({ type: "image_url", image_url: { url: src.url } });
        }
        break;
      }
      case "tool_use":
        // assistant requested a tool → OpenAI tool_call
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
        break;
      case "tool_result":
        // user is returning a tool result → its own OpenAI `tool` message
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: anthropicResultContentToText(b.content),
        });
        break;
      default:
        break;
    }
  }

  if (role === "assistant") {
    const assistantMsg: Json = { role: "assistant" };
    const text = textParts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    assistantMsg.content = text || null;
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    // Only emit if it carries something (text or tool calls).
    if (assistantMsg.content || toolCalls.length) out.unshift(assistantMsg);
  } else {
    // user: text/image parts become one message; tool_result messages were
    // already pushed above and must follow nothing in particular for OpenAI.
    if (textParts.length) {
      const onlyText = textParts.every((p) => p.type === "text");
      out.unshift({
        role: "user",
        content: onlyText ? textParts.map((p) => p.text).join("") : textParts,
      });
    }
  }
  return out;
}

function anthropicResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object") {
          const bb = b as Json;
          if (bb.type === "text") return String(bb.text ?? "");
          return JSON.stringify(bb);
        }
        return String(b);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function translateAnthropicSystem(system: unknown): Json | null {
  if (!system) return null;
  const text = typeof system === "string" ? system : anthropicContentToOpenAiText(system);
  if (!text) return null;
  return { role: "system", content: text };
}

function translateAnthropicTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .filter((t) => t && typeof t === "object" && (t as Json).name)
    .map((t) => {
      const tt = t as Json;
      return {
        type: "function",
        function: {
          name: tt.name,
          description: tt.description ?? "",
          parameters: tt.input_schema ?? { type: "object", properties: {} },
        },
      };
    });
}

function translateAnthropicToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as Json;
  switch (c.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return c.name ? { type: "function", function: { name: c.name } } : "required";
    default:
      return undefined;
  }
}

export function anthropicRequestToOpenAi(body: Json): Json {
  const messages: Json[] = [];
  const system = translateAnthropicSystem(body.system);
  if (system) messages.push(system);
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    messages.push(...translateAnthropicMessage(msg as Json));
  }

  const out: Json = {
    model: body.model,
    messages,
    // Anthropic requires max_tokens; carry it through (OpenAI accepts max_tokens).
    max_tokens: body.max_tokens,
    stream: body.stream === true,
  };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }
  const tools = translateAnthropicTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = translateAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

// ---------------------------------------------------------------------------
// Response (non-streaming): OpenAI chat/completions → Anthropic Messages
// ---------------------------------------------------------------------------

export function openAiFinishReasonToAnthropic(reason: unknown): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return reason == null ? null : "end_turn";
  }
}

export function openAiResponseToAnthropic(resp: Json, fallbackModel: string): Json {
  const choice = (Array.isArray(resp.choices) ? resp.choices[0] : null) || {};
  const message = choice.message || {};
  const content: Json[] = [];

  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
    }
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = call.function || {};
    let input: unknown = {};
    try {
      input = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      input = { __raw: fn.arguments };
    }
    content.push({ type: "tool_use", id: call.id, name: fn.name, input });
  }

  const usage = resp.usage || {};
  return {
    id: resp.id || `msg_${Math.abs(hashString(JSON.stringify(resp))).toString(36)}`,
    type: "message",
    role: "assistant",
    model: resp.model || fallbackModel,
    content,
    stop_reason: openAiFinishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numberOr(usage.prompt_tokens, 0),
      output_tokens: numberOr(usage.completion_tokens, 0),
    },
  };
}

function numberOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Response (streaming): OpenAI SSE → Anthropic SSE
//
// A stateful machine. Feed it parsed OpenAI chunk objects (the JSON after
// `data: `); it returns the Anthropic SSE event strings to emit. Call
// `start()` first, then `chunk()` per OpenAI chunk, then `finish()`.
// ---------------------------------------------------------------------------

interface StreamBlock {
  index: number;
  type: "text" | "tool_use";
  toolCallId?: string;
}

export class AnthropicStreamTranslator {
  private model: string;
  private messageId: string;
  private started = false;
  private nextIndex = 0;
  private textBlock: StreamBlock | null = null;
  // OpenAI streams tool_calls keyed by their array index; map → our block.
  private toolBlocks = new Map<number, StreamBlock>();
  private stopReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(model: string, messageId: string) {
    this.model = model;
    this.messageId = messageId;
  }

  private static event(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  start(): string {
    this.started = true;
    return AnthropicStreamTranslator.event("message_start", {
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  chunk(openAiChunk: Json): string {
    if (!this.started) return "";
    let out = "";
    const choice = (Array.isArray(openAiChunk.choices) ? openAiChunk.choices[0] : null) || {};
    const delta = choice.delta || {};

    if (openAiChunk.usage) {
      this.inputTokens = numberOr(openAiChunk.usage.prompt_tokens, this.inputTokens);
      this.outputTokens = numberOr(openAiChunk.usage.completion_tokens, this.outputTokens);
    }

    // text delta
    if (typeof delta.content === "string" && delta.content.length) {
      if (!this.textBlock) {
        this.textBlock = { index: this.nextIndex++, type: "text" };
        out += AnthropicStreamTranslator.event("content_block_start", {
          index: this.textBlock.index,
          content_block: { type: "text", text: "" },
        });
      }
      out += AnthropicStreamTranslator.event("content_block_delta", {
        index: this.textBlock.index,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // tool-call deltas (each keyed by its OpenAI array index)
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = numberOr(tc.index, 0);
      let block = this.toolBlocks.get(key);
      if (!block) {
        block = { index: this.nextIndex++, type: "tool_use", toolCallId: tc.id };
        this.toolBlocks.set(key, block);
        out += AnthropicStreamTranslator.event("content_block_start", {
          index: block.index,
          content_block: {
            type: "tool_use",
            id: tc.id || `toolu_${key}`,
            name: tc.function?.name || "",
            input: {},
          },
        });
      }
      const argFragment = tc.function?.arguments;
      if (typeof argFragment === "string" && argFragment.length) {
        out += AnthropicStreamTranslator.event("content_block_delta", {
          index: block.index,
          delta: { type: "input_json_delta", partial_json: argFragment },
        });
      }
    }

    if (choice.finish_reason) {
      this.stopReason = openAiFinishReasonToAnthropic(choice.finish_reason);
    }
    return out;
  }

  finish(): string {
    if (!this.started) return "";
    let out = "";
    // Close every open block (text first if present, then tool blocks in order).
    const blocks: StreamBlock[] = [];
    if (this.textBlock) blocks.push(this.textBlock);
    blocks.push(...Array.from(this.toolBlocks.values()));
    blocks.sort((a, b) => a.index - b.index);
    for (const block of blocks) {
      out += AnthropicStreamTranslator.event("content_block_stop", { index: block.index });
    }
    out += AnthropicStreamTranslator.event("message_delta", {
      delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += AnthropicStreamTranslator.event("message_stop", {});
    return out;
  }
}
