import { MissingVeniceUsageError } from "./cost-estimator";

export const VENICE_RESPONSES_ENDPOINT = "/api/v1/responses";
export const VENICE_RESPONSES_URL = "https://api.venice.ai/api/v1/responses";
export const RESPONSES_RECONCILIATION_REASON = "managed_venice_responses_ambiguous_usage";
export const RESPONSES_MAX_REQUEST_BYTES = 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toolName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const clientTool = (tool: unknown): boolean => record(tool) && ["function", "custom"].includes(String(tool.type)) && toolName(tool.name);
function supportedTool(tool: unknown): boolean {
  if (clientTool(tool)) return true;
  // Codex 0.149.1 groups client tools into one namespace level. Its child
  // grammar is function/custom, not arbitrary provider tools or namespaces.
  // Do not traverse parameters/format schemas: those are inert tool data.
  return record(tool) && tool.type === "namespace" && toolName(tool.name)
    && typeof tool.description === "string"
    && Object.keys(tool).every(key => ["type", "name", "description", "tools"].includes(key))
    && Array.isArray(tool.tools) && tool.tools.length > 0 && tool.tools.length <= 128
    && tool.tools.every(clientTool);
}

/** Text and client-executed tools only. Provider-side tools, persisted response
 * IDs, background work and media need separate ownership/billing contracts. */
export function responsesEstimateRequest(body: Record<string, unknown>) {
  const allowed = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning",
    "store", "stream", "include", "prompt_cache_key", "text", "metadata", "max_output_tokens", "temperature", "top_p",
    "truncation", "safety_identifier", "background", "service_tier", "client_metadata"]);
  if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.model !== "string"
    || !/^[A-Za-z0-9._/-]{1,128}$/.test(body.model)
    || (body.store !== undefined && body.store !== false) || (body.background !== undefined && body.background !== false)
    || (body.service_tier != null && body.service_tier !== "default" && body.service_tier !== "auto")
    || (body.stream !== undefined && typeof body.stream !== "boolean")
    || (body.max_output_tokens !== undefined && (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) < 1 || Number(body.max_output_tokens) > 131072))) {
    throw new Error("Unsupported Responses request. Use stateless text with client-side tools.");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) throw new Error("Responses input is required.");
  if (body.instructions !== undefined && typeof body.instructions !== "string") throw new Error("Invalid Responses instructions.");
  // Pinned Codex sends this for every provider. It is inert caller metadata,
  // never an ownership, identity, pricing or routing authority.
  if (body.client_metadata !== undefined && (!record(body.client_metadata) || Object.keys(body.client_metadata).length > 32
    || Object.entries(body.client_metadata).some(([key, value]) => key.length > 128 || typeof value !== "string" || value.length > 4096))) throw new Error("Invalid client metadata.");
  if (body.tool_choice !== undefined && !["auto", "none", "required"].includes(String(body.tool_choice))
    && !(record(body.tool_choice) && ["function", "custom"].includes(String(body.tool_choice.type)))) throw new Error("Unsupported Responses tool choice.");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128 || !body.tools.every(supportedTool))) {
    throw new Error("Managed Responses supports client-side function/custom tools only; provider tools are not billed here.");
  }
  if (Array.isArray(body.input)) for (const item of body.input) {
    if (!record(item) || ![undefined, "message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning"].includes(item.type as string | undefined)) throw new Error("Unsupported Responses input item.");
    if (item.type === undefined || item.type === "message") {
      if (typeof item.content !== "string" && (!Array.isArray(item.content) || item.content.some(part => !record(part) || !["input_text", "output_text", "refusal"].includes(String(part.type))))) throw new Error("Managed Responses currently supports text input only.");
    }
    if (["function_call_output", "custom_tool_call_output"].includes(String(item.type)) && typeof item.output !== "string") throw new Error("Tool output must be text.");
  }
  // This shape is ONLY for the existing conservative estimator. The upstream
  // payload remains Responses JSON, byte-for-byte; never a wire conversion.
  return { model: body.model, messages: [{ content: JSON.stringify({ input: body.input, instructions: body.instructions }) }],
    tools: body.tools, response_format: body.text, max_completion_tokens: body.max_output_tokens as number | undefined };
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MissingVeniceUsageError();
  return value as number;
}
export function responsesUsageTokens(usage: unknown) {
  if (!record(usage)) throw new MissingVeniceUsageError();
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  if (usage.input_tokens_details !== undefined && !record(usage.input_tokens_details)) throw new MissingVeniceUsageError();
  const cached = record(usage.input_tokens_details) && usage.input_tokens_details.cached_tokens !== undefined ? count(usage.input_tokens_details.cached_tokens) : 0;
  // Premium cache-write units are not covered by this initial Responses rate
  // contract. Keep the hold for operator review rather than price them at the
  // ordinary input rate or silently charge zero. The request still has a receipt.
  for (const value of [usage.cache_write_tokens, record(usage.input_tokens_details) ? usage.input_tokens_details.cache_creation_input_tokens : undefined]) {
    if (value !== undefined && count(value) !== 0) throw new MissingVeniceUsageError();
  }
  if (cached > input || !Number.isSafeInteger(input + output)
    || (usage.total_tokens !== undefined && count(usage.total_tokens) !== input + output)) throw new MissingVeniceUsageError();
  // Cached input is a subset, not an extra prompt. Reasoning is already inside
  // output_tokens. Preserve full totals separately for the usage ledger.
  return { promptTokens: input - cached, completionTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0, totalInputTokens: input };
}

export function responseTerminal(value: unknown): { id: string; usage: unknown } | null {
  if (!record(value) || !["completed", "incomplete", "failed"].includes(String(value.status))) return null;
  if (typeof value.id !== "string" || !value.id || value.id.length > 256) throw new MissingVeniceUsageError();
  responsesUsageTokens(value.usage);
  return { id: value.id, usage: value.usage };
}

/** Incremental SSE observer. Original bytes are forwarded separately. No
 * prompt, tool content or full response is retained or logged. */
export function responsesUsageObserver() {
  const decoder = new TextDecoder();
  let buffer = "", terminal: ReturnType<typeof responseTerminal> = null, responseId: string | null = null;
  function frame(text: string) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event: unknown = JSON.parse(data);
    if (!record(event)) throw new MissingVeniceUsageError();
    if (record(event.response) && typeof event.response.id === "string") {
      if (responseId && responseId !== event.response.id) throw new MissingVeniceUsageError();
      responseId = event.response.id;
    }
    if (!["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) return;
    const next = responseTerminal(event.response);
    if (!next || (terminal && JSON.stringify(next) !== JSON.stringify(terminal))) throw new MissingVeniceUsageError();
    terminal = next;
  }
  function feed(bytes?: Uint8Array) {
    buffer += bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const value of frames) { if (value.length > RESPONSES_MAX_REQUEST_BYTES) throw new MissingVeniceUsageError(); frame(value); }
    if (buffer.length > RESPONSES_MAX_REQUEST_BYTES) throw new MissingVeniceUsageError();
    if (!bytes && buffer) { frame(buffer); buffer = ""; }
  }
  return { feed, usage: () => terminal?.usage ?? null };
}
