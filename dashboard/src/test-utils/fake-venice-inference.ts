/**
 * A worst-case Venice inference upstream for managed-Venice spend tests.
 *
 * It follows Venice's published API contract (api.venice.ai/doc/api/swagger.yaml)
 * for how many tokens a request may generate, and always generates all of them,
 * the way a prompt such as "repeat this forever" does:
 *   - Chat Completions: `max_completion_tokens` / `max_tokens` bound the output.
 *     When both are sent the fake honours the LARGER one, since nothing in the
 *     contract says which Venice prefers. A missing, null or non-positive value
 *     means "the model's default maximum" (the swagger text for `max_tokens`).
 *   - Responses: `max_output_tokens` bounds the output, else the model maximum.
 *   - The model maximum is the published `maxCompletionTokens`
 *     (`VeniceChatModelPrice.maxOutputTokens`); output never exceeds it. A test
 *     can say Venice's real maximum differs from the static catalog
 *     (`veniceMaxOutputTokens`), the drift the catalog has had before
 *     (zai-org-glm-5-1: 24,000 in the catalog, 80,000 on Venice).
 *   - `n` choices each generate that many tokens.
 * Prompt tokens are a realistic ~4 characters per token of the forwarded body.
 *
 * Every forwarded body is recorded so a test can check what reached Venice.
 */

import { getVeniceChatModelPrice } from "@/lib/venice/pricing";
import type { ManagedVeniceSpendWorld } from "./managed-venice-spend-world";

export interface FakeVeniceCall {
  url: string;
  body: Record<string, unknown>;
  rawBody: string;
  promptTokens: number;
  completionTokens: number;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function chatOutputTokens(body: Record<string, unknown>, modelMax: number) {
  const caps = [positive(body.max_completion_tokens), positive(body.max_tokens)].filter(
    (value): value is number => value !== null
  );
  const cap = caps.length ? Math.max(...caps) : modelMax;
  const choices = positive(body.n) ?? 1;
  return Math.min(cap, modelMax) * choices;
}

function responsesOutputTokens(body: Record<string, unknown>, modelMax: number) {
  return Math.min(positive(body.max_output_tokens) ?? modelMax, modelMax);
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createWorstCaseVenice(
  options: {
    /** Venice's real per-model output maximum, where it is not the catalog's. */
    veniceMaxOutputTokens?: Record<string, number>;
    /**
     * Awaited after a call is recorded and before Venice answers, so a test
     * can hold a request "at Venice" (its hold still active) while another runs.
     */
    beforeRespond?: () => Promise<void>;
  } = {}
) {
  const calls: FakeVeniceCall[] = [];

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
    const model = String(body.model);
    const modelMax =
      options.veniceMaxOutputTokens?.[model] ?? getVeniceChatModelPrice(model).maxOutputTokens;
    const promptTokens = Math.ceil(rawBody.length / 4);

    if (url.endsWith("/api/v1/responses")) {
      const completionTokens = responsesOutputTokens(body, modelMax);
      calls.push({ url, body, rawBody, promptTokens, completionTokens });
      await options.beforeRespond?.();
      const usage = {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      return json({ id: `resp_${calls.length}`, status: "completed", usage, output: [] });
    }

    if (url.endsWith("/api/v1/chat/completions")) {
      const completionTokens = chatOutputTokens(body, modelMax);
      calls.push({ url, body, rawBody, promptTokens, completionTokens });
      await options.beforeRespond?.();
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      if (body.stream === true) {
        const encoder = new TextEncoder();
        const frames = [
          { id: "chatcmpl_fake", choices: [{ index: 0, delta: { content: "and again, " } }] },
          { id: "chatcmpl_fake", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
          { id: "chatcmpl_fake", choices: [], usage },
        ];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return json({
        id: `chatcmpl_${calls.length}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "and again, and again" },
            finish_reason: "length",
          },
        ],
        usage,
      });
    }

    throw new Error(`Unexpected upstream call in a managed-Venice spend test: ${url}`);
  }

  return { fetch: jest.fn(fetchImpl), calls };
}

/** What Venice bills Hivra for a call, at the static catalog price. */
export function veniceCostMicroUsd(model: string, promptTokens: number, completionTokens: number) {
  const price = getVeniceChatModelPrice(model);
  return (
    Math.ceil((promptTokens * price.inputMicroUsdPerMillion) / 1_000_000) +
    Math.ceil((completionTokens * price.outputMicroUsdPerMillion) / 1_000_000)
  );
}

/**
 * Every call that reached the fake was covered by its own wallet hold and
 * charged in full: no overage debit was needed, none went uncovered, and the
 * card wallet never went below zero.
 */
export function expectEveryCallCoveredByItsHold(
  world: ManagedVeniceSpendWorld,
  venice: ReturnType<typeof createWorstCaseVenice>,
  userId: string
) {
  expect(venice.calls.length).toBeGreaterThan(0);
  const reservations = world.reservations();
  const usage = world.usageEvents();
  expect(reservations).toHaveLength(venice.calls.length);
  for (const [index, call] of venice.calls.entries()) {
    const cost = veniceCostMicroUsd(String(call.body.model), call.promptTokens, call.completionTokens);
    expect(Number(reservations[index].reserved_micro_usd)).toBeGreaterThanOrEqual(cost);
    expect(Number(usage[index].actual_cost_micro_usd)).toBe(cost);
    expect(Number(usage[index].charged_micro_usd)).toBe(cost);
  }
  const uncovered = world.tables.managed_venice_reconciliation_items.filter(
    (row) => row.reason === "managed_venice_overage_uncovered"
  );
  expect(uncovered).toEqual([]);
  expect(world.cardBalanceMicroUsd(userId)).toBeGreaterThanOrEqual(0);
}
