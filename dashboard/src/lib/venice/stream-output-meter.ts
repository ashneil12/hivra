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
// text (Venice streams about one token per frame) and a floor for frames that
// batch several tokens: a token per 4 ASCII characters plus a token per other
// character (CJK, emoji and accented letters take about a token each, often
// more; UTF-8 size / 4 counted CJK at 0.75 of a token). Reasoning a model
// does not stream cannot be seen here and is not counted, which is why the
// routes read a stream to Venice's usage frame even after the client leaves.
//
// services/venice-proxy-worker/src/index.ts carries a copy of the chat parts
// for the Worker; keep the two in lockstep.

/** ASCII characters per token in the floor for batched frames. */
export const OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN = 4;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// The floor's weight of a text, in quarter tokens: 1 per ASCII character, 4
// (a whole token) per other character.
function quarterTokens(text: string): number {
  let units = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      units += 1;
      continue;
    }
    units += OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN;
    // A surrogate pair is one character.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) index += 1;
  }
  return units;
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

const RESPONSES_TEXT_KEYS = ["text", "arguments", "input", "refusal"] as const;

// Every string under the keys that carry generated text in a Responses
// `output` array (output_text, reasoning text and summaries, tool arguments).
function responsesOutputText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (Array.isArray(value)) return value.map((item) => responsesOutputText(item, depth + 1)).join("");
  if (!isRecord(value)) return "";
  let text = "";
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if ((RESPONSES_TEXT_KEYS as readonly string[]).includes(key)) text += child;
    } else if (child && typeof child === "object") {
      text += responsesOutputText(child, depth + 1);
    }
  }
  return text;
}

// The final text a Responses `.done` event carries for one part of an output
// item (response.output_text.done's `text`, function_call_arguments.done's
// `arguments`, ...), if any.
function responsesDoneText(event: JsonRecord): string | null {
  for (const key of RESPONSES_TEXT_KEYS) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return null;
}

// Which part of which output item a Responses delta or done event belongs to.
function responsesPartKey(event: JsonRecord, family: string): string {
  const item = typeof event.item_id === "string" ? event.item_id : `#${String(event.output_index ?? "")}`;
  const part = event.content_index ?? event.summary_index ?? "";
  return `${item}|${String(part)}|${family}`;
}

function responsesItemKey(event: JsonRecord): string {
  return typeof event.item_id === "string" ? event.item_id : `#${String(event.output_index ?? "")}`;
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
  let textQuarterTokens = 0;
  // Responses: the weight already counted for each part and each output item,
  // so a `.done` event (or response.output_item.done) that carries more than
  // its deltas did adds only the difference. Venice may send tool arguments
  // only in the `.done` event (#167 second review: 40 KB of arguments, about
  // 10k tokens, were charged 30 µUSD).
  const countedByPart = new Map<string, number>();
  const countedByItem = new Map<string, number>();

  const count = (text: string) => {
    if (!text) return 0;
    const units = quarterTokens(text);
    textFrames += 1;
    textQuarterTokens += units;
    return units;
  };
  const countExtra = (units: number) => {
    if (units <= 0) return;
    textFrames += 1;
    textQuarterTokens += units;
  };
  const credit = (map: Map<string, number>, key: string, units: number) => {
    map.set(key, (map.get(key) ?? 0) + units);
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
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "response.output_item.done") {
        const item = isRecord(event.item) ? event.item : null;
        if (!item) return;
        const key = typeof item.id === "string" ? item.id : responsesItemKey(event);
        const units = quarterTokens(responsesOutputText(item));
        countExtra(units - (countedByItem.get(key) ?? 0));
        countedByItem.set(key, Math.max(units, countedByItem.get(key) ?? 0));
        return;
      }
      const family = event.type.replace(/\.(delta|done)$/, "");
      if (event.type.endsWith(".delta")) {
        if (typeof event.delta !== "string") return;
        const units = count(event.delta);
        credit(countedByPart, responsesPartKey(event, family), units);
        credit(countedByItem, responsesItemKey(event), units);
        return;
      }
      if (event.type.endsWith(".done")) {
        const text = responsesDoneText(event);
        if (text === null) return;
        const partKey = responsesPartKey(event, family);
        const extra = quarterTokens(text) - (countedByPart.get(partKey) ?? 0);
        if (extra <= 0) return;
        countExtra(extra);
        credit(countedByPart, partKey, extra);
        credit(countedByItem, responsesItemKey(event), extra);
      }
    },
    observeResponsesBody(body) {
      if (isRecord(body)) count(responsesOutputText(body.output));
    },
    observeUnparsedText(text) {
      if (text) textQuarterTokens += quarterTokens(text);
    },
    outputTokens() {
      return Math.max(textFrames, Math.ceil(textQuarterTokens / OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN));
    },
  };
}
