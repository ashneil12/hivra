import { responsesEstimateRequest, responsesUsageTokens, responsesUsageObserver, responseTerminal, RESPONSES_RECONCILIATION_REASON } from "../responses-protocol";
import { estimateChatCompletionCost, calculateActualChatCost } from "../cost-estimator";
import { SWEEPABLE_RECONCILIATION_REASONS } from "../reservation-sweep";

const request = { model: "zai-org-glm-4.7", input: "hello", instructions: "Be concise", max_output_tokens: 100 };
const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 60 } };
const terminal = { id: "resp_fixture", status: "completed", usage };
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);
const clientTool = { type: "function", name: "exec_command", description: "Run a local command", strict: false, parameters: { type: "object" } };
const namespace = { type: "namespace", name: "functions", description: "", tools: [clientTool] };

it("accepts the installed Codex namespace shape without changing or undercounting children", () => {
  const tools = [clientTool, { ...namespace, tools: Array.from({ length: 5 }, (_, i) => ({ ...clientTool, name: `local_${i}` })) }];
  const body = { ...request, tools }, original = JSON.stringify(body);
  const estimated = responsesEstimateRequest(body);
  expect(estimated.tools).toBe(tools);
  const larger = responsesEstimateRequest({ ...body, tools: [{ ...namespace, tools: [{ ...clientTool, description: "local schema ".repeat(1000) }] }] });
  expect(estimateChatCompletionCost(larger).inputTokens).toBeGreaterThan(estimateChatCompletionCost(estimated).inputTokens);
  expect(JSON.stringify(body)).toBe(original);
  // Schema literals are data, not extra tool definitions.
  expect(() => responsesEstimateRequest({ ...request, tools: [{ ...namespace, tools: [{ ...clientTool, parameters: { const: { type: "web_search" } } }, { type: "custom", name: "patch", format: { type: "text" } }] }] })).not.toThrow();
});
it.each([
  ...["web_search", "x_search", "file_search", "code_interpreter", "computer_use_preview", "mcp", "tool_search", "unknown"].map(type => ({ ...namespace, tools: [clientTool, { type, name: "bad" }] })),
  { ...namespace, tools: [namespace] }, { ...namespace, tools: [] }, { ...namespace, tools: null },
  { ...namespace, tools: [null] }, { ...namespace, tools: [{ type: "function", name: "" }] },
  { ...namespace, tools: Array(129).fill(clientTool) }, { ...namespace, name: "" },
  { ...namespace, name: "x".repeat(129) }, { ...namespace, description: null },
  { ...namespace, provider_options: { web_search: true } },
])("rejects malformed namespaces and every non-client child: %j", tool => {
  expect(() => responsesEstimateRequest({ ...request, tools: [tool] })).toThrow();
});

it("reserves for full Responses input/instructions/tools and explicit output without changing the wire request", () => {
  const original = JSON.stringify(request), base = estimateChatCompletionCost(responsesEstimateRequest(request));
  const bigger = estimateChatCompletionCost(responsesEstimateRequest({ ...request, input: "long".repeat(500), tools: [{ type: "function", name: "test", description: "a".repeat(500) }] }));
  expect(bigger.inputTokens).toBeGreaterThan(base.inputTokens);
  expect(bigger.outputTokens).toBe(100);
  expect(JSON.stringify(request)).toBe(original);
});
it("accepts the pinned non-OpenAI Codex Responses request metadata as inert data", () => {
  const body = { model: "deepseek-v4-pro", instructions: "You are Codex", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }], tool_choice: "auto", parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" }, store: false, stream: true, include: ["reasoning.encrypted_content"],
    prompt_cache_key: "fixture-thread", text: { verbosity: "low" }, client_metadata: { "x-codex-turn-metadata": "fixture" } };
  expect(responsesEstimateRequest(body).model).toBe("deepseek-v4-pro");
  expect(() => responsesEstimateRequest({ ...body, client_metadata: { user: { id: "spoof" } } })).toThrow();
});
it("partitions cached input and does not double count reasoning", () => {
  const tokens = responsesUsageTokens(usage);
  expect(tokens).toEqual({ promptTokens: 200, completionTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0, totalInputTokens: 1000 });
  expect(calculateActualChatCost({ model: request.model, ...tokens }).actualCostMicroUsd).toBe(463);
});
it.each([{ input_tokens: 1 }, { ...usage, input_tokens: -1 }, { ...usage, input_tokens: 799 }, { ...usage, total_tokens: 1 }, { ...usage, output_tokens: NaN }, { ...usage, input_tokens_details: "bad" }])("rejects invalid usage instead of inventing counts: %j", value => {
  expect(() => responsesUsageTokens(value)).toThrow();
});
it.each([{ previous_response_id: "other-owner" }, { background: true }, { background: "true" }, { store: true }, { service_tier: "priority" }, { model: "test:web" }, { tools: [{ type: "web_search" }] }, { tool_choice: { type: "web_search" } }, { tools: [{ type: "file_search" }] }, { venice_parameters: { enable_web_search: "on" } }, { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://private.test" }] }] }, { max_output_tokens: 0 }])("rejects unsupported or separately priced operations: %j", patch => {
  expect(() => responsesEstimateRequest({ ...request, ...patch })).toThrow();
});
it.each(["completed", "incomplete", "failed"])("reads nested terminal %s usage across byte boundaries and duplicate frames", status => {
  const observer = responsesUsageObserver(), bytes = frame({ type: `response.${status}`, response: { ...terminal, status } });
  for (const byte of bytes) observer.feed(new Uint8Array([byte]));
  observer.feed(bytes); observer.feed();
  expect(observer.usage()).toEqual(usage);
  expect(responseTerminal({ ...terminal, status })?.usage).toEqual(usage);
});
it("rejects inconsistent terminal identity or counts", () => {
  const observer = responsesUsageObserver();
  observer.feed(frame({ type: "response.completed", response: terminal }));
  expect(() => observer.feed(frame({ type: "response.completed", response: { ...terminal, id: "different" } }))).toThrow();
});
it("does not mistake deltas, missing telemetry or [DONE] for usage", () => {
  const observer = responsesUsageObserver();
  observer.feed(frame({ type: "response.output_text.delta", delta: "hi" }));
  observer.feed(new TextEncoder().encode("data: [DONE]\n\n")); observer.feed();
  expect(observer.usage()).toBeNull();
  expect(SWEEPABLE_RECONCILIATION_REASONS).not.toContain(RESPONSES_RECONCILIATION_REASON);
});
