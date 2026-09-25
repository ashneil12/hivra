// Counts the output a Venice response delivered, so a request whose usage
// never arrived is charged what was streamed rather than a flat estimate.
//
// Security review 2026-09 (#166/#167): a client that read a whole 120k-token
// Opus answer and closed the socket just before the usage frame was charged a
// $0.12 estimate for a $3.60 Venice bill. The Vercel routes and the Cloudflare
// Worker now feed every frame they forward through this meter and settle an
// interrupted or usage-less stream at input estimate + observed output.
//
// Tokens are estimated from the text Venice sent (content, reasoning, refusal
// and tool-call arguments): the larger of the number of frames that carried
// text (Venice streams about one token per frame) and the UTF-8 size / 4 (a
// floor when frames batch several tokens). Reasoning a model does not stream
// cannot be seen here and is not counted.
//
// services/venice-proxy-worker/src/index.ts carries a copy for the Worker;
// keep the two in lockstep.

export const OBSERVED_OUTPUT_UTF8_BYTES_PER_TOKEN = 4;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return "";
}

// The generated text of one chat choice: a stream `delta` or a whole `message`.
function chatChoiceText(part: unknown): string {
  if (!isRecord(part)) return "";
  let text =
    textOf(part.content) + textOf(part.reasoning_content) + textOf(part.reasoning) + textOf(part.refusal);
  const calls = Array.isArray(part.tool_calls) ? part.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    text += textOf(call.function.name) + textOf(call.function.arguments);
  }
  if (isRecord(part.function_call)) {
    text += textOf(part.function_call.name) + textOf(part.function_call.arguments);
  }
  return text;
}

// Every string under the keys that carry generated text in a Responses
// `output` array (output_text, reasoning text and summaries, tool arguments).
function responsesOutputText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (Array.isArray(value)) return value.map((item) => responsesOutputText(item, depth + 1)).join("");
  if (!isRecord(value)) return "";
  let text = "";
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (key === "text" || key === "arguments" || key === "input" || key === "refusal") text += child;
    } else if (child && typeof child === "object") {
      text += responsesOutputText(child, depth + 1);
    }
  }
  return text;
}

export interface ManagedVeniceOutputMeter {
  /** One parsed chat.completion.chunk, or a whole chat.completion body. */
  observeChatChunk(chunk: unknown): void;
  /**
   * One SSE frame of an OpenAI-compatible chat stream. Returns the `usage`
   * block the frame carried, if any, so callers parse each frame once.
   */
  observeChatSseFrame(frame: string): unknown;
  /** One parsed Responses stream event. */
  observeResponsesEvent(event: unknown): void;
  /** A whole non-streamed Responses body. */
  observeResponsesBody(body: unknown): void;
  /** A 2xx body Hivra could not parse: counted by size. */
  observeUnparsedText(text: string): void;
  /** Estimated output tokens delivered so far. */
  outputTokens(): number;
}

export function createManagedVeniceOutputMeter(): ManagedVeniceOutputMeter {
  let textFrames = 0;
  let textBytes = 0;

  const count = (text: string) => {
    if (!text) return;
    textFrames += 1;
    textBytes += utf8Length(text);
  };

  const observeChatChunk = (chunk: unknown) => {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return;
    for (const choice of chunk.choices) {
      if (!isRecord(choice)) continue;
      count(chatChoiceText(choice.delta) + chatChoiceText(choice.message));
    }
  };

  return {
    observeChatChunk,
    observeChatSseFrame(frame) {
      let usage: unknown = null;
      for (const line of frame.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive or comment frame
        }
        observeChatChunk(parsed);
        if (isRecord(parsed) && parsed.usage) usage = parsed.usage;
      }
      return usage;
    },
    observeResponsesEvent(event) {
      if (!isRecord(event) || typeof event.type !== "string" || !event.type.endsWith(".delta")) return;
      if (typeof event.delta === "string") count(event.delta);
    },
    observeResponsesBody(body) {
      if (isRecord(body)) count(responsesOutputText(body.output));
    },
    observeUnparsedText(text) {
      if (text) textBytes += utf8Length(text);
    },
    outputTokens() {
      return Math.max(textFrames, Math.ceil(textBytes / OBSERVED_OUTPUT_UTF8_BYTES_PER_TOKEN));
    },
  };
}
