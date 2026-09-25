/**
 * Regression: options Venice bills on top of tokens must be held and charged.
 *
 * Venice charges extra for `venice_parameters.enable_web_search` ($10 per 1K
 * requests), `enable_web_scraping` ($10 per 1K URLs, up to 5 per request),
 * `enable_x_search` ($10 per 1K results) and the `web_search` / `x_search`
 * tools. The chat route (and the Cloudflare Worker behind internal/authorize)
 * forwarded them to Venice with Hivra's key while the hold and settlement
 * priced tokens only: a web-search call was held $0.0002 and charged $0.00001
 * while Venice billed Hivra $0.01+. They are now held at their most and
 * charged from Venice's own `cost`, or at the published rates without it
 * (chat-surcharges.ts). Options nothing here can price are refused.
 *
 * Runs the real routes and wallet code against an in-memory DB; only the
 * proxy-key lookup, live pricing and Venice itself are faked.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";

let mockMemory: ManagedVeniceSpendWorld;
const mockVerifyKey = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: null,
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));
jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({
    map: new Map(),
    source: "fallback",
    fetchedAt: Date.now(),
    liveModelCount: 0,
  })),
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import { POST as chatCompletions } from "../chat/completions/route";
import { POST as internalAuthorize } from "../../internal/authorize/route";
import { POST as internalSettle } from "../../internal/settle/route";
import { POST as anthropicMessages } from "../../anthropic/v1/messages/route";
import { POST as responses } from "../responses/route";
import { calculateActualChatCost, estimateChatCompletionCost } from "@/lib/venice/cost-estimator";

const USER_ID = "user_chat_billed_options_fixture";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const MODEL = "venice-uncensored-1-2";
const STARTING_BALANCE = 1_000_000; // $1.00
const INTERNAL_SECRET = "internal-secret-fixture";
const messages = [{ role: "user", content: "what happened in the news today?" }];
const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
const TOKEN_COST = calculateActualChatCost({ model: MODEL, promptTokens: 20, completionTokens: 5 }).actualCostMicroUsd;
const baseBody = { model: MODEL, messages, max_completion_tokens: 200 };
const TOKEN_HOLD = estimateChatCompletionCost(baseBody).reservedCostMicroUsd;

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const chat = (body: Record<string, unknown>) =>
  chatCompletions(post("https://hivra.test/api/managed-venice/v1/chat/completions", { ...baseBody, ...body }));

const internal = { "x-managed-venice-internal-secret": INTERNAL_SECRET };

/** A Venice JSON response; `extra` adds `cost` / `venice_parameters`. */
function veniceJson(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_fixture",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage,
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function veniceStream(chunks: Array<Record<string, unknown>>) {
  const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const costUsd = (microUsd: number) => ({ usd: microUsd / 1_000_000, diem: 0 });

describe("managed-Venice chat: options Venice bills on top of tokens", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockMemory = createManagedVeniceSpendWorld();
    mockMemory.fundCard(USER_ID, STARTING_BALANCE);
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "card" });
    process.env.VENICE_API_KEY = "server-key-fixture";
    process.env.MANAGED_VENICE_INTERNAL_SECRET = INTERNAL_SECRET;
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    fetchMock = jest.fn(async () => veniceJson());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  const reservation = () => {
    const rows = mockMemory.reservations();
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const reconciliationItems = () => mockMemory.tables.managed_venice_reconciliation_items ?? [];

  function sentBody(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer server-key-fixture");
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  /** The request settled; returns what the wallet was charged. */
  function charged() {
    const row = reservation();
    expect(row.status).toBe("captured");
    const [event] = mockMemory.usageEvents();
    const total = Number(event.charged_micro_usd);
    expect(Number(event.actual_cost_micro_usd)).toBe(total);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE - total);
    return { total, surcharge: total - TOKEN_COST, metadata: event.metadata as Record<string, unknown> };
  }

  function expectRefusedUntouched(res: Response) {
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMemory.reservations()).toHaveLength(0);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE);
  }

  describe("held at their most and forwarded", () => {
    it.each([
      ["web search on", { enable_web_search: "on" }, 10_000],
      ["web search auto", { enable_web_search: "auto" }, 10_000],
      ["web scraping", { enable_web_scraping: true }, 50_000],
      ["X search", { enable_x_search: true }, 200_000],
      ["all three", { enable_web_search: "on", enable_web_scraping: "true", enable_x_search: 1 }, 260_000],
    ])("%s", async (_label, veniceParameters, surchargeHold) => {
      const res = await chat({ venice_parameters: veniceParameters });
      expect(res.status).toBe(200);
      expect(sentBody().venice_parameters).toEqual(veniceParameters);
      expect(Number(reservation().reserved_micro_usd)).toBe(TOKEN_HOLD + surchargeHold);
    });

    it("refuses with a 402 when the wallet can't cover the X search hold", async () => {
      mockMemory = createManagedVeniceSpendWorld();
      mockMemory.fundCard(USER_ID, 100_000); // $0.10 < $0.20 X search hold
      const res = await chat({ venice_parameters: { enable_x_search: true } });
      expect(res.status).toBe(402);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("charged from Venice's reported cost", () => {
    it("web search on: cost minus tokens", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: costUsd(TOKEN_COST + 10_000) }));
      await chat({ venice_parameters: { enable_web_search: "on" } });
      const { surcharge, metadata } = charged();
      expect(surcharge).toBe(10_000);
      expect(metadata).toMatchObject({ surchargeMicroUsd: 10_000, surchargeSource: "venice_cost", tokenCostMicroUsd: TOKEN_COST });
    });

    it("counts DIEM-paid cost as USD-equivalent", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: { usd: TOKEN_COST / 1e6, diem: 0.02 } }));
      await chat({ venice_parameters: { enable_web_scraping: true }, messages: [{ role: "user", content: "https://a.test https://b.test" }] });
      expect(charged().surcharge).toBe(20_000);
    });

    it("web search auto that didn't search costs nothing extra", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: costUsd(TOKEN_COST) }));
      await chat({ venice_parameters: { enable_web_search: "auto" } });
      expect(charged().surcharge).toBe(0);
    });

    it("X search is charged per result reported", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: costUsd(TOKEN_COST + 370_000) }));
      await chat({ venice_parameters: { enable_x_search: true } });
      // Above the $0.20 hold: the overage is debited from the wallet.
      expect(charged().surcharge).toBe(370_000);
      expect(reconciliationItems()).toHaveLength(0);
    });

    it("clamps a reported cost above what the options can cost and files it for ops", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: costUsd(TOKEN_COST + 5_000_000) }));
      await chat({ venice_parameters: { enable_web_search: "on" } });
      expect(charged().surcharge).toBe(10_000);
      expect(reconciliationItems()).toEqual([
        expect.objectContaining({ reason: "managed_venice_surcharge_above_ceiling", status: "open" }),
      ]);
      expect(mockMemory.tables.managed_venice_proxy_keys.find((key) => key.id === KEY_ID)?.status).not.toBe("paused");
    });

    it("streamed: citations in the first chunk, cost with the usage chunk", async () => {
      fetchMock.mockResolvedValueOnce(
        veniceStream([
          { choices: [{ delta: { content: "" } }], venice_parameters: { web_search_citations: [{ url: "https://n.test" }] } },
          { choices: [{ delta: { content: "hi" } }] },
          { choices: [], usage, cost: costUsd(TOKEN_COST + 10_000) },
        ])
      );
      const res = await chat({ stream: true, venice_parameters: { enable_web_search: "auto" } });
      await res.text();
      expect(charged().surcharge).toBe(10_000);
    });
  });

  describe("charged at published rates when Venice reports no cost", () => {
    it.each([
      ["web search on", { enable_web_search: "on" }, {}, 10_000],
      ["web search auto, citations returned", { enable_web_search: "auto" }, { venice_parameters: { web_search_citations: [{ url: "https://n.test" }] } }, 10_000],
      ["web search auto, no citations", { enable_web_search: "auto" }, { venice_parameters: { web_search_citations: [] } }, 0],
      ["web search auto, nothing reported", { enable_web_search: "auto" }, {}, 10_000],
    ])("%s", async (_label, veniceParameters, response, surcharge) => {
      fetchMock.mockResolvedValueOnce(veniceJson(response));
      await chat({ venice_parameters: veniceParameters });
      expect(charged()).toMatchObject({ surcharge, metadata: expect.objectContaining({ surchargeSource: "published_rates" }) });
    });

    it("web scraping: per URL in the latest user message, at most 5", async () => {
      await chat({
        venice_parameters: { enable_web_scraping: true },
        messages: [
          { role: "user", content: "old https://ignored.test" },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "read https://a.test/x and www.b.test, then https://a.test/x again" }] },
        ],
      });
      expect(charged().surcharge).toBe(20_000);
    });

    it("web scraping caps at 5 URLs", async () => {
      const urls = Array.from({ length: 8 }, (_, i) => `https://s${i}.test`).join(" ");
      await chat({ venice_parameters: { enable_web_scraping: true }, messages: [{ role: "user", content: urls }] });
      expect(charged().surcharge).toBe(50_000);
    });

    it("X search is charged at the held results and filed for ops to true up", async () => {
      await chat({ venice_parameters: { enable_x_search: true } });
      expect(charged().surcharge).toBe(200_000);
      expect(reconciliationItems()).toEqual([
        expect.objectContaining({ reason: "managed_venice_x_search_cost_unreported", status: "open" }),
      ]);
      expect(mockMemory.tables.managed_venice_proxy_keys.find((key) => key.id === KEY_ID)?.status).not.toBe("paused");
    });

    it.each([
      ["a web_search tool (the model decides)", { tools: [{ type: "web_search" }] }, 10_000],
      ["an x_search tool", { tools: [{ type: "x_search" }, { type: "function", function: { name: "f", parameters: { type: "object" } } }] }, 200_000],
      ["a forced web_search tool_choice", { tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }, 10_000],
    ])("%s", async (_label, patch, surcharge) => {
      await chat(patch);
      expect(sentBody().tools).toEqual(patch.tools);
      expect(charged().surcharge).toBe(surcharge);
    });

    it("streamed without cost", async () => {
      fetchMock.mockResolvedValueOnce(veniceStream([{ choices: [{ delta: { content: "hi" } }] }, { choices: [], usage }]));
      const res = await chat({ stream: true, venice_parameters: { enable_web_search: "on" } });
      await res.text();
      expect(charged().surcharge).toBe(10_000);
    });
  });

  describe("through the Cloudflare Worker (internal authorize + settle)", () => {
    async function authorize(body: Record<string, unknown>) {
      const res = await internalAuthorize(
        post("https://hivra.test/api/managed-venice/internal/authorize", { plaintextKey: "hven_live_fixture", body }, internal)
      );
      return { res, json: (await res.json()) as Record<string, unknown> };
    }
    const settle = (referenceId: string, extra: Record<string, unknown> = {}) =>
      internalSettle(
        post(
          "https://hivra.test/api/managed-venice/internal/settle",
          { outcome: "settle", userId: USER_ID, proxyKeyId: KEY_ID, walletType: "card", referenceId, model: MODEL, upstreamStatus: 200, usage, ...extra },
          internal
        )
      );

    it("holds the surcharge, and an old Worker that sends only usage still charges it", async () => {
      const { res, json } = await authorize({ ...baseBody, stream: true, venice_parameters: { enable_web_search: "on" } });
      expect(res.status).toBe(200);
      expect(Number(reservation().reserved_micro_usd)).toBe(TOKEN_HOLD + 10_000);
      expect((await settle(String(json.referenceId))).status).toBe(200);
      expect(charged().surcharge).toBe(10_000);
    });

    it("uses Venice's cost when the Worker forwards it", async () => {
      const { json } = await authorize({ ...baseBody, venice_parameters: { enable_x_search: true } });
      await settle(String(json.referenceId), { surchargeEvidence: { veniceCostMicroUsd: TOKEN_COST + 30_000, webSearchCitations: null } });
      expect(charged().surcharge).toBe(30_000);
      expect(reconciliationItems()).toHaveLength(0);
    });

    it("ignores malformed evidence", async () => {
      const { json } = await authorize({ ...baseBody, venice_parameters: { enable_web_search: "on" } });
      await settle(String(json.referenceId), { surchargeEvidence: { veniceCostMicroUsd: -5, webSearchCitations: "many" } });
      expect(charged().surcharge).toBe(10_000);
    });

    it("refuses what can't be priced", async () => {
      const { res } = await authorize({ ...baseBody, venice_parameters: { enable_future_paid_thing: true } });
      expectRefusedUntouched(res);
    });
  });

  describe("unchanged: no billed option", () => {
    it("the Hermes agent's chat (character_slug, function tools) pays tokens only, even if Venice reports cost", async () => {
      fetchMock.mockResolvedValueOnce(veniceJson({ cost: costUsd(TOKEN_COST + 99_000) }));
      const hermes = {
        venice_parameters: { character_slug: "alan-watts" },
        tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
        tool_choice: "auto",
      };
      const res = await chat(hermes);
      expect(res.status).toBe(200);
      expect(sentBody().venice_parameters).toEqual({ character_slug: "alan-watts" });
      expect(Number(reservation().reserved_micro_usd)).toBe(
        estimateChatCompletionCost({ ...baseBody, ...hermes }).reservedCostMicroUsd
      );
      const { surcharge, metadata } = charged();
      expect(surcharge).toBe(0);
      expect(metadata).not.toHaveProperty("surchargeMicroUsd");
    });

    it.each([
      ["false / 'off' / 'false'", { enable_web_search: "off", enable_web_scraping: false, enable_x_search: "false" }],
      ["0 / '0' / ''", { enable_web_search: "", enable_web_scraping: 0, enable_x_search: "0" }],
      ["null", { enable_web_search: null, enable_web_scraping: null, enable_x_search: null }],
      ["free options", {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        disable_thinking: true,
        enable_web_citations: true,
        include_search_results_in_stream: false,
        return_search_results_as_documents: false,
        enable_e2ee: true,
      }],
    ])("billed options switched off: %s", async (_label, veniceParameters) => {
      const res = await chat({ venice_parameters: veniceParameters });
      expect(res.status).toBe(200);
      expect(sentBody().venice_parameters).toEqual(veniceParameters);
      expect(Number(reservation().reserved_micro_usd)).toBe(TOKEN_HOLD);
      expect(charged().surcharge).toBe(0);
    });

    it("Anthropic messages never forward venice_parameters (the body is rebuilt)", async () => {
      const res = await anthropicMessages(
        post("https://hivra.test/api/managed-venice/anthropic/v1/messages", {
          model: MODEL,
          max_tokens: 200,
          messages,
          venice_parameters: { enable_web_search: "on" },
        })
      );
      expect(res.status).toBe(200);
      expect(sentBody()).not.toHaveProperty("venice_parameters");
    });
  });

  describe("refused before any hold or Venice call", () => {
    it.each([
      ["an undocumented venice_parameters option", { venice_parameters: { enable_future_paid_thing: true } }],
      ["venice_parameters as a string", { venice_parameters: "enable_web_search=on" }],
      ["venice_parameters as an array", { venice_parameters: [{ enable_web_search: "on" }] }],
      ["an unknown tool type", { tools: [{ type: "file_search" }] }],
      ["tools that aren't an array", { tools: { type: "web_search" } }],
      ["an unknown tool_choice type", { tool_choice: { type: "code_interpreter" } }],
      ["a model feature suffix", { model: `${MODEL}:enable_web_search=on` }],
    ])("%s", async (_label, patch) => {
      expectRefusedUntouched(await chat(patch));
    });

    it("on the Responses route (its own allowlist)", async () => {
      const res = await responses(
        post("https://hivra.test/api/managed-venice/v1/responses", {
          model: MODEL,
          input: "news?",
          venice_parameters: { enable_web_search: "on" },
        })
      );
      expectRefusedUntouched(res);
    });
  });
});
