/**
 * Regression: a managed-Venice chat request must not switch on an option
 * Venice bills on top of tokens.
 *
 * Venice charges extra for `venice_parameters.enable_web_search` ($10 per 1K
 * requests), `enable_web_scraping` ($10 per 1K URLs, up to 5 per request) and
 * `enable_x_search` ($10 per 1K results), and for provider-side `web_search` /
 * `x_search` tools. The chat hold and settlement price tokens only, and the
 * chat route (and the Cloudflare Worker behind internal/authorize) forwarded
 * the caller's body as sent, so Hivra paid those surcharges and the user was
 * never charged for them. These requests are now refused before any hold or
 * upstream call. The Hermes agent's own chat (`character_slug`, function
 * tools) still goes through and is charged as before.
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
import { POST as anthropicMessages } from "../../anthropic/v1/messages/route";
import { POST as responses } from "../responses/route";

const USER_ID = "user_chat_billed_options_fixture";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const MODEL = "venice-uncensored-1-2";
const STARTING_BALANCE = 1_000_000; // $1.00
const INTERNAL_SECRET = "internal-secret-fixture";
const messages = [{ role: "user", content: "what happened in the news today?" }];

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const chat = (body: Record<string, unknown>) =>
  chatCompletions(
    post("https://hivra.test/api/managed-venice/v1/chat/completions", {
      model: MODEL,
      messages,
      max_completion_tokens: 200,
      ...body,
    })
  );

function veniceChatResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_fixture",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

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
    fetchMock = jest.fn(async () => veniceChatResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  function expectRefusedUntouched(res: Response) {
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMemory.reservations()).toHaveLength(0);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE);
  }

  function sentBody(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  function chargedTokensOnly() {
    const [reservation] = mockMemory.reservations();
    expect(reservation?.status).toBe("captured");
    const captured = Number(reservation.captured_micro_usd);
    expect(captured).toBeGreaterThan(0);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE - captured);
  }

  describe("refused before any hold or Venice call", () => {
    it.each([
      ["enable_web_search: 'on'", { enable_web_search: "on" }],
      ["enable_web_search: 'auto'", { enable_web_search: "auto" }],
      ["enable_web_search: 'ON '", { enable_web_search: "ON " }],
      ["enable_web_search: true", { enable_web_search: true }],
      ["enable_web_scraping: true", { enable_web_scraping: true }],
      ["enable_web_scraping: 'true'", { enable_web_scraping: "true" }],
      ["enable_x_search: true", { enable_x_search: true }],
      ["enable_x_search: 1", { enable_x_search: 1 }],
      ["an undocumented option", { enable_future_paid_thing: true }],
    ])("venice_parameters with %s", async (_label, veniceParameters) => {
      const res = await chat({ venice_parameters: veniceParameters });
      expectRefusedUntouched(res);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/venice_parameters/);
    });

    it.each([
      ["a string", "enable_web_search=on"],
      ["an array", [{ enable_web_search: "on" }]],
    ])("venice_parameters as %s", async (_label, veniceParameters) => {
      expectRefusedUntouched(await chat({ venice_parameters: veniceParameters }));
    });

    it.each([
      ["web_search", { tools: [{ type: "web_search" }] }],
      ["x_search", { tools: [{ type: "x_search" }] }],
      ["web_search beside a function", {
        tools: [{ type: "function", function: { name: "local", parameters: { type: "object" } } }, { type: "web_search" }],
      }],
      ["a web_search tool_choice", { tool_choice: { type: "web_search" } }],
    ])("provider-side tool: %s", async (_label, patch) => {
      expectRefusedUntouched(await chat(patch));
    });

    it("a model feature suffix that switches web search on", async () => {
      expectRefusedUntouched(await chat({ model: `${MODEL}:enable_web_search=on` }));
    });

    it("through the Cloudflare Worker's internal authorize (it forwards its own copy of the body)", async () => {
      const res = await internalAuthorize(
        post(
          "https://hivra.test/api/managed-venice/internal/authorize",
          {
            plaintextKey: "hven_live_fixture",
            body: { model: MODEL, messages, stream: true, venice_parameters: { enable_web_search: "on" } },
          },
          { "x-managed-venice-internal-secret": INTERNAL_SECRET }
        )
      );
      expectRefusedUntouched(res);
    });

    it("on the Responses route", async () => {
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

  describe("still served and charged", () => {
    it("the Hermes agent's chat: character_slug plus function tools", async () => {
      const res = await chat({
        venice_parameters: { character_slug: "alan-watts" },
        tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
        tool_choice: "auto",
      });
      expect(res.status).toBe(200);
      expect(sentBody().venice_parameters).toEqual({ character_slug: "alan-watts" });
      chargedTokensOnly();
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
      chargedTokensOnly();
    });

    it("the Worker path for an ordinary request", async () => {
      const res = await internalAuthorize(
        post(
          "https://hivra.test/api/managed-venice/internal/authorize",
          { plaintextKey: "hven_live_fixture", body: { model: MODEL, messages, venice_parameters: { character_slug: "x" } } },
          { "x-managed-venice-internal-secret": INTERNAL_SECRET }
        )
      );
      expect(res.status).toBe(200);
      expect(mockMemory.reservations()).toHaveLength(1);
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
});
